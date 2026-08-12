const { SlashCommandBuilder } = require('discord.js');
const { errorEmbed } = require('../embeds');
const { addServerOption } = require('../serverOption');
const { formatStructuredLog } = require('../notify');

const { cleanPlayerId } = require('../playerPoller');

const data = addServerOption(new SlashCommandBuilder().setName('players').setDescription('List connected players'));
const tier = 'common';

async function execute(interaction, ctx) {
  try {
    const { players = [] } = await ctx.palworld.getPlayers();
    if (!players || players.length === 0) {
      await interaction.reply(errorEmbed('No players are currently connected.', { event: 'player.list', count: 0 }));
      return;
    }

    const listStr = players.map((p, i) => `${i + 1}. player="${p.name}" id=${cleanPlayerId(p.playerId) ?? p.userId ?? p.accountName ?? 'unknown'}`).join('\n');
    const logHeader = formatStructuredLog({ event: 'player.list', count: players.length, level: 'success', description: 'Connected players' });
    // Strip trailing ``` and append list cleanly inside codeblock
    const codeContent = logHeader.replace(/\n```$/, `\n${listStr}\n\`\`\``);
    await interaction.reply({ content: codeContent });
  } catch (err) {
    await interaction.reply({ ...errorEmbed(`Server unreachable: ${err.message}`), ephemeral: true });
  }
}

module.exports = { data, tier, execute };
