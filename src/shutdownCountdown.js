const MILESTONES = [300, 120, 60, 30, 10, 5, 3, 2, 1];

// Announces at each whole-second milestone crossed as `waittime` counts
// down (skipping thresholds that don't apply, e.g. no "10s" warning for a
// 5-second wait), on top of whatever message shutdown() itself already
// sent immediately when the stop was first triggered. `sleep` is
// injectable so tests don't have to wait in real time.
async function runShutdownCountdown(palworld, waittime, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const milestones = MILESTONES.filter((s) => s < waittime);
  let remaining = waittime;
  for (const mark of milestones) {
    await sleep((remaining - mark) * 1000);
    await palworld.announce(`Server shutting down in ${mark} second${mark === 1 ? '' : 's'}.`).catch(() => {});
    remaining = mark;
  }
  await sleep(remaining * 1000);
}

module.exports = { runShutdownCountdown };
