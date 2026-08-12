const crypto = require('node:crypto');
const express = require('express');
const { ensureState, listServers, addServer, updateServer, removeServer } = require('./state');

const DEFAULT_PORT = 4300;
const DEFAULT_HOST = '127.0.0.1';

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// HTTP Basic Auth -- the browser's own native login prompt, no custom
// login page or session/cookie machinery needed for a small admin tool.
// Only active when a password is actually configured.
function basicAuthMiddleware(password) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const [scheme, encoded] = auth.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const suppliedPassword = decoded.slice(decoded.indexOf(':') + 1);
      if (timingSafeEqual(suppliedPassword, password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Palworld Bot Agent"');
    res.status(401).send('Authentication required.');
  };
}

function renderPage(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Palworld Bot Agent</title>
<style>body{font-family:sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}
table{width:100%;border-collapse:collapse}td,th{padding:.5rem;border-bottom:1px solid #ddd;text-align:left}
input{width:100%;padding:.4rem;margin:.2rem 0;box-sizing:border-box}button{padding:.5rem 1rem}
@media (max-width:480px){body{margin:1rem auto}}</style></head>
<body>${body}</body></html>`;
}

// Always running while the agent is up, not just a first-run wizard --
// owners revisit this anytime at http://<host>:<port> to add/remove
// servers or re-copy the pairing info.
function startSite({ statePath, botWsUrl, onServersChanged, port = DEFAULT_PORT, host = DEFAULT_HOST, password }) {
  const isLocalOnly = host === '127.0.0.1' || host === 'localhost';
  if (!isLocalOnly && !password) {
    // Refuse to start rather than silently serve an unauthenticated admin
    // panel (REST passwords, add/remove servers) on a reachable-from-
    // outside address. This is the whole reason a password exists at all.
    throw new Error(`Refusing to bind the agent site to ${host} without AGENT_SITE_PASSWORD set -- that would be reachable with no login. Set AGENT_SITE_PASSWORD in agent/.env, or leave AGENT_SITE_HOST unset to stay on 127.0.0.1.`);
  }

  const app = express();
  if (password) app.use(basicAuthMiddleware(password));
  app.use(express.urlencoded({ extended: true }));

  app.get('/', (req, res) => {
    const state = ensureState(statePath);
    const rows = state.servers.map((s) => `<tr>
      <td>${s.label}</td><td>${s.serverId}</td>
      <td><a href="/servers/${s.serverId}/edit">Edit</a></td>
      <td><form method="post" action="/servers/${s.serverId}/delete"><button>Remove</button></form></td>
    </tr>`).join('');
    res.send(renderPage(`
      <h1>Palworld Bot Agent</h1>
      <p>Paste these into the bot's dashboard to pair this agent:</p>
      <p><b>Agent ID:</b> <code>${state.agentId}</code></p>
      <p><b>Agent Token:</b> <code>${state.agentToken}</code></p>
      <p><b>Bot URL:</b> <code>${botWsUrl}</code></p>
      <h2>Registered servers</h2>
      <table><tr><th>Label</th><th>Server ID</th><th></th><th></th></tr>${rows}</table>
      <h2>Add a server</h2>
      <form method="post" action="/servers">
        <label>Label<input name="label" required></label>
        <label>Palworld REST URL<input name="restApiUrl" placeholder="http://localhost:8212"></label>
        <label>Admin password<input name="restApiPassword" type="password"></label>
        <label>pm2 process name<input name="pm2ProcessName"></label>
        <label>Save file path<input name="saveFilePath"></label>
        <label>Settings (ini) file path<input name="settingsFilePath"></label>
        <button type="submit">Add server</button>
      </form>
    `));
  });

  app.get('/servers/:id/edit', (req, res) => {
    const server = ensureState(statePath).servers.find((s) => s.serverId === req.params.id);
    if (!server) return res.status(404).send(renderPage('<p>Server not found. <a href="/">Back</a></p>'));

    const field = (name, label, type = 'text') => `<label>${label}<input name="${name}" type="${type}" value="${server[name] || ''}"></label>`;
    res.send(renderPage(`
      <h1>Edit ${server.label}</h1>
      <form method="post" action="/servers/${server.serverId}/edit">
        ${field('label', 'Label')}
        ${field('restApiUrl', 'Palworld REST URL')}
        ${field('restApiPassword', 'Admin password', 'password')}
        ${field('pm2ProcessName', 'pm2 process name')}
        ${field('saveFilePath', 'Save file path')}
        ${field('settingsFilePath', 'Settings (ini) file path')}
        <button type="submit">Save</button>
      </form>
      <p><a href="/">Back</a></p>
    `));
  });

  app.post('/servers', (req, res) => {
    addServer(statePath, req.body);
    onServersChanged();
    res.redirect('/');
  });

  app.post('/servers/:id/edit', (req, res) => {
    updateServer(statePath, req.params.id, req.body);
    onServersChanged();
    res.redirect('/');
  });

  app.post('/servers/:id/delete', (req, res) => {
    removeServer(statePath, req.params.id);
    onServersChanged();
    res.redirect('/');
  });

  // ponytail: for the default 127.0.0.1 case specifically, the literal
  // address is used rather than the 'localhost' hostname -- on Windows,
  // resolving 'localhost' can prefer ::1 (IPv6) while a client's fetch
  // resolves it to 127.0.0.1 (or vice versa), leaving the two sides trying
  // to reach different addresses and hanging instead of erroring. A
  // caller-supplied host (0.0.0.0, a public IP, etc.) is used as given.
  return app.listen(port, host, () => {
    const actualPort = typeof port === 'number' && port !== 0 ? port : undefined;
    if (actualPort) console.log(`agent: local site at http://${host}:${actualPort}${password ? ' (password required)' : ''}`);
  });
}

module.exports = { startSite };
