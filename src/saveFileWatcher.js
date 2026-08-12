// Palworld's REST API has no "world was just saved" signal -- only /save,
// which triggers one but doesn't confirm it, and no endpoint reports when
// the last save happened. Since the bot runs on the same machine as the
// server, watching the actual save file's mtime on disk catches saves
// however they happen: autosave (AutoSaveSpan), an in-game/console save, or
// our own /save. `expectedActions` (shared with pm2Watcher, keyed
// `save:${guildId}:${label}` to not collide with its pm2-process-name keys)
// filters out the ones the bot itself just triggered.
const fs = require('node:fs');
const path = require('node:path');

function resolveSaveFilePath(saveFilePath) {
  if (!saveFilePath) return null;
  if (fs.existsSync(saveFilePath)) return saveFilePath;

  try {
    const parentDir = path.dirname(path.dirname(saveFilePath));
    if (fs.existsSync(parentDir)) {
      const subdirs = fs.readdirSync(parentDir);
      for (const subdir of subdirs) {
        const candidate = path.join(parentDir, subdir, 'Level.sav');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}

  return saveFilePath;
}

function createSaveFileWatcher({ getServers, statSync = fs.statSync, expectedActions, notify, intervalMs = 15000 }) {
  const known = new Map(); // `${guildId}:${label}` -> last mtimeMs

  function pollOnce() {
    const servers = getServers().filter((s) => s.saveFilePath);
    const activeKeys = new Set();

    for (const server of servers) {
      const key = `${server.guildId}:${server.label}`;
      activeKeys.add(key);

      const targetPath = resolveSaveFilePath(server.saveFilePath);
      let mtimeMs;
      try {
        mtimeMs = statSync(targetPath).mtimeMs;
      } catch {
        continue; // file missing / transient read error this cycle -- skip
      }

      const previous = known.get(key);
      const isFirstPoll = previous === undefined;
      if (!isFirstPoll && mtimeMs > previous && !expectedActions.wasExpected(`save:${key}`)) {
        notify.serverLog(server.guildId, {
          event: 'server.save',
          server: server.label,
          trigger: 'autosave_or_ingame',
          level: 'info',
          msg: `World saved on ${server.label}`,
        }).catch(() => {});
      }
      known.set(key, mtimeMs);
    }

    for (const key of known.keys()) {
      if (!activeKeys.has(key)) known.delete(key);
    }
  }

  function start() {
    pollOnce();
    return setInterval(pollOnce, intervalMs);
  }

  return { start, pollOnce };
}

module.exports = { createSaveFileWatcher, resolveSaveFilePath };
