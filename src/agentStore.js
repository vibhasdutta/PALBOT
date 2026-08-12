const fs = require('node:fs');
const path = require('node:path');

function readAgents(agentsPath) {
  try {
    return JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
  } catch {
    return [];
  }
}

function writeAgents(agentsPath, agents) {
  fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
  fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2));
}

// Trust-on-first-use: an agentId the bot has never seen is recorded
// unowned (ownerId: null) the first time it authenticates -- the token
// itself, a 32-byte secret only the agent (and later its claimer) ever
// knows, is what makes that safe. Idempotent: a known agentId's stored
// record is returned unchanged, even if a different token is presented
// (agentRegistry.authenticate is what actually rejects a mismatched token
// on a known agent -- this function only ever creates or reads).
function registerOrGetAgent(agentsPath, agentId, token) {
  const agents = readAgents(agentsPath);
  const existing = agents.find((a) => a.agentId === agentId);
  if (existing) return existing;

  const record = { agentId, agentToken: token, ownerId: null };
  agents.push(record);
  writeAgents(agentsPath, agents);
  return record;
}

function findAgent(agentsPath, agentId) {
  return readAgents(agentsPath).find((a) => a.agentId === agentId) || null;
}

function findAgentsByOwner(agentsPath, ownerId) {
  return readAgents(agentsPath).filter((a) => a.ownerId === ownerId);
}

// Claims an unowned agent for ownerId if agentId/token match exactly --
// returns the claimed record, or null if the pair doesn't match an
// unowned agent (wrong token, already claimed, or unknown agentId all
// fail the same way, deliberately -- don't help an attacker tell those
// apart via the response).
function claimAgent(agentsPath, agentId, token, ownerId) {
  const agents = readAgents(agentsPath);
  const record = agents.find((a) => a.agentId === agentId && a.agentToken === token && a.ownerId === null);
  if (!record) return null;
  record.ownerId = ownerId;
  writeAgents(agentsPath, agents);
  return record;
}

module.exports = { registerOrGetAgent, findAgent, findAgentsByOwner, claimAgent };
