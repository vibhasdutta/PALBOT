const fs = require('node:fs');
const path = require('node:path');

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8').trim();
  return raw ? JSON.parse(raw) : [];
}

function appendAuditEntry(logPath, entry) {
  const log = readLog(logPath);
  log.push({ timestamp: new Date().toISOString(), ...entry });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  return log;
}

module.exports = { appendAuditEntry, readLog };
