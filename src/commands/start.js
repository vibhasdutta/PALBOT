const { SlashCommandBuilder } = require('discord.js');
const { successEmbed, errorEmbed } = require('../embeds');
const { addServerOption } = require('../serverOption');

const data = addServerOption(new SlashCommandBuilder().setName('start').setDescription('Start the Palworld server process'));
const tier = 'operator';

async function execute(interaction, ctx) {
  const lockKey = `${interaction.guildId}:${ctx.server.label}`;
  const inFlight = ctx.actionLock.tryAcquire(lockKey, 'start');
  if (inFlight) {
    await interaction.reply({ ...errorEmbed(`A ${inFlight} is already in progress for this server.`, { command: 'start' }), ephemeral: true });
    return;
  }

  try {
    // REST reachable means the process is already up -- pm2 start on an
    // already-running process isn't harmful, but there's nothing useful
    // for it to do, so say so instead of pretending to trigger a start.
    let alreadyRunning = false;
    try {
      await ctx.palworld.getInfo();
      alreadyRunning = true;
    } catch {
      // unreachable — genuinely not running, proceed below.
    }
    if (alreadyRunning) {
      await interaction.reply(successEmbed('Server is already running.', { command: 'start' }));
      return;
    }

    await ctx.processControl.controlService('start');
    ctx.auditLog.appendAuditEntry({ guildId: interaction.guildId, actor: interaction.user.tag, actorId: interaction.user.id, command: 'start' });
    await interaction.reply(successEmbed('Server start triggered.', { command: 'start' }));
  } catch (err) {
    await interaction.reply({ ...errorEmbed(`Failed to start: ${err.message}`, { command: 'start' }), ephemeral: true });
  } finally {
    ctx.actionLock.release(lockKey);
  }
}

module.exports = { data, tier, execute };
