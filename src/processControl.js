const { execFile } = require('node:child_process');

const ALLOWED_ACTIONS = ['start', 'stop', 'restart'];

function runPm2(pm2Name, action, execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl('pm2', [action, pm2Name], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`pm2 ${action} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// pm2's native `restart` reloads the process in place. For the game server
// we want a real full exit between the two so PalServer doesn't get torn
// down mid-reload -- explicit stop then start instead.
async function controlService(pm2Name, action, execFileImpl = execFile) {
  if (!ALLOWED_ACTIONS.includes(action)) {
    return Promise.reject(new Error(`Unsupported pm2 action: ${action}`));
  }
  if (action === 'restart') {
    await runPm2(pm2Name, 'stop', execFileImpl);
    return runPm2(pm2Name, 'start', execFileImpl);
  }
  return runPm2(pm2Name, action, execFileImpl);
}

module.exports = { controlService, ALLOWED_ACTIONS };
