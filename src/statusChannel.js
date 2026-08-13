// Live status dashboard: one auto-updating channel per statusChannelId,
// holding a status+players message pair for every server that shares it
// (edited in place on a fixed interval, not reposted). Servers with no
// statusChannelId configured are skipped entirely -- channels are created
// explicitly via the dashboard's "Create Channel" button
// (src/webServer.js), never silently by this tick loop. If a configured
// channel gets deleted, its servers are just skipped again until someone
// points them at a channel through the dashboard.
const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder } = require('discord.js');
const pm2 = require('pm2');
const { readWorldSettings } = require('./worldSettingsParser');
const { cleanPlayerId } = require('./playerPoller');

const COLORS = { online: 0x16a34a, starting: 0xd97706, offline: 0xdc2626 };

function slugForChannel(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function guildChannelNameFor(onlineCount, total) {
  return `⌈${onlineCount}⇋${total}⌋-servers`;
}

const OWN_NAME_PATTERN = /^⌈\d+⇋\d+⌋-servers$/;

// The ini's own ServerName is always on disk whether the process is running
// or not; falls back to the config label if even that's unavailable.
function getServerDisplayName(server) {
  if (server.settingsFilePath) {
    try {
      const { settings } = readWorldSettings(server.settingsFilePath);
      const name = settings.get('ServerName');
      if (name) return name.replace(/^"|"$/g, '');
    } catch {
      // fall through to label
    }
  }
  return server.label;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Agent-routed servers run on someone else's host -- the bot's own local
// pm2 daemon has no idea about their process, so there's nothing to check
// (a name collision with an unrelated local process would be worse than
// not checking at all). 'unknown' makes buildStatusPayload fall back to
// 'offline' rather than falsely claiming 'starting'.
function defaultGetPm2Status(server) {
  if (server.agentId) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    pm2.describe(server.pm2ProcessName, (err, list) => {
      resolve(err || !list?.[0] ? 'unknown' : list[0].pm2_env.status);
    });
  });
}

// Builds the status embed for one server and resolves its state
// ('online'/'starting'/'offline') in one shot, since the embed depends on
// which branch it took. REST reachable -> online. REST unreachable but pm2
// says the process is up -> starting (booting, not crashed). Anything else
// -> offline.
async function buildStatusPayload(palworld, pm2Status, displayName) {
  try {
    const [, { players = [] }, metrics] = await Promise.all([
      palworld.getInfo(),
      palworld.getPlayers(),
      palworld.getMetrics(),
    ]);
    const embed = new EmbedBuilder()
      .setTitle(`${displayName} — Online`)
      .setColor(COLORS.online)
      .addFields(
        { name: 'Players', value: `${players.length}/${metrics.maxplayernum}`, inline: true },
        { name: 'Day', value: `${metrics.days}`, inline: true },
        { name: 'FPS', value: `${metrics.serverfps} (${metrics.serverframetime.toFixed(1)}ms)`, inline: true },
        { name: 'Uptime', value: formatUptime(metrics.uptime), inline: true },
      )
      .setTimestamp();
    return { state: 'online', embed };
  } catch {
    const state = pm2Status === 'online' ? 'starting' : 'offline';
    const embed = new EmbedBuilder()
      .setTitle(state === 'starting' ? `${displayName} — Starting` : `${displayName} — Offline`)
      .setColor(COLORS[state])
      .setDescription(state === 'starting' ? 'Process is up, waiting for the game to finish booting...' : 'The server process is not running.')
      .setTimestamp();
    return { state, embed };
  }
}

async function buildPlayersPayload(palworld, displayName) {
  try {
    const { players = [] } = await palworld.getPlayers();
    const embed = new EmbedBuilder().setTitle(`${displayName} — Players (${players.length})`).setColor(0x6366f1).setTimestamp();
    if (players.length === 0) {
      embed.setDescription('No players connected.');
    } else {
      embed.addFields(
        { name: 'Name', value: players.map((p) => p.name || 'Connecting').join('\n').slice(0, 1024), inline: true },
        { name: 'Player ID', value: players.map((p) => cleanPlayerId(p.playerId) || p.userId || 'unknown').join('\n').slice(0, 1024), inline: true },
      );
    }
    return embed;
  } catch {
    return new EmbedBuilder().setTitle(`${displayName} — Players`).setColor(0x6b7280).setDescription('Unavailable -- server unreachable.').setTimestamp();
  }
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return [];
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function createStatusChannelManager({
  client,
  getGuildGroups,
  createClient,
  statePath,
  getPm2Status = defaultGetPm2Status,
  intervalMs = 10000,
}) {
  const lastChannelName = new Map(); // `${guildId}:${channelKey}` -> last name we set/observed
  const purgedChannels = new Set(); // tracks channels purged in this session

  function getEntry(guildId, label) {
    return readState(statePath).find((e) => e.guildId === guildId && e.label === label) || null;
  }

  function saveEntry(guildId, label, patch) {
    const state = readState(statePath);
    let entry = state.find((e) => e.guildId === guildId && e.label === label);
    if (!entry) {
      entry = { guildId, label };
      state.push(entry);
    }
    Object.assign(entry, patch);
    writeState(statePath, state);
  }

  // Explicit only -- channels are created via the dashboard's "Create
  // Channel" button (src/webServer.js), never silently by this tick loop.
  // A server with no statusChannelId configured, or one pointing at a
  // channel that's been deleted, is simply skipped until someone points
  // it at a real channel again.
  async function resolveChannel(guildId, channelId) {
    if (!channelId) return null;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    const existing = await guild.channels.fetch(channelId).catch(() => null);
    if (!existing) return null;

    if (!purgedChannels.has(existing.id)) {
      purgedChannels.add(existing.id);
      try {
        const fetchedMsgs = await existing.messages.fetch({ limit: 50 }).catch(() => null);
        if (fetchedMsgs && fetchedMsgs.size > 0 && typeof existing.bulkDelete === 'function') {
          await existing.bulkDelete(fetchedMsgs, true).catch(async () => {
            for (const [, msg] of fetchedMsgs) {
              if (msg.author.id === client.user?.id) {
                await msg.delete().catch(() => {});
              }
            }
          });
        }
      } catch {
        // Ignore purge errors
      }
    }
    return existing;
  }

  // Configured message missing, deleted, or never sent -- send a fresh one
  // and persist its ID the same way.
  async function resolveMessage(channel, guildId, label, idField) {
    const existingId = getEntry(guildId, label)?.[idField];
    if (existingId) {
      const msg = await channel.messages.fetch(existingId).catch(() => null);
      if (msg) return msg;
    }
    const msg = await channel.send({ content: 'Initializing...' }).catch((err) => {
      console.error(`statusChannel: failed to send message in channel ${channel.id}:`, err.message);
      return null;
    });
    if (msg) saveEntry(guildId, label, { [idField]: msg.id });
    return msg;
  }

  // One channel's worth of servers: build every server's status/players
  // payload, resolve or create the channel, edit/send each server's
  // message pair, then rename the channel to reflect this group's own
  // online-count/total (not the whole guild's).
  async function tickChannelGroup(guildId, channelKey, servers) {
    const results = [];
    for (const server of servers) {
      const palworld = createClient(server);
      const pm2Status = await getPm2Status(server);
      const displayName = getServerDisplayName(server);
      const { state, embed: statusEmbed } = await buildStatusPayload(palworld, pm2Status, displayName);
      const playersEmbed = await buildPlayersPayload(palworld, displayName);
      results.push({ server, state, statusEmbed, playersEmbed });
    }

    const onlineCount = results.filter((r) => r.state === 'online').length;
    const desiredName = guildChannelNameFor(onlineCount, results.length);

    // channelKey is already the resolved effective channel ID (see
    // tickGuild) -- tracked-vs-config precedence is decided once, up front,
    // not re-derived here.
    const channel = await resolveChannel(guildId, channelKey);
    if (!channel) return;

    for (const server of servers) {
      const entry = getEntry(guildId, server.label);
      if (entry && entry.lastChannelId !== channel.id) {
        saveEntry(guildId, server.label, { statusMessageId: null, playersMessageId: null, lastChannelId: channel.id });
      } else if (!entry) {
        saveEntry(guildId, server.label, { lastChannelId: channel.id });
      }
    }

    for (const r of results) {
      const statusMsg = await resolveMessage(channel, guildId, r.server.label, 'statusMessageId');
      if (statusMsg) await statusMsg.edit({ content: '', embeds: [r.statusEmbed] }).catch(() => {});

      const playersMsg = await resolveMessage(channel, guildId, r.server.label, 'playersMessageId');
      if (playersMsg) await playersMsg.edit({ content: '', embeds: [r.playersEmbed] }).catch(() => {});
    }

    // Only touch the name of a channel that already looks like ours (either
    // just created with this pattern, or previously auto-named by us on an
    // earlier tick) -- an existing channel someone picked and gave their
    // own name to is left alone, never overwritten back to the bracket
    // pattern.
    const trackKey = `${guildId}:${channelKey}`;
    if (OWN_NAME_PATTERN.test(channel.name) && lastChannelName.get(trackKey) !== desiredName && channel.name !== desiredName) {
      await channel.setName(desiredName).catch((err) => console.error(`statusChannel: failed to rename channel for guild ${guildId}:`, err.message));
    }
    lastChannelName.set(trackKey, desiredName);
  }

  async function tickGuild(group) {
    // Effective channel per server: prefer our own last-known channel ID
    // (this manager's local state file, written synchronously the moment a
    // channel is resolved) over server.statusChannelId, which comes from
    // config.servers in index.js and only catches up once
    // config/servers.json's file-watcher reload fires -- not instant, not
    // always reliable depending on the filesystem. A server with neither
    // has nothing to tick -- channel assignment is an explicit dashboard
    // action now, not something this loop does on its own.
    const withChannel = group.servers
      .map((server) => ({ server, channelId: getEntry(group.guildId, server.label)?.lastChannelId || server.statusChannelId }))
      .filter((x) => x.channelId);
    if (withChannel.length === 0) return;

    // Servers sharing a channel render together in one.
    const byChannel = new Map();
    for (const { server, channelId } of withChannel) {
      if (!byChannel.has(channelId)) byChannel.set(channelId, []);
      byChannel.get(channelId).push(server);
    }

    for (const [key, servers] of byChannel) {
      await tickChannelGroup(group.guildId, key, servers);
    }
  }

  async function tick() {
    for (const group of getGuildGroups()) {
      try {
        await tickGuild(group);
      } catch (err) {
        console.error(`statusChannel: tick failed for guild ${group.guildId}:`, err.message);
      }
    }
  }

  function start() {
    tick().catch((err) => console.error('statusChannel: initial tick failed:', err.message));
    return setInterval(() => tick().catch((err) => console.error('statusChannel: tick failed:', err.message)), intervalMs);
  }

  return { start, tick };
}

module.exports = {
  createStatusChannelManager,
  buildStatusPayload,
  buildPlayersPayload,
  getServerDisplayName,
  slugForChannel,
  guildChannelNameFor,
};
