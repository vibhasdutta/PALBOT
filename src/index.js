const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, Events, REST, Routes, Options, ChannelType } = require('discord.js');
const {
  loadConfig,
  ensureGuildEntry,
  guildsFromServers,
  rolesFromServers,
  loadServersFile,
  findGuildServer,
  findGuildServers,
  allCompleteServers,
  resolveServerConnection,
  mutateGuildEntry,
} = require('./config');
const { resolveTier, resolveTierFromGrants, hasAccess, findGuildRoles } = require('./permissions');
const { createPalworldClient } = require('./palworldClient');
const { controlService } = require('./processControl');
const { createAgentRegistry } = require('./agentRegistry');
const { createAgentPalworldClient } = require('./agentPalworldClient');
const { appendAuditEntry } = require('./auditLog');
const { errorEmbed } = require('./embeds');
const { createNotifier, formatAuditEntry } = require('./notify');
const { autocompleteServer } = require('./serverOption');
const { autocompletePlayers } = require('./playerOption');
const { createExpectedActions } = require('./expectedActions');
const { createActionLock } = require('./actionLock');
const { watchPm2 } = require('./pm2Watcher');
const { createPlayerPoller } = require('./playerPoller');
const { createSaveFileWatcher } = require('./saveFileWatcher');
const { createStatusChannelManager } = require('./statusChannel');
const loadCommands = require('./commands');
const { createWebServer } = require('./webServer');

const BOT_PM2_NAME = 'palworld-bot';

const config = loadConfig();
// ponytail: temporary diagnostic for a data-loss bug where servers.json
// looks empty to the bot on some restarts even though `cat` shows real
// data -- remove once the root cause (path mismatch vs. a genuine
// race/write issue) is confirmed.
console.log(`[diag] serversPath=${config.serversPath} exists=${fs.existsSync(config.serversPath)} guildsLoaded=${config.servers.length} guildIds=${JSON.stringify(config.servers.map((s) => s.guildId))}`);
const commands = loadCommands();
const agentRegistry = createAgentRegistry({ agentsPath: config.agentsPath });
const commandData = [...commands.values()].map((c) => c.data.toJSON());
const rest = new REST().setToken(config.discordToken);

// ponytail: this bot only handles slash commands, never reads messages/presences/
// reactions/voice state — zeroing those caches keeps memory flat instead of growing
// with server activity. GuildMemberManager is zeroed too since interaction.member
// is populated straight from the interaction payload, not from cache.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ThreadManager: 0,
    VoiceStateManager: 0,
    GuildBanManager: 0,
    GuildInviteManager: 0,
    GuildEmojiManager: 0,
    StageInstanceManager: 0,
    GuildMemberManager: 0,
  }),
});

const notify = createNotifier(client, (guildId) => config.servers.find((s) => s.guildId === guildId)?.botLogChannelId || null);
const expectedActions = createExpectedActions();
// Shared across every guild/server -- keyed by `${guildId}:${label}` inside
// each command, so start/stop/restart can't stack a second in-flight
// action onto the same server no matter which guild's command triggered it.
const actionLock = createActionLock();

const auditLog = {
  appendAuditEntry: (entry) => {
    const saved = appendAuditEntry(config.auditLogPath, entry);
    if (entry.server) notify.serverLog(entry.server, formatAuditEntry(entry)).catch(() => {});
    else if (entry.guildId) notify.botLog(entry.guildId, formatAuditEntry(entry)).catch(() => {});
    return saved;
  },
};

const webServer = createWebServer({ config, client, notify, auditLog, agentRegistry });

const baseCtx = { config, auditLog, webServer, actionLock };

// Resolves which server (if any) a command should act on for this guild, and
// builds the ctx for it. A guild is its own tenant: no shared Palworld
// connection. Zero configured servers, an ambiguous "which one" with more
// than one and no label given, or an unknown label all fail closed --
// `errorMessage` explains which case it was so the user isn't just told "no".
function resolveServerCtx(guildId, label) {
  const server = findGuildServer(config.servers, guildId, label);
  // Stamps `server` onto every entry before it reaches the real audit log,
  // so module-scope auditLog.appendAuditEntry above can route it to
  // notify.serverLog instead of notify.botLog -- command handlers keep
  // calling ctx.auditLog.appendAuditEntry({guildId, ...}) exactly as they
  // do today, unaware this wrapper exists. guildId is attached here too --
  // findGuildServer's own server objects don't carry it, but
  // notify.serverLog needs it to resolve the guild's one auto-created log
  // channel.
  const scopedAuditLog = server ? {
    appendAuditEntry: (entry) => auditLog.appendAuditEntry({ ...entry, server: { ...server, guildId } }),
  } : null;

  if (server) {
    // Agent-routed: the server lives on its owner's own host. No
    // expectedActions wrapping needed here -- pm2Watcher only ever
    // observes the bot's own local pm2 daemon, so it structurally can't
    // see a remote agent's pm2 events regardless.
    if (server.agentId) {
      return {
        ctx: {
          ...baseCtx,
          auditLog: scopedAuditLog,
          server,
          palworld: createAgentPalworldClient({ agentRegistry, agentId: server.agentId, serverId: server.serverId }),
          processControl: {
            controlService: (action) => agentRegistry.sendCommand(server.agentId, server.serverId, 'controlService', { action }),
          },
        },
        errorMessage: null,
      };
    }

    const { restApiUrl, restApiPassword } = resolveServerConnection(server);
    const rawPalworld = createPalworldClient({ baseUrl: restApiUrl, password: restApiPassword });
    return {
      ctx: {
        ...baseCtx,
        auditLog: scopedAuditLog,
        server,
        palworld: {
          ...rawPalworld,
          // Marking this expected before the call means saveFileWatcher.js
          // (which watches the save file's mtime for autosaves/in-game
          // saves) doesn't also report a save the bot itself just triggered,
          // whether directly via /save or as restart.js's pre-restart save.
          save: () => {
            expectedActions.expect(`save:${guildId}:${server.label}`);
            return rawPalworld.save();
          },
        },
        processControl: {
          controlService: (action) => {
            expectedActions.expect(server.pm2ProcessName);
            return controlService(server.pm2ProcessName, action);
          },
        },
      },
      errorMessage: null,
    };
  }

  const available = findGuildServers(config.servers, guildId);
  let errorMessage;
  if (available.length === 0) {
    errorMessage = 'No Palworld server is configured for this Discord server yet. Ask the bot owner to fill in config/servers.json.';
  } else if (label) {
    errorMessage = `No server named \`${label}\` found for this guild. Available: ${available.map((s) => s.label).join(', ')}.`;
  } else {
    errorMessage = `This guild has multiple servers — specify which one with the \`server\` option: ${available.map((s) => s.label).join(', ')}.`;
  }
  return { ctx: null, errorMessage };
}

// The status channel already auto-creates itself lazily and idempotently
// (statusChannel.js checks for an existing channel before creating). This
// mirrors that: idempotent regardless of how many times or how often it's
// called -- skips creating anything if the guild's botLogChannelId already
// points at a channel that still exists, and self-heals (creates a fresh
// one) if that channel was deleted. Called on every onboardGuild pass
// (including every bot restart, not just "first time seen") specifically
// so it never depends on a fragile one-shot "was this guild new" flag --
// relying on that flag firing exactly once was what let duplicate
// "palworld-logs" channels get created if it ever fired more than once.
async function ensureLogChannel(guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const entry = config.servers.find((s) => s.guildId === guildId);
  if (entry?.botLogChannelId) {
    const existing = await guild.channels.fetch(entry.botLogChannelId).catch(() => null);
    if (existing) return;
  }

  try {
    const created = await guild.channels.create({ name: 'palworld-logs', type: ChannelType.GuildText, reason: 'Palworld bot log channel' });
    mutateGuildEntry(config.serversPath, guildId, (e) => { e.botLogChannelId = created.id; });
    config.servers = loadServersFile(config.serversPath);
  } catch (err) {
    console.error(`Failed to create log channel for guild ${guildId}:`, err.message);
  }
}

async function onboardGuild(guildId, guildName) {
  const added = ensureGuildEntry(config.serversPath, guildId);
  if (added) {
    config.servers = loadServersFile(config.serversPath);
    config.guilds = guildsFromServers(config.servers);
    config.roles = rolesFromServers(config.servers);
    console.log(`Joined "${guildName}" (${guildId}) — added a stub entry to config/servers.json. This guild cannot control any Palworld server until config/servers.json is filled in for it.`);
  }
  await ensureLogChannel(guildId);

  try {
    const data = await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: commandData });
    console.log(`Registered ${data.length} commands in guild ${guildId}.`);
  } catch (err) {
    console.error(`Failed to register commands in guild ${guildId}:`, err.message);
  }
}

// ponytail: watch the directory, not the file directly — editors like nano/vim
// replace the file on save (write temp + rename), which breaks a watch held on
// the original inode. Debounced since a single save can fire multiple events.
function watchConfigFiles() {
  const dir = path.dirname(config.serversPath);
  fs.mkdirSync(dir, { recursive: true });

  const reloaders = {
    [path.basename(config.serversPath)]: () => {
      config.servers = loadServersFile(config.serversPath);
      config.guilds = guildsFromServers(config.servers);
      config.roles = rolesFromServers(config.servers);
    },
  };

  const debounceTimers = {};
  fs.watch(dir, (eventType, filename) => {
    const reload = reloaders[filename];
    if (!reload) return;
    clearTimeout(debounceTimers[filename]);
    debounceTimers[filename] = setTimeout(() => {
      try {
        reload();
        console.log(`Reloaded config/${filename}.`);
      } catch (err) {
        console.error(`Failed to reload config/${filename} (keeping previous values):`, err.message);
      }
    }, 200);
  });
}

watchConfigFiles();

// Catches `pm2 start/stop/restart` run directly (e.g. over SSH) instead of
// through the bot -- Discord never sees those otherwise. expectedActions
// filters out the bot's own pm2 calls (already reported via the normal
// command/audit-log flow) so only genuinely-external actions get flagged.
// Returns full server objects (with guildId attached) so callers can pass
// one straight to notify.serverLog -- not just {guildId, label}.
function findOwningGuildServers(processName) {
  const owners = [];
  for (const entry of config.servers) {
    for (const server of entry.servers) {
      if (server.pm2ProcessName === processName) owners.push({ ...server, guildId: entry.guildId });
    }
  }
  return owners;
}

watchPm2({
  expectedActions,
  onExternalEvent: (processName, eventType) => {
    // PM2 doesn't distinguish a first start from a restart at the event
    // level (see pm2Watcher.js) -- 'restart' covers both, so say so honestly
    // rather than guessing which one it was.
    const verb = eventType === 'restart' ? 'started or restarted' : 'stopped';

    if (processName === BOT_PM2_NAME) {
      const message = {
        event: 'bot.pm2_action',
        process: processName,
        status: verb,
        level: 'warning',
        msg: `Bot process ${processName} was ${verb}`,
      };
      for (const entry of config.guilds) notify.botLog(entry.guildId, message).catch(() => {});
      return;
    }

    for (const server of findOwningGuildServers(processName)) {
      const message = {
        event: 'pm2.external_action',
        server: server.label,
        process: processName,
        status: verb,
        level: 'warning',
        msg: `Server ${server.label} (pm2: ${processName}) was ${verb} externally via pm2`,
      };
      notify.serverLog(server, message).catch(() => {});
    }
  },
});

// Palworld's REST API has no join/leave events -- only a snapshot of who's
// currently online (see playerPoller.js) -- so this polls it and diffs.
// Read-only (GET /v1/api/players), never affects the server or players.
const playerPoller = createPlayerPoller({
  // Agent-routed servers hold no restApiUrl/restApiPassword on the bot
  // side (see agentRegistry.js/agentPalworldClient.js) -- polling them
  // directly here would just fail every cycle. Excluded until a later
  // phase relays player events through the agent instead.
  getServers: () => allCompleteServers(config.servers).filter((s) => !s.agentId).map((s) => ({ ...s, ...resolveServerConnection(s) })),
  createClient: createPalworldClient,
  notify,
});

// Detects a world save that happened outside the bot (autosave, in-game
// console) by watching the save file's mtime -- see saveFileWatcher.js.
// Read-only fs.stat, never touches the file.
const saveFileWatcher = createSaveFileWatcher({
  // Same exclusion as playerPoller/statusChannelManager above -- an
  // agent-routed server's saveFilePath (if any leftover value remains from
  // before it was switched to agent mode) points at a path on someone
  // else's host, not this one.
  getServers: () => allCompleteServers(config.servers).filter((s) => !s.agentId),
  statSync: fs.statSync,
  expectedActions,
  notify,
});

// Live status dashboard channel per server: two auto-updating messages
// (status, players) plus a channel name reflecting online/starting/offline.
// Auto-creates the channel and persists its ID back to servers.json when
// none is configured yet, or the configured one has been deleted. Unlike
// playerPoller/saveFileWatcher, agent-routed servers are NOT excluded here
// -- getInfo/getPlayers/getMetrics all cross the agent connection fine via
// createAgentPalworldClient, so there's no reason this feature shouldn't
// work for them too.
const statusChannelManager = createStatusChannelManager({
  client,
  getGuildGroups: () => config.servers.map((entry) => ({
    guildId: entry.guildId,
    servers: findGuildServers(config.servers, entry.guildId).map((s) => (s.agentId ? s : { ...s, ...resolveServerConnection(s) })),
  })),
  createClient: (server) => (server.agentId
    ? createAgentPalworldClient({ agentRegistry, agentId: server.agentId, serverId: server.serverId })
    : createPalworldClient({ baseUrl: server.restApiUrl, password: server.restApiPassword })),
  serversPath: config.serversPath,
  statePath: path.join(path.dirname(config.auditLogPath), 'statusChannels.json'),
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) {
    await onboardGuild(guild.id, guild.name);
  }
  playerPoller.start();
  saveFileWatcher.start();
  statusChannelManager.start();
  webServer.start();
});

client.on(Events.GuildCreate, (guild) => {
  onboardGuild(guild.id, guild.name);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const focusedName = interaction.options.getFocused(true).name;
    if (focusedName === 'server') {
      await autocompleteServer(interaction, config).catch((err) => console.error('Autocomplete failed:', err.message));
    } else if (focusedName === 'userid') {
      await autocompletePlayers(interaction, config, agentRegistry).catch((err) => console.error('Autocomplete failed:', err.message));
    }
    return;
  }



  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  const member = {
    roleIds: interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [],
    userId: interaction.user.id,
  };

  // Resolved before the permission check now, not after: a server's own
  // owner-set tierGrants (agent-routed servers) decide access for that
  // specific server, taking priority over the guild-wide roles.json check
  // -- so which server a command targets has to be known first. Commands
  // that don't target a server (needsServer === false) have no tierGrants
  // to consult and fall straight to the guild-wide check, same as before.
  let execCtx = baseCtx;
  let server = null;
  if (command.needsServer !== false) {
    const label = interaction.options.getString('server');
    const { ctx, errorMessage } = resolveServerCtx(interaction.guildId, label);
    if (!ctx) {
      await interaction.reply({ ...errorEmbed(errorMessage), ephemeral: true });
      return;
    }
    execCtx = ctx;
    server = ctx.server;
  }

  const tier = server?.tierGrants
    ? resolveTierFromGrants(member, server.tierGrants)
    : resolveTier(member, findGuildRoles(config.roles, interaction.guildId));

  if (command.tier && !hasAccess(tier, command.tier)) {
    await interaction.reply({ ...errorEmbed('You do not have permission to use this command.'), ephemeral: true });
    notify.botLog(interaction.guildId, {
      event: 'auth.access_denied',
      command: interaction.commandName,
      actor: interaction.user.tag,
      actorId: interaction.user.id,
      tier: command.tier,
      level: 'warning',
      msg: `**${interaction.user.tag}** (Discord ID: \`${interaction.user.id}\`) was denied /${interaction.commandName} (no ${command.tier} access)`,
    }).catch(() => {});
    return;
  }

  try {
    await command.execute(interaction, execCtx);
  } catch (err) {
    console.error(`Error executing /${interaction.commandName}:`, err);
    const payload = { ...errorEmbed(`Something went wrong: ${err.message}`), ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
    notify.botLog(interaction.guildId, {
      event: 'command.error',
      command: interaction.commandName,
      actor: interaction.user.tag,
      actorId: interaction.user.id,
      error: err.message,
      level: 'danger',
      msg: `Error executing /${interaction.commandName} for **${interaction.user.tag}** (Discord ID: \`${interaction.user.id}\`): ${err.message}`,
    }).catch(() => {});
  }
});

client.login(config.discordToken);
