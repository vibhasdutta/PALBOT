function applyServer(server) {
  if (!server) return;
  const set = (id, val) => { if (val) document.getElementById(id).value = val; };
  set('inputLabel', server.label);
  set('inputRestApiUrl', server.restApiUrl);
  set('inputRestApiPassword', server.restApiPassword);
  set('inputPm2ProcessName', server.pm2ProcessName);
  set('inputSaveFilePath', server.saveFilePath);
  set('inputSettingsFilePath', server.settingsFilePath);

  const form = document.getElementById('addForm');
  if (!form) return;
  let warnDiv = document.getElementById('apiWarnMsg');
  if (server.restApiEnabled === false) {
    if (!warnDiv) {
      warnDiv = document.createElement('div');
      warnDiv.id = 'apiWarnMsg';
      form.prepend(warnDiv);
    }
    warnDiv.className = 'banner banner-warn';
    warnDiv.innerHTML = '<b>Warning:</b> <code>RESTAPIEnabled=True</code> was not found in <code>PalWorldSettings.ini</code>. Make sure REST API is enabled so the bot can connect.';
  } else if (warnDiv) {
    warnDiv.remove();
  }
}

function wireDetectButton() {
  const btn = document.getElementById('btnDetect');
  if (!btn) return;
  let detectedServers = [];

  btn.addEventListener('click', async () => {
    const msg = document.getElementById('detectMsg');
    msg.className = 'banner banner-info';
    msg.textContent = 'Scanning system for Palworld configs and processes...';
    try {
      const res = await fetch('/detect');
      const data = await res.json();
      detectedServers = data.detected || [];
      if (detectedServers.length > 0) {
        applyServer(detectedServers[0]);
        msg.className = 'banner banner-info';
        if (detectedServers.length === 1) {
          msg.textContent = 'Auto-detected server configuration. Form pre-filled.';
        } else {
          let html = 'Found ' + detectedServers.length + ' new server(s). Select one: <select id="selDetected" style="padding:.3rem;margin-left:.5rem;border-radius:8px;">';
          detectedServers.forEach((s, i) => {
            html += '<option value="' + i + '">' + (s.label || ('Server ' + (i + 1))) + ' (' + (s.restApiUrl || 'no REST URL') + ')</option>';
          });
          html += '</select>';
          msg.innerHTML = html;
          document.getElementById('selDetected').addEventListener('change', (e) => {
            applyServer(detectedServers[e.target.value]);
          });
        }
      } else if (data.alreadyRegisteredCount > 0) {
        msg.className = 'banner banner-info';
        msg.textContent = 'All detected local servers are already registered above.';
      } else {
        msg.className = 'banner banner-warn';
        msg.textContent = 'No running Palworld process or PalWorldSettings.ini found in common paths. Please enter details manually.';
      }
    } catch (err) {
      msg.className = 'banner banner-warn';
      msg.textContent = 'Auto-detection failed: ' + err.message;
    }
  });
}

async function loadIndexPage() {
  const rowsEl = document.getElementById('serverRows');
  if (!rowsEl) return;

  const res = await fetch('/api/state');
  const state = await res.json();

  document.getElementById('agentId').textContent = state.agentId;
  document.getElementById('agentToken').textContent = state.agentToken;
  document.getElementById('botWsUrl').textContent = state.botWsUrl;

  rowsEl.innerHTML = '';
  if (!state.servers.length) {
    rowsEl.innerHTML = '<tr><td colspan="4" style="color:#979797;">No servers registered yet.</td></tr>';
    return;
  }
  state.servers.forEach((s) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml(s.label) + '</td>' +
      '<td class="mono-label">' + escapeHtml(s.serverId) + '</td>' +
      '<td><a href="/edit.html?id=' + encodeURIComponent(s.serverId) + '">Edit</a></td>' +
      '<td><form method="post" action="/servers/' + encodeURIComponent(s.serverId) + '/delete">' +
      '<button type="submit" class="btn btn-danger">Remove</button></form></td>';
    rowsEl.append(tr);
  });
}

async function loadEditPage() {
  const form = document.getElementById('editForm');
  if (!form) return;

  const id = new URLSearchParams(location.search).get('id');
  if (!id) { document.getElementById('pageTitle').textContent = 'Server not found'; return; }

  const res = await fetch('/api/state');
  const state = await res.json();
  const server = state.servers.find((s) => s.serverId === id);
  if (!server) { document.getElementById('pageTitle').textContent = 'Server not found'; return; }

  document.getElementById('pageTitle').textContent = 'Edit ' + server.label;
  form.action = '/servers/' + encodeURIComponent(id) + '/edit';
  applyServer(server);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

wireDetectButton();
loadIndexPage();
loadEditPage();
