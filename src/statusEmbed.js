const { formatStructuredLog } = require('./notify');
const { getSystemStats } = require('./systemStats');

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

async function buildStatusEmbed(palworld) {
  const [info, { players = [] }, metrics] = await Promise.all([
    palworld.getInfo(),
    palworld.getPlayers(),
    palworld.getMetrics(),
  ]);
  const system = getSystemStats();

  const content = formatStructuredLog({
    event: 'server.status',
    level: 'success',
    server: info.servername,
    version: info.version,
    players: `${players.length}/${metrics.maxplayernum}`,
    in_game_day: metrics.days,
    fps: `${metrics.serverfps} (${metrics.serverframetime.toFixed(1)}ms)`,
    uptime: formatUptime(metrics.uptime),
    cpu: `${system.cpuLoad1m.toFixed(2)} / ${system.cpuCount} cores`,
    mem: `${system.memUsedMb}MB / ${system.memTotalMb}MB`,
  });

  return { content };
}

module.exports = { buildStatusEmbed, formatUptime };
