// agent/config.js
function loadAgentConfig(env = process.env) {
  return { botWsUrl: env.BOT_WS_URL };
}

module.exports = { loadAgentConfig };
