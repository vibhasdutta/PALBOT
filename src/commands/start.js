const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../embeds');
const { addServerOption } = require('../serverOption');

const data = addServerOption(new SlashCommandBuilder().setName('start').setDescription('Start the Palworld server process'));
const tier = 'operator';

async function execute(interaction, ctx) {
  try {
    await ctx.processControl.controlService('start');
    ctx.auditLog.appendAuditEntry({ guildId: interaction.guildId, actor: interaction.user.tag, actorId: interaction.user.id, command: 'start' });
    await interaction.reply(successEmbed('Server start triggered.', { command: 'start' }));
  } catch (err) {
    await interaction.reply({ ...errorEmbed(`Failed to start: ${err.message}`, { command: 'start' }), ephemeral: true });
  }
}

module.exports = { data, tier, execute };
