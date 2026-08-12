const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { SETTINGS_SCHEMA, CATEGORIES } = require('./settingsSchema');
const { resolveTierFromGrants, hasAccess } = require('./permissions');
const { findEntriesByServer, mutateGuildEntry, loadServersFile, ensureGuildEntry } = require('./config');
const { findAgentsByOwner, claimAgent } = require('./agentStore');

const SITE_DIR = path.join(__dirname, 'site');
const ERROR_PAGE_TEMPLATE = fs.readFileSync(path.join(SITE_DIR, 'error.html'), 'utf8');

// Configuration constants from ENV
const WEB_PORT = process.env.WEB_PORT || 8090;
const WEB_SECRET = process.env.WEB_SECRET || crypto.randomBytes(32).toString('hex');
const WEB_HOST = process.env.WEB_HOST || 'localhost';
const WEB_SCHEME = process.env.WEB_SCHEME || (WEB_HOST !== 'localhost' && WEB_HOST !== '127.0.0.1' ? 'https' : 'http');
const WEB_BASE_URL = process.env.WEB_BASE_URL || (
  WEB_SCHEME === 'https'
    ? `https://${WEB_HOST}`
    : `http://${WEB_HOST}:${WEB_PORT}`
);
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

// Substitutes into the real src/site/error.html file (read once at module
// load) rather than generating markup inline -- still needs to be a
// function (not a plain static file) since the title/message vary per
// call and callers rely on setting the exact HTTP status code in the same
// response, which a client-side-only static page can't do.
function renderErrorPage(title, message) {
  return ERROR_PAGE_TEMPLATE
    .replace('{{TITLE}}', escapeHtml(title))
    .replace('{{MESSAGE}}', escapeHtml(message));
}

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
    res.sendFile(path.join(SITE_DIR, 'dashboard.html'));
  });

  // The static dashboard.html has no server-rendered session data baked
  // in -- this is what its app.js fetches on load to populate the header.
  app.get('/dashboard/me', (req, res) => {
    const session = requireDashboardSession(req, res);
    if (!session) return;
    const avatarUrl = session.avatar
      ? `https://cdn.discordapp.com/avatars/${session.userId}/${session.avatar}.png?size=64`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
    res.json({ success: true, username: session.username, avatarUrl, userId: session.userId });
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

  app.get('/dashboard/guilds/:guildId/resources', async (req, res) => {
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ success: false, error: 'Guild not found or bot is not in this guild.' });

    try {
      await guild.members.fetch(session.userId);
    } catch {
      return res.status(403).json({ success: false, error: 'You are not a member of this guild.' });
    }

    try {
      if (guild.channels?.fetch) await guild.channels.fetch();
      if (guild.roles?.fetch) await guild.roles.fetch();
    } catch {
      // Ignore if fetch fails, use cache
    }

    const channels = Array.from(guild.channels?.cache?.values() || [])
      .filter((c) => c.type === 0 || c.type === 5 || (typeof c.isTextBased === 'function' && c.isTextBased() && !c.isThread?.()))
      .map((c) => ({ id: c.id, name: c.name, position: c.rawPosition ?? c.position ?? 0 }))
      .sort((a, b) => a.position - b.position);

    const roles = Array.from(guild.roles?.cache?.values() || [])
      .filter((r) => r.name !== '@everyone' && !r.managed)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : 'rgba(255, 255, 255, 0.4)',
        position: r.position ?? 0,
      }))
      .sort((a, b) => b.position - a.position);

    res.json({ success: true, channels, roles });
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
      if (typeof val === 'string' && val.trim() !== '' && val !== '__loading__') {
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

  // Serves style.css/app.js (and dashboard.html for any request not
  // caught by the exact GET /dashboard route above, e.g. a direct hit on
  // dashboard.html itself). Registered last so none of the API routes
  // above are ever shadowed by it.
  app.use('/dashboard', express.static(SITE_DIR));

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
