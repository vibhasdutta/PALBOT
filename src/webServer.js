const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ChannelType } = require('discord.js');
const { SETTINGS_SCHEMA, CATEGORIES } = require('./settingsSchema');
const { resolveTierFromGrants, hasAccess } = require('./permissions');
const { findEntriesByServer, mutateGuildEntry, loadServersFile, ensureGuildEntry } = require('./config');
const { findAgentsByOwner, claimAgent, readAgents, findAgent, transferAgent, unclaimAgent, addCoOwner, removeCoOwner } = require('./agentStore');
const { slugForChannel } = require('./statusChannel');

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

  app.post('/dashboard/agents/:agentId/transfer', (req, res) => {
    const { agentId } = req.params;
    const session = requirePrimaryOwner(req, res, agentId);
    if (!session) return;

    const { newOwnerId } = req.body || {};
    if (typeof newOwnerId !== 'string' || !newOwnerId.trim()) {
      return res.status(400).json({ success: false, error: 'newOwnerId is required.' });
    }

    const cleanNewOwner = newOwnerId.trim().replace(/\D/g, '');
    if (cleanNewOwner.length < 15) {
      return res.status(400).json({ success: false, error: 'Invalid Discord User ID for new owner.' });
    }

    const updated = transferAgent(config.agentsPath, agentId, session.userId, cleanNewOwner);
    if (!updated) {
      return res.status(400).json({ success: false, error: 'Failed to transfer ownership.' });
    }
    res.json({ success: true, agentId: updated.agentId, ownerId: updated.ownerId });
  });

  app.post('/dashboard/agents/:agentId/unclaim', (req, res) => {
    const { agentId } = req.params;
    const session = requirePrimaryOwner(req, res, agentId);
    if (!session) return;

    const updated = unclaimAgent(config.agentsPath, agentId, session.userId);
    if (!updated) {
      return res.status(400).json({ success: false, error: 'Failed to unclaim agent.' });
    }
    res.json({ success: true, agentId: updated.agentId });
  });

  app.post('/dashboard/agents/:agentId/co-owners', (req, res) => {
    const { agentId } = req.params;
    const session = requirePrimaryOwner(req, res, agentId);
    if (!session) return;

    const { action, coOwnerId } = req.body || {};
    if (typeof coOwnerId !== 'string' || !coOwnerId.trim() || (action !== 'add' && action !== 'remove')) {
      return res.status(400).json({ success: false, error: 'action ("add" or "remove") and coOwnerId are required.' });
    }

    const cleanCoOwner = coOwnerId.trim().replace(/\D/g, '');
    if (cleanCoOwner.length < 15) {
      return res.status(400).json({ success: false, error: 'Invalid Discord User ID for co-owner.' });
    }

    const updated = action === 'add'
      ? addCoOwner(config.agentsPath, agentId, session.userId, cleanCoOwner)
      : removeCoOwner(config.agentsPath, agentId, session.userId, cleanCoOwner);

    if (!updated) {
      return res.status(400).json({ success: false, error: 'Failed to update co-owners.' });
    }
    res.json({ success: true, agentId: updated.agentId, coOwnerIds: updated.coOwnerIds });
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

  function requirePrimaryOwner(req, res, agentId) {
    const session = requireDashboardSession(req, res);
    if (!session) return null;
    const agent = findAgent(config.agentsPath, agentId);
    if (!agent || agent.ownerId !== session.userId) {
      res.status(403).json({ success: false, error: 'Only the primary owner of this agent can perform this action.' });
      return null;
    }
    return session;
  }

  function hasServerAdminAccess(sessionUserId, agentId, serverId = null) {
    const isOwner = findAgentsByOwner(config.agentsPath, sessionUserId).some((a) => a.agentId === agentId);
    if (isOwner) return true;

    return config.servers.some((entry) => {
      const guild = client.guilds.cache.get(entry.guildId);
      const member = guild?.members?.cache?.get(sessionUserId);
      const roleIds = member?.roles?.cache ? [...member.roles.cache.keys()] : [];

      return entry.servers.some((server) => {
        if (server.agentId !== agentId) return false;
        if (serverId && server.serverId !== serverId) return false;
        const tier = resolveTierFromGrants({ roleIds, userId: sessionUserId }, server.tierGrants);
        return hasAccess(tier, 'admin');
      });
    });
  }

  function requireServerAdminOrOwner(req, res, agentId, serverId = null) {
    const session = requireDashboardSession(req, res);
    if (!session) return null;
    if (!hasServerAdminAccess(session.userId, agentId, serverId)) {
      res.status(403).json({ success: false, error: 'You do not have admin access to this server.' });
      return null;
    }
    return session;
  }

  app.get('/dashboard/servers', (req, res) => {
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const allAgents = readAgents(config.agentsPath);
    const visibleAgents = [];

    for (const a of allAgents) {
      const isOwner = a.ownerId === session.userId;
      const liveServers = agentRegistry ? agentRegistry.listServers(a.agentId) : [];

      const accessibleServers = liveServers.filter((s) => isOwner || hasServerAdminAccess(session.userId, a.agentId, s.serverId));

      if (accessibleServers.length > 0) {
        visibleAgents.push({
          agentId: a.agentId,
          ownerId: a.ownerId,
          isPrimaryOwner: a.ownerId === session.userId,
          coOwnerIds: Array.isArray(a.coOwnerIds) ? a.coOwnerIds : [],
          servers: accessibleServers.map((s) => {
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
                botLogChannelId: ge.botLogChannelId || null,
                categoryId: ge.categoryId || null,
              };
            });
            return { ...s, attachedGuilds };
          }),
        });
      }
    }

    res.json({ success: true, agents: visibleAgents });
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

    const categories = Array.from(guild.channels?.cache?.values() || [])
      .filter((c) => c.type === ChannelType.GuildCategory)
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

    res.json({ success: true, channels, categories, roles });
  });

  app.post('/dashboard/servers/:agentId/:serverId/guilds', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireServerAdminOrOwner(req, res, agentId, serverId);
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
    if (typeof body.statusChannelId === 'string' && body.statusChannelId.trim() !== '' && body.statusChannelId !== '__loading__') {
      const ch = await client.channels.fetch(body.statusChannelId).catch(() => null);
      if (!ch || ch.guildId !== guildId) {
        return res.status(400).json({ success: false, error: `Channel ${body.statusChannelId} does not exist in this guild.` });
      }
    }
    if (typeof body.botLogChannelId === 'string' && body.botLogChannelId.trim() !== '' && body.botLogChannelId !== '__loading__') {
      const ch = await client.channels.fetch(body.botLogChannelId).catch(() => null);
      if (!ch || ch.guildId !== guildId) {
        return res.status(400).json({ success: false, error: `Log channel ${body.botLogChannelId} does not exist in this guild.` });
      }
    }
    if (typeof body.categoryId === 'string' && body.categoryId.trim() !== '' && body.categoryId !== '__loading__') {
      const cat = await client.channels.fetch(body.categoryId).catch(() => null);
      if (!cat || cat.guildId !== guildId || cat.type !== ChannelType.GuildCategory) {
        return res.status(400).json({ success: false, error: `Category ${body.categoryId} does not exist in this guild.` });
      }
    }

    // Labels only have to be unique per guild, but that guild can easily
    // have servers from several different agent owners attached to it --
    // the agent's own UI defaults every new server to the label "main", so
    // without this check two different people's servers can silently
    // collide and corrupt each other's tracked status-channel state
    // (everything downstream keys per-server state off guildId+label).
    const guildEntry = config.servers.find((s) => s.guildId === guildId);
    const labelTaken = guildEntry?.servers?.some((s) => s.label === label && !(s.agentId === agentId && s.serverId === serverId));
    if (labelTaken) {
      return res.status(400).json({ success: false, error: `Another server in this guild already uses the label "${label}". Pick a different label.` });
    }

    ensureGuildEntry(config.serversPath, guildId);
    const entry = mutateGuildEntry(config.serversPath, guildId, (e) => {
      // Guild-level: which category (if any) this guild's status channels
      // are grouped under. Preserve the existing value unless the request
      // explicitly includes the field.
      e.categoryId = 'categoryId' in body ? (body.categoryId || null) : e.categoryId;
      if ('botLogChannelId' in body) {
        e.botLogChannelId = body.botLogChannelId || null;
      }

      e.servers = e.servers || [];
      const existingIndex = e.servers.findIndex((s) => s.agentId === agentId && s.serverId === serverId);
      const serverEntry = { label, agentId, serverId, tierGrants };

      // Channel ID handling: on insert default to null; on update preserve
      // the existing value unless the request explicitly includes the field.
      if (existingIndex >= 0) {
        const existing = e.servers[existingIndex];
        serverEntry.statusChannelId = 'statusChannelId' in body ? body.statusChannelId : existing.statusChannelId;
        e.servers[existingIndex] = serverEntry;
      } else {
        serverEntry.statusChannelId = body.statusChannelId || null;
        e.servers.push(serverEntry);
      }
    });
    config.servers = loadServersFile(config.serversPath);

    res.json({ success: true, guildId, entry });
  });

  // Explicit creation -- the dashboard's "Create" buttons. Status channels
  // are never created silently by the tick loop; this is the only path
  // that creates one, always as a direct result of clicking a button, with
  // a name tied to the specific server it's for (a guild's status
  // channels can hold servers belonging to different agent owners, so a
  // generic name would be ambiguous about whose server is whose). Log
  // channels are automatic instead (ensureLogChannel in index.js) -- not
  // handled here at all.
  app.post('/dashboard/servers/:agentId/:serverId/channels', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireServerAdminOrOwner(req, res, agentId, serverId);
    if (!session) return;

    const { guildId, kind, label, categoryId } = req.body || {};
    if (typeof guildId !== 'string' || (kind !== 'status' && kind !== 'category' && kind !== 'log')) {
      return res.status(400).json({ success: false, error: 'guildId and a valid kind ("status", "log", or "category") are required.' });
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

    try {
      if (kind === 'category') {
        const created = await guild.channels.create({ name: 'Palworld Servers', type: ChannelType.GuildCategory, reason: 'Palworld status category' });
        return res.json({ success: true, id: created.id, name: created.name });
      }

      const suffix = kind === 'log' ? 'logs' : 'status';
      const reason = kind === 'log' ? 'Palworld bot log channel' : 'Palworld status channel';
      const opts = { name: `${slugForChannel(label || 'server')}-${suffix}`, type: ChannelType.GuildText, reason };
      if (typeof categoryId === 'string' && categoryId.trim()) {
        const parent = await guild.channels.fetch(categoryId).catch(() => null);
        if (parent && parent.type === ChannelType.GuildCategory) opts.parent = categoryId;
      }
      const created = await guild.channels.create(opts);
      res.json({ success: true, id: created.id, name: created.name });
    } catch (err) {
      res.status(502).json({ success: false, error: `Failed to create channel: ${err.message}` });
    }
  });

  app.delete('/dashboard/servers/:agentId/:serverId/guilds/:guildId', (req, res) => {
    const { agentId, serverId, guildId } = req.params;
    const session = requireServerAdminOrOwner(req, res, agentId, serverId);
    if (!session) return;

    mutateGuildEntry(config.serversPath, guildId, (e) => {
      e.servers = (e.servers || []).filter((s) => !(s.agentId === agentId && s.serverId === serverId));
    });
    config.servers = loadServersFile(config.serversPath);

    res.json({ success: true });
  });

  app.get('/dashboard/servers/:agentId/:serverId/settings', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireServerAdminOrOwner(req, res, agentId, serverId);
    if (!session) return;

    try {
      const result = await agentRegistry.sendCommand(agentId, serverId, 'getSettings', {});
      res.json({ success: true, ...result, schema: SETTINGS_SCHEMA, categories: CATEGORIES });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message });
    }
  });

  app.post('/dashboard/servers/:agentId/:serverId/settings', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireServerAdminOrOwner(req, res, agentId, serverId);
    if (!session) return;

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
