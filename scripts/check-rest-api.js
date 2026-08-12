const { loadConfig, findGuildServer, findGuildServers, resolveServerConnection } = require('../src/config');
const { createPalworldClient } = require('../src/palworldClient');

const guildId = process.argv[2];
const label = process.argv[3];
if (!guildId) {
  console.error('Usage: node scripts/check-rest-api.js <guildId> [label]');
  console.error('(each guild can have several servers in config/servers.json — pass a label if it has more than one)');
  process.exit(1);
}

(async () => {
  const config = loadConfig();
  const server = findGuildServer(config.servers, guildId, label);
  if (!server) {
    const available = findGuildServers(config.servers, guildId);
    if (available.length === 0) {
      console.error(`No server configured for guild ${guildId} in config/servers.json.`);
    } else if (label) {
      console.error(`No server named "${label}" for guild ${guildId}. Available: ${available.map((s) => s.label).join(', ')}`);
    } else {
      console.error(`Guild ${guildId} has multiple servers — pass a label. Available: ${available.map((s) => s.label).join(', ')}`);
    }
    process.exit(1);
  }

  const { restApiUrl, restApiPassword } = resolveServerConnection(server);
  const client = createPalworldClient({ baseUrl: restApiUrl, password: restApiPassword });
  const info = await client.getInfo();
  console.log(`Connected to Palworld REST API for guild ${guildId} (server "${server.label}"):`, info);
})();
