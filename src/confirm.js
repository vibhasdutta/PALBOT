const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function buildConfirmRow(actionId) {
  const confirmId = `confirm:${actionId}`;
  const cancelId = `cancel:${actionId}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return { row, confirmId, cancelId };
}

async function awaitConfirmation(interaction, actionId, { timeoutMs = 15000, embeds = [] } = {}) {
  const { row, confirmId, cancelId } = buildConfirmRow(actionId);

  const previewContent = embeds[0]?.content ? `${embeds[0].content}\nAre you sure? This action cannot be undone.` : 'Are you sure? This action cannot be undone.';
  const activeEmbeds = embeds[0]?.content ? [] : embeds;

  const reply = await interaction.reply({
    content: previewContent,
    embeds: activeEmbeds,
    components: [row],
    ephemeral: true,
    fetchReply: true,
  });

  try {
    const buttonInteraction = await reply.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id && [confirmId, cancelId].includes(i.customId),
      time: timeoutMs,
    });
    const confirmed = buttonInteraction.customId === confirmId;
    await buttonInteraction.update({ content: confirmed ? 'Confirmed.' : 'Cancelled.', embeds: [], components: [] });
    return confirmed;
  } catch (err) {
    // Not just a timeout — anything that breaks this flow (a code error, a
    // Discord API rejection) previously got silently reported to the user as
    // "timed out," hiding real bugs. Log the actual cause instead.
    console.error(`awaitConfirmation(${actionId}) did not resolve to a button click:`, err?.message || err);
    await interaction.editReply({ content: 'Confirmation timed out or failed — check the bot logs.', embeds: [], components: [] }).catch(() => {});
    return false;
  }
}

module.exports = { buildConfirmRow, awaitConfirmation };
