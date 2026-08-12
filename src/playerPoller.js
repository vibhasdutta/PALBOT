// Palworld's REST API has no push events for player connect/disconnect --
// only GET /v1/api/players, a snapshot. This polls it periodically per
// server and diffs against the last snapshot to report joins/leaves. A
// "leave" could be a normal disconnect, a kick, or a ban -- the players
// list can't tell those apart, so the message stays honest about that
// (just "left") instead of guessing.
function isValidId(id) {
  if (!id || typeof id !== 'string') return false;
  const lower = id.trim().toLowerCase();
  return lower !== '' && lower !== 'none' && lower !== 'null' && lower !== 'undefined' && !/^0+$/.test(lower);
}

function playerKey(player) {
  const pId = isValidId(player.playerId) ? player.playerId : null;
  const uId = isValidId(player.userId) ? player.userId : null;
  const acc = player.accountName && player.accountName !== '' ? player.accountName : null;
  const name = player.name && player.name !== '' ? player.name : null;
  return pId || uId || acc || name || 'unknown';
}

function cleanPlayerId(id) {
  if (!id || typeof id !== 'string') return id;
  const str = id.trim();
  if (/^[0-9a-fA-F]{32}$/.test(str) && str.endsWith('000000000000000000000000')) {
    return str.slice(0, 8);
  }
  return str;
}

function getDisplayPlayerId(player) {
  const pId = isValidId(player.playerId) ? cleanPlayerId(player.playerId) : null;
  const uId = isValidId(player.userId) ? player.userId : null;
  if (pId && uId) return `${pId} | Platform: ${uId}`;
  if (pId) return pId;
  if (uId) return uId;
  if (player.accountName && player.accountName !== '') return player.accountName;
  if (player.name && player.name !== '') return player.name;
  return 'Connecting';
}

function isSamePlayer(p1, p2) {
  if (!p1 || !p2) return false;
  const samePlayerId = isValidId(p1.playerId) && isValidId(p2.playerId) && p1.playerId === p2.playerId;
  const sameUserId = isValidId(p1.userId) && isValidId(p2.userId) && p1.userId === p2.userId;
  const sameAccount = p1.accountName && p2.accountName && p1.accountName === p2.accountName;
  const sameName = p1.name && p2.name && p1.name === p2.name;
  return samePlayerId || sameUserId || sameAccount || sameName;
}

function createPlayerPoller({ getServers, createClient, notify, intervalMs = 20000 }) {
  const known = new Map(); // `${guildId}:${label}` -> Map<pKey, playerObj>

  async function pollOnce() {
    const servers = getServers();
    const activeKeys = new Set();

    for (const server of servers) {
      const key = `${server.guildId}:${server.label}`;
      activeKeys.add(key);
      const isFirstPoll = !known.has(key);

      let players;
      try {
        const client = createClient({ baseUrl: server.restApiUrl, password: server.restApiPassword });
        ({ players = [] } = await client.getPlayers());
      } catch {
        continue;
      }

      const previous = known.get(key) || new Map();
      const current = new Map();

      for (const p of players) {
        const pKey = playerKey(p);
        const displayId = getDisplayPlayerId(p);
        const playerObj = {
          name: p.name,
          accountName: p.accountName,
          playerId: p.playerId,
          userId: p.userId,
          displayId,
        };

        // Check if player matched any entry in previous poll
        let matchedPrevKey = null;
        for (const [prevKey, prevObj] of previous.entries()) {
          if (isSamePlayer(p, prevObj)) {
            matchedPrevKey = prevKey;
            break;
          }
        }

        current.set(pKey, playerObj);

        if (!isFirstPoll && !matchedPrevKey) {
          notify.serverLog(server.guildId, {
            event: 'player.join',
            server: server.label,
            player: p.name,
            playerId: displayId,
            status: 'joined',
            level: 'join',
            msg: `**${p.name}** (Player ID: \`${displayId}\`) joined ${server.label}`,
          }).catch(() => {});
        }
      }

      if (!isFirstPoll) {
        for (const [prevKey, prevObj] of previous.entries()) {
          let foundInCurrent = false;
          for (const currObj of current.values()) {
            if (isSamePlayer(prevObj, currObj)) {
              foundInCurrent = true;
              break;
            }
          }

          if (!foundInCurrent) {
            const leaveId = prevObj.displayId;
            notify.serverLog(server.guildId, {
              event: 'player.leave',
              server: server.label,
              player: prevObj.name,
              playerId: leaveId,
              status: 'left',
              level: 'leave',
              msg: `**${prevObj.name}** (Player ID: \`${leaveId}\`) left ${server.label}`,
            }).catch(() => {});
          }
        }
      }

      known.set(key, current);
    }

    for (const key of known.keys()) {
      if (!activeKeys.has(key)) known.delete(key);
    }
  }

  function start() {
    pollOnce().catch((err) => console.error('playerPoller: initial poll failed:', err.message));
    return setInterval(() => pollOnce().catch((err) => console.error('playerPoller: poll failed:', err.message)), intervalMs);
  }

  return { start, pollOnce };
}

module.exports = { createPlayerPoller, playerKey, cleanPlayerId };
