// Prevents overlapping start/stop/restart commands for the same server --
// e.g. someone hitting /restart twice in a row while the first is still
// mid-countdown. Keyed by whatever the caller supplies (guildId + label),
// not pm2ProcessName, since agent-routed servers don't expose one to the
// bot.
function createActionLock() {
  const inFlight = new Map(); // key -> action name currently running

  return {
    // Returns the action already in flight for this key, or null if the
    // key was free and is now held by `action`.
    tryAcquire(key, action) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      inFlight.set(key, action);
      return null;
    },
    release(key) {
      inFlight.delete(key);
    },
  };
}

module.exports = { createActionLock };
