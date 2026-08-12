const express = require('express');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { SETTINGS_SCHEMA, CATEGORIES } = require('./settingsSchema');
const { resolveTierFromGrants, hasAccess } = require('./permissions');
const { findEntriesByServer, mutateGuildEntry, loadServersFile, ensureGuildEntry } = require('./config');
const { findAgentsByOwner, claimAgent } = require('./agentStore');

// Configuration constants from ENV
const WEB_PORT = process.env.WEB_PORT || 8090;
const WEB_SECRET = process.env.WEB_SECRET || crypto.randomBytes(32).toString('hex');
// WEB_HOST is just the reachable hostname/IP -- the port only ever comes
// from WEB_PORT, composed here, so the two can't drift out of sync the way
// a separately hand-typed WEB_BASE_URL (old approach) could. Doesn't cover
// a reverse-proxy setup where the public port differs from WEB_PORT itself
// -- revisit if that's ever needed.
const WEB_HOST = process.env.WEB_HOST || 'localhost';
const WEB_BASE_URL = `http://${WEB_HOST}:${WEB_PORT}`;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

// Helper: Signing and verification
function signPayload(payload, secret) {
  const json = JSON.stringify(payload);
  const base64url = Buffer.from(json).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(base64url).digest('base64url');
  return `${base64url}.${hmac}`;
}

function verifyPayload(signed, secret) {
  if (!signed || typeof signed !== 'string') return null;
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [base64url, signature] = parts;
  const expectedHmac = crypto.createHmac('sha256', secret).update(base64url).digest('base64url');
  if (expectedHmac !== signature) return null;
  
  try {
    const json = Buffer.from(base64url, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Helper: parse cookies
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    if (!value) return;
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// Helper: escape HTML
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>'"]/g, (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[tag]));
}

const ERROR_TEMPLATE = (title, message) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Palworld Settings</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      background-color: #0f172a;
      color: #f8fafc;
      font-family: 'Inter', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1rem;
    }
    .card {
      background-color: #1e293b;
      border: 1px solid #334155;
      border-radius: 0.5rem;
      padding: 2.5rem;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #dc2626; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>
`;

function renderErrorPage(title, message) {
  return ERROR_TEMPLATE(title, message);
}

const DASHBOARD_TEMPLATE = (username, avatarUrl, userId) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Palworld Bot Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      background-color: #0f172a;
      color: #f8fafc;
      font-family: 'Inter', sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
    }
    .header {
      background: #1e293b;
      border-bottom: 1px solid #334155;
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header-left { display: flex; align-items: center; gap: 0.75rem; }
    .header img { width: 36px; height: 36px; border-radius: 50%; }
    .header h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
    .header-user { color: #94a3b8; font-size: 0.85rem; }
    .main { max-width: 900px; margin: 2rem auto; padding: 0 1.5rem; }
    .section-title { font-size: 1.3rem; font-weight: 700; margin-bottom: 1.5rem; color: #e2e8f0; }
    .spinner { text-align: center; color: #94a3b8; padding: 3rem; }
    .error-banner {
      background: #7f1d1d;
      border: 1px solid #dc2626;
      color: #fca5a5;
      padding: 0.75rem 1rem;
      border-radius: 0.375rem;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .success-banner {
      background: #14532d;
      border: 1px solid #22c55e;
      color: #86efac;
      padding: 0.75rem 1rem;
      border-radius: 0.375rem;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .server-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 0.5rem;
      padding: 1.5rem;
      margin-bottom: 1.25rem;
    }
    .server-card-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .server-card-header .label { font-size: 1.05rem; font-weight: 600; }
    .server-card-header .agent-id { color: #64748b; font-size: 0.8rem; }
    .guild-list { list-style: none; padding: 0; margin: 0 0 1rem; }
    .guild-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      background: #0f172a;
      border-radius: 0.375rem;
      margin-bottom: 0.5rem;
      font-size: 0.9rem;
    }
    .guild-item-name { font-weight: 500; }
    .guild-item-actions { display: flex; gap: 0.5rem; }
    .btn {
      padding: 0.4rem 0.85rem;
      border: none;
      border-radius: 0.375rem;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: 500;
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-danger { background: #dc2626; color: #fff; }
    .btn-secondary { background: #334155; color: #e2e8f0; }
    .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.75rem; }
    .form-panel {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 0.375rem;
      padding: 1.25rem;
      margin-top: 0.75rem;
    }
    .form-row { margin-bottom: 1rem; }
    .form-row label {
      display: block;
      font-size: 0.8rem;
      color: #94a3b8;
      margin-bottom: 0.3rem;
      font-weight: 500;
    }
    .form-row input, .form-row select {
      width: 100%;
      padding: 0.5rem;
      background: #1e293b;
      border: 1px solid #475569;
      border-radius: 0.375rem;
      color: #f8fafc;
      font-family: inherit;
      font-size: 0.85rem;
    }
    .form-row input:focus, .form-row select:focus { outline: none; border-color: #3b82f6; }
    .radio-group { display: flex; gap: 1rem; align-items: center; margin-top: 0.3rem; }
    .radio-group label { margin: 0; font-size: 0.85rem; color: #e2e8f0; cursor: pointer; display: flex; align-items: center; gap: 0.3rem; }
    .channel-id-input { margin-top: 0.5rem; }
    .form-actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    .no-guilds { color: #64748b; font-size: 0.85rem; font-style: italic; }
    .empty { color: #64748b; text-align: center; padding: 2rem; }
  </style>
</head>
<body data-username="${username}" data-avatar="${avatarUrl}" data-user-id="${userId}">
  <div class="header">
    <div class="header-left">
      <img src="${avatarUrl}" alt="avatar">
      <div>
        <h1>Palworld Dashboard</h1>
        <div class="header-user">${username}</div>
      </div>
    </div>
  </div>
  <div class="main">
    <div class="section-title">My Servers</div>
    <div id="content"><div class="spinner">Loading\u2026</div></div>
  </div>
<script>
(function() {
  let guildsCache = null;
  const content = document.getElementById('content');

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    });
    children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? c : c); });
    return el;
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = '/dashboard/login'; throw new Error('Session expired'); }
    const body = await res.json();
    if (!body.success) throw new Error(body.error || 'Request failed');
    return body;
  }

  async function loadGuilds() {
    if (guildsCache) return guildsCache;
    const data = await api('/dashboard/guilds');
    guildsCache = data.guilds;
    return guildsCache;
  }

  function showBanner(parent, msg, type) {
    const old = parent.querySelector('.error-banner, .success-banner');
    if (old) old.remove();
    const el = h('div', { className: type === 'error' ? 'error-banner' : 'success-banner' }, msg);
    parent.prepend(el);
    setTimeout(() => el.remove(), 5000);
  }

  function buildChannelFields(prefix, currentValue) {
    const isExisting = typeof currentValue === 'string' && currentValue;
    const row = h('div', { className: 'form-row' });
    const label = h('label', null, prefix === 'status' ? 'Status Channel' : 'Log Channel');
    const group = h('div', { className: 'radio-group' });
    const radioAuto = h('input', { type: 'radio', name: prefix + 'Channel', value: 'auto', id: prefix + 'Auto' });
    const radioExisting = h('input', { type: 'radio', name: prefix + 'Channel', value: 'existing', id: prefix + 'Existing' });
    if (isExisting) radioExisting.checked = true; else radioAuto.checked = true;
    group.append(
      h('label', { for: prefix + 'Auto' }, radioAuto, ' Auto-create'),
      h('label', { for: prefix + 'Existing' }, radioExisting, ' Use existing channel')
    );
    const idInput = h('input', {
      type: 'text', placeholder: 'Paste channel ID', className: 'channel-id-input',
      id: prefix + 'ChannelId', value: isExisting ? currentValue : ''
    });
    idInput.style.display = isExisting ? '' : 'none';
    radioAuto.addEventListener('change', () => { idInput.style.display = 'none'; });
    radioExisting.addEventListener('change', () => { idInput.style.display = ''; idInput.focus(); });
    row.append(label, group, idInput);
    return row;
  }

  function getChannelValue(prefix) {
    const radio = document.querySelector('input[name="' + prefix + 'Channel"]:checked');
    if (!radio || radio.value === 'auto') return null;
    return document.getElementById(prefix + 'ChannelId').value.trim() || null;
  }

  function buildAttachForm(agentId, serverId, serverLabel, existingData, card) {
    const old = card.querySelector('.form-panel');
    if (old) { old.remove(); return; }

    const panel = h('div', { className: 'form-panel' });
    const isEdit = !!existingData;

    const guildRow = h('div', { className: 'form-row' });
    if (isEdit) {
      guildRow.append(h('label', null, 'Guild'), h('input', { type: 'text', value: existingData.guildName, disabled: 'true' }));
    } else {
      guildRow.append(h('label', null, 'Guild'), h('select', { id: 'guildSelect' }, h('option', { value: '' }, 'Loading\u2026')));
    }
    const labelRow = h('div', { className: 'form-row' },
      h('label', null, 'Label'),
      h('input', { type: 'text', id: 'serverLabel', value: isEdit ? existingData.label : serverLabel })
    );
    const adminRow = h('div', { className: 'form-row' },
      h('label', null, 'Admin User IDs (comma-separated)'),
      h('input', { type: 'text', id: 'adminUserIds', value: isEdit && existingData.tierGrants?.admin?.userIds ? existingData.tierGrants.admin.userIds.join(', ') : '' })
    );
    const opRow = h('div', { className: 'form-row' },
      h('label', null, 'Operator User IDs (comma-separated)'),
      h('input', { type: 'text', id: 'opUserIds', value: isEdit && existingData.tierGrants?.operator?.userIds ? existingData.tierGrants.operator.userIds.join(', ') : '' })
    );
    const modRow = h('div', { className: 'form-row' },
      h('label', null, 'Mod User IDs (comma-separated)'),
      h('input', { type: 'text', id: 'modUserIds', value: isEdit && existingData.tierGrants?.mod?.userIds ? existingData.tierGrants.mod.userIds.join(', ') : '' })
    );

    const statusFields = buildChannelFields('status', isEdit ? existingData.statusChannelId : null);
    const logFields = buildChannelFields('log', isEdit ? existingData.logChannelId : null);

    const actions = h('div', { className: 'form-actions' },
      h('button', { className: 'btn btn-primary', onClick: async () => {
        const guildId = isEdit ? existingData.guildId : document.getElementById('guildSelect').value;
        if (!guildId) { showBanner(panel, 'Please select a guild.', 'error'); return; }
        const parseIds = (id) => document.getElementById(id).value.split(',').map(s => s.trim()).filter(Boolean);
        const payload = {
          guildId,
          label: document.getElementById('serverLabel').value.trim(),
          tierGrants: {
            admin: { roleIds: [], userIds: parseIds('adminUserIds') },
            operator: { roleIds: [], userIds: parseIds('opUserIds') },
            mod: { roleIds: [], userIds: parseIds('modUserIds') },
          },
          statusChannelId: getChannelValue('status'),
          logChannelId: getChannelValue('log'),
        };
        try {
          await api('/dashboard/servers/' + agentId + '/' + serverId + '/guilds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          showBanner(content, isEdit ? 'Server updated.' : 'Server attached to guild.', 'success');
          loadServers();
        } catch (err) {
          showBanner(panel, err.message, 'error');
        }
      }}, isEdit ? 'Save' : 'Attach'),
      h('button', { className: 'btn btn-secondary', onClick: () => panel.remove() }, 'Cancel')
    );

    panel.append(guildRow, labelRow, adminRow, opRow, modRow, statusFields, logFields, actions);
    card.append(panel);

    if (!isEdit) {
      loadGuilds().then(guilds => {
        const sel = document.getElementById('guildSelect');
        sel.innerHTML = '';
        sel.append(h('option', { value: '' }, '-- Select a guild --'));
        // get already-attached guild IDs for this server
        const attached = new Set();
        card.querySelectorAll('.guild-item').forEach(gi => { const gid = gi.dataset.guildId; if (gid) attached.add(gid); });
        guilds.filter(g => !attached.has(g.id)).forEach(g => {
          sel.append(h('option', { value: g.id }, g.name));
        });
        if (sel.options.length === 1) {
          sel.append(h('option', { value: '', disabled: 'true' }, 'No available guilds'));
        }
      }).catch(err => showBanner(panel, 'Failed to load guilds: ' + err.message, 'error'));
    }
  }

  async function detachServer(agentId, serverId, guildId) {
    if (!confirm('Detach this server from the guild? The server will no longer be controllable from that guild.')) return;
    try {
      await api('/dashboard/servers/' + agentId + '/' + serverId + '/guilds/' + guildId, { method: 'DELETE' });
      showBanner(content, 'Server detached.', 'success');
      loadServers();
    } catch (err) {
      showBanner(content, err.message, 'error');
    }
  }

  async function loadServers() {
    try {
      const data = await api('/dashboard/servers');
      content.innerHTML = '';
      if (!data.agents.length) {
        content.append(h('div', { className: 'empty' }, 'No agents claimed yet. Claim an agent to get started.'));
        return;
      }
      let hasServers = false;
      for (const agent of data.agents) {
        for (const server of agent.servers) {
          hasServers = true;
          const card = h('div', { className: 'server-card' });
          const header = h('div', { className: 'server-card-header' },
            h('span', null, '\uD83D\uDDA5\uFE0F'),
            h('span', { className: 'label' }, server.label || server.serverId),
            h('span', { className: 'agent-id' }, 'agent: ' + agent.agentId)
          );
          card.append(header);

          if (server.attachedGuilds && server.attachedGuilds.length) {
            const list = h('ul', { className: 'guild-list' });
            for (const ag of server.attachedGuilds) {
              const item = h('li', { className: 'guild-item', 'data-guild-id': ag.guildId },
                h('span', { className: 'guild-item-name' }, ag.guildName),
                h('div', { className: 'guild-item-actions' },
                  h('button', { className: 'btn btn-secondary btn-sm', onClick: () => buildAttachForm(agent.agentId, server.serverId, server.label, ag, card) }, 'Edit'),
                  h('button', { className: 'btn btn-danger btn-sm', onClick: () => detachServer(agent.agentId, server.serverId, ag.guildId) }, 'Detach')
                )
              );
              list.append(item);
            }
            card.append(list);
          } else {
            card.append(h('div', { className: 'no-guilds' }, 'Not attached to any guild yet.'));
          }

          card.append(h('button', { className: 'btn btn-primary', onClick: () => buildAttachForm(agent.agentId, server.serverId, server.label, null, card) }, '+ Attach to a guild'));
          content.append(card);
        }
      }
      if (!hasServers) {
        content.append(h('div', { className: 'empty' }, 'Your agents have no registered servers yet. Add servers through the agent\\'s local site.'));
      }
    } catch (err) {
      content.innerHTML = '';
      content.append(h('div', { className: 'error-banner' }, 'Failed to load servers: ' + err.message));
    }
  }

  loadServers();
})();
</script>
</body>
</html>
`;

function createWebServer({ config, client, notify, auditLog, agentRegistry }) {
  const app = express();
  app.use(express.json());

  // Health Check
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Dashboard session: just the logged-in Discord identity, not scoped to
  // one guild/server. Permission per server/guild is checked per-action
  // from tierGrants, not baked into the session.
  function signDashboardSession(payload) {
    return signPayload(payload, WEB_SECRET);
  }

  function getDashboardSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies.dashboard_session) return null;
    const session = verifyPayload(cookies.dashboard_session, WEB_SECRET);
    if (!session || session.exp < Date.now()) return null;
    return session;
  }

  function requireDashboardSession(req, res) {
    const session = getDashboardSession(req);
    if (!session) {
      res.status(401).json({ success: false, error: 'Not logged in.' });
      return null;
    }
    return session;
  }

  app.get('/dashboard/login', (req, res) => {
    const statePayload = { nonce: crypto.randomBytes(16).toString('hex'), exp: Date.now() + 10 * 60 * 1000 };
    const state = signPayload(statePayload, WEB_SECRET);
    const redirectUri = `${WEB_BASE_URL}/dashboard/callback`;
    const authorizeUrl = `https://discord.com/api/oauth2/authorize?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify&state=${encodeURIComponent(state)}`;
    res.redirect(authorizeUrl);
  });

  app.get('/dashboard/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send(renderErrorPage('Authentication Failed', 'Missing code or state parameter from Discord OAuth2 redirect.'));
    }
    const statePayload = verifyPayload(state, WEB_SECRET);
    if (!statePayload || statePayload.exp < Date.now()) {
      return res.status(400).send(renderErrorPage('Invalid Session State', 'The login session has expired or been tampered with. Please try logging in again.'));
    }

    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: DISCORD_CLIENT_SECRET || '',
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: `${WEB_BASE_URL}/dashboard/callback`,
        }),
      });
      if (!tokenRes.ok) {
        console.error('Dashboard OAuth2 token exchange failed:', await tokenRes.text());
        return res.status(401).send(renderErrorPage('OAuth2 Failed', 'Failed to authenticate with Discord.'));
      }
      const tokenData = await tokenRes.json();

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) {
        return res.status(401).send(renderErrorPage('Failed to Fetch User Profile', 'Could not retrieve Discord user information.'));
      }
      const userData = await userRes.json();

      const sessionPayload = { userId: userData.id, username: userData.username, avatar: userData.avatar, exp: Date.now() + 30 * 60 * 1000 };
      const sessionCookie = signDashboardSession(sessionPayload);
      res.setHeader('Set-Cookie', `dashboard_session=${sessionCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`);
      res.redirect('/dashboard');
    } catch (err) {
      console.error('Dashboard OAuth2 Callback Error:', err);
      res.status(500).send(renderErrorPage('Login Failed', 'An unexpected error occurred during login.'));
    }
  });

  app.post('/dashboard/claim', (req, res) => {
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const { agentId, agentToken } = req.body || {};
    if (typeof agentId !== 'string' || typeof agentToken !== 'string') {
      return res.status(400).json({ success: false, error: 'agentId and agentToken are required.' });
    }

    const claimed = claimAgent(config.agentsPath, agentId, agentToken, session.userId);
    if (!claimed) {
      return res.status(404).json({ success: false, error: 'Not found, already claimed, or the token is wrong.' });
    }
    res.json({ success: true, agentId: claimed.agentId });
  });

  app.get('/dashboard', (req, res) => {
    const session = getDashboardSession(req);
    if (!session) return res.redirect('/dashboard/login');
    const avatarUrl = session.avatar
      ? `https://cdn.discordapp.com/avatars/${escapeHtml(session.userId)}/${escapeHtml(session.avatar)}.png?size=64`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
    res.send(DASHBOARD_TEMPLATE(escapeHtml(session.username), avatarUrl, escapeHtml(session.userId)));
  });

  app.get('/dashboard/servers', (req, res) => {
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const agents = findAgentsByOwner(config.agentsPath, session.userId).map((a) => {
      const servers = agentRegistry ? agentRegistry.listServers(a.agentId) : [];
      return {
        agentId: a.agentId,
        servers: servers.map((s) => {
          const entries = findEntriesByServer(config.servers, a.agentId, s.serverId);
          const attachedGuilds = entries.map((ge) => {
            const srv = ge.servers.find((x) => x.agentId === a.agentId && x.serverId === s.serverId);
            const guild = client.guilds.cache.get(ge.guildId);
            return {
              guildId: ge.guildId,
              guildName: guild ? guild.name : ge.guildId,
              label: srv?.label || s.label,
              tierGrants: srv?.tierGrants || null,
              statusChannelId: srv?.statusChannelId || null,
              logChannelId: srv?.logChannelId || null,
            };
          });
          return { ...s, attachedGuilds };
        }),
      };
    });
    res.json({ success: true, agents });
  });

  app.get('/dashboard/guilds', async (req, res) => {
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const guilds = [];
    for (const [, guild] of client.guilds.cache) {
      try {
        await guild.members.fetch(session.userId);
        guilds.push({ id: guild.id, name: guild.name, icon: guild.iconURL ? guild.iconURL() : null });
      } catch {
        // user is not a member — skip
      }
    }
    res.json({ success: true, guilds });
  });

  // Verifies the requesting user actually owns agentId before letting them
  // grant/revoke anything about one of its servers -- ownership, not just
  // being logged in, is what authorizes dashboard writes.
  function requireOwnedAgent(req, res, agentId) {
    const session = requireDashboardSession(req, res);
    if (!session) return null;
    const owned = findAgentsByOwner(config.agentsPath, session.userId).some((a) => a.agentId === agentId);
    if (!owned) {
      res.status(403).json({ success: false, error: 'You do not own this agent.' });
      return null;
    }
    return session;
  }

  app.post('/dashboard/servers/:agentId/:serverId/guilds', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireOwnedAgent(req, res, agentId);
    if (!session) return;

    const body = req.body || {};
    const { guildId, label, tierGrants } = body;
    if (typeof guildId !== 'string' || typeof label !== 'string' || !tierGrants) {
      return res.status(400).json({ success: false, error: 'guildId, label, and tierGrants are required.' });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(404).json({ success: false, error: 'The bot is not in that guild.' });
    }
    try {
      await guild.members.fetch(session.userId);
    } catch {
      return res.status(404).json({ success: false, error: 'You are not a member of that guild.' });
    }

    // Validate channel IDs if provided as non-null strings
    for (const field of ['statusChannelId', 'logChannelId']) {
      const val = body[field];
      if (typeof val === 'string') {
        const ch = await client.channels.fetch(val).catch(() => null);
        if (!ch || ch.guildId !== guildId) {
          return res.status(400).json({ success: false, error: `Channel ${val} does not exist in this guild.` });
        }
      }
    }

    ensureGuildEntry(config.guildsPath, config.rolesPath, config.serversPath, guildId);
    const entry = mutateGuildEntry(config.serversPath, guildId, (e) => {
      e.servers = e.servers || [];
      const existingIndex = e.servers.findIndex((s) => s.agentId === agentId && s.serverId === serverId);
      const serverEntry = { label, agentId, serverId, tierGrants };

      // Channel ID handling: on insert default to null; on update preserve
      // existing values unless the request explicitly includes the field.
      if (existingIndex >= 0) {
        const existing = e.servers[existingIndex];
        serverEntry.statusChannelId = 'statusChannelId' in body ? body.statusChannelId : existing.statusChannelId;
        serverEntry.logChannelId = 'logChannelId' in body ? body.logChannelId : existing.logChannelId;
        e.servers[existingIndex] = serverEntry;
      } else {
        serverEntry.statusChannelId = body.statusChannelId || null;
        serverEntry.logChannelId = body.logChannelId || null;
        e.servers.push(serverEntry);
      }
    });
    config.servers = loadServersFile(config.serversPath);

    res.json({ success: true, guildId, entry });
  });

  app.delete('/dashboard/servers/:agentId/:serverId/guilds/:guildId', (req, res) => {
    const { agentId, serverId, guildId } = req.params;
    const session = requireOwnedAgent(req, res, agentId);
    if (!session) return;

    mutateGuildEntry(config.serversPath, guildId, (e) => {
      e.servers = (e.servers || []).filter((s) => !(s.agentId === agentId && s.serverId === serverId));
    });
    config.servers = loadServersFile(config.serversPath);

    res.json({ success: true });
  });

  app.get('/dashboard/servers/:agentId/:serverId/settings', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const isOwner = findAgentsByOwner(config.agentsPath, session.userId).some((a) => a.agentId === agentId);
    const grantedAsAdmin = findEntriesByServer(config.servers, agentId, serverId).some((entry) => {
      const server = entry.servers.find((s) => s.agentId === agentId && s.serverId === serverId);
      const tier = resolveTierFromGrants({ roleIds: [], userId: session.userId }, server?.tierGrants);
      return hasAccess(tier, 'admin');
    });
    if (!isOwner && !grantedAsAdmin) {
      return res.status(403).json({ success: false, error: 'You do not have admin access to this server.' });
    }

    try {
      const result = await agentRegistry.sendCommand(agentId, serverId, 'getSettings', {});
      res.json({ success: true, ...result, schema: SETTINGS_SCHEMA, categories: CATEGORIES });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message });
    }
  });

  app.post('/dashboard/servers/:agentId/:serverId/settings', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const isOwner = findAgentsByOwner(config.agentsPath, session.userId).some((a) => a.agentId === agentId);
    const grantedAsAdmin = findEntriesByServer(config.servers, agentId, serverId).some((entry) => {
      const server = entry.servers.find((s) => s.agentId === agentId && s.serverId === serverId);
      const tier = resolveTierFromGrants({ roleIds: [], userId: session.userId }, server?.tierGrants);
      return hasAccess(tier, 'admin');
    });
    if (!isOwner && !grantedAsAdmin) {
      return res.status(403).json({ success: false, error: 'You do not have admin access to this server.' });
    }

    const { settings } = req.body || {};
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ success: false, error: 'settings is required.' });
    }

    try {
      const result = await agentRegistry.sendCommand(agentId, serverId, 'setSettings', { settings });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message });
    }
  });

  return {
    app,
    signDashboardSession,
    start: () => {
      const server = app.listen(WEB_PORT, () => {
        console.log(`Web settings server listening on port ${WEB_PORT} (${WEB_BASE_URL})`);
      });

      if (agentRegistry) {
        const HELLO_TIMEOUT_MS = 5000;
        const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
        server.on('upgrade', (req, socket, head) => {
          if (req.url !== '/agent/connect') {
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            // Attached once, here, before anything else on this connection --
            // ws.on() listeners persist for the connection's whole lifetime,
            // so this covers both the pre-auth handshake below AND every
            // command/response exchange agentRegistry.authenticate() sets up
            // afterward. Without it, an unhandled 'error' event (a malformed
            // frame, oversized payload, etc. -- easy to trigger, no token
            // needed) throws synchronously and crashes the whole bot
            // process. Found in code review, verified with a live repro.
            ws.on('error', (err) => console.warn('Agent WebSocket error:', err.message));

            const helloTimeout = setTimeout(() => {
              console.warn('Rejected /agent/connect handshake: no hello received within timeout');
              ws.terminate();
            }, HELLO_TIMEOUT_MS);

            // The first message on a fresh connection must be the hello --
            // authenticate() takes over listening for command responses
            // only after this succeeds, so a connection that never sends
            // one (or sends a bad token) never gets a chance to send
            // anything else.
            ws.once('message', (raw) => {
              clearTimeout(helloTimeout);

              let hello;
              try {
                hello = JSON.parse(raw);
              } catch {
                console.warn('Rejected /agent/connect handshake: malformed JSON');
                ws.close();
                return;
              }

              if (hello.type !== 'hello' || typeof hello.agentId !== 'string' || typeof hello.token !== 'string') {
                console.warn('Rejected /agent/connect handshake: malformed hello');
                ws.close();
                return;
              }

              if (!agentRegistry.authenticate(ws, { agentId: hello.agentId, token: hello.token })) {
                console.warn('Rejected /agent/connect handshake: authentication failed for agentId', hello.agentId);
                ws.close();
              }
            });
          });
        });
      }
    },
    getBaseUrl: () => WEB_BASE_URL,
  };
}

module.exports = { createWebServer, signPayload, verifyPayload, parseCookies };
