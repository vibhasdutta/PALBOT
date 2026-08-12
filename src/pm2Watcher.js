const pm2 = require('pm2');

// PM2 fires BOTH 'online' and 'restart' for a single restart -- and even a
// plain `pm2 start` on a stopped process fires 'restart' too (PM2 doesn't
// distinguish "first start" from "restart" at the event-bus level, it always
// goes through the same internal restart path). Watching only 'restart' and
// 'stop' means exactly one event per real action instead of two.
const WATCHED_EVENTS = new Set(['stop', 'restart']);

// Listens on PM2's own event bus for start/stop/restart of any process --
// this fires no matter how it happened (bot-triggered `pm2 restart` call, or
// someone running `pm2 stop palworld` by hand over SSH). `expectedActions`
// filters out the former since that's already reported through the normal
// command/audit-log flow; only genuinely-external events reach `onExternalEvent`.
//
// ponytail: runs inside the bot's own long-lived process rather than as a
// separate watcher process -- simplest option, and reliable for observing
// the *Palworld* process's lifecycle since the bot stays up independently of
// it. The one gap: if the bot's own process is killed externally, there's
// only a best-effort window to report that before the process actually
// dies. A fully robust version would run as its own always-on PM2 app.
function watchPm2({ expectedActions, onExternalEvent }) {
  pm2.connect((err) => {
    if (err) {
      console.error('pm2Watcher: failed to connect to the PM2 daemon:', err.message);
      return;
    }
    pm2.launchBus((busErr, bus) => {
      if (busErr) {
        console.error('pm2Watcher: failed to launch the PM2 event bus:', busErr.message);
        return;
      }
      bus.on('process:event', (packet) => {
        const name = packet.process?.name;
        const eventType = packet.event;
        if (!name || !WATCHED_EVENTS.has(eventType)) return;
        if (expectedActions.wasExpected(name)) return;
        onExternalEvent(name, eventType);
      });
    });
  });
}

module.exports = { watchPm2 };
