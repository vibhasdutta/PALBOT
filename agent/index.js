const path = require('node:path');
const WebSocket = require('ws');
const { loadAgentConfig } = require('./config');
const { ensureState, listServers } = require('./state');
const { createActionHandlers } = require('./actions');
const { createPalworldClient } = require('../src/palworldClient');
const { controlService } = require('../src/processControl');
const { startSite } = require('./site');

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const AUTH_GRACE_PERIOD_MS = 3000;
const STATE_PATH = path.join(__dirname, 'data', 'state.json');

const config = loadAgentConfig();
const state = ensureState(STATE_PATH);

// Re-reads state.json on every call rather than caching -- the local site
// (site.js) runs in this same process and writes directly to the file, so
// this always sees the owner's latest add/edit/remove without needing any
// in-process event wiring between the two.
function resolveServer(serverId) {
  const server = listServers(STATE_PATH).find((s) => s.serverId === serverId);
  if (!server) return null;
  return {
    palworld: createPalworldClient({ baseUrl: server.restApiUrl, password: server.restApiPassword }),
    pm2ProcessName: server.pm2ProcessName,
    settingsFilePath: server.settingsFilePath,
  };
}

const actions = createActionHandlers({ resolveServer, controlService });

let backoff = MIN_BACKOFF_MS;
let activeWs = null;

function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

function sendServerList(ws) {
  const list = listServers(STATE_PATH).map((s) => ({ serverId: s.serverId, label: s.label }));
  ws.send(JSON.stringify({ type: 'servers', list }));
}

async function handleCommand(ws, msg) {
  const handler = actions[msg.action];
  if (typeof handler !== 'function') {
    ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: false, error: `Unknown action: ${msg.action}` }));
    return;
  }
  try {
    const result = await handler(msg.serverId, msg.args || {});
    ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result: result === undefined ? null : result }));
  } catch (err) {
    console.error('agent: command failed:', msg.action, msg.serverId, err.message);
    ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: false, error: err.message, errorType: err.name }));
  }
}

function connect() {
  const ws = new WebSocket(config.botWsUrl);
  let resetBackoffTimer = null;

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', agentId: state.agentId, token: state.agentToken }));
    sendServerList(ws);
    console.log(`agent: connected to ${config.botWsUrl} as ${state.agentId}`);
    // Same reasoning as phase 1: don't reset backoff on bare transport
    // open, since the bot accepts the WS upgrade before validating hello --
    // only after surviving a grace period does a connection count as real.
    resetBackoffTimer = setTimeout(() => { backoff = MIN_BACKOFF_MS; }, AUTH_GRACE_PERIOD_MS);
    activeWs = ws;
  });

  ws.on('error', (err) => console.warn('agent: WebSocket error:', err.message));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'command') handleCommand(ws, msg).catch((err) => console.error('agent: unhandled command error:', err.message));
  });

  ws.on('close', () => {
    clearTimeout(resetBackoffTimer);
    if (activeWs === ws) activeWs = null;
    console.log('agent: disconnected, reconnecting...');
    scheduleReconnect();
  });
}

// Called by the local site whenever the owner adds/edits/removes a server,
// so the bot's view of this agent's server list updates immediately
// instead of only on the next reconnect.
function onServersChanged() {
  if (activeWs && activeWs.readyState === WebSocket.OPEN) sendServerList(activeWs);
}

connect();
startSite({ statePath: STATE_PATH, botWsUrl: config.botWsUrl, onServersChanged });
