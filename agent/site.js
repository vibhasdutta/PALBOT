const crypto = require('node:crypto');
const express = require('express');
const { ensureState, listServers, addServer, updateServer, removeServer } = require('./state');
const { detectLocalServers } = require('./detector');

const DEFAULT_PORT = process.env.AGENT_SITE_PORT || 4300;
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
function basicAuthMiddleware(password, username) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const [scheme, encoded] = auth.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      const suppliedUser = decoded.slice(0, colonIdx);
      const suppliedPassword = decoded.slice(colonIdx + 1);
      const passwordMatch = timingSafeEqual(suppliedPassword, password);
      const userMatch = !username || timingSafeEqual(suppliedUser, username);
      if (passwordMatch && userMatch) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Palworld Bot Agent"');
    res.status(401).send('Authentication required.');
  };
}

function renderPage(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Palworld Bot Agent</title>
<style>
:root{--cah-black:#000000;--cah-white:#ffffff;--cah-red:#fe2f2f;--cah-violet:#7333f1;--cah-gold:#d7b73b;--cah-surface:#121212;--cah-muted:rgba(255,255,255,0.55)}
*,*::before,*::after{box-sizing:border-box}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:var(--cah-black);color:var(--cah-white);max-width:720px;margin:2rem auto;padding:0 1rem}
h1{font-weight:800}
h2{font-weight:800;font-size:1.1rem;margin-top:2rem}
p{color:var(--cah-muted)}
code{color:var(--cah-white);background:var(--cah-surface);border:2px solid var(--cah-white);border-radius:8px;padding:0.1rem 0.4rem}
a{color:var(--cah-violet);font-weight:700}
table{width:100%;border-collapse:collapse}
td,th{padding:.6rem;border-bottom:2px solid var(--cah-surface);text-align:left}
th{color:var(--cah-muted);font-size:0.8rem;text-transform:uppercase;letter-spacing:0.03em;font-weight:800}
label{display:block;font-size:.75rem;color:var(--cah-muted);font-weight:800;text-transform:uppercase;letter-spacing:0.03em;margin-top:0.75rem}
input{width:100%;padding:.6rem .9rem;margin:.2rem 0;box-sizing:border-box;background:var(--cah-black);border:2px solid var(--cah-white);border-radius:38px;color:var(--cah-white);font-family:inherit}
input:focus{outline:none;border-color:var(--cah-violet)}
button{padding:.5rem 1.1rem;cursor:pointer;border:2px solid var(--cah-white);background:transparent;color:var(--cah-white);border-radius:38px;font-family:inherit;font-weight:800;font-size:0.85rem}
button:hover{background:var(--cah-white);color:var(--cah-black)}
.btn-detect{border-color:var(--cah-violet);color:var(--cah-violet);margin-bottom:1rem}
.btn-detect:hover{background:var(--cah-violet);color:var(--cah-white)}
.banner{padding:.6rem .9rem;margin:.5rem 0;border-radius:13px;font-size:.9rem;font-weight:700;background:var(--cah-black)}
.banner-info{border:2px solid var(--cah-gold);color:var(--cah-white)}
.banner-warn{border:2px solid var(--cah-red);color:var(--cah-white)}
@media (max-width:480px){body{margin:1rem auto}}</style></head>
<body>${body}</body></html>`;
}

// Always running while the agent is up, not just a first-run wizard --
// owners revisit this anytime at http://<host>:<port> to add/remove
// servers or re-copy the pairing info.
function startSite({ statePath, botWsUrl, onServersChanged, port = DEFAULT_PORT, host = DEFAULT_HOST, password, username }) {
  const isLocalOnly = host === '127.0.0.1' || host === 'localhost';
  if (!isLocalOnly && !password) {
    // Refuse to start rather than silently serve an unauthenticated admin
    // panel (REST passwords, add/remove servers) on a reachable-from-
    // outside address. This is the whole reason a password exists at all.
    throw new Error(`Refusing to bind the agent site to ${host} without AGENT_SITE_PASSWORD set -- that would be reachable with no login. Set AGENT_SITE_PASSWORD in agent/.env, or leave AGENT_SITE_HOST unset to stay on 127.0.0.1.`);
  }

  const app = express();
  if (password) app.use(basicAuthMiddleware(password, username));
  app.use(express.urlencoded({ extended: true }));

  app.get('/detect', (req, res) => {
    const state = ensureState(statePath);
    const registered = state.servers || [];
    const allDetected = detectLocalServers();
    const detected = allDetected.filter((d) => {
      return !registered.some((r) => {
        if (d.settingsFilePath && r.settingsFilePath && d.settingsFilePath === r.settingsFilePath) return true;
        if (d.restApiUrl && r.restApiUrl && d.restApiUrl === r.restApiUrl) return true;
        if (d.pm2ProcessName && r.pm2ProcessName && d.pm2ProcessName === r.pm2ProcessName) return true;
        return false;
      });
    });
    res.json({
      success: true,
      detected,
      alreadyRegisteredCount: allDetected.length - detected.length,
    });
  });

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
      <button type="button" class="btn-detect" id="btnDetect">🔍 Auto-Detect Local Server</button>
      <div id="detectMsg"></div>
      <form method="post" action="/servers" id="addForm">
        <label>Label<input name="label" id="inputLabel" value="main" required></label>
        <label>Palworld REST URL<input name="restApiUrl" id="inputRestApiUrl" placeholder="http://localhost:8212"></label>
        <label>Admin password<input name="restApiPassword" id="inputRestApiPassword" type="password"></label>
        <label>pm2 process name<input name="pm2ProcessName" id="inputPm2ProcessName"></label>
        <label>Save file path<input name="saveFilePath" id="inputSaveFilePath"></label>
        <label>Settings (ini) file path<input name="settingsFilePath" id="inputSettingsFilePath"></label>
        <button type="submit">Add server</button>
      </form>
      <script>
      let detectedServers = [];
      function applyServer(server) {
        if (!server) return;
        if (server.label) document.getElementById('inputLabel').value = server.label;
        if (server.restApiUrl) document.getElementById('inputRestApiUrl').value = server.restApiUrl;
        if (server.restApiPassword) document.getElementById('inputRestApiPassword').value = server.restApiPassword;
        if (server.pm2ProcessName) document.getElementById('inputPm2ProcessName').value = server.pm2ProcessName;
        if (server.saveFilePath) document.getElementById('inputSaveFilePath').value = server.saveFilePath;
        if (server.settingsFilePath) document.getElementById('inputSettingsFilePath').value = server.settingsFilePath;
        
        const warnDiv = document.getElementById('apiWarnMsg') || document.createElement('div');
        warnDiv.id = 'apiWarnMsg';
        if (server.restApiEnabled === false) {
          warnDiv.className = 'banner banner-warn';
          warnDiv.innerHTML = '⚠️ <b>Warning:</b> <code>RESTAPIEnabled=True</code> was not found in <code>PalWorldSettings.ini</code>. Please make sure REST API is enabled in your server settings so the bot can connect!';
          document.getElementById('addForm').prepend(warnDiv);
        } else if (warnDiv.parentNode) {
          warnDiv.remove();
        }
      }
      document.getElementById('btnDetect').addEventListener('click', async () => {
        const msg = document.getElementById('detectMsg');
        msg.className = 'banner banner-info';
        msg.textContent = 'Scanning system for Palworld configs and processes...';
        try {
          const res = await fetch('/detect');
          const data = await res.json();
          detectedServers = data.detected || [];
          if (detectedServers.length > 0) {
            applyServer(detectedServers[0]);
            msg.className = 'banner banner-info';
            if (detectedServers.length === 1) {
              msg.textContent = '✓ Auto-detected server configuration! Form pre-filled.';
            } else {
              let html = '✓ Found ' + detectedServers.length + ' new server(s)! Select one: <select id="selDetected" style="padding:.2rem;margin-left:.5rem">';
              detectedServers.forEach((s, i) => {
                html += '<option value="' + i + '">' + (s.label || ('Server ' + (i+1))) + ' (' + (s.restApiUrl || 'no REST URL') + ')</option>';
              });
              html += '</select>';
              msg.innerHTML = html;
              document.getElementById('selDetected').addEventListener('change', (e) => {
                applyServer(detectedServers[e.target.value]);
              });
            }
          } else if (data.alreadyRegisteredCount > 0) {
            msg.className = 'banner banner-info';
            msg.textContent = '✓ All detected local servers are already registered above!';
          } else {
            msg.className = 'banner banner-warn';
            msg.textContent = 'No running Palworld process or PalWorldSettings.ini found in common paths. Please enter details manually.';
          }
        } catch (err) {
          msg.className = 'banner banner-warn';
          msg.textContent = 'Auto-detection failed: ' + err.message;
        }
      });
      </script>
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
