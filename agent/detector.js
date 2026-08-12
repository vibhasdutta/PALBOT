const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

function readIniOptionSettings(iniPath) {
  try {
    const content = fs.readFileSync(iniPath, 'utf8');
    const password = content.match(/AdminPassword="([^"]*)"/)?.[1] || null;
    const port = content.match(/RESTAPIPort=(\d+)/)?.[1] || '8212';
    const restApiEnabled = /bEnableRESTAPI=True/i.test(content);
    return {
      restApiPassword: password,
      restApiPort: port,
      restApiUrl: `http://localhost:${port}`,
      restApiEnabled,
    };
  } catch {
    return null;
  }
}

function findSaveFilesNearIni(iniPath) {
  // PalWorldSettings.ini is typically at:
  // .../Pal/Saved/Config/LinuxServer/PalWorldSettings.ini
  // SaveGames are typically at:
  // .../Pal/Saved/SaveGames/0/<WORLD_ID>/Level.sav
  const palSavedDir = path.resolve(path.dirname(iniPath), '..', '..');
  const saveGamesDir = path.join(palSavedDir, 'SaveGames');

  if (!fs.existsSync(saveGamesDir)) return null;

  try {
    // Find Level.sav recursively inside SaveGames
    const results = [];
    function searchDir(current) {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          searchDir(fullPath);
        } else if (entry.isFile() && entry.name === 'Level.sav') {
          results.push(fullPath);
        }
      }
    }
    searchDir(saveGamesDir);
    return results[0] || null;
  } catch {
    return null;
  }
}

function detectPm2ProcessNames() {
  try {
    const output = execSync('pm2 jlist', { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const list = JSON.parse(output);
    if (!Array.isArray(list)) return [];
    
    // Return names of active PM2 processes matching palworld / pal / server
    return list
      .filter((p) => p.name && /palworld|palserver|pal/i.test(p.name))
      .map((p) => p.name);
  } catch {
    return [];
  }
}

function getCandidateIniPaths() {
  const home = os.homedir();
  const candidates = [
    // Standard Steam / Linux paths
    path.join(home, 'palworld', 'Pal', 'Saved', 'Config', 'LinuxServer', 'PalWorldSettings.ini'),
    path.join(home, 'PalServer', 'Pal', 'Saved', 'Config', 'LinuxServer', 'PalWorldSettings.ini'),
    path.join(home, '.steam', 'steam', 'steamapps', 'common', 'PalServer', 'Pal', 'Saved', 'Config', 'LinuxServer', 'PalWorldSettings.ini'),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'PalServer', 'Pal', 'Saved', 'Config', 'LinuxServer', 'PalWorldSettings.ini'),
    '/opt/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
    '/var/lib/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
    // Windows paths
    'C:\\PalServer\\Pal\\Saved\\Config\\WindowsServer\\PalWorldSettings.ini',
  ];

  // Also check current working directory
  const cwdIni = path.join(process.cwd(), 'Pal', 'Saved', 'Config', 'LinuxServer', 'PalWorldSettings.ini');
  candidates.push(cwdIni);

  return [...new Set(candidates)];
}

function detectLocalServers() {
  const iniPaths = getCandidateIniPaths();
  const pm2Names = detectPm2ProcessNames();
  const detected = [];

  let idx = 0;
  for (const iniPath of iniPaths) {
    if (!fs.existsSync(iniPath)) continue;

    const iniData = readIniOptionSettings(iniPath);
    if (!iniData) continue;

    const saveFilePath = findSaveFilesNearIni(iniPath);
    const pm2ProcessName = pm2Names[idx] || pm2Names[0] || 'palworld';
    const label = iniData.restApiPort ? `server-${iniData.restApiPort}` : `server-${idx + 1}`;

    detected.push({
      label,
      restApiUrl: iniData.restApiUrl,
      restApiPassword: iniData.restApiPassword || '',
      restApiEnabled: iniData.restApiEnabled,
      pm2ProcessName,
      saveFilePath: saveFilePath || '',
      settingsFilePath: iniPath,
    });
    idx++;
  }

  // If no INI was found but PM2 processes are running
  if (detected.length === 0 && pm2Names.length > 0) {
    pm2Names.forEach((pm2Name, i) => {
      detected.push({
        label: pm2Names.length === 1 ? 'main' : `server-${i + 1}`,
        restApiUrl: `http://localhost:${8212 + i}`,
        restApiPassword: '',
        pm2ProcessName: pm2Name,
        saveFilePath: '',
        settingsFilePath: '',
      });
    });
  }

  return detected;
}

module.exports = { detectLocalServers, getCandidateIniPaths, readIniOptionSettings, findSaveFilesNearIni };
