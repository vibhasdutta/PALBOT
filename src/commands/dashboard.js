const { SlashCommandBuilder } = require('discord.js');
const { errorEmbed } = require('../embeds');

const data = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Open the bot dashboard (register servers, manage access, edit world settings)');
// No tier requirement -- getting the login link isn't sensitive, and
// gating it behind config/roles.json would be a chicken-and-egg problem
// for anyone only using the newer per-server tierGrants system (nobody to
// grant them roles.json access in the first place). Real authorization
// happens web-side after login (requireOwnedAgent / admin-tier tierGrants
// checks in webServer.js), not here.
const tier = null;
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
