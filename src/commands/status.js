const { SlashCommandBuilder } = require('discord.js');
const { errorEmbed } = require('../embeds');
const { buildStatusEmbed } = require('../statusEmbed');
const { addServerOption } = require('../serverOption');

const data = addServerOption(new SlashCommandBuilder().setName('status').setDescription('Show Palworld server status'));
const tier = 'common';

async function execute(interaction, ctx) {
  try {
    const statusPayload = await buildStatusEmbed(ctx.palworld);
    await interaction.reply(statusPayload);
  } catch (err) {
    await interaction.reply({ ...errorEmbed(`Server unreachable: ${err.message}`), ephemeral: true });
  }
}

module.exports = { data, tier, execute };
