const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { ensureState, addServer, updateServer, removeServer } = require('./state');
const { detectLocalServers } = require('./detector');

const SITE_DIR = path.join(__dirname, 'site');

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

  // Everything the static index.html/edit.html pages need to render
  // themselves client-side -- pairing info plus the current server list.
  app.get('/api/state', (req, res) => {
    const state = ensureState(statePath);
    res.json({ agentId: state.agentId, agentToken: state.agentToken, botWsUrl, servers: state.servers });
  });

  app.use(express.static(SITE_DIR));

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
