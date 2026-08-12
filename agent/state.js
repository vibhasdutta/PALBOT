const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readStateFile(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeStateFile(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// Generates agentId/agentToken once, on first run, and persists them --
// every later run just loads the same identity back. Nothing about this
// identity is ever derived from anything the bot says; the bot only ever
// finds out what this agent generated for itself (see agentStore.js,
// bot-side, for the trust-on-first-use half of this).
function ensureState(statePath) {
  const existing = readStateFile(statePath);
  if (existing) return existing;

  const state = {
    agentId: crypto.randomUUID(),
    agentToken: crypto.randomBytes(32).toString('hex'),
    servers: [],
  };
  writeStateFile(statePath, state);
  return state;
}

function listServers(statePath) {
  return ensureState(statePath).servers;
}

function addServer(statePath, server) {
  const state = ensureState(statePath);
  const entry = {
    serverId: crypto.randomUUID(),
    label: server.label,
    restApiUrl: server.restApiUrl || null,
    restApiPassword: server.restApiPassword || null,
    pm2ProcessName: server.pm2ProcessName || null,
    saveFilePath: server.saveFilePath || null,
    settingsFilePath: server.settingsFilePath || null,
  };
  state.servers.push(entry);
  writeStateFile(statePath, state);
  return entry;
}

function updateServer(statePath, serverId, patch) {
  const state = ensureState(statePath);
  const entry = state.servers.find((s) => s.serverId === serverId);
  if (!entry) return null;
  Object.assign(entry, patch);
  writeStateFile(statePath, state);
  return entry;
}

function removeServer(statePath, serverId) {
  const state = ensureState(statePath);
  const before = state.servers.length;
  state.servers = state.servers.filter((s) => s.serverId !== serverId);
  writeStateFile(statePath, state);
  return state.servers.length < before;
}

module.exports = { ensureState, listServers, addServer, updateServer, removeServer };
