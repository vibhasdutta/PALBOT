const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../embeds');
const { addServerOption } = require('../serverOption');

const data = addServerOption(
  new SlashCommandBuilder()
    .setName('worldsettings')
    .setDescription('Open the web-based world settings editor (admin only)'),
);
const tier = 'admin';

async function execute(interaction, ctx) {
  const server = ctx.server;
  if (!server.settingsFilePath) {
    await interaction.reply({
      ...errorEmbed('No settingsFilePath configured for this server in config/servers.json.', { command: 'worldsettings' }),
      ephemeral: true,
    });
    return;
  }

  const baseUrl = ctx.webServer?.getBaseUrl();
  if (!baseUrl) {
    await interaction.reply({
      ...errorEmbed('Web settings server is not configured. Set WEB_BASE_URL and DISCORD_CLIENT_SECRET in .env.', { command: 'worldsettings' }),
      ephemeral: true,
    });
    return;
  }

  const loginUrl = `${baseUrl}/auth/login?guild=${encodeURIComponent(interaction.guildId)}&server=${encodeURIComponent(server.label)}`;

  ctx.auditLog.appendAuditEntry({
    guildId: interaction.guildId,
    actor: interaction.user.tag,
    actorId: interaction.user.id,
    command: 'worldsettings',
  });

  await interaction.reply({
    content: `🔧 **World Settings Editor**\n🔗 **[Open Settings Editor](<${loginUrl}>)**\n> *Admin only • Session lasts 30 minutes*`,
    ephemeral: true,
  });
}

module.exports = { data, tier, execute };
