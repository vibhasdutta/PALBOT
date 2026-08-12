// Live status dashboard: one auto-updating channel per guild, holding a
// status+players message pair for every server that guild owns (edited in
// place on a fixed interval, not reposted), plus a channel name showing how
// many of the guild's servers are currently online. If no channel is
// configured yet, or a configured channel/message has been deleted, one is
// (re)created automatically and the new ID is written back to
// config/servers.json -- the human only ever has to *edit* that file
// afterward to point at a different existing channel.
const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder, ChannelType } = require('discord.js');
const pm2 = require('pm2');
const { mutateGuildEntry } = require('./config');
const { readWorldSettings } = require('./worldSettingsParser');
const { cleanPlayerId } = require('./playerPoller');

const COLORS = { online: 0x16a34a, starting: 0xd97706, offline: 0xdc2626 };

function slugForChannel(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function guildChannelNameFor(onlineCount, total) {
  return `⌈${onlineCount}⇋${total}⌋-servers`;
}

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

function defaultGetPm2Status(pm2ProcessName) {
  return new Promise((resolve) => {
    pm2.describe(pm2ProcessName, (err, list) => {
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
  serversPath,
  statePath,
  getPm2Status = defaultGetPm2Status,
  intervalMs = 10000,
}) {
  const lastChannelName = new Map(); // guildId -> last name we set/observed

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

  // Configured channel missing, deleted, or never set -- (re)create one and
  // persist the new ID so config/servers.json stays the source of truth the
  // human can hand-edit afterward.
  async function resolveGuildChannel(group, initialName) {
    const guild = client.guilds.cache.get(group.guildId);
    if (!guild) return null;

    if (group.statusChannelId) {
      const existing = await guild.channels.fetch(group.statusChannelId).catch(() => null);
      if (existing) return existing;
    }

    const created = await guild.channels.create({
      name: initialName,
      type: ChannelType.GuildText,
      reason: 'Palworld live status channel',
    }).catch((err) => {
      console.error(`statusChannel: failed to create status channel in guild ${group.guildId}:`, err.message);
      return null;
    });
    if (!created) return null;

    mutateGuildEntry(serversPath, group.guildId, (entry) => { entry.statusChannelId = created.id; });
    return created;
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

  async function tickGuild(group) {
    if (group.servers.length === 0) return;

    const results = [];
    for (const server of group.servers) {
      const palworld = createClient({ baseUrl: server.restApiUrl, password: server.restApiPassword });
      const pm2Status = await getPm2Status(server.pm2ProcessName);
      const displayName = getServerDisplayName(server);
      const { state, embed: statusEmbed } = await buildStatusPayload(palworld, pm2Status, displayName);
      const playersEmbed = await buildPlayersPayload(palworld, displayName);
      results.push({ server, state, statusEmbed, playersEmbed });
    }

    const onlineCount = results.filter((r) => r.state === 'online').length;
    const desiredName = guildChannelNameFor(onlineCount, results.length);

    const channel = await resolveGuildChannel(group, desiredName);
    if (!channel) return;

    for (const r of results) {
      const statusMsg = await resolveMessage(channel, group.guildId, r.server.label, 'statusMessageId');
      if (statusMsg) await statusMsg.edit({ content: '', embeds: [r.statusEmbed] }).catch(() => {});

      const playersMsg = await resolveMessage(channel, group.guildId, r.server.label, 'playersMessageId');
      if (playersMsg) await playersMsg.edit({ content: '', embeds: [r.playersEmbed] }).catch(() => {});
    }

    if (lastChannelName.get(group.guildId) !== desiredName && channel.name !== desiredName) {
      await channel.setName(desiredName).catch((err) => console.error(`statusChannel: failed to rename channel for guild ${group.guildId}:`, err.message));
    }
    lastChannelName.set(group.guildId, desiredName);
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
