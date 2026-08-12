const { REST, Routes } = require('discord.js');
const { loadConfig } = require('./config');
const loadCommands = require('./commands');

const config = loadConfig();
const commandData = [...loadCommands().values()].map((c) => c.data.toJSON());
const rest = new REST().setToken(config.discordToken);

(async () => {
  if (config.guilds.length === 0) {
    const data = await rest.put(Routes.applicationCommands(config.clientId), { body: commandData });
    console.log(`No guilds configured — registered ${data.length} commands globally (can take up to an hour to propagate).`);
    return;
  }

  for (const guild of config.guilds) {
    const data = await rest.put(
      Routes.applicationGuildCommands(config.clientId, guild.guildId),
      { body: commandData },
    );
    console.log(`Registered ${data.length} commands in guild ${guild.guildId}.`);
  }
})();
