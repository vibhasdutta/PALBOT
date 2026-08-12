const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../embeds');
const { addServerOption } = require('../serverOption');

const data = addServerOption(new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Broadcast a message to all connected players')
  .addStringOption((opt) => opt.setName('message').setDescription('Message to broadcast').setRequired(true)));
const tier = 'operator';

async function execute(interaction, ctx) {
  const message = interaction.options.getString('message', true);
  try {
    await ctx.palworld.announce(message);
    ctx.auditLog.appendAuditEntry({ guildId: interaction.guildId, actor: interaction.user.tag, actorId: interaction.user.id, command: 'announce', message });
    await interaction.reply(successEmbed(`Announced: "${message}"`, { command: 'announce', message }));
  } catch (err) {
    await interaction.reply({ ...errorEmbed(`Failed to announce: ${err.message}`, { command: 'announce' }), ephemeral: true });
  }
}

module.exports = { data, tier, execute };
