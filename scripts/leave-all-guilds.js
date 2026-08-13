#!/usr/bin/env node
// One-off utility: makes the bot leave every guild it's currently a
// member of. Useful for forcing a clean re-onboard -- ensureGuildEntry()
// treats a guild as brand new the moment the bot rejoins it, without
// needing to hand-edit config/guilds.json, roles.json, or servers.json.
//
// DESTRUCTIVE: this removes the bot from every server it's in, including
// ones actively in use. You'll need to re-invite it everywhere afterward.
// Existing config/servers.json data for those guilds is NOT touched by
// this script -- only Discord membership changes.
//
// Usage: node --env-file=.env scripts/leave-all-guilds.js
const { Client, GatewayIntentBits, Events } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is not set. Run with: node --env-file=.env scripts/leave-all-guilds.js');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  const guilds = [...readyClient.guilds.cache.values()];
  console.log(`Logged in as ${readyClient.user.tag}. Leaving ${guilds.length} guild(s)...`);

  for (const guild of guilds) {
    try {
      await guild.leave();
      console.log(`Left "${guild.name}" (${guild.id})`);
    } catch (err) {
      console.error(`Failed to leave "${guild.name}" (${guild.id}):`, err.message);
    }
  }

  console.log('Done.');
  process.exit(0);
});

client.login(token);
