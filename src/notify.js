function levelForCommand(command) {
  switch (command) {
    case 'kick':
    case 'ban':
    case 'stop':
      return 'danger';
    case 'start':
      return 'success';
    case 'restart':
      return 'warning';
    default:
      return 'info';
  }
}

function actorLabel(entry) {
  return entry.actorId ? `${entry.actor} (Discord ID: ${entry.actorId})` : entry.actor;
}

function actorMention(entry) {
  return entry.actorId ? `**${entry.actor || 'User'}** (Discord ID: \`${entry.actorId}\`)` : `**${entry.actor}**`;
}

function formatAuditEntry(entry) {
  const actor = actorMention(entry);
  const actorName = actorLabel(entry);
  const level = levelForCommand(entry.command);
  const event = `discord.audit.${entry.command}`;
  const base = {
    timestamp: entry.timestamp,
    event,
    level,
    command: entry.command,
    actor: actorName,
    actorId: entry.actorId,
    description: '',
  };

  switch (entry.command) {
    case 'announce':
      return { ...base, message: entry.message, description: `${actor} announced: "${entry.message}"` };
    case 'kick':
      return { ...base, target: entry.target, reason: entry.reason, description: `${actor} kicked \`${entry.target}\` (Player ID: \`${entry.target}\`) — ${entry.reason}` };
    case 'ban':
      return { ...base, target: entry.target, reason: entry.reason, description: `${actor} banned \`${entry.target}\` (Player ID: \`${entry.target}\`) — ${entry.reason}` };
    case 'unban':
      return { ...base, target: entry.target, description: `${actor} unbanned \`${entry.target}\` (Player ID: \`${entry.target}\`)` };
    case 'save':
      return { ...base, description: `${actor} saved the world` };
    case 'start':
      return { ...base, description: `${actor} started the server` };
    case 'restart':
      return { ...base, description: `${actor} restarted the server` };
    case 'stop':
      return { ...base, force: !!entry.force, description: `${actor} stopped the server${entry.force ? ' (force)' : ''}` };
    case 'operator': {
      const verb = entry.action.startsWith('add') ? 'granted operator to' : 'revoked operator from';
      const mention = entry.targetType === 'role' ? `<@&${entry.target}>` : `<@${entry.target}> (ID: \`${entry.target}\`)`;
      return {
        ...base,
        action: entry.action,
        target: entry.target,
        targetType: entry.targetType,
        description: `${actor} ${verb} ${mention}`,
      };
    }
    default:
      return { ...base, description: `${actor} ran ${entry.command}` };
  }
}

function formatLogfmtValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  const str = String(val);
  if (/[\s="]|\n/.test(str)) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

const ANSI = {
  reset: '\u001b[0m',
  white: '\u001b[1;37m',
  red: '\u001b[1;31m',
  yellow: '\u001b[1;33m',
  orange: '\u001b[0;33m',
  green: '\u001b[1;32m',
  blue: '\u001b[1;34m',
  magenta: '\u001b[1;35m',
  cyan: '\u001b[36m',
};

function levelColor(level) {
  switch (level) {
    case 'ERROR':
      return ANSI.red;
    case 'AUDIT':
      return ANSI.orange;
    case 'WARN':
    case 'LEAVE':
      return ANSI.yellow;
    case 'SUCCESS':
    case 'JOIN':
      return ANSI.green;
    case 'INFO':
    default:
      return ANSI.blue;
  }
}

function formatStructuredLog(entry) {
  const timestamp = entry.timestamp || new Date().toISOString();
  const rawLevel = (entry.level || 'info').toLowerCase();
  const levelMap = {
    info: 'INFO',
    success: 'SUCCESS',
    warning: 'WARN',
    warn: 'WARN',
    danger: 'AUDIT',
    audit: 'AUDIT',
    error: 'ERROR',
    join: 'JOIN',
    leave: 'LEAVE',
  };
  const level = levelMap[rawLevel] || 'INFO';

  const event = entry.event || (entry.title ? entry.title.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'system.log');

  const color = levelColor(level);
  const timeStr = `${ANSI.white}${timestamp}${ANSI.reset}`;
  const levelStr = `${color}[${level}]${ANSI.reset}`;
  const eventStr = `${ANSI.magenta}event=${formatLogfmtValue(event)}${ANSI.reset}`;

  const fields = [];
  fields.push(eventStr);

  if (entry.description && !entry.msg && !entry.message) {
    fields.push(`${ANSI.cyan}msg=${ANSI.reset}${ANSI.white}${formatLogfmtValue(entry.description)}${ANSI.reset}`);
  }

  const reserved = new Set(['timestamp', 'level', 'event', 'title', 'description', 'diff']);

  for (const [k, v] of Object.entries(entry)) {
    if (reserved.has(k) || v === undefined || v === null || v === '') continue;
    fields.push(`${ANSI.cyan}${k}=${ANSI.reset}${ANSI.white}${formatLogfmtValue(v)}${ANSI.reset}`);
  }

  const logLine = `${timeStr} ${levelStr} ${fields.join(' ')}`;
  const ansiBlock = `\`\`\`ansi\n${logLine}\n\`\`\``;
  return entry.diff ? `${ansiBlock}\n${entry.diff}` : ansiBlock;
}

function buildLogEmbed(entry) {
  return formatStructuredLog(entry);
}

async function postToChannel(client, channelId, entry) {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    let content = typeof entry === 'string' ? entry : formatStructuredLog(entry);
    if (content.length > 2000) {
      const inCodeblock = content.endsWith('```');
      content = content.slice(0, 1980) + (inCodeblock ? '\n...\n```' : '...');
    }
    await channel.send({ content });
  } catch (err) {
    console.error(`Failed to post to channel ${channelId}:`, err.message);
  }
}

// One shared logs channel per guild -- bot events and server events both
// land in the same place, per explicit feedback that the earlier separate
// bot-log/server-log channel split wasn't needed. botLog/serverLog stay as
// two methods (most call sites already use whichever fits semantically) but
// both resolve to the same channel via `getLogChannelId(guildId)`.
function createNotifier(client, getLogChannelId) {
  const log = (guildId, entry) => postToChannel(client, getLogChannelId(guildId), entry);
  return { botLog: log, serverLog: log };
}

module.exports = {
  createNotifier,
  formatAuditEntry,
  formatStructuredLog,
  buildLogEmbed,
};

