const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../embeds');
const { addServerOption } = require('../serverOption');
const { addUserIdOption } = require('../playerOption');

// Declared in server -> userid -> reason order so filling out the command in
// Discord naturally goes "pick a server" first, then userid's autocomplete
// filters to that server's connected players.
const data = addUserIdOption(addServerOption(new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a player from the server')))
  .addStringOption((opt) => opt.setName('reason').setDescription('Reason shown to the player'));
const tier = 'operator';

async function execute(interaction, ctx) {
  const userid = interaction.options.getString('userid');
  if (!userid) {
    await interaction.reply({ ...errorEmbed('Specify a player to kick (the `userid` option).', { command: 'kick' }), ephemeral: true });
    return;
  }
  const reason = interaction.options.getString('reason') || 'Kicked by an admin.';
  try {
    await ctx.palworld.kick(userid, reason);
    ctx.auditLog.appendAuditEntry({ guildId: interaction.guildId, actor: interaction.user.tag, actorId: interaction.user.id, command: 'kick', target: userid, reason });
    await ctx.palworld.announce(`${userid} was kicked. Reason: ${reason}`).catch(() => {});
    await interaction.reply(successEmbed(`Kicked \`${userid}\`.`, { command: 'kick', target: userid, reason }));
  } catch (err) {
    await interaction.reply({ ...errorEmbed(`Failed to kick: ${err.message}`, { command: 'kick', target: userid }), ephemeral: true });
  }
}

module.exports = { data, tier, execute };
