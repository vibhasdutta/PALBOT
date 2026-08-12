const { SlashCommandBuilder } = require('discord.js');
const { errorEmbed } = require('../embeds');

const data = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Open the bot dashboard (register servers, manage access, edit world settings)');
const tier = 'common';
// Doesn't target a specific server -- the dashboard itself decides what
// you can see and do once you're logged in, based on ownership and
// per-server tierGrants, not on which server was picked here.
const needsServer = false;

async function execute(interaction, ctx) {
  const baseUrl = ctx.webServer?.getBaseUrl();
  if (!baseUrl) {
    await interaction.reply({
      ...errorEmbed('Web dashboard is not configured. Set WEB_BASE_URL and DISCORD_CLIENT_SECRET in .env.', { command: 'dashboard' }),
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `🔧 **Bot Dashboard**\n🔗 **[Open Dashboard](<${baseUrl}/dashboard/login>)**\n> *Register servers, manage guild access, and edit world settings*`,
    ephemeral: true,
  });
}

module.exports = { data, tier, execute, needsServer };
