// Three independent pm2 apps -- start/stop/restart whichever one you
// actually need (`pm2 start ecosystem.config.js --only palworld-agent`,
// etc.) rather than all three together:
//   palworld       -- the Palworld game server itself ("world")
//   palworld-bot   -- the Discord bot (central control plane)
//   palworld-agent -- the remote agent, for a server registered through
//                     the agent/dashboard flow rather than the bot's own
//                     local config/servers.json. Not needed if this host
//                     only ever runs "server #1" the old way.
//
// palworld-bot/palworld-agent paths are derived from this file's own
// location (repoRoot), not hardcoded -- this file previously hardcoded
// /home/morfit/palworld-bot, which silently broke once the checkout moved
// to /home/morfit/PALBOT. Deriving them means that class of bug can't
// recur regardless of where the repo ends up checked out. palworld's own
// paths stay hardcoded since PalServer lives in a separate install
// directory, not inside this repo.
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

module.exports = {
  apps: [
    {
      // Every bot operator's PalServer install lives somewhere different --
      // this is a placeholder, not a real path. Edit both lines below to
      // point at your own install before deploying "palworld".
      // deploy.mjs refuses to start this app while the path is still the
      // example one, so leaving it unedited fails with a clear message
      // instead of a confusing pm2 error.
      name: 'palworld',
      script: '/path/to/your/palworld/PalServer.sh',
      interpreter: 'bash',
      cwd: '/path/to/your/palworld',
      autorestart: false,
      max_restarts: 10,
    },
    {
      name: 'palworld-bot',
      script: path.join(repoRoot, 'src', 'index.js'),
      cwd: repoRoot,
      node_args: '--env-file=.env',
      autorestart: true,
      max_memory_restart: '250M',
    },
    {
      name: 'palworld-agent',
      script: path.join(repoRoot, 'agent', 'index.js'),
      cwd: path.join(repoRoot, 'agent'),
      node_args: '--env-file=.env',
      autorestart: true,
      max_memory_restart: '250M',
    },
  ],
};
