const express = require('express');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { readWorldSettings, writeWorldSettings } = require('./worldSettingsParser');
const { SETTINGS_SCHEMA, CATEGORIES } = require('./settingsSchema');
const { resolveTier, resolveTierFromGrants, hasAccess, findGuildRoles } = require('./permissions');
const { findGuildServer, findEntriesByServer, mutateGuildEntry, loadServersFile, ensureGuildEntry } = require('./config');
const { controlService } = require('./processControl');
const { findAgentsByOwner, claimAgent } = require('./agentStore');

// Configuration constants from ENV
const WEB_PORT = process.env.WEB_PORT || 8090;
const WEB_SECRET = process.env.WEB_SECRET || crypto.randomBytes(32).toString('hex');
const WEB_BASE_URL = process.env.WEB_BASE_URL || `http://localhost:${WEB_PORT}`;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

// Helper: Signing and verification
function signPayload(payload, secret) {
  const json = JSON.stringify(payload);
  const base64url = Buffer.from(json).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(base64url).digest('base64url');
  return `${base64url}.${hmac}`;
}

function verifyPayload(signed, secret) {
  if (!signed || typeof signed !== 'string') return null;
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [base64url, signature] = parts;
  const expectedHmac = crypto.createHmac('sha256', secret).update(base64url).digest('base64url');
  if (expectedHmac !== signature) return null;
  
  try {
    const json = Buffer.from(base64url, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Helper: parse cookies
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    if (!value) return;
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// Helper: escape HTML
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>'"]/g, (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[tag]));
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj || {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\//g, '\\u002f')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const ERROR_TEMPLATE = (title, message) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Palworld Settings</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      background-color: #0f172a;
      color: #f8fafc;
      font-family: 'Inter', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1rem;
    }
    .card {
      background-color: #1e293b;
      border: 1px solid #334155;
      border-radius: 0.5rem;
      padding: 2.5rem;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #dc2626; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>
`;

const LOGOUT_TEMPLATE = () => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Logged Out - Palworld Settings</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      background-color: #0f172a;
      color: #f8fafc;
      font-family: 'Inter', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background-color: #1e293b;
      border: 1px solid #334155;
      border-radius: 0.5rem;
      padding: 2.5rem;
      text-align: center;
    }
    h1 { font-size: 1.5rem; color: #16a34a; margin-bottom: 0.5rem; }
    p { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Logged Out</h1>
    <p>Your session has been securely terminated.</p>
  </div>
</body>
</html>
`;

// The HTML Template
const HTML_TEMPLATE = (user, serverName, serverLabel, settings, schema, categories) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Palworld Server Settings - ${escapeHtml(serverLabel)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0f172a;
      --card-bg: #1e293b;
      --item-bg: #0f172a;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --success: #16a34a;
      --error: #dc2626;
      --warning: #d97706;
      --border: #334155;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
    body { background-color: var(--bg-color); color: var(--text-main); padding-bottom: 80px; min-height: 100vh; }
    
    .header {
      background-color: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .header-left { display: flex; align-items: center; gap: 1rem; }
    .header-title { font-size: 1.25rem; font-weight: 700; }
    .badge {
      background-color: var(--accent);
      color: white;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      text-transform: uppercase;
    }
    
    .user-profile { display: flex; align-items: center; gap: 0.75rem; }
    .avatar { width: 36px; height: 36px; border-radius: 50%; background-color: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 700; }
    .avatar img { width: 100%; height: 100%; border-radius: 50%; }
    .username { font-weight: 600; font-size: 0.9rem; }
    .logout-btn { color: var(--text-muted); text-decoration: none; font-size: 0.85rem; padding: 0.4rem 0.8rem; border: 1px solid var(--border); border-radius: 0.25rem; transition: background 0.2s; }
    .logout-btn:hover { background-color: #334155; color: var(--text-main); }

    .main-container { max-width: 1000px; margin: 2rem auto; padding: 0 1rem; }
    .search-box { width: 100%; background-color: var(--card-bg); border: 1px solid var(--border); border-radius: 0.375rem; padding: 0.8rem 1rem; color: var(--text-main); font-size: 0.95rem; margin-bottom: 1.5rem; outline: none; }
    .search-box:focus { border-color: var(--accent); }

    .category-card { background-color: var(--card-bg); border: 1px solid var(--border); border-radius: 0.375rem; margin-bottom: 1rem; overflow: hidden; }
    .category-header { padding: 1rem 1.25rem; display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; background-color: #1e293b; }
    .category-title { font-weight: 600; font-size: 1.05rem; display: flex; align-items: center; gap: 0.5rem; }
    .category-body { padding: 1.25rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.25rem; border-top: 1px solid var(--border); background-color: #1e293b; }
    .category-card.collapsed .category-body { display: none; }
    .chevron { transition: transform 0.2s; }
    .category-card.collapsed .chevron { transform: rotate(-90deg); }

    .setting-item { background-color: var(--item-bg); border: 1px solid var(--border); border-radius: 0.375rem; padding: 0.9rem; transition: border-color 0.2s; }
    .setting-item.changed { border-color: var(--warning); background-color: #1e1b18; }
    .setting-label { font-weight: 600; font-size: 0.85rem; margin-bottom: 0.3rem; display: flex; justify-content: space-between; align-items: center; }
    .setting-desc { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.6rem; line-height: 1.3; }
    
    .setting-header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem; }
    .range-badge {
      background-color: var(--accent);
      color: white;
      font-family: monospace;
      font-size: 0.8rem;
      font-weight: 700;
      padding: 0.15rem 0.5rem;
      border-radius: 0.25rem;
    }
    input[type="range"].range-slider {
      width: 100%;
      height: 6px;
      background: var(--bg-color);
      border: 1px solid var(--border);
      border-radius: 3px;
      outline: none;
      accent-color: var(--accent);
      cursor: pointer;
      margin-top: 0.4rem;
    }

    input[type="text"], input[type="number"], input[type="password"], select {
      width: 100%;
      background-color: var(--bg-color);
      border: 1px solid var(--border);
      border-radius: 0.25rem;
      padding: 0.5rem 0.75rem;
      color: var(--text-main);
      font-size: 0.875rem;
      outline: none;
    }
    input:focus, select:focus { border-color: var(--accent); }

    .password-wrapper { position: relative; width: 100%; display: flex; align-items: center; }
    .password-wrapper input { width: 100%; padding-right: 2.5rem; }
    .toggle-password-btn {
      position: absolute;
      right: 0.5rem;
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 1rem;
      padding: 0.2rem 0.4rem;
      border-radius: 0.25rem;
      transition: background 0.2s, color 0.2s;
    }
    .toggle-password-btn:hover { color: var(--text-main); background-color: rgba(255, 255, 255, 0.1); }

    .toggle-switch { position: relative; display: inline-block; width: 44px; height: 22px; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #334155; transition: .2s; border-radius: 22px; }
    .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: white; transition: .2s; border-radius: 50%; }
    input:checked + .slider { background-color: var(--accent); }
    input:checked + .slider:before { transform: translateX(22px); }

    .footer {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background-color: var(--card-bg);
      border-top: 1px solid var(--border);
      padding: 1rem 2rem;
      display: flex;
      justify-content: flex-end;
      gap: 1rem;
      z-index: 100;
    }

    .btn {
      padding: 0.6rem 1.25rem;
      border-radius: 0.25rem;
      font-weight: 600;
      font-size: 0.9rem;
      cursor: pointer;
      border: none;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: background 0.2s;
    }
    .btn-primary { background-color: var(--success); color: white; }
    .btn-primary:hover { background-color: #15803d; }
    .btn-warning { background-color: var(--warning); color: white; }
    .btn-warning:hover { background-color: #b45309; }
    .btn-secondary { background-color: #475569; color: white; }
    .btn-secondary:hover { background-color: #334155; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }

    .toast-container { position: fixed; top: 80px; right: 20px; z-index: 1000; display: flex; flex-direction: column; gap: 0.5rem; }
    .toast {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      padding: 0.8rem 1.2rem;
      border-radius: 0.25rem;
      font-size: 0.85rem;
      transform: translateX(120%);
      transition: transform 0.3s ease;
    }
    .toast.show { transform: translateX(0); }
    .toast.success { border-left-color: var(--success); }
    .toast.error { border-left-color: var(--error); }
    
    .spinner { display: none; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: white; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading .spinner { display: inline-block; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="header-title">${escapeHtml(serverName || 'Palworld Server')}</div>
      <div class="badge">${escapeHtml(serverLabel)}</div>
    </div>
    <div class="user-profile">
      <div class="avatar">
        ${user.avatar ? `<img src="https://cdn.discordapp.com/avatars/${user.userId}/${user.avatar}.png" alt="Avatar">` : escapeHtml(user.username.charAt(0).toUpperCase())}
      </div>
      <div class="username">${escapeHtml(user.username)}</div>
      <a href="/auth/logout" class="logout-btn">Logout</a>
    </div>
  </div>

  <div class="main-container">
    <div class="setting-item" style="border-color: var(--warning); margin-bottom: 1.5rem;">
      <div class="setting-label" style="color: var(--warning);">⚠️ Existing worlds may ignore these changes</div>
      <div class="setting-desc">Once a world has been generated, Palworld stores most world-balance settings (rates, death penalty, building rules) in <code>WorldOption.sav</code> and stops reading them from this ini file -- only server identity, ports, player caps and passwords keep reading from here. If a saved change doesn't seem to take effect after a restart, that's why. This editor does not touch <code>WorldOption.sav</code>.</div>
    </div>
    <input type="text" class="search-box" id="searchInput" placeholder="🔍 Search settings by name...">
    <div id="settingsContainer"></div>
  </div>

  <div class="footer">
    <button class="btn btn-secondary" id="btnReset">Reset Changes</button>
    <button class="btn btn-primary" id="btnSave">Save Settings <div class="spinner"></div></button>
    <button class="btn btn-warning" id="btnSaveRestart">Save & Restart Server <div class="spinner"></div></button>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    function togglePassword(btn) {
      const input = btn ? btn.previousElementSibling || (btn.parentElement ? btn.parentElement.querySelector('input') : null) : null;
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
      } else {
        input.type = 'password';
        btn.textContent = '👁️';
      }
    }

    const INITIAL_SETTINGS = ${safeJsonForScript(settings)};
    const SCHEMA = ${safeJsonForScript(schema)};
    const CATEGORIES = ${safeJsonForScript(categories)};
    
    let currentSettings = { ...INITIAL_SETTINGS };
    let originalSettings = { ...INITIAL_SETTINGS };
    
    const container = document.getElementById('settingsContainer');
    const grouped = {};
    SCHEMA.forEach(field => {
      const cat = field.category || 'general';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(field);
    });
    
    let catIndex = 0;
    for (const [catName, fields] of Object.entries(grouped)) {
      const catInfo = CATEGORIES[catName] || { label: catName, icon: '⚙️' };
      const card = document.createElement('div');
      card.className = 'category-card' + (catIndex >= 3 ? ' collapsed' : '');
      card.dataset.category = catName;
      
      const header = document.createElement('div');
      header.className = 'category-header';
      header.innerHTML = '<div class="category-title"><span class="category-icon">' + catInfo.icon + '</span>' + catInfo.label + '</div><svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      
      header.addEventListener('click', () => card.classList.toggle('collapsed'));
      
      const body = document.createElement('div');
      body.className = 'category-body';
      
      fields.forEach(field => {
        let rawVal = currentSettings[field.key];
        let val = rawVal !== undefined ? String(rawVal) : '';
        if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
          val = val.slice(1, -1);
        }
        currentSettings[field.key] = val;
        originalSettings[field.key] = val;

        const wrapper = document.createElement('div');
        wrapper.className = 'setting-item';
        wrapper.dataset.key = field.key;
        wrapper.dataset.name = (field.label || field.key).toLowerCase();
        
        let inputHtml = '';
        if (field.type === 'boolean') {
          const checked = (val === true || val === 'True' || val === 'true') ? 'checked' : '';
          inputHtml = '<div class="setting-label"><span>' + (field.label || field.key) + '</span><label class="toggle-switch"><input type="checkbox" id="input-' + field.key + '" ' + checked + '><span class="slider"></span></label></div>' + (field.description ? '<div class="setting-desc">' + field.description + '</div>' : '');
        } else if (field.type === 'select' && field.options) {
          const opts = field.options.map(o => '<option value="' + o + '" ' + (val == o ? 'selected' : '') + '>' + o + '</option>').join('');
          inputHtml = '<label class="setting-label" for="input-' + field.key + '">' + (field.label || field.key) + '</label>' + (field.description ? '<div class="setting-desc">' + field.description + '</div>' : '') + '<select id="input-' + field.key + '">' + opts + '</select>';
        } else if (field.type === 'range') {
          const stepAttr = field.step ? 'step="' + field.step + '"' : 'step="0.1"';
          const minAttr = field.min !== undefined ? 'min="' + field.min + '"' : 'min="0.1"';
          const maxAttr = field.max !== undefined ? 'max="' + field.max + '"' : 'max="5"';
          const displayVal = val !== undefined && val !== '' ? val : '1.0';
          inputHtml = '<div class="setting-header-row"><label class="setting-label" for="input-' + field.key + '" style="margin:0;">' + (field.label || field.key) + '</label><span class="range-badge" id="badge-' + field.key + '">' + displayVal + '</span></div>' + (field.description ? '<div class="setting-desc">' + field.description + '</div>' : '') + '<input type="range" class="range-slider" id="input-' + field.key + '" value="' + displayVal + '" ' + minAttr + ' ' + maxAttr + ' ' + stepAttr + '>';
        } else if (field.type === 'number') {
          const stepAttr = field.step ? 'step="' + field.step + '"' : '';
          const minAttr = field.min !== undefined ? 'min="' + field.min + '"' : '';
          const maxAttr = field.max !== undefined ? 'max="' + field.max + '"' : '';
          inputHtml = '<label class="setting-label" for="input-' + field.key + '">' + (field.label || field.key) + '</label>' + (field.description ? '<div class="setting-desc">' + field.description + '</div>' : '') + '<input type="number" id="input-' + field.key + '" value="' + (val !== undefined ? String(val).replace(/"/g, '&quot;') : '') + '" ' + stepAttr + ' ' + minAttr + ' ' + maxAttr + '>';
        } else if (field.type === 'password') {
          inputHtml = '<label class="setting-label" for="input-' + field.key + '">' + (field.label || field.key) + '</label>' + (field.description ? '<div class="setting-desc">' + field.description + '</div>' : '') + '<div class="password-wrapper"><input type="password" id="input-' + field.key + '" value="' + (val !== undefined ? String(val).replace(/"/g, '&quot;') : '') + '"><button type="button" class="toggle-password-btn" title="Toggle password visibility" onclick="togglePassword(this)">👁️</button></div>';
        } else {
          inputHtml = '<label class="setting-label" for="input-' + field.key + '">' + (field.label || field.key) + '</label>' + (field.description ? '<div class="setting-desc">' + field.description + '</div>' : '') + '<input type="text" id="input-' + field.key + '" value="' + (val !== undefined ? String(val).replace(/"/g, '&quot;') : '') + '">';
        }
        
        wrapper.innerHTML = inputHtml;
        body.appendChild(wrapper);
      });
      
      card.appendChild(header);
      card.appendChild(body);
      container.appendChild(card);
      catIndex++;
    }
    
    const OFFICIAL_DEFAULTS = {
      DayTimeSpeedRate: 1.0, NightTimeSpeedRate: 1.0, ExpRate: 1.0, PalCaptureRate: 1.0, PalSpawnNumRate: 1.0,
      PalDamageRateAttack: 1.0, PalDamageRateDefense: 1.0, PlayerDamageRateAttack: 1.0, PlayerDamageRateDefense: 1.0,
      PlayerStomachDecreaceRate: 1.0, PlayerStaminaDecreaceRate: 1.0, PlayerAutoHPRegeneRate: 1.0, PlayerAutoHpRegeneRateInSleep: 1.0,
      PalStomachDecreaceRate: 1.0, PalStaminaDecreaceRate: 1.0, PalAutoHPRegeneRate: 1.0, PalAutoHpRegeneRateInSleep: 1.0,
      BuildObjectHpRate: 1.0, BuildObjectDamageRate: 1.0, BuildObjectDeteriorationDamageRate: 1.0,
      CollectionDropRate: 1.0, CollectionObjectHpRate: 1.0, CollectionObjectRespawnSpeedRate: 1.0,
      EnemyDropItemRate: 1.0, DeathPenalty: 'Item', bEnablePlayerToPlayerDamage: false, bEnableFriendlyFire: false,
      bEnableInvaderEnemy: true, bActiveUNKO: false, bEnableAimAssistPad: true, bEnableAimAssistKeyboard: false,
      DropItemMaxNum: 3000, PhysicsActiveDropItemMaxNum: -1, DropItemMaxNum_UNKO: 100, BaseCampMaxNum: 128,
      BaseCampWorkerMaxNum: 15, DropItemAliveMaxHours: 1.0, bAutoResetGuildNoOnlinePlayers: false,
      AutoResetGuildTimeNoOnlinePlayers: 72.0, GuildPlayerMaxNum: 20, BaseCampMaxNumInGuild: 4,
      PalEggDefaultHatchingTime: 1.0, WorkSpeedRate: 1.0, AutoSaveSpan: 30.0, bIsMultiplay: false, bIsPvP: false,
      bHardcore: false, bPalLost: false, bCharacterRecreateInHardcore: false, bCanPickupOtherGuildDeathPenaltyDrop: false,
      bEnableNonLoginPenalty: true, bEnableFastTravel: true, bEnableFastTravelOnlyBaseCamp: false,
      bIsStartLocationSelectByMap: false, bExistPlayerAfterLogout: false, bEnableDefenseOtherGuildPlayer: false,
      bInvisibleOtherGuildBaseCampAreaFX: false, bBuildAreaLimit: false, ItemWeightRate: 1.0,
      EquipmentDurabilityDamageRate: 1.0, ItemContainerForceMarkDirtyInterval: 1.0,
      PlayerDataPalStorageUpdateCheckTickInterval: 1.0, ItemCorruptionMultiplier: 1.0,
      MonsterFarmActionSpeedRate: 1.0, GuildRejoinCooldownMinutes: 0, AutoTransferMasterCheckIntervalSeconds: 3600.0,
      AutoTransferMasterThresholdDays: 14, MaxGuildsPerFrame: 10, BlockRespawnTime: 5.0,
      RespawnPenaltyDurationThreshold: 0.0, RespawnPenaltyTimeScale: 2.0, bDisplayPvPItemNumOnWorldMap_BaseCamp: false,
      bDisplayPvPItemNumOnWorldMap_Player: false, AdditionalDropItemNumWhenPlayerKillingInPvPMode: 1,
      bAdditionalDropItemWhenPlayerKillingInPvPMode: false, bEnableVoiceChat: false,
      VoiceChatMaxVolumeDistance: 3000.0, VoiceChatZeroVolumeDistance: 15000.0,
      bAllowEnhanceStat_Health: true, bAllowEnhanceStat_Attack: true, bAllowEnhanceStat_Stamina: true,
      bAllowEnhanceStat_Weight: true, bAllowEnhanceStat_WorkSpeed: true, bEnableBuildingPlayerUIdDisplay: false,
      BuildingNameDisplayCacheTTLSeconds: 60, bAllowGlobalPalboxExport: true, bAllowGlobalPalboxImport: false
    };

    const PRESETS = {
      None: OFFICIAL_DEFAULTS,
      Easy: { ...OFFICIAL_DEFAULTS, ExpRate: 1.3, PalCaptureRate: 1.3, PalDamageRateAttack: 1.0, PalDamageRateDefense: 0.8, PlayerDamageRateAttack: 1.5, PlayerDamageRateDefense: 0.7, PlayerStomachDecreaceRate: 0.7, PlayerStaminaDecreaceRate: 0.7, PalStomachDecreaceRate: 0.7, PalStaminaDecreaceRate: 0.7, CollectionDropRate: 1.3, EnemyDropItemRate: 1.3, DeathPenalty: 'None', PalEggDefaultHatchingTime: 0.0 },
      Normal: { ...OFFICIAL_DEFAULTS, ExpRate: 1.0, PalCaptureRate: 1.0, PalDamageRateAttack: 1.0, PalDamageRateDefense: 1.0, PlayerDamageRateAttack: 1.0, PlayerDamageRateDefense: 1.0, PlayerStomachDecreaceRate: 1.0, PlayerStaminaDecreaceRate: 1.0, PalStomachDecreaceRate: 1.0, PalStaminaDecreaceRate: 1.0, CollectionDropRate: 1.0, EnemyDropItemRate: 1.0, DeathPenalty: 'Item', PalEggDefaultHatchingTime: 1.0 },
      Hard: { ...OFFICIAL_DEFAULTS, ExpRate: 0.8, PalCaptureRate: 0.8, PalDamageRateAttack: 1.5, PalDamageRateDefense: 1.5, PlayerDamageRateAttack: 0.5, PlayerDamageRateDefense: 4.0, PlayerStomachDecreaceRate: 1.5, PlayerStaminaDecreaceRate: 1.5, PalStomachDecreaceRate: 1.5, PalStaminaDecreaceRate: 1.5, CollectionDropRate: 0.5, EnemyDropItemRate: 0.5, DeathPenalty: 'All', PalEggDefaultHatchingTime: 72.0 }
    };

    function updateFormFromSettings(settingsObj) {
      SCHEMA.forEach(field => {
        const el = document.getElementById('input-' + field.key);
        if (!el) return;
        let val = settingsObj[field.key];
        if (val !== undefined && typeof val === 'string' && val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
          val = val.slice(1, -1);
        }
        if (field.type === 'boolean') {
          el.checked = (val === true || val === 'True' || val === 'true');
        } else {
          el.value = val !== undefined ? val : '';
          const badge = document.getElementById('badge-' + field.key);
          if (badge) badge.innerText = el.value;
        }
        
        const orig = originalSettings[field.key];
        const isChanged = String(val) !== String(orig);
        const wrapper = document.querySelector('.setting-item[data-key="' + field.key + '"]');
        if (wrapper) {
          if (isChanged) wrapper.classList.add('changed');
          else wrapper.classList.remove('changed');
        }
      });
    }

    // Populate all input values directly via JS DOM properties on initial load
    updateFormFromSettings(currentSettings);

    SCHEMA.forEach(field => {
      const el = document.getElementById('input-' + field.key);
      if (!el) return;
      
      const updateChangeState = () => {
        let newVal;
        if (field.type === 'boolean') {
          newVal = el.checked ? 'True' : 'False';
        } else if (field.type === 'range' || field.type === 'number') {
          newVal = el.value !== '' ? Number(el.value) : undefined;
          const badge = document.getElementById('badge-' + field.key);
          if (badge) badge.innerText = el.value;
        } else {
          newVal = el.value;
        }
        
        // Handle Difficulty Preset selection
        if (field.key === 'Difficulty' && PRESETS[newVal]) {
          const preset = PRESETS[newVal];
          for (const [pKey, pVal] of Object.entries(preset)) {
            currentSettings[pKey] = pVal;
          }
          currentSettings.Difficulty = newVal;
          updateFormFromSettings(currentSettings);
          showToast('Applied ' + newVal + ' preset settings!', 'success');
          return;
        }

        // If manually changing a setting while Difficulty is preset, switch Difficulty to Custom
        if (field.key !== 'Difficulty' && PRESETS[currentSettings.Difficulty]) {
          currentSettings.Difficulty = 'Custom';
          const diffEl = document.getElementById('input-Difficulty');
          if (diffEl) diffEl.value = 'Custom';
        }
        
        currentSettings[field.key] = newVal;
        const orig = originalSettings[field.key];
        const isChanged = String(newVal) !== String(orig);
        
        const wrapper = document.querySelector('.setting-item[data-key="' + field.key + '"]');
        if (wrapper) {
          if (isChanged) wrapper.classList.add('changed');
          else wrapper.classList.remove('changed');
        }
      };
      
      el.addEventListener('input', updateChangeState);
      el.addEventListener('change', updateChangeState);
    });

    document.getElementById('btnReset').addEventListener('click', () => {
      currentSettings = { ...originalSettings };
      updateFormFromSettings(currentSettings);
      showToast('Form reset to loaded settings.', 'success');
    });
    
    document.getElementById('searchInput').addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      document.querySelectorAll('.category-card').forEach(card => {
        let hasVisible = false;
        card.querySelectorAll('.setting-item').forEach(item => {
          const name = item.dataset.name;
          if (name.includes(term)) {
            item.classList.remove('hidden');
            hasVisible = true;
          } else {
            item.classList.add('hidden');
          }
        });
        if (hasVisible) {
          card.classList.remove('hidden');
          if (term.length > 0) card.classList.remove('collapsed');
        } else {
          card.classList.add('hidden');
        }
      });
    });
    
    function showToast(message, type = 'success') {
      const t = document.createElement('div');
      t.className = 'toast ' + type;
      t.innerHTML = message;
      document.getElementById('toastContainer').appendChild(t);
      void t.offsetWidth;
      t.classList.add('show');
      setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 300);
      }, 4000);
    }
    
    async function save(restart = false) {
      const btn = restart ? document.getElementById('btnSaveRestart') : document.getElementById('btnSave');
      btn.classList.add('loading');
      btn.disabled = true;
      try {
        const res = await fetch('/settings/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: currentSettings, restart })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || (restart ? 'Saved and restarting server...' : 'Settings saved successfully!'), 'success');
          originalSettings = { ...currentSettings };
          document.querySelectorAll('.setting-item.changed').forEach(el => el.classList.remove('changed'));
        } else {
          showToast(data.error || 'Failed to save settings.', 'error');
        }
      } catch (err) {
        showToast('Network error saving settings.', 'error');
      } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    }
document.getElementById('btnSave').addEventListener('click', () => save(false));
    document.getElementById('btnSaveRestart').addEventListener('click', () => save(true));
  </script>
</body>
</html>
`;

function renderErrorPage(title, message) {
  return ERROR_TEMPLATE(title, message);
}

function renderSettingsPage({ settings, schema, categories, user, serverLabel, serverName }) {
  return HTML_TEMPLATE(user, serverName, serverLabel, settings, schema, categories);
}

function normalizeSettingValue(key, val) {
  if (val === undefined || val === null) return '';
  const str = String(val).trim();
  let clean = (str.startsWith('"') && str.endsWith('"') && str.length >= 2) ? str.slice(1, -1) : str;

  const schemaItem = SETTINGS_SCHEMA.find(s => s.key === key);
  const isBool = schemaItem ? schemaItem.type === 'boolean' : key.startsWith('b');
  const isRange = schemaItem ? schemaItem.type === 'range' : (key.endsWith('Rate') || key.endsWith('Multiplier') || key.endsWith('TimeScale'));

  if (isBool) {
    return (clean === 'true' || clean === 'True' || clean === true) ? 'True' : 'False';
  }
  if (isRange && clean !== '' && !isNaN(clean)) {
    return Number(clean).toFixed(6);
  }
  if (schemaItem && schemaItem.type === 'number' && clean !== '' && !isNaN(clean)) {
    return String(Number(clean));
  }
  return clean;
}

function createWebServer({ config, client, notify, auditLog, agentRegistry }) {
  const app = express();
  app.use(express.json());

  // Helper: check session
  const getSession = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies.palworld_session) return null;
    return verifyPayload(cookies.palworld_session, WEB_SECRET);
  };

  // Login Route
  app.get('/auth/login', (req, res) => {
    const { guild, server } = req.query;
    if (!guild) {
      return res.status(400).send(renderErrorPage('Missing Guild ID', 'Please provide a valid guild parameter in the login URL.'));
    }

    const statePayload = {
      guildId: guild,
      serverLabel: server || 'main',
      nonce: crypto.randomBytes(16).toString('hex'),
      exp: Date.now() + 10 * 60 * 1000,
    };
    const state = signPayload(statePayload, WEB_SECRET);

    const redirectUri = `${WEB_BASE_URL}/auth/callback`;
    const authorizeUrl = `https://discord.com/api/oauth2/authorize?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify&state=${encodeURIComponent(state)}`;

    res.redirect(authorizeUrl);
  });

  // Callback Route
  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send(renderErrorPage('Authentication Failed', 'Missing code or state parameter from Discord OAuth2 redirect.'));
    }

    const statePayload = verifyPayload(state, WEB_SECRET);
    if (!statePayload || statePayload.exp < Date.now()) {
      return res.status(400).send(renderErrorPage('Invalid Session State', 'The login session has expired or been tampered with. Please try logging in again.'));
    }

    const { guildId, serverLabel } = statePayload;

    try {
      // Exchange code for token
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: DISCORD_CLIENT_SECRET || '',
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: `${WEB_BASE_URL}/auth/callback`,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error('OAuth2 token exchange failed:', errText);
        return res.status(401).send(renderErrorPage('OAuth2 Failed', 'Failed to authenticate with Discord. Please verify client secret configuration.'));
      }

      const tokenData = await tokenRes.json();

      // Fetch user info
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userRes.ok) {
        return res.status(401).send(renderErrorPage('Failed to Fetch User Profile', 'Could not retrieve Discord user information.'));
      }

      const userData = await userRes.json();
      const userId = userData.id;

      // Check Discord Guild Membership & Admin Permission
      let isAllowed = false;
      let userRoles = [];
      try {
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        userRoles = [...member.roles.cache.keys()];
      } catch (err) {
        console.error('Failed to fetch guild member for permission check:', err.message);
      }

      const guildRolesConfig = findGuildRoles(config.roles, guildId);
      const tier = resolveTier({ roleIds: userRoles, userId }, guildRolesConfig);
      isAllowed = hasAccess(tier, 'admin');

      if (!isAllowed) {
        return res.status(403).send(renderErrorPage('Access Denied', 'You do not have Administrator permissions in this Discord server to access World Settings.'));
      }

      // Create Session Cookie
      const sessionPayload = {
        userId,
        username: userData.username,
        avatar: userData.avatar,
        guildId,
        serverLabel,
        exp: Date.now() + 30 * 60 * 1000, // 30 minutes
      };
      const sessionCookie = signPayload(sessionPayload, WEB_SECRET);

      res.setHeader('Set-Cookie', `palworld_session=${sessionCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`);
      res.redirect('/settings');
    } catch (err) {
      console.error('OAuth2 Callback Error:', err);
      res.status(500).send(renderErrorPage('Server Error', 'An unexpected error occurred during authentication.'));
    }
  });

  // Settings Page Route
  app.get('/settings', (req, res) => {
    const session = getSession(req);
    if (!session) {
      return res.redirect('/auth/login');
    }

    const { guildId, serverLabel, username, avatar, userId } = session;
    const server = findGuildServer(config.servers, guildId, serverLabel);

    if (!server || !server.settingsFilePath) {
      return res.status(404).send(renderErrorPage('Server Not Found', `No server configured with label "${serverLabel}" in this guild.`));
    }

    const { settings: settingsMap } = readWorldSettings(server.settingsFilePath);
    const settingsObj = Object.fromEntries(settingsMap);
    const serverName = settingsMap.get('ServerName') || serverLabel;

    const html = renderSettingsPage({
      settings: settingsObj,
      schema: SETTINGS_SCHEMA,
      categories: CATEGORIES,
      user: { username, avatar, userId },
      serverLabel,
      serverName: serverName.replace(/^"|"$/g, ''),
    });

    res.send(html);
  });

  // Save Settings Route
  app.post('/settings/save', async (req, res) => {
    const session = getSession(req);
    if (!session) {
      return res.status(401).json({ success: false, error: 'Unauthorized or session expired.' });
    }

    const { guildId, serverLabel, username, userId } = session;
    const { settings: newSettings, restart } = req.body;

    if (!newSettings || typeof newSettings !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid settings payload.' });
    }

    const server = findGuildServer(config.servers, guildId, serverLabel);
    if (!server || !server.settingsFilePath) {
      return res.status(404).json({ success: false, error: 'Server configuration not found.' });
    }

    const { settings: currentMap } = readWorldSettings(server.settingsFilePath);
    const changedKeys = [];
    const changedDetails = [];

    for (const [key, val] of Object.entries(newSettings)) {
      const rawOld = currentMap.get(key);
      const oldNorm = normalizeSettingValue(key, rawOld);
      const newNorm = normalizeSettingValue(key, val);

      if (oldNorm !== newNorm) {
        changedKeys.push(key);
        changedDetails.push({ key, oldVal: oldNorm, newVal: newNorm });

        let formattedVal;
        const schemaItem = SETTINGS_SCHEMA.find(s => s.key === key);
        if (schemaItem && schemaItem.type === 'range' && newNorm !== '' && !isNaN(newNorm)) {
          formattedVal = Number(newNorm).toFixed(6);
        } else if (key === 'Difficulty' || key === 'RandomizerType' || key === 'DeathPenalty' || key === 'LogFormatType' || key === 'DenyTechnologyList' || (String(newNorm).startsWith('(') && String(newNorm).endsWith(')')) || newNorm === 'True' || newNorm === 'False' || (!isNaN(newNorm) && String(newNorm).trim() !== '')) {
          formattedVal = newNorm;
        } else if (newNorm !== '') {
          formattedVal = `"${String(newNorm).replace(/"/g, '')}"`;
        } else {
          formattedVal = '""';
        }
        currentMap.set(key, formattedVal);
      }
    }

    if (changedKeys.length === 0 && !restart) {
      return res.json({ success: true, message: 'No settings were changed.' });
    }

    if (restart && server.pm2ProcessName) {
      // Stop the server first so PalServer finishes its shutdown flush before we write new settings to disk
      try {
        await controlService(server.pm2ProcessName, 'stop');
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch {
        // Server was likely offline -- ignore stop failure
      }
    }

    if (changedKeys.length > 0) {
      const success = writeWorldSettings(server.settingsFilePath, currentMap);
      if (!success) {
        if (restart && server.pm2ProcessName) {
          await controlService(server.pm2ProcessName, 'start').catch(() => {});
        }
        return res.status(500).json({ success: false, error: 'Failed to write updated settings to disk.' });
      }

      const diffLines = changedDetails.map(c => `- ${c.key}: ${c.oldVal}\n+ ${c.key}: ${c.newVal}`).join('\n');
      const diffContent = `\`\`\`diff\n${diffLines}\n\`\`\``;

      // Append Audit Log
      if (auditLog && auditLog.appendAuditEntry) {
        auditLog.appendAuditEntry({
          guildId,
          actor: username,
          actorId: userId,
          command: 'worldsettings',
          changes: changedKeys.length,
          changedKeys: changedKeys.join(', '),
        });
      }

      // Post to Server Log
      if (notify && notify.serverLog) {
        notify.serverLog(guildId, {
          event: 'settings.updated',
          level: 'warning',
          msg: `**${username}** (Discord ID: \`${userId}\`) updated ${changedKeys.length} setting(s) via web editor`,
          diff: diffContent,
          actor: `${username} (${userId})`,
          actorId: userId,
          server: server.label,
        }).catch(() => {});
      }
    }

    let message = changedKeys.length > 0
      ? `Successfully saved ${changedKeys.length} setting(s)!`
      : 'No settings were changed.';

    // Start server if restart was requested
    if (restart && server.pm2ProcessName) {
      try {
        await controlService(server.pm2ProcessName, 'start');
        message += ' Server restarted with new settings loaded!';
      } catch (startErr) {
        message += ` Warning: failed to start server: ${startErr.message}`;
      }
    }

    res.json({ success: true, message });
  });

  // Logout Route
  app.get('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'palworld_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    res.send(LOGOUT_TEMPLATE());
  });

  // Health Check
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use(express.json());

  // Dashboard session: separate from palworld_session (the existing
  // settings-editor login) since it's not scoped to one guild/server --
  // just the logged-in Discord identity. Permission per server/guild is
  // checked per-action from tierGrants, not baked into the session.
  function signDashboardSession(payload) {
    return signPayload(payload, WEB_SECRET);
  }

  function getDashboardSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies.dashboard_session) return null;
    const session = verifyPayload(cookies.dashboard_session, WEB_SECRET);
    if (!session || session.exp < Date.now()) return null;
    return session;
  }

  function requireDashboardSession(req, res) {
    const session = getDashboardSession(req);
    if (!session) {
      res.status(401).json({ success: false, error: 'Not logged in.' });
      return null;
    }
    return session;
  }

  app.get('/dashboard/login', (req, res) => {
    const statePayload = { nonce: crypto.randomBytes(16).toString('hex'), exp: Date.now() + 10 * 60 * 1000 };
    const state = signPayload(statePayload, WEB_SECRET);
    const redirectUri = `${WEB_BASE_URL}/dashboard/callback`;
    const authorizeUrl = `https://discord.com/api/oauth2/authorize?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify&state=${encodeURIComponent(state)}`;
    res.redirect(authorizeUrl);
  });

  app.get('/dashboard/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send(renderErrorPage('Authentication Failed', 'Missing code or state parameter from Discord OAuth2 redirect.'));
    }
    const statePayload = verifyPayload(state, WEB_SECRET);
    if (!statePayload || statePayload.exp < Date.now()) {
      return res.status(400).send(renderErrorPage('Invalid Session State', 'The login session has expired or been tampered with. Please try logging in again.'));
    }

    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: DISCORD_CLIENT_SECRET || '',
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: `${WEB_BASE_URL}/dashboard/callback`,
        }),
      });
      if (!tokenRes.ok) {
        console.error('Dashboard OAuth2 token exchange failed:', await tokenRes.text());
        return res.status(401).send(renderErrorPage('OAuth2 Failed', 'Failed to authenticate with Discord.'));
      }
      const tokenData = await tokenRes.json();

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) {
        return res.status(401).send(renderErrorPage('Failed to Fetch User Profile', 'Could not retrieve Discord user information.'));
      }
      const userData = await userRes.json();

      const sessionPayload = { userId: userData.id, username: userData.username, avatar: userData.avatar, exp: Date.now() + 30 * 60 * 1000 };
      const sessionCookie = signDashboardSession(sessionPayload);
      res.setHeader('Set-Cookie', `dashboard_session=${sessionCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`);
      res.redirect('/dashboard');
    } catch (err) {
      console.error('Dashboard OAuth2 Callback Error:', err);
      res.status(500).send(renderErrorPage('Login Failed', 'An unexpected error occurred during login.'));
    }
  });

  app.post('/dashboard/claim', (req, res) => {
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const { agentId, agentToken } = req.body || {};
    if (typeof agentId !== 'string' || typeof agentToken !== 'string') {
      return res.status(400).json({ success: false, error: 'agentId and agentToken are required.' });
    }

    const claimed = claimAgent(config.agentsPath, agentId, agentToken, session.userId);
    if (!claimed) {
      return res.status(404).json({ success: false, error: 'Not found, already claimed, or the token is wrong.' });
    }
    res.json({ success: true, agentId: claimed.agentId });
  });

  app.get('/dashboard/servers', (req, res) => {
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const agents = findAgentsByOwner(config.agentsPath, session.userId).map((a) => ({
      agentId: a.agentId,
      servers: agentRegistry ? agentRegistry.listServers(a.agentId) : [],
    }));
    res.json({ success: true, agents });
  });

  // Verifies the requesting user actually owns agentId before letting them
  // grant/revoke anything about one of its servers -- ownership, not just
  // being logged in, is what authorizes dashboard writes.
  function requireOwnedAgent(req, res, agentId) {
    const session = requireDashboardSession(req, res);
    if (!session) return null;
    const owned = findAgentsByOwner(config.agentsPath, session.userId).some((a) => a.agentId === agentId);
    if (!owned) {
      res.status(403).json({ success: false, error: 'You do not own this agent.' });
      return null;
    }
    return session;
  }

  app.post('/dashboard/servers/:agentId/:serverId/guilds', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireOwnedAgent(req, res, agentId);
    if (!session) return;

    const { guildId, label, tierGrants } = req.body || {};
    if (typeof guildId !== 'string' || typeof label !== 'string' || !tierGrants) {
      return res.status(400).json({ success: false, error: 'guildId, label, and tierGrants are required.' });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(404).json({ success: false, error: 'The bot is not in that guild.' });
    }
    try {
      await guild.members.fetch(session.userId);
    } catch {
      return res.status(404).json({ success: false, error: 'You are not a member of that guild.' });
    }

    ensureGuildEntry(config.guildsPath, config.rolesPath, config.serversPath, guildId);
    const entry = mutateGuildEntry(config.serversPath, guildId, (e) => {
      e.servers = e.servers || [];
      const existingIndex = e.servers.findIndex((s) => s.agentId === agentId && s.serverId === serverId);
      const serverEntry = { label, agentId, serverId, tierGrants };
      if (existingIndex >= 0) e.servers[existingIndex] = serverEntry;
      else e.servers.push(serverEntry);
    });
    config.servers = loadServersFile(config.serversPath);

    res.json({ success: true, guildId, entry });
  });

  app.delete('/dashboard/servers/:agentId/:serverId/guilds/:guildId', (req, res) => {
    const { agentId, serverId, guildId } = req.params;
    const session = requireOwnedAgent(req, res, agentId);
    if (!session) return;

    mutateGuildEntry(config.serversPath, guildId, (e) => {
      e.servers = (e.servers || []).filter((s) => !(s.agentId === agentId && s.serverId === serverId));
    });
    config.servers = loadServersFile(config.serversPath);

    res.json({ success: true });
  });

  app.get('/dashboard/servers/:agentId/:serverId/settings', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const isOwner = findAgentsByOwner(config.agentsPath, session.userId).some((a) => a.agentId === agentId);
    const grantedAsAdmin = findEntriesByServer(config.servers, agentId, serverId).some((entry) => {
      const server = entry.servers.find((s) => s.agentId === agentId && s.serverId === serverId);
      const tier = resolveTierFromGrants({ roleIds: [], userId: session.userId }, server?.tierGrants);
      return hasAccess(tier, 'admin');
    });
    if (!isOwner && !grantedAsAdmin) {
      return res.status(403).json({ success: false, error: 'You do not have admin access to this server.' });
    }

    try {
      const result = await agentRegistry.sendCommand(agentId, serverId, 'getSettings', {});
      res.json({ success: true, ...result, schema: SETTINGS_SCHEMA, categories: CATEGORIES });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message });
    }
  });

  app.post('/dashboard/servers/:agentId/:serverId/settings', async (req, res) => {
    const { agentId, serverId } = req.params;
    const session = requireDashboardSession(req, res);
    if (!session) return;

    const isOwner = findAgentsByOwner(config.agentsPath, session.userId).some((a) => a.agentId === agentId);
    const grantedAsAdmin = findEntriesByServer(config.servers, agentId, serverId).some((entry) => {
      const server = entry.servers.find((s) => s.agentId === agentId && s.serverId === serverId);
      const tier = resolveTierFromGrants({ roleIds: [], userId: session.userId }, server?.tierGrants);
      return hasAccess(tier, 'admin');
    });
    if (!isOwner && !grantedAsAdmin) {
      return res.status(403).json({ success: false, error: 'You do not have admin access to this server.' });
    }

    const { settings } = req.body || {};
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ success: false, error: 'settings is required.' });
    }

    try {
      const result = await agentRegistry.sendCommand(agentId, serverId, 'setSettings', { settings });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message });
    }
  });

  return {
    app,
    signDashboardSession,
    start: () => {
      const server = app.listen(WEB_PORT, () => {
        console.log(`Web settings server listening on port ${WEB_PORT} (${WEB_BASE_URL})`);
      });

      if (agentRegistry) {
        const HELLO_TIMEOUT_MS = 5000;
        const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
        server.on('upgrade', (req, socket, head) => {
          if (req.url !== '/agent/connect') {
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            // Attached once, here, before anything else on this connection --
            // ws.on() listeners persist for the connection's whole lifetime,
            // so this covers both the pre-auth handshake below AND every
            // command/response exchange agentRegistry.authenticate() sets up
            // afterward. Without it, an unhandled 'error' event (a malformed
            // frame, oversized payload, etc. -- easy to trigger, no token
            // needed) throws synchronously and crashes the whole bot
            // process. Found in code review, verified with a live repro.
            ws.on('error', (err) => console.warn('Agent WebSocket error:', err.message));

            const helloTimeout = setTimeout(() => {
              console.warn('Rejected /agent/connect handshake: no hello received within timeout');
              ws.terminate();
            }, HELLO_TIMEOUT_MS);

            // The first message on a fresh connection must be the hello --
            // authenticate() takes over listening for command responses
            // only after this succeeds, so a connection that never sends
            // one (or sends a bad token) never gets a chance to send
            // anything else.
            ws.once('message', (raw) => {
              clearTimeout(helloTimeout);

              let hello;
              try {
                hello = JSON.parse(raw);
              } catch {
                console.warn('Rejected /agent/connect handshake: malformed JSON');
                ws.close();
                return;
              }

              if (hello.type !== 'hello' || typeof hello.agentId !== 'string' || typeof hello.token !== 'string') {
                console.warn('Rejected /agent/connect handshake: malformed hello');
                ws.close();
                return;
              }

              if (!agentRegistry.authenticate(ws, { agentId: hello.agentId, token: hello.token })) {
                console.warn('Rejected /agent/connect handshake: authentication failed for agentId', hello.agentId);
                ws.close();
              }
            });
          });
        });
      }
    },
    getBaseUrl: () => WEB_BASE_URL,
  };
}

module.exports = { createWebServer, signPayload, verifyPayload, parseCookies };
