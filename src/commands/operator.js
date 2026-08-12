const { SlashCommandBuilder } = require('discord.js');
const { mutateGuildRoles } = require('../config');
const { successEmbed, errorEmbed } = require('../embeds');

const data = new SlashCommandBuilder()
  .setName('operator')
  .setDescription('Manage who has operator access in this server')
  .addSubcommand((sub) => sub
    .setName('add-role')
    .setDescription('Grant operator access to everyone with a role')
    .addRoleOption((opt) => opt.setName('role').setDescription('Role to grant operator to').setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('add-user')
    .setDescription('Grant operator access to a specific user')
    .addUserOption((opt) => opt.setName('user').setDescription('User to grant operator to').setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('remove-role')
    .setDescription('Revoke operator access from a role')
    .addRoleOption((opt) => opt.setName('role').setDescription('Role to revoke operator from').setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('remove-user')
    .setDescription('Revoke operator access from a specific user')
    .addUserOption((opt) => opt.setName('user').setDescription('User to revoke operator from').setRequired(true)))
  .addSubcommand((sub) => sub.setName('list').setDescription('List current operator roles and users'));
const tier = 'admin';
const needsServer = false; // manages roles.json, not the Palworld connection

function mentionRoles(roleIds) {
  return roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(', ') : '*none*';
}

function mentionUsers(userIds) {
  return userIds.length ? userIds.map((id) => `<@${id}>`).join(', ') : '*none*';
}

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === 'list') {
    const entry = ctx.config.roles.find((r) => r.guildId === guildId);
    const operator = entry?.operator ?? { roleIds: [], userIds: [] };
    await interaction.reply({
      ...successEmbed(`Operator roles: ${mentionRoles(operator.roleIds)} | Operator users: ${mentionUsers(operator.userIds)}`, { command: 'operator', sub }),
      ephemeral: true,
    });
    return;
  }

  const isRoleAction = sub === 'add-role' || sub === 'remove-role';
  const isAdd = sub === 'add-role' || sub === 'add-user';
  const target = isRoleAction ? interaction.options.getRole('role', true) : interaction.options.getUser('user', true);
  const targetType = isRoleAction ? 'role' : 'user';
  const listKey = isRoleAction ? 'roleIds' : 'userIds';

  try {
    mutateGuildRoles(ctx.config.rolesPath, guildId, (entry) => {
      const list = entry.operator[listKey];
      if (isAdd) {
        if (!list.includes(target.id)) list.push(target.id);
      } else {
        entry.operator[listKey] = list.filter((id) => id !== target.id);
      }
    });

    ctx.auditLog.appendAuditEntry({
      guildId,
      actor: interaction.user.tag,
      actorId: interaction.user.id,
      command: 'operator',
      action: sub,
      target: target.id,
      targetType,
    });

    const mention = targetType === 'role' ? `<@&${target.id}>` : `<@${target.id}>`;
    const verb = isAdd ? 'Granted operator access to' : 'Revoked operator access from';
    await interaction.reply(successEmbed(`${verb} ${mention}.`, { command: 'operator', sub, target: target.id }));
  } catch (err) {
    await interaction.reply({ ...errorEmbed(`Failed: ${err.message}`, { command: 'operator' }), ephemeral: true });
  }
}

module.exports = { data, tier, execute, needsServer };
