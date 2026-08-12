// Three independent pm2 apps -- start/stop/restart whichever one you
// actually need (`pm2 start ecosystem.config.js --only palworld-agent`,
// etc.) rather than all three together:
//   palworld       -- the Palworld game server itself ("world")
//   palworld-bot   -- the Discord bot (central control plane)
//   palworld-agent -- the remote agent, for a server registered through
//                     the agent/dashboard flow rather than the bot's own
//                     local config/servers.json. Not needed if this host
//                     only ever runs "server #1" the old way.
module.exports = {
  apps: [
    {
      name: 'palworld',
      script: '/home/morfit/palworld/PalServer.sh',
      interpreter: 'bash',
      cwd: '/home/morfit/palworld',
      autorestart: false,
      max_restarts: 10,
    },
    {
      name: 'palworld-bot',
      script: '/home/morfit/palworld-bot/src/index.js',
      cwd: '/home/morfit/palworld-bot',
      node_args: '--env-file=.env',
      autorestart: true,
      max_memory_restart: '250M',
    },
    {
      name: 'palworld-agent',
      script: '/home/morfit/palworld-bot/agent/index.js',
      cwd: '/home/morfit/palworld-bot/agent',
      node_args: '--env-file=.env',
      autorestart: true,
      max_memory_restart: '250M',
    },
  ],
};
