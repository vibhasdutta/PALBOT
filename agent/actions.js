const { readWorldSettings: readWorldSettingsDefault, writeWorldSettings: writeWorldSettingsDefault } = require('../src/worldSettingsParser');

// One entry per protocol action name the bot's agentRegistry can send.
// Every handler takes (serverId, args) -- resolveServer(serverId) looks up
// which of this agent's locally-registered servers to act against, since
// one agent connection now serves many servers over the same socket (see
// agent/state.js). readWorldSettings/writeWorldSettings are injectable for
// testing, defaulting to the real, already-tested worldSettingsParser.js
// (reused from the bot's own src/, not rebuilt).
function createActionHandlers({
  resolveServer,
  controlService,
  readWorldSettings = readWorldSettingsDefault,
  writeWorldSettings = writeWorldSettingsDefault,
}) {
  function requireServer(serverId) {
    const server = resolveServer(serverId);
    if (!server) throw new Error(`Unknown serverId: ${serverId}`);
    return server;
  }

  return {
    // async on every handler matters, not just style: requireServer throws
    // synchronously on an unknown serverId, and without async that throw
    // would escape as a raw exception instead of a rejected promise --
    // agent/index.js's handleCommand (and every test here) expects a
    // promise it can await/catch either way.
    getInfo: async (serverId) => requireServer(serverId).palworld.getInfo(),
    getPlayers: async (serverId) => requireServer(serverId).palworld.getPlayers(),
    getMetrics: async (serverId) => requireServer(serverId).palworld.getMetrics(),
    announce: async (serverId, { message }) => requireServer(serverId).palworld.announce(message),
    kick: async (serverId, { userid, message }) => requireServer(serverId).palworld.kick(userid, message),
    ban: async (serverId, { userid, message }) => requireServer(serverId).palworld.ban(userid, message),
    unban: async (serverId, { userid }) => requireServer(serverId).palworld.unban(userid),
    save: async (serverId) => requireServer(serverId).palworld.save(),
    shutdown: async (serverId, { waittime, message }) => requireServer(serverId).palworld.shutdown(waittime, message),
    stop: async (serverId) => requireServer(serverId).palworld.stop(),
    // No agentPalworldClient.js counterpart -- that pack site lives directly
    // in index.js's resolveServerCtx, not in a client-shaped module. Only
    // `action` crosses the wire on purpose: the process name always comes
    // from this agent's own local pm2ProcessName, never from the bot side,
    // so a compromised/malicious command can't target an arbitrary process.
    controlService: async (serverId, { action }) => controlService(requireServer(serverId).pm2ProcessName, action),
    getSettings: async (serverId) => {
      const server = requireServer(serverId);
      if (!server.settingsFilePath) throw new Error('No settingsFilePath configured for this server');
      const { settings, exists } = readWorldSettings(server.settingsFilePath);
      return { settings: Object.fromEntries(settings), exists };
    },
    setSettings: async (serverId, { settings }) => {
      const server = requireServer(serverId);
      if (!server.settingsFilePath) throw new Error('No settingsFilePath configured for this server');
      const ok = writeWorldSettings(server.settingsFilePath, new Map(Object.entries(settings)));
      if (!ok) throw new Error('Failed to write settings file');
      return { ok: true };
    },
  };
}

module.exports = { createActionHandlers };
