const { SlashCommandBuilder } = require('discord.js');
const { awaitConfirmation } = require('../confirm');
const { successEmbed, errorEmbed } = require('../embeds');
const { buildStatusEmbed } = require('../statusEmbed');
const { PalworldApiError } = require('../palworldClient');
const { addServerOption } = require('../serverOption');
const { runShutdownCountdown } = require('../shutdownCountdown');

const data = addServerOption(new SlashCommandBuilder()
  .setName('restart')
  .setDescription('Restart the Palworld server process')
  .addIntegerOption((opt) => opt.setName('waittime').setDescription('Seconds to warn players before restarting').setMinValue(0)));
const tier = 'operator';

async function execute(interaction, ctx) {
  const lockKey = `${interaction.guildId}:${ctx.server.label}`;
  const inFlight = ctx.actionLock.tryAcquire(lockKey, 'restart');
  if (inFlight) {
    await interaction.reply({ ...errorEmbed(`A ${inFlight} is already in progress for this server.`, { command: 'restart' }), ephemeral: true });
    return;
  }

  try {
    const waittime = interaction.options.getInteger('waittime') ?? 5;

    let statusEmbeds = [];
    try {
      statusEmbeds = [await buildStatusEmbed(ctx.palworld)];
    } catch {
      // server unreachable — proceed without a status preview
    }

    const confirmed = await awaitConfirmation(interaction, 'restart', { embeds: statusEmbeds });
    if (!confirmed) return;

    let restApiWorked = true;
    try {
      await ctx.palworld.announce(`Server is restarting in ${waittime} seconds.`);
      await ctx.palworld.save();
    } catch (err) {
      if (!(err instanceof PalworldApiError)) throw err;
      // REST API unreachable — nothing to announce to, go straight to restart.
      restApiWorked = false;
    }

    if (waittime > 0) {
      // Periodic in-game reminders as the clock runs down, not just the one
      // message sent above -- only meaningful if the REST API actually
      // worked, since that's what the reminders themselves go through.
      if (restApiWorked) {
        await runShutdownCountdown(ctx.palworld, waittime);
      } else {
        await new Promise((resolve) => setTimeout(resolve, waittime * 1000));
      }
    }

    try {
      await ctx.processControl.controlService('restart');
      ctx.auditLog.appendAuditEntry({ guildId: interaction.guildId, actor: interaction.user.tag, actorId: interaction.user.id, command: 'restart', waittime });
      await interaction.followUp(successEmbed('Server restart triggered.', { command: 'restart', waittime }));
    } catch (err) {
      await interaction.followUp({ ...errorEmbed(`Failed to restart: ${err.message}`, { command: 'restart' }), ephemeral: true });
    }
  } finally {
    ctx.actionLock.release(lockKey);
  }
}

module.exports = { data, tier, execute };
