(function () {
  let guildsCache = null;
  const content = document.getElementById('content');
  const claimPanel = document.getElementById('claimPanel');
  const btnHeaderClaim = document.getElementById('btnHeaderClaim');

  btnHeaderClaim.addEventListener('click', () => {
    claimPanel.style.display = claimPanel.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btnCancelClaim').addEventListener('click', () => {
    claimPanel.style.display = 'none';
  });
  document.getElementById('btnSubmitClaim').addEventListener('click', async () => {
    const agentId = document.getElementById('claimAgentId').value.trim();
    const agentToken = document.getElementById('claimAgentToken').value.trim();
    if (!agentId || !agentToken) {
      showBanner(claimPanel, 'Agent ID and Agent Token are required.', 'error');
      return;
    }
    try {
      await api('/dashboard/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, agentToken }),
      });
      showBanner(content, 'Agent claimed successfully!', 'success');
      claimPanel.style.display = 'none';
      document.getElementById('claimAgentId').value = '';
      document.getElementById('claimAgentToken').value = '';
      loadServers();
    } catch (err) {
      showBanner(claimPanel, err.message, 'error');
    }
  });

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    });
    children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? c : c); });
    return el;
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = '/dashboard/login'; throw new Error('Session expired'); }
    const body = await res.json();
    if (!body.success) throw new Error(body.error || 'Request failed');
    return body;
  }

  async function loadHeader() {
    try {
      const data = await api('/dashboard/me');
      document.getElementById('headerUsername').textContent = data.username;
      document.getElementById('headerAvatar').src = data.avatarUrl;
    } catch {
      // Session expired -- api() already redirected to /dashboard/login.
    }
  }

  async function loadGuilds() {
    if (guildsCache) return guildsCache;
    const data = await api('/dashboard/guilds');
    guildsCache = data.guilds;
    return guildsCache;
  }

  function showBanner(parent, msg, type) {
    const old = parent.querySelector('.error-banner, .success-banner');
    if (old) old.remove();
    const el = h('div', { className: type === 'error' ? 'error-banner' : 'success-banner' }, msg);
    parent.prepend(el);
    setTimeout(() => el.remove(), 5000);
  }

  function renderRoleBadges(tierName, roles, existingRoleIds = []) {
    const list = h('div', { className: 'role-badge-list' });
    if (!roles || !roles.length) {
      list.append(h('span', { className: 'no-guilds' }, 'No non-managed roles in this guild.'));
      return list;
    }
    const roleSet = new Set(existingRoleIds);
    roles.forEach(r => {
      const chk = h('input', { type: 'checkbox', value: r.id, id: tierName + 'Role_' + r.id });
      if (roleSet.has(r.id)) chk.checked = true;
      const dot = h('span', { className: 'role-badge-dot' });
      dot.style.background = r.color || 'rgba(0, 0, 0, 0.3)';
      const label = h('label', { className: 'role-badge', for: tierName + 'Role_' + r.id }, chk, dot, r.name);
      list.append(label);
    });
    return list;
  }

  function buildTagInput(tierName, initialUserIds = []) {
    const tags = new Set(initialUserIds);
    const wrapper = h('div', { className: 'tag-input-wrapper' });

    const inputRow = h('div', { style: 'display:flex;gap:0.5rem;align-items:center;' });
    const input = h('input', {
      type: 'text',
      placeholder: 'Type Discord User ID & press Enter or + Add',
      className: 'user-id-input',
      style: 'flex:1;'
    });
    const addBtn = h('button', {
      type: 'button',
      className: 'btn btn-secondary btn-sm',
      onClick: () => addTag(input.value)
    }, '+ Add');

    inputRow.append(input, addBtn);

    const tagList = h('div', { className: 'tag-list-below', style: 'display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem;min-height:24px;' });

    function renderTags() {
      tagList.innerHTML = '';
      if (!tags.size) {
        tagList.append(h('span', { style: 'font-size:0.75rem;color:#979797;font-style:italic;' }, 'No individual user IDs added.'));
        return;
      }
      tags.forEach(id => {
        const removeBtn = h('span', {
          className: 'user-tag-remove',
          style: 'cursor:pointer;margin-left:0.3rem;',
          onClick: () => { tags.delete(id); renderTags(); }
        }, '✕');
        const pill = h('span', { className: 'user-tag-pill' }, '👤 ' + id, removeBtn);
        tagList.append(pill);
      });
    }

    function addTag(val) {
      if (!val) return;
      const parts = val.split(/[\s,]+/);
      let added = false;
      parts.forEach(p => {
        const cleanId = p.replace(/\D/g, '');
        if (cleanId.length >= 15) {
          tags.add(cleanId);
          added = true;
        }
      });
      if (added) {
        input.value = '';
        renderTags();
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13 || e.key === ',' || e.key === ' ') {
        e.preventDefault();
        addTag(input.value);
      }
    });

    input.addEventListener('blur', () => {
      if (input.value) addTag(input.value);
    });

    wrapper.append(inputRow, tagList);
    renderTags();

    wrapper.getUserIds = () => {
      if (input.value) addTag(input.value);
      return Array.from(tags);
    };
    return wrapper;
  }

  function buildAttachForm(agentId, serverId, serverLabel, existingData, card) {
    const old = card.querySelector('.form-panel');
    if (old) { old.remove(); return; }

    const panel = h('div', { className: 'form-panel' });
    const isEdit = !!existingData;

    const guildRow = h('div', { className: 'form-row' });
    if (isEdit) {
      guildRow.append(h('label', null, 'Guild'), h('input', { type: 'text', value: existingData.guildName, disabled: 'true' }));
    } else {
      guildRow.append(h('label', null, 'Guild'), h('select', { id: 'guildSelect' }, h('option', { value: '' }, 'Loading…')));
    }
    const labelRow = h('div', { className: 'form-row' },
      h('label', null, 'Label'),
      h('input', { type: 'text', id: 'serverLabel', value: isEdit ? existingData.label : serverLabel })
    );

    // Log channel is fully automatic now (ensureLogChannel in index.js
    // creates one "palworld-logs" channel per guild; every server's
    // events land there unless someone hand-edits a per-server override
    // into servers.json directly) -- no dashboard UI for it at all.
    //
    // Status channel stays explicit: a "Create" button, never automatic,
    // since a guild's status channels can hold servers from several
    // different agent owners and a silent background create wouldn't know
    // whose server it's even for. Servers no longer share one combined
    // channel -- each always gets its own, optionally grouped together
    // under a category (a Discord channel folder) so a guild with many
    // servers stays organized instead of cluttering the channel list.
    const categoryRow = h('div', { className: 'form-row' },
      h('label', null, 'Status Category (optional, groups servers together)'),
      h('div', { style: 'display:flex;gap:0.5rem;' },
        h('select', { id: 'statusCategorySelect', style: 'flex:1;' },
          h('option', { value: '' }, 'None'),
          h('option', { value: '__loading__', disabled: 'true' }, 'Loading categories…')
        ),
        h('button', { type: 'button', className: 'btn btn-secondary btn-sm', onClick: () => createChannel('category') }, '+ Create Category')
      )
    );

    const statusRow = h('div', { className: 'form-row' },
      h('label', null, 'Status Channel'),
      h('div', { style: 'display:flex;gap:0.5rem;' },
        h('select', { id: 'statusChannelSelect', style: 'flex:1;' },
          h('option', { value: '' }, 'None'),
          h('option', { value: '__loading__', disabled: 'true' }, 'Loading channels…')
        ),
        h('button', { type: 'button', className: 'btn btn-secondary btn-sm', onClick: () => createChannel('status') }, '+ Create')
      )
    );

    const logRow = h('div', { className: 'form-row' },
      h('label', null, 'Log Channel'),
      h('div', { style: 'display:flex;gap:0.5rem;' },
        h('select', { id: 'botLogChannelSelect', style: 'flex:1;' },
          h('option', { value: '' }, 'None'),
          h('option', { value: '__loading__', disabled: 'true' }, 'Loading channels…')
        ),
        h('button', { type: 'button', className: 'btn btn-secondary btn-sm', onClick: () => createChannel('log') }, '+ Create')
      )
    );

    // Creates a channel/category immediately (POST .../channels) and
    // selects it in the relevant dropdown -- the user still has to hit
    // Save/Attach to actually persist the status channel choice, same as
    // picking an existing one. A newly-created status channel nests under
    // whichever category is currently selected, if any.
    async function createChannel(kind) {
      const guildId = isEdit ? existingData.guildId : document.getElementById('guildSelect').value;
      if (!guildId) { showBanner(panel, 'Select a guild first.', 'error'); return; }
      const label = document.getElementById('serverLabel').value.trim() || serverLabel || 'server';
      const categoryId = document.getElementById('statusCategorySelect')?.value || undefined;
      try {
        const result = await api('/dashboard/servers/' + agentId + '/' + serverId + '/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guildId, kind, label, categoryId }),
        });
        if (kind === 'category') {
          const sel = document.getElementById('statusCategorySelect');
          const opt = h('option', { value: result.id }, result.name);
          sel.append(opt);
          sel.value = result.id;
          return;
        }
        if (kind === 'log') {
          const sel = document.getElementById('botLogChannelSelect');
          const opt = h('option', { value: result.id }, '#' + result.name);
          sel.append(opt);
          sel.value = result.id;
          return;
        }
        const sel = document.getElementById('statusChannelSelect');
        const opt = h('option', { value: result.id }, '#' + result.name);
        sel.append(opt);
        sel.value = result.id;
      } catch (err) {
        showBanner(panel, 'Failed to create channel: ' + err.message, 'error');
      }
    }

    const adminTagInput = buildTagInput('admin', isEdit && existingData.tierGrants?.admin?.userIds ? existingData.tierGrants.admin.userIds : []);
    const adminGroup = h('div', { className: 'tier-group' },
      h('div', { className: 'tier-group-title' }, 'Admin roles (full control)'),
      h('div', { id: 'adminRoleContainer' }, h('div', { className: 'spinner' }, 'Loading roles…')),
      h('div', { className: 'form-row', style: 'margin-top:0.5rem;margin-bottom:0;' },
        h('label', null, 'Individual Admin User IDs'),
        adminTagInput
      )
    );

    const opTagInput = buildTagInput('op', isEdit && existingData.tierGrants?.operator?.userIds ? existingData.tierGrants.operator.userIds : []);
    const opGroup = h('div', { className: 'tier-group' },
      h('div', { className: 'tier-group-title' }, 'Operator roles (start / stop / restart / kick)'),
      h('div', { id: 'opRoleContainer' }, h('div', { className: 'spinner' }, 'Loading roles…')),
      h('div', { className: 'form-row', style: 'margin-top:0.5rem;margin-bottom:0;' },
        h('label', null, 'Individual Operator User IDs'),
        opTagInput
      )
    );

    const commonInitialUserIds = isEdit ? (existingData.tierGrants?.common?.userIds || existingData.tierGrants?.mod?.userIds || []) : [];
    const commonTagInput = buildTagInput('common', commonInitialUserIds);
    const commonGroup = h('div', { className: 'tier-group' },
      h('div', { className: 'tier-group-title' }, 'Common roles (view status, players & metrics)'),
      h('div', { id: 'commonRoleContainer' }, h('div', { className: 'spinner' }, 'Loading roles…')),
      h('div', { className: 'form-row', style: 'margin-top:0.5rem;margin-bottom:0;' },
        h('label', null, 'Individual Common User IDs'),
        commonTagInput
      )
    );

    async function loadGuildResources(guildId) {
      if (!guildId) return;
      try {
        const res = await api('/dashboard/guilds/' + guildId + '/resources');
        const channels = res.channels || [];
        const categories = res.categories || [];
        const roles = res.roles || [];

        const statusSel = document.getElementById('statusChannelSelect');
        statusSel.innerHTML = '';
        statusSel.append(h('option', { value: '' }, 'None'));
        channels.forEach(c => {
          const opt = h('option', { value: c.id }, '#' + c.name);
          if (isEdit && existingData.statusChannelId === c.id) opt.selected = true;
          statusSel.append(opt);
        });

        const logSel = document.getElementById('botLogChannelSelect');
        logSel.innerHTML = '';
        logSel.append(h('option', { value: '' }, 'None'));
        channels.forEach(c => {
          const opt = h('option', { value: c.id }, '#' + c.name);
          if (isEdit && existingData.botLogChannelId === c.id) opt.selected = true;
          logSel.append(opt);
        });

        const catSel = document.getElementById('statusCategorySelect');
        catSel.innerHTML = '';
        catSel.append(h('option', { value: '' }, 'None'));
        categories.forEach(c => {
          const opt = h('option', { value: c.id }, c.name);
          if (isEdit && existingData.categoryId === c.id) opt.selected = true;
          catSel.append(opt);
        });

        const adminCon = document.getElementById('adminRoleContainer');
        adminCon.innerHTML = '';
        adminCon.append(renderRoleBadges('admin', roles, isEdit ? existingData.tierGrants?.admin?.roleIds : []));

        const opCon = document.getElementById('opRoleContainer');
        opCon.innerHTML = '';
        opCon.append(renderRoleBadges('op', roles, isEdit ? existingData.tierGrants?.operator?.roleIds : []));

        const commonRoleIds = isEdit ? (existingData.tierGrants?.common?.roleIds || existingData.tierGrants?.mod?.roleIds || []) : [];
        const commonCon = document.getElementById('commonRoleContainer');
        commonCon.innerHTML = '';
        commonCon.append(renderRoleBadges('common', roles, commonRoleIds));
      } catch (err) {
        showBanner(panel, 'Failed to load guild channels/roles: ' + err.message, 'error');
      }
    }

    const actions = h('div', { className: 'form-actions' },
      h('button', { className: 'btn btn-primary', onClick: async () => {
        const guildId = isEdit ? existingData.guildId : document.getElementById('guildSelect').value;
        if (!guildId) { showBanner(panel, 'Please select a guild.', 'error'); return; }
        const getCheckedRoles = (prefix) => Array.from(panel.querySelectorAll('input[id^="' + prefix + 'Role_"]:checked')).map(el => el.value);

        const commonRoles = getCheckedRoles('common');
        const commonUserIds = commonTagInput.getUserIds();

        const payload = {
          guildId,
          label: document.getElementById('serverLabel').value.trim(),
          tierGrants: {
            admin: { roleIds: getCheckedRoles('admin'), userIds: adminTagInput.getUserIds() },
            operator: { roleIds: getCheckedRoles('op'), userIds: opTagInput.getUserIds() },
            common: { roleIds: commonRoles, userIds: commonUserIds },
          },
          statusChannelId: (document.getElementById('statusChannelSelect').value && document.getElementById('statusChannelSelect').value !== '__loading__') ? document.getElementById('statusChannelSelect').value : null,
          botLogChannelId: (document.getElementById('botLogChannelSelect').value && document.getElementById('botLogChannelSelect').value !== '__loading__') ? document.getElementById('botLogChannelSelect').value : null,
          categoryId: (document.getElementById('statusCategorySelect').value && document.getElementById('statusCategorySelect').value !== '__loading__') ? document.getElementById('statusCategorySelect').value : null,
        };
        try {
          await api('/dashboard/servers/' + agentId + '/' + serverId + '/guilds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          showBanner(content, isEdit ? 'Server updated.' : 'Server attached to guild.', 'success');
          loadServers();
        } catch (err) {
          showBanner(panel, err.message, 'error');
        }
      }}, isEdit ? 'Save' : 'Attach'),
      h('button', { className: 'btn btn-secondary', onClick: () => panel.remove() }, 'Cancel')
    );

    panel.append(guildRow, labelRow, categoryRow, statusRow, logRow, adminGroup, opGroup, commonGroup, actions);
    card.append(panel);

    if (isEdit) {
      loadGuildResources(existingData.guildId);
    } else {
      loadGuilds().then(guilds => {
        const sel = document.getElementById('guildSelect');
        sel.innerHTML = '';
        sel.append(h('option', { value: '' }, '-- Select a guild --'));
        const attached = new Set();
        card.querySelectorAll('.guild-item').forEach(gi => { const gid = gi.dataset.guildId; if (gid) attached.add(gid); });
        guilds.filter(g => !attached.has(g.id)).forEach(g => {
          sel.append(h('option', { value: g.id }, g.name));
        });
        if (sel.options.length === 1) {
          sel.append(h('option', { value: '', disabled: 'true' }, 'No available guilds'));
        }
        sel.addEventListener('change', (e) => {
          if (e.target.value) loadGuildResources(e.target.value);
        });
      }).catch(err => showBanner(panel, 'Failed to load guilds: ' + err.message, 'error'));
    }
  }

  async function detachServer(agentId, serverId, guildId) {
    if (!confirm('Detach this server from the guild? The server will no longer be controllable from that guild.')) return;
    try {
      await api('/dashboard/servers/' + agentId + '/' + serverId + '/guilds/' + guildId, { method: 'DELETE' });
      showBanner(content, 'Server detached.', 'success');
      loadServers();
    } catch (err) {
      showBanner(content, err.message, 'error');
    }
  }

  async function buildSettingsPanel(agentId, serverId, serverLabel, card) {
    const old = card.querySelector('.settings-panel');
    if (old) { old.remove(); return; }

    const panel = h('div', { className: 'form-panel settings-panel' },
      h('h3', { style: 'margin-top:0;' }, 'World Settings — ' + serverLabel),
      h('div', { className: 'spinner' }, 'Loading world settings…')
    );
    card.append(panel);

    try {
      const data = await api('/dashboard/servers/' + agentId + '/' + serverId + '/settings');
      panel.innerHTML = '';
      panel.append(h('h3', { style: 'margin-top:0;' }, 'World Settings — ' + serverLabel));

      if (!data.settings || !Object.keys(data.settings).length) {
        showBanner(panel, 'No settings file configured or found for this server.', 'error');
        return;
      }

      const settingsMap = { ...data.settings };
      const categories = data.categories || {};
      const schema = data.schema || [];

      function buildFieldInput(meta, currentValue) {
        if (meta.type === 'boolean') {
          const hidden = h('input', { type: 'hidden', id: 'set_' + meta.key, value: currentValue ?? '' });
          const trueBtn = h('button', { type: 'button', className: 'toggle-btn' + (currentValue === 'True' ? ' active' : '') }, 'True');
          const falseBtn = h('button', { type: 'button', className: 'toggle-btn' + (currentValue === 'False' ? ' active' : '') }, 'False');
          trueBtn.addEventListener('click', () => {
            hidden.value = 'True';
            trueBtn.classList.add('active');
            falseBtn.classList.remove('active');
          });
          falseBtn.addEventListener('click', () => {
            hidden.value = 'False';
            falseBtn.classList.add('active');
            trueBtn.classList.remove('active');
          });
          return h('div', { className: 'toggle-group' }, hidden, trueBtn, falseBtn);
        }

        if (meta.type === 'range') {
          const numValue = parseFloat(currentValue);
          const hasValue = Number.isFinite(numValue);
          // A native range input silently clamps its value to [min, max] on
          // render -- if the ini's actual stored value falls outside the
          // schema's documented range, widen the bounds to include it so
          // hitting Save without touching this field can never silently
          // shrink the real value.
          const min = hasValue ? Math.min(meta.min ?? 0, numValue) : (meta.min ?? 0);
          const max = hasValue ? Math.max(meta.max ?? 100, numValue) : (meta.max ?? 100);
          const slider = h('input', {
            type: 'range',
            id: 'set_' + meta.key,
            min,
            max,
            step: meta.step || 0.1,
            value: hasValue ? numValue : min,
          });
          const readout = h('span', { className: 'range-readout' }, slider.value);
          slider.addEventListener('input', () => { readout.textContent = slider.value; });
          return h('div', { className: 'range-row' }, slider, readout);
        }

        return h('input', {
          type: meta.type === 'number' ? 'number' : 'text',
          step: meta.step || 'any',
          id: 'set_' + meta.key,
          value: currentValue ?? ''
        });
      }

      const form = h('div', { className: 'settings-grid', style: 'max-height:65vh;overflow-y:auto;padding-right:0.5rem;' });

      Object.entries(categories).forEach(([catKey, catInfo]) => {
        const catLabel = (catInfo && catInfo.icon ? catInfo.icon + ' ' : '') + (catInfo && catInfo.label ? catInfo.label : catKey);
        const catHeader = h('div', { className: 'tier-group-title', style: 'margin-top:1rem;font-size:0.85rem;' }, catLabel);
        const catFields = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0.75rem 1.25rem;margin-bottom:1rem;' });
        let count = 0;

        schema.forEach((meta) => {
          if (meta.category === catKey && meta.key in settingsMap) {
            count++;
            const row = h('div', { className: 'form-row', style: 'margin-bottom:0;' },
              h('label', null, (meta.label || meta.key) + (meta.unit ? ' (' + meta.unit + ')' : '')),
              buildFieldInput(meta, settingsMap[meta.key])
            );
            catFields.append(row);
          }
        });

        if (count > 0) {
          form.append(catHeader, catFields);
        }
      });

      const actions = h('div', { className: 'form-actions' },
        h('button', { className: 'btn btn-primary', onClick: async () => {
          const newSettings = {};
          schema.forEach((meta) => {
            const input = document.getElementById('set_' + meta.key);
            if (input) newSettings[meta.key] = input.value;
          });
          try {
            await api('/dashboard/servers/' + agentId + '/' + serverId + '/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ settings: newSettings }),
            });
            showBanner(panel, 'World settings saved successfully!', 'success');
          } catch (err) {
            showBanner(panel, err.message, 'error');
          }
        }}, 'Save Settings'),
        h('button', { className: 'btn btn-secondary', onClick: () => panel.remove() }, 'Close')
      );

      panel.append(form, actions);
    } catch (err) {
      panel.innerHTML = '';
      showBanner(panel, 'Failed to load settings: ' + err.message, 'error');
      panel.append(h('button', { className: 'btn btn-secondary', onClick: () => panel.remove(), style: 'margin-top:1rem;' }, 'Close'));
    }
  }

  async function loadServers() {
    try {
      const data = await api('/dashboard/servers');
      content.innerHTML = '';
      if (!data.agents.length) {
        content.append(h('div', { className: 'empty' }, 'No agents claimed yet. Claim an agent to get started.'));
        return;
      }
      let hasServers = false;
      for (const agent of data.agents) {
        for (const server of agent.servers) {
          hasServers = true;
          const card = h('div', { className: 'server-card' });
          const header = h('div', { className: 'server-card-header' },
            h('span', { className: 'label' }, server.label || server.serverId),
            h('span', { className: 'agent-id' }, 'agent: ' + agent.agentId)
          );
          card.append(header);

          if (server.attachedGuilds && server.attachedGuilds.length) {
            const list = h('ul', { className: 'guild-list' });
            for (const ag of server.attachedGuilds) {
              const item = h('li', { className: 'guild-item', 'data-guild-id': ag.guildId },
                h('span', { className: 'guild-item-name' }, ag.guildName),
                h('div', { className: 'guild-item-actions' },
                  h('button', { className: 'btn btn-secondary btn-sm', onClick: () => buildAttachForm(agent.agentId, server.serverId, server.label, ag, card) }, 'Edit'),
                  h('button', { className: 'btn btn-danger btn-sm', onClick: () => detachServer(agent.agentId, server.serverId, ag.guildId) }, 'Detach')
                )
              );
              list.append(item);
            }
            card.append(list);
          } else {
            card.append(h('div', { className: 'no-guilds' }, 'Not attached to any guild yet.'));
          }

          const btnGroup = h('div', { style: 'display:flex;gap:0.5rem;margin-top:0.75rem;' },
            h('button', { className: 'btn btn-primary', onClick: () => buildAttachForm(agent.agentId, server.serverId, server.label, null, card) }, '+ Attach to a guild'),
            h('button', { className: 'btn btn-secondary', onClick: () => buildSettingsPanel(agent.agentId, server.serverId, server.label, card) }, 'World Settings')
          );
          card.append(btnGroup);
          content.append(card);
        }
      }
      if (!hasServers) {
        content.append(h('div', { className: 'empty' }, 'Your agents have no registered servers yet. Add servers through the agent\'s local site.'));
      }
    } catch (err) {
      content.innerHTML = '';
      content.append(h('div', { className: 'error-banner' }, 'Failed to load servers: ' + err.message));
    }
  }

  loadHeader();
  loadServers();
})();
