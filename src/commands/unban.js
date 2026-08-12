const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../embeds');
const { addServerOption } = require('../serverOption');

const data = addServerOption(new SlashCommandBuilder()
  .setName('unban')
  .setDescription('Remove a player ban')
  .addStringOption((opt) => opt.setName('userid').setDescription('Player ID (e.g. steam_xxxx)').setRequired(true)));
const tier = 'operator';

async function execute(interaction, ctx) {
  const userid = interaction.options.getString('userid', true);
  try {
    await ctx.palworld.unban(userid);
    ctx.auditLog.appendAuditEntry({ guildId: interaction.guildId, actor: interaction.user.tag, actorId: interaction.user.id, command: 'unban', target: userid });
    await ctx.palworld.announce(`${userid} was unbanned.`).catch(() => {});
    await interaction.reply(successEmbed(`Unbanned \`${userid}\`.`, { command: 'unban', target: userid }));
  } catch (err) {
    await interaction.reply({ ...errorEmbed(`Failed to unban: ${err.message}`, { command: 'unban', target: userid }), ephemeral: true });
  }
}

module.exports = { data, tier, execute };
