const { findGuildServers } = require('./config');

// Every command that talks to a Palworld server takes the same optional
// `server` option -- only needed when a guild has more than one. Sharing
// this builder and the autocomplete handler keeps that consistent across
// all 10 command files instead of repeating the option definition in each.
function addServerOption(builder) {
  return builder.addStringOption((opt) => opt
    .setName('server')
    .setDescription('Which server (only needed if this guild has more than one)')
    .setAutocomplete(true));
}

async function autocompleteServer(interaction, config) {
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = findGuildServers(config.servers, interaction.guildId)
    .filter((s) => s.label.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((s) => ({ name: s.label, value: s.label }));
  await interaction.respond(choices);
}

module.exports = { addServerOption, autocompleteServer };
