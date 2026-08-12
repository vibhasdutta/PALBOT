const fs = require('node:fs');
const path = require('node:path');
const { Collection } = require('discord.js');

function loadCommands(dir = __dirname) {
  const commands = new Collection();
  for (const file of fs.readdirSync(dir)) {
    if (file === 'index.js' || !file.endsWith('.js')) continue;
    const command = require(path.join(dir, file));
    commands.set(command.data.name, command);
  }
  return commands;
}

module.exports = loadCommands;
