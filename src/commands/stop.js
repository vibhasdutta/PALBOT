const { SlashCommandBuilder } = require('discord.js');
const { awaitConfirmation } = require('../confirm');
const { PalworldApiError } = require('../palworldClient');
const { successEmbed, errorEmbed } = require('../embeds');
const { buildStatusEmbed } = require('../statusEmbed');
const { addServerOption } = require('../serverOption');
const { runShutdownCountdown } = require('../shutdownCountdown');

const data = addServerOption(new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop the Palworld server')
  .addIntegerOption((opt) => opt.setName('waittime').setDescription('Seconds to warn players before shutdown').setMinValue(0))
  .addBooleanOption((opt) => opt.setName('force').setDescription('Force stop immediately, skipping the in-game warning')));
const tier = 'operator';

async function execute(interaction, ctx) {
  const lockKey = `${interaction.guildId}:${ctx.server.label}`;
  const inFlight = ctx.actionLock.tryAcquire(lockKey, 'stop');
  if (inFlight) {
    await interaction.reply({ ...errorEmbed(`A ${inFlight} is already in progress for this server.`, { command: 'stop' }), ephemeral: true });
    return;
  }

  try {
    const waittime = interaction.options.getInteger('waittime') ?? 5;
    const force = interaction.options.getBoolean('force') ?? false;

    let statusEmbeds = [];
    let reachable = true;
    try {
      statusEmbeds = [await buildStatusEmbed(ctx.palworld)];
    } catch {
      reachable = false;
      // server unreachable — proceed without a status preview
    }

    // Not reachable and not forcing means there's nothing running to stop
    // -- force still goes through in case pm2 has a zombied process REST
    // just isn't answering for.
    if (!reachable && !force) {
      await interaction.reply(successEmbed('Server already appears to be stopped (not reachable).', { command: 'stop' }));
      return;
    }

    const confirmed = await awaitConfirmation(interaction, 'stop', { embeds: statusEmbeds });
    if (!confirmed) return;

    let restApiWorked = true;
    try {
      if (force) {
        // /v1/api/stop has no message parameter at all -- announce separately
        // first so players get at least some warning instead of none.
        await ctx.palworld.announce('Server is stopping now.').catch(() => {});
        await ctx.palworld.stop();
      } else {
        await ctx.palworld.shutdown(waittime, `Server is shutting down in ${waittime} seconds.`);
      }
    } catch (err) {
      if (!(err instanceof PalworldApiError)) {
        await interaction.followUp({ ...errorEmbed(`Failed to stop: ${err.message}`, { command: 'stop' }), ephemeral: true });
        return;
      }
      restApiWorked = false;
    }

    if (restApiWorked) {
      // PalServer's own REST shutdown makes the process exit on its own timeline
      // (immediately for force, after the in-game countdown otherwise). PM2's
      // autorestart can't tell that apart from a crash and brings it right back
      // up -- wait for the exit, then explicitly `pm2 stop` so PM2 knows this
      // was intentional and stays down. The non-force wait doubles as a
      // countdown: players still get periodic in-game reminders (300/120/
      // 60/30/10/5/3/2/1s) as the clock runs down, not just the one message
      // sent when shutdown() was first called.
      if (force) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } else {
        await runShutdownCountdown(ctx.palworld, waittime);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    try {
      await ctx.processControl.controlService('stop');
      ctx.auditLog.appendAuditEntry({
        guildId: interaction.guildId,
        actor: interaction.user.tag,
        actorId: interaction.user.id,
        command: 'stop',
        force,
        waittime,
        via: restApiWorked ? 'rest+pm2' : 'pm2-fallback',
      });
      await interaction.followUp(successEmbed('Server stopped.', { command: 'stop', force, waittime }));
    } catch (err) {
      await interaction.followUp({ ...errorEmbed(`Failed to stop: ${err.message}`, { command: 'stop' }), ephemeral: true });
    }
  } finally {
    ctx.actionLock.release(lockKey);
  }
}

module.exports = { data, tier, execute };
