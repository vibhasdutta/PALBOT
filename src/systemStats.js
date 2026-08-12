const os = require('node:os');

function getSystemStats(osImpl = os) {
  const [cpuLoad1m] = osImpl.loadavg();
  const totalMem = osImpl.totalmem();
  const freeMem = osImpl.freemem();
  return {
    cpuLoad1m,
    cpuCount: osImpl.cpus().length,
    memUsedMb: Math.round((totalMem - freeMem) / 1024 / 1024),
    memTotalMb: Math.round(totalMem / 1024 / 1024),
  };
}

module.exports = { getSystemStats };
