const { SlashCommandBuilder } = require('discord.js');
const { awaitConfirmation } = require('../confirm');
const { successEmbed, errorEmbed } = require('../embeds');
const { buildStatusEmbed } = require('../statusEmbed');
const { PalworldApiError } = require('../palworldClient');
const { addServerOption } = require('../serverOption');

const data = addServerOption(new SlashCommandBuilder()
  .setName('restart')
  .setDescription('Restart the Palworld server process')
  .addIntegerOption((opt) => opt.setName('waittime').setDescription('Seconds to warn players before restarting').setMinValue(0)));
const tier = 'operator';

async function execute(interaction, ctx) {
  const waittime = interaction.options.getInteger('waittime') ?? 5;

  let statusEmbeds = [];
  try {
    statusEmbeds = [await buildStatusEmbed(ctx.palworld)];
  } catch {
    // server unreachable — proceed without a status preview
  }

  const confirmed = await awaitConfirmation(interaction, 'restart', { embeds: statusEmbeds });
  if (!confirmed) return;

  try {
    await ctx.palworld.announce(`Server is restarting in ${waittime} seconds.`);
    await ctx.palworld.save();
  } catch (err) {
    if (!(err instanceof PalworldApiError)) throw err;
    // REST API unreachable — nothing to announce to, go straight to restart.
  }

  if (waittime > 0) {
    await new Promise((resolve) => setTimeout(resolve, waittime * 1000));
  }

  try {
    await ctx.processControl.controlService('restart');
    ctx.auditLog.appendAuditEntry({ guildId: interaction.guildId, actor: interaction.user.tag, actorId: interaction.user.id, command: 'restart', waittime });
    await interaction.followUp(successEmbed('Server restart triggered.', { command: 'restart', waittime }));
  } catch (err) {
    await interaction.followUp({ ...errorEmbed(`Failed to restart: ${err.message}`, { command: 'restart' }), ephemeral: true });
  }
}

module.exports = { data, tier, execute };
