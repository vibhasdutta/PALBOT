const { SlashCommandBuilder } = require('discord.js');
const { awaitConfirmation } = require('../confirm');
const { successEmbed, errorEmbed } = require('../embeds');
const { addServerOption } = require('../serverOption');
const { addUserIdOption } = require('../playerOption');

// Declared in server -> userid -> reason order so filling out the command in
// Discord naturally goes "pick a server" first, then userid's autocomplete
// filters to that server's connected players.
const data = addUserIdOption(addServerOption(new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a player from the server')))
  .addStringOption((opt) => opt.setName('reason').setDescription('Reason shown to the player'));
const tier = 'operator';

async function execute(interaction, ctx) {
  const userid = interaction.options.getString('userid');
  if (!userid) {
    await interaction.reply({ ...errorEmbed('Specify a player to ban (the `userid` option).', { command: 'ban' }), ephemeral: true });
    return;
  }
  const reason = interaction.options.getString('reason') || 'Banned by an admin.';

  const confirmed = await awaitConfirmation(interaction, `ban:${userid}`);
  if (!confirmed) return;

  try {
    await ctx.palworld.ban(userid, reason);
    ctx.auditLog.appendAuditEntry({ guildId: interaction.guildId, actor: interaction.user.tag, actorId: interaction.user.id, command: 'ban', target: userid, reason });
    await ctx.palworld.announce(`${userid} was banned. Reason: ${reason}`).catch(() => {});
    await interaction.followUp(successEmbed(`Banned \`${userid}\`.`, { command: 'ban', target: userid, reason }));
  } catch (err) {
    await interaction.followUp({ ...errorEmbed(`Failed to ban: ${err.message}`, { command: 'ban', target: userid }), ephemeral: true });
  }
}

module.exports = { data, tier, execute };
