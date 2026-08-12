// Same method set as createPalworldClient (palworldClient.js), so
// resolveServerCtx (index.js) can hand either one to a command handler
// interchangeably. Each method just shapes its args and forwards to
// agentRegistry.sendCommand -- the agent (agent/actions.js) unpacks them
// the same way and calls the real palworldClient locally.
const { PalworldApiError } = require('./palworldClient');

function createAgentPalworldClient({ agentRegistry, agentId, serverId }) {
  // restart.js/stop.js branch on `err instanceof PalworldApiError`
  // specifically (REST-unreachable is an expected case for them) -- an
  // errorType-tagged rejection from agentRegistry gets reconstructed here
  // so that check still works for agent-routed servers, not just local
  // ones.
  const call = async (action, args = {}) => {
    try {
      return await agentRegistry.sendCommand(agentId, serverId, action, args);
    } catch (err) {
      if (err.errorType === 'PalworldApiError') throw new PalworldApiError(err.message);
      throw err;
    }
  };

  return {
    getInfo: () => call('getInfo'),
    getPlayers: () => call('getPlayers'),
    getMetrics: () => call('getMetrics'),
    announce: (message) => call('announce', { message }),
    kick: (userid, message) => call('kick', { userid, message }),
    ban: (userid, message) => call('ban', { userid, message }),
    unban: (userid) => call('unban', { userid }),
    save: () => call('save'),
    shutdown: (waittime, message) => call('shutdown', { waittime, message }),
    stop: () => call('stop'),
  };
}

module.exports = { createAgentPalworldClient };
