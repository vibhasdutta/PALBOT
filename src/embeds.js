const { formatStructuredLog } = require('./notify');

function successEmbed(description, fields = {}) {
  const content = formatStructuredLog({ level: 'success', description, ...fields });
  return { content };
}

function errorEmbed(description, fields = {}) {
  const content = formatStructuredLog({ level: 'danger', description, ...fields });
  return { content };
}

module.exports = { successEmbed, errorEmbed };
