const fs = require('fs');

/**
 * Parses the INI content and extracts the OptionSettings into a Map
 * @param {string} iniContent - The full INI file content
 * @returns {Map<string, string>} A map of key-value pairs
 */
function parseOptionSettings(iniContent) {
  const map = new Map();
  if (!iniContent) return map;

  const match = iniContent.match(/OptionSettings\s*=\s*\(/i);
  if (!match) return map;

  const contentStartIndex = match.index + match[0].length;
  // OptionSettings is supposed to end with a parenthesis, so let's find the closing parenthesis of the overall block.
  let contentEndIndex = iniContent.lastIndexOf(')');
  if (contentEndIndex <= contentStartIndex) {
      // Just in case it's malformed or not found
      contentEndIndex = iniContent.length;
  }
  const settingsString = iniContent.substring(contentStartIndex, contentEndIndex);

  let currentKey = '';
  let currentValue = '';
  let isKey = true;
  let inQuotes = false;
  let nestedParens = 0;

  for (let i = 0; i < settingsString.length; i++) {
    const char = settingsString[i];

    if (inQuotes) {
      if (char === '"') {
        inQuotes = false;
      }
      currentValue += char;
    } else if (char === '"') {
      inQuotes = true;
      currentValue += char;
    } else if (char === '(') {
      nestedParens++;
      currentValue += char;
    } else if (char === ')') {
      nestedParens--;
      currentValue += char;
    } else if (char === '=' && isKey) {
      isKey = false;
    } else if (char === ',' && !inQuotes && nestedParens === 0) {
      map.set(currentKey.trim(), currentValue);
      currentKey = '';
      currentValue = '';
      isKey = true;
    } else {
      if (isKey) {
        currentKey += char;
      } else {
        currentValue += char;
      }
    }
  }

  if (currentKey) {
    map.set(currentKey.trim(), currentValue);
  }

  return map;
}

function serializeOptionSettings(settingsMap) {
  const settingsArray = [];
  for (const [key, value] of settingsMap.entries()) {
    settingsArray.push(`${key}=${value}`);
  }
  const settingsString = settingsArray.join(',');
  return `[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(${settingsString})\n`;
}

const path = require('path');

function readWorldSettings(settingsFilePath, readFileSync = fs.readFileSync) {
  try {
    const content = readFileSync(settingsFilePath, 'utf8');
    return {
      settings: parseOptionSettings(content),
      exists: true
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        const defaultPath = path.resolve(path.dirname(settingsFilePath), '../../../../DefaultPalWorldSettings.ini');
        const defaultContent = readFileSync(defaultPath, 'utf8');
        return {
          settings: parseOptionSettings(defaultContent),
          exists: true,
          isDefaultFallback: true
        };
      } catch {
        return {
          settings: new Map(),
          exists: false
        };
      }
    }
    throw error;
  }
}

function writeWorldSettings(settingsFilePath, settingsMap, writeFileSync = fs.writeFileSync, mkdirSync = fs.mkdirSync) {
  try {
    const dir = path.dirname(settingsFilePath);
    if (mkdirSync && dir) {
      mkdirSync(dir, { recursive: true });
    }
    const content = serializeOptionSettings(settingsMap);
    writeFileSync(settingsFilePath, content, 'utf8');
    return true;
  } catch (error) {
    console.error(`Failed to write settings to ${settingsFilePath}:`, error.message);
    return false;
  }
}

module.exports = {
  parseOptionSettings,
  serializeOptionSettings,
  readWorldSettings,
  writeWorldSettings
};
