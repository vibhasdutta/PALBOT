// agent/config.js
function loadAgentConfig(env = process.env) {
  return {
    botWsUrl: env.BOT_WS_URL,
    siteHost: env.AGENT_SITE_HOST || '127.0.0.1',
    sitePort: env.AGENT_SITE_PORT || 4300,
    sitePassword: env.AGENT_SITE_PASSWORD,
    siteUsername: env.AGENT_SITE_USERNAME,
  };
}

module.exports = { loadAgentConfig };
