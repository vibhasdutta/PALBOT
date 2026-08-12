const crypto = require('node:crypto');
const { registerOrGetAgent } = require('./agentStore');

const DEFAULT_COMMAND_TIMEOUT_MS = 8000;
const MAX_PENDING_PER_AGENT = 5;
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX_COMMANDS = 20;

function timingSafeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Binds authenticated WebSocket-like connections (anything with .send(str)
// and .on(event, cb)) to an agent's agentId, and turns sendCommand into an
// id-correlated request/response exchange over that socket, addressed to
// one of that agent's registered servers by serverId. One registry
// instance serves every agent -- the agentId a connection authenticated as
// is the only thing that ever scopes which agent a message can affect.
//
// Authentication is trust-on-first-use, backed by data/agents.json
// (agentStore.js): an agentId the bot has never seen is accepted and
// recorded unowned; a known agentId must present the same token it first
// connected with. Ownership (who may act on an agent's behalf via the
// dashboard) is a separate concern this module doesn't touch.
function createAgentRegistry({ agentsPath, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) {
  const connections = new Map(); // agentId -> { socket, servers, pending: Map<id, {resolve, reject, timer}>, windowStart, windowCount }

  function rejectAllPending(entry, message) {
    for (const { reject, timer } of entry.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    entry.pending.clear();
  }

  function handleMessage(agentId, raw) {
    const entry = connections.get(agentId);
    if (!entry) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'servers') {
      if (Array.isArray(msg.list)) entry.servers = msg.list;
      return;
    }
    if (msg.type !== 'response') return;

    const pending = entry.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    entry.pending.delete(msg.id);

    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      const err = new Error(msg.error || 'Agent command failed');
      // Passed through opaquely -- agentRegistry doesn't know or care what
      // this means, but agentPalworldClient.js (Palworld-specific) uses it
      // to reconstruct a PalworldApiError when that's what actually
      // failed, since restart.js/stop.js branch on that type specifically.
      if (msg.errorType) err.errorType = msg.errorType;
      pending.reject(err);
    }
  }

  // Called once a WS connection's first message (its {type:'hello'}) has
  // been parsed by the caller. Returns whether the connection was accepted
  // -- the caller is responsible for closing the socket on false.
  function authenticate(socket, { agentId, token }) {
    if (typeof agentId !== 'string' || !agentId || typeof token !== 'string' || !token) return false;

    const record = registerOrGetAgent(agentsPath, agentId, token);
    if (!timingSafeTokenEqual(token, record.agentToken)) return false;

    // A reconnect (agent restarted, network blip) replaces the stale
    // connection -- fail its pending commands now instead of leaving
    // callers to wait out the full timeout, and actively retire the old
    // socket rather than just ignoring it.
    const existing = connections.get(agentId);
    if (existing) {
      rejectAllPending(existing, "This server's agent is offline");
      existing.socket.close?.();
    }

    const entry = { socket, servers: [], pending: new Map(), windowStart: Date.now(), windowCount: 0 };
    connections.set(agentId, entry);

    socket.on('message', (raw) => {
      if (connections.get(agentId) !== entry) return; // superseded connection, ignore
      handleMessage(agentId, raw);
    });
    socket.on('close', () => {
      if (connections.get(agentId) === entry) {
        connections.delete(agentId);
        rejectAllPending(entry, "This server's agent is offline");
      }
    });

    return true;
  }

  function sendCommand(agentId, serverId, action, args = {}) {
    const entry = connections.get(agentId);
    if (!entry) return Promise.reject(new Error("This server's agent is offline"));

    // Fixed window, not sliding -- a burst straddling the boundary can let through
    // up to ~2x RATE_LIMIT_MAX_COMMANDS. Acceptable for this use case; tighten if it isn't.
    const now = Date.now();
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      entry.windowStart = now;
      entry.windowCount = 0;
    }
    if (entry.windowCount >= RATE_LIMIT_MAX_COMMANDS) {
      return Promise.reject(new Error('Too many commands sent to this server too quickly -- try again shortly.'));
    }
    if (entry.pending.size >= MAX_PENDING_PER_AGENT) {
      return Promise.reject(new Error("This server's agent hasn't responded to earlier commands yet -- try again shortly."));
    }

    entry.windowCount += 1;
    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(new Error("This server's agent is offline"));
      }, commandTimeoutMs);

      entry.pending.set(id, { resolve, reject, timer });
      entry.socket.send(JSON.stringify({ type: 'command', id, serverId, action, args }));
    });
  }

  function isConnected(agentId) {
    return connections.has(agentId);
  }

  function listServers(agentId) {
    return connections.get(agentId)?.servers || [];
  }

  return { authenticate, sendCommand, isConnected, listServers };
}

module.exports = { createAgentRegistry };
