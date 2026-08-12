// Tracks "the bot itself just told PM2 to do this" so the pm2-bus watcher
// (src/pm2Watcher.js) can tell a bot-triggered start/stop/restart apart from
// someone running `pm2 restart <name>` by hand over SSH -- the former is
// already reported through the normal command/audit-log flow, only the
// latter needs a separate out-of-band notification.
function createExpectedActions(ttlMs = 8000, now = Date.now) {
  const expiries = new Map();

  return {
    expect(processName) {
      expiries.set(processName, now() + ttlMs);
    },
    wasExpected(processName) {
      const expiry = expiries.get(processName);
      if (expiry === undefined) return false;
      if (now() > expiry) {
        expiries.delete(processName);
        return false;
      }
      expiries.delete(processName);
      return true;
    },
  };
}

module.exports = { createExpectedActions };
