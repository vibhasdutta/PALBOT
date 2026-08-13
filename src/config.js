const fs = require('node:fs');
const path = require('node:path');

function normalizeTier(tier) {
  return {
    roleIds: Array.isArray(tier?.roleIds) ? tier.roleIds : [],
    userIds: Array.isArray(tier?.userIds) ? tier.userIds : [],
  };
}

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

function writeJsonArray(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

function normalizeRoles(roles) {
  return {
    admin: normalizeTier(roles?.admin),
    operator: normalizeTier(roles?.operator),
    common: normalizeTier(roles?.common),
  };
}

// guilds.json and roles.json used to be separate files, each duplicating
// the same "one entry per guild" shape servers.json already has. Now
// there's just servers.json, and these two derive the same flat shapes
// findGuildRoles()/the pm2-restart-broadcast loop already expect, so
// nothing downstream of loadConfig() has to change.
function guildsFromServers(servers) {
  return servers.map((s) => ({ guildId: s.guildId }));
}

function rolesFromServers(servers) {
  return servers.map((s) => ({ guildId: s.guildId, ...s.roles }));
}

// Each guild's Palworld connection(s) -- a guild can list zero, one, or many
// servers, each identified by a short `label`. A guild with no complete
// server entries is structurally incapable of controlling anything,
// regardless of what roles.json grants -- this is the multi-tenancy
// boundary, not just an allowlist bolted on top.
function normalizeServer(server) {
  return {
    label: server.label || null,
    restApiUrl: server.restApiUrl || null,
    restApiPassword: server.restApiPassword || null,
    pm2ProcessName: server.pm2ProcessName || null,
    // Optional: absolute path to this server's Level.sav on disk. Palworld's
    // REST API has no "was just saved" signal, so detecting an autosave or
    // in-game save (as opposed to one triggered through /save) means
    // watching the save file's mtime instead -- only possible if we know
    // where it is. Leave unset to skip that detection for this server.
    saveFilePath: server.saveFilePath || null,
    // Optional: absolute path to this server's PalWorldSettings.ini. When
    // set, restApiUrl/restApiPassword above are ignored in favor of reading
    // AdminPassword and RESTAPIPort straight from the ini on every use (see
    // resolveServerConnection) -- the ini is the game's own source of truth
    // for that password, so it can never drift out of sync with a copy
    // pasted into servers.json again.
    settingsFilePath: server.settingsFilePath || null,
    // Set together when this server is controlled through a remote agent
    // (see agentRegistry.js) instead of the bot's own local pm2/REST
    // access. The secret token lives only in data/agents.json
    // (agentStore.js) now, keyed by agentId -- never here, since one
    // server can appear in several guilds' entries and the token must
    // only ever be stored once. tierGrants (admin/operator/mod, by role or
    // user ID) decides who in this guild can act on this server; it's the
    // server owner's decision, set from the dashboard, not the guild's
    // roles.json.
    agentId: server.agentId || null,
    serverId: server.serverId || null,
    tierGrants: server.tierGrants || null,
    // Set by statusChannel.js/webServer.js. null means "not assigned yet" --
    // the dashboard's "+ Create" button is the only thing that sets this
    // (see statusRow in site/app.js); there's no automatic fallback.
    statusChannelId: server.statusChannelId || null,
  };
}

function loadServersFile(serversPath) {
  return readJsonArray(serversPath).map((entry) => ({
    guildId: entry.guildId,
    // One shared live-status dashboard channel per guild (not per server) --
    // it holds a status+players message pair for every server the guild
    // owns. Left unset, statusChannel.js creates one itself and writes the
    // resulting ID back here via mutateGuildEntry -- the human only ever
    // needs to *edit* this to point at a different existing channel.
    statusChannelId: entry.statusChannelId || null,
    // Every log event for every server in this guild -- bot-wide events
    // (restart, access denials, /operator grants) and per-server events
    // alike -- goes to this one auto-created channel (see ensureLogChannel
    // in index.js). No per-server override; one channel per guild, always.
    botLogChannelId: entry.botLogChannelId || null,
    // The Discord category (channel folder) this guild's status channels
    // get organized under, if any. Set via the dashboard's "Status
    // Category" picker (see webServer.js's guilds POST handler) -- purely
    // cosmetic grouping, statusChannel.js doesn't read this itself.
    categoryId: entry.categoryId || null,
    // Guild-wide admin/operator/common role grants (was roles.json) -- the
    // fallback tier check for commands that don't target a specific server,
    // and what /operator manages.
    roles: normalizeRoles(entry.roles),
    servers: Array.isArray(entry.servers) ? entry.servers.map(normalizeServer) : [],
  }));
}

function isCompleteServer(server) {
  if (!server?.label) return false;
  if (server.agentId && server.serverId) return true;
  if (!server.pm2ProcessName) return false;
  // Either a direct restApiUrl/restApiPassword pair, or a settingsFilePath
  // to derive them from -- resolveServerConnection() handles the latter.
  return Boolean(server.settingsFilePath || (server.restApiUrl && server.restApiPassword));
}

// Palworld packs everything into one line: OptionSettings=(key=val,...).
// Pulling just AdminPassword/RESTAPIPort with a targeted regex (rather than
// fully parsing that line) avoids the risk of a hand-rolled parser mangling
// a value it doesn't need to touch -- see the design spec's note on why a
// generic settings editor was deliberately not built.
function readIniOptionSettings(iniPath, readFileSync = fs.readFileSync) {
  let content;
  try {
    content = readFileSync(iniPath, 'utf8');
  } catch {
    return null;
  }
  return {
    restApiPassword: content.match(/AdminPassword="([^"]*)"/)?.[1] ?? null,
    restApiPort: content.match(/RESTAPIPort=(\d+)/)?.[1] ?? null,
  };
}

// Resolves the actual restApiUrl/restApiPassword to connect with. If
// settingsFilePath is set, these are read fresh from the live ini every
// call instead of trusting a (possibly stale) copy in servers.json.
function resolveServerConnection(server, readFileSync = fs.readFileSync) {
  const fallback = { restApiUrl: server.restApiUrl, restApiPassword: server.restApiPassword };
  if (!server.settingsFilePath) return fallback;

  const live = readIniOptionSettings(server.settingsFilePath, readFileSync);
  if (!live) return fallback;

  return {
    restApiUrl: live.restApiPort ? `http://localhost:${live.restApiPort}` : fallback.restApiUrl,
    restApiPassword: live.restApiPassword,
  };
}

// Every complete (fully-configured) server for a guild -- what /status etc.
// offer as autocomplete choices for the `server` option.
function findGuildServers(servers, guildId) {
  const entry = servers.find((s) => s.guildId === guildId);
  return entry ? entry.servers.filter(isCompleteServer) : [];
}

// Every complete server across every guild, flattened, with its owning
// guildId attached -- what the player-join/leave poller iterates over.
function allCompleteServers(servers) {
  const flat = [];
  for (const entry of servers) {
    for (const server of entry.servers.filter(isCompleteServer)) {
      flat.push({ guildId: entry.guildId, ...server });
    }
  }
  return flat;
}

// Every guild entry (across all guilds) that references a given
// agentId+serverId pair -- what the dashboard's "which guilds is this
// server granted to" view is built from. A server can be granted to more
// than one guild, each with its own tierGrants.
function findEntriesByServer(servers, agentId, serverId) {
  const matches = [];
  for (const entry of servers) {
    if (entry.servers.some((s) => s.agentId === agentId && s.serverId === serverId)) {
      matches.push(entry);
    }
  }
  return matches;
}

// Resolves which single server a command should act on.
// - No label given + exactly one server configured -> that one (the common
//   case: most guilds only ever have one server, no need to specify it).
// - No label given + zero or multiple servers -> null (ambiguous or
//   unconfigured; the caller decides how to explain that).
// - Label given -> that specific server, or null if no match.
function findGuildServer(servers, guildId, label) {
  const available = findGuildServers(servers, guildId);
  if (label) return available.find((s) => s.label === label) || null;
  return available.length === 1 ? available[0] : null;
}

const EMPTY_ROLES = () => ({ admin: { roleIds: [], userIds: [] }, operator: { roleIds: [], userIds: [] }, common: { roleIds: [], userIds: [] } });

// Registers a newly-seen guild in servers.json with empty/no-op defaults
// (no roles granted, no server to control) so the human only ever has to
// *edit* values, never create the entry by hand. Returns true the first
// time a guild is seen, false on every call after.
function ensureGuildEntry(serversPath, guildId) {
  const servers = readJsonArray(serversPath);
  // ponytail: temporary diagnostic for a data-loss bug, see matching note
  // in src/index.js. Remove once the root cause is confirmed.
  console.log(`[diag] ensureGuildEntry guildId=${guildId} serversPath=${serversPath} readCount=${servers.length} match=${servers.some((s) => s.guildId === guildId)}`);
  if (servers.some((s) => s.guildId === guildId)) return false;

  writeJsonArray(serversPath, [...servers, { guildId, statusChannelId: null, botLogChannelId: null, roles: EMPTY_ROLES(), servers: [] }]);
  return true;
}

// Reads servers.json, applies `mutate` to one guild's roles sub-object --
// creating both the guild entry and its roles with empty defaults first if
// either is somehow missing -- and writes the result straight back. Used
// by the /operator command so admins can grant/revoke access from Discord
// instead of hand-editing config/servers.json. `mutate` receives the flat
// {admin, operator, common} shape directly, same as when this read from a
// separate roles.json.
function mutateGuildRoles(serversPath, guildId, mutate) {
  const servers = readJsonArray(serversPath);
  let entry = servers.find((s) => s.guildId === guildId);
  if (!entry) {
    entry = { guildId, statusChannelId: null, botLogChannelId: null, roles: EMPTY_ROLES(), servers: [] };
    servers.push(entry);
  }
  if (!entry.roles) entry.roles = EMPTY_ROLES();
  mutate(entry.roles);
  writeJsonArray(serversPath, servers);
  return entry.roles;
}

// Reads servers.json, applies `mutate` to one guild's top-level entry, and
// writes the result straight back. Used by statusChannel.js to persist an
// auto-created status channel's ID without hand-editing the file. Unlike
// mutateGuildRoles, this doesn't create missing entries -- a guild must
// already be registered (via ensureGuildEntry) first.
function mutateGuildEntry(serversPath, guildId, mutate) {
  const servers = readJsonArray(serversPath);
  const entry = servers.find((s) => s.guildId === guildId);
  if (!entry) return null;
  mutate(entry);
  writeJsonArray(serversPath, servers);
  return entry;
}

// Same idea as mutateGuildEntry, but reaches one level deeper into a
// specific server within a specific guild's `servers` array. Used by
// statusChannel.js to persist an auto-created channel ID onto the right
// server instead of the guild. Requires both the guild and the server
// (by label) to already exist.
function mutateServerEntry(serversPath, guildId, label, mutate) {
  const servers = readJsonArray(serversPath);
  const entry = servers.find((s) => s.guildId === guildId);
  if (!entry) return null;
  const server = entry.servers.find((s) => s.label === label);
  if (!server) return null;
  mutate(server);
  writeJsonArray(serversPath, servers);
  return server;
}

function loadConfig(env = process.env) {
  const configDir = env.CONFIG_DIR || path.join(__dirname, '..', 'config');
  const serversPath = env.SERVERS_CONFIG_PATH || path.join(configDir, 'servers.json');
  const agentsPath = env.AGENTS_STORE_PATH || path.join(__dirname, '..', 'data', 'agents.json');

  const servers = loadServersFile(serversPath);

  return {
    discordToken: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    auditLogPath: env.AUDIT_LOG_PATH || path.join(__dirname, '..', 'data', 'audit-log.json'),
    serversPath,
    agentsPath,
    guilds: guildsFromServers(servers),
    roles: rolesFromServers(servers),
    servers,
  };
}

module.exports = {
  loadConfig,
  loadServersFile,
  guildsFromServers,
  rolesFromServers,
  findGuildServer,
  findGuildServers,
  allCompleteServers,
  findEntriesByServer,
  readIniOptionSettings,
  resolveServerConnection,
  ensureGuildEntry,
  mutateGuildRoles,
  mutateGuildEntry,
  mutateServerEntry,
};
