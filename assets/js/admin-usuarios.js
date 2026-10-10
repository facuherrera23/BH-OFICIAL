/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Usuarios y Permisos
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, checkPasswordPwned, on, getAuthedClient, updateUserInfo, openModal, closeModal, downloadCSV, showToast, invalidateSearchCache, esc } = window.__BH || {};

  const USER_ROLE_LABELS = { super_admin: 'Super Admin', broker: 'Broker', agente: 'Agente' };
  const USER_ROLE_ORDER = ['super_admin', 'broker', 'agente'];
  const ROLE_BADGE_STYLE = {
    super_admin: { bg: 'rgba(31,200,195,0.12)', color: 'var(--accent)', border: 'rgba(31,200,195,0.3)', icon: 'fa-shield-halved' },
    broker: { bg: 'rgba(139,92,246,0.12)', color: '#a78bfa', border: 'rgba(139,92,246,0.3)', icon: 'fa-user-tie' },
    agente: { bg: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)', border: 'rgba(255,255,255,0.1)', icon: 'fa-user' },
  };
  const ROLE_CHANGE_INFO = {
    'agente>broker': 'Gana acceso al Chat Redes para responder mensajes de Instagram.',
    'broker>agente': 'Pierde acceso al Chat Redes. Sus conversaciones quedan para super_admin.',
    'agente>super_admin': 'Gana control total: usuarios, configuración, supervisión y todos los módulos.',
    'broker>super_admin': 'Gana control total: usuarios, configuración, supervisión y todos los módulos.',
    'super_admin>broker': 'Pierde gestión de usuarios, configuración y supervisión. Mantiene el chat.',
    'super_admin>agente': 'Pierde gestión de usuarios, configuración, supervisión Y el chat.',
  };
  let usersCache = [];
  let _roleFilter = '';
  let _sortKey = 'created_at';
  let _sortDir = 'asc';
  let _agentIds = new Set();

  /* ── Password strength ── */
  function evalPwdStrength(pwd) {
    let score = 0;
    if (pwd.length >= 6) score++;
    if (pwd.length >= 10) score++;
    if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++;
    if (/\d/.test(pwd)) score++;
    if (/[^a-zA-Z0-9]/.test(pwd)) score++;
    if (pwd.length >= 14) score++;
    const LEVELS = [
      { max: 1, color: '#ef4444', label: 'Muy débil' },
      { max: 2, color: '#ef4444', label: 'Débil' },
      { max: 3, color: '#FFB800', label: 'Aceptable' },
      { max: 4, color: '#FFB800', label: 'Buena' },
      { max: 5, color: '#00c878', label: 'Fuerte' },
      { max: 99, color: 'var(--accent)', label: 'Excelente' },
    ];
    const lvl = LEVELS.find(l => score <= l.max) || LEVELS[LEVELS.length - 1];
    return { score: Math.min(100, (score / 6) * 100), color: lvl.color, label: lvl.label };
  }

  function bindPasswordStrength(formEl, inputSelector, barId, labelId) {
    const input = formEl?.querySelector(inputSelector);
    const bar = document.getElementById(barId);
    const label = document.getElementById(labelId);
    if (!input || !bar || !label) return;
    input.addEventListener('input', () => {
      const pwd = input.value;
      if (!pwd) { bar.firstElementChild.style.width = '0%'; label.textContent = ''; return; }
      const r = evalPwdStrength(pwd);
      bar.firstElementChild.style.width = r.score + '%';
      bar.firstElementChild.style.background = r.color;
      label.textContent = 'Fuerza: ' + r.label;
      label.style.color = r.color;
    });
  }

  /* ── Show/hide password toggle ── */
  document.querySelectorAll('.pwd-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.closest('div')?.querySelector('input');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      const icon = btn.querySelector('i');
      if (icon) icon.className = 'fas ' + (input.type === 'password' ? 'fa-eye' : 'fa-eye-slash');
    });
  });

  function buildRoleSelect(userId, currentRole) {
    const isSelf = currentUser && userId === currentUser.id;
    if (isSelf) return '<span style="color:var(--text-dim); font-size:11px;"><i class="fas fa-user-shield" style="margin-right:4px; color:var(--accent); opacity:0.6;"></i>Tu usuario</span>';
    const options = USER_ROLE_ORDER.map(r =>
      `<option value="${r}" ${currentRole === r ? 'selected' : ''}>${USER_ROLE_LABELS[r]}</option>`
    ).join('');
    return `<select class="user-role-select" data-id="${esc(userId)}" data-current="${esc(currentRole || 'agente')}" style="background:rgba(255,255,255,0.03); border:1px solid var(--border-input); border-radius:10px; padding:7px 12px; color:#fff; font-size:12px;">${options}</select>`;
  }

  function canManageUsers() {
    return !!currentProfile && currentProfile.role === 'super_admin';
  }

  function userStatusCellHtml(u) {
    const isSelf = !!(currentUser && u.id === currentUser.id);
    const active = u.is_active !== false;
    const dot = '<span style="display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:5px; background:' + (active ? '#00c878' : '#ef4444') + ';"></span>';
    if (!canManageUsers() || isSelf) {
      return '<span style="font-size:11.5px; font-weight:600; color:' + (active ? 'var(--success)' : 'var(--danger)') + ';">' + dot + (active ? 'Activo' : 'Inactivo') + '</span>';
    }
    return '<button type="button" class="user-status-toggle" data-id="' + esc(u.id) + '" title="' + (active ? 'Desactivar acceso' : 'Reactivar acceso') + '" style="background:none; border:none; cursor:pointer; font-size:11.5px; font-weight:600; color:' + (active ? 'var(--success)' : 'var(--danger)') + '; padding:4px 8px; border-radius:999px;">' + dot + (active ? 'Activo' : 'Inactivo') + '</button>';
  }

  function userEditCellHtml(u) {
    const isSelf = !!(currentUser && u.id === currentUser.id);
    if (!(canManageUsers() || isSelf)) return '';
    return '<button type="button" class="user-edit-btn" data-id="' + esc(u.id) + '" title="' + (isSelf ? 'Editar mi usuario' : 'Editar usuario') + '" style="background:rgba(31,200,195,0.08); border:1px solid rgba(31,200,195,0.25); border-radius:8px; padding:6px 12px; color:var(--accent); cursor:pointer; font-size:12px;"><i class="fas fa-pen-to-square"></i></button>';
  }

  function renderKpis() {
    const el = document.getElementById('usersKpis');
    if (!el) return;
    const total = usersCache.length;
    const active = usersCache.filter(u => u.is_active !== false).length;
    const admins = usersCache.filter(u => u.role === 'super_admin').length;
    const brokers = usersCache.filter(u => u.role === 'broker').length;
    el.innerHTML =
      '<span style="display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:999px; padding:4px 14px; font-size:11.5px; color:var(--text-secondary);"><i class="fas fa-users" style="color:var(--accent); font-size:11px;"></i> <b style="color:#fff;">' + total + '</b> total</span>' +
      '<span style="display:flex; align-items:center; gap:6px; background:rgba(0,200,120,0.06); border:1px solid rgba(0,200,120,0.2); border-radius:999px; padding:4px 14px; font-size:11.5px; color:var(--success);"><b>' + active + '</b> activos</span>' +
      '<span style="display:flex; align-items:center; gap:6px; background:rgba(31,200,195,0.06); border:1px solid rgba(31,200,195,0.2); border-radius:999px; padding:4px 14px; font-size:11.5px; color:var(--accent);"><i class="fas fa-shield-halved" style="font-size:10px;"></i> <b>' + admins + '</b></span>' +
      '<span style="display:flex; align-items:center; gap:6px; background:rgba(139,92,246,0.06); border:1px solid rgba(139,92,246,0.2); border-radius:999px; padding:4px 14px; font-size:11.5px; color:#a78bfa;"><i class="fas fa-user-tie" style="font-size:10px;"></i> <b>' + brokers + '</b></span>';
  }

  function applyFilters() {
    const tbody = $('#usersTableBody');
    if (!tbody) return;
    let list = [...usersCache];
    if (_roleFilter) list = list.filter(u => u.role === _roleFilter);
    const search = ($('#usersSearchInput')?.value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (search) list = list.filter(u => {
      const txt = (u.full_name + ' ' + u.email + ' ' + (u.phone || '')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return txt.includes(search);
    });
    list.sort((a, b) => {
      const va = a[_sortKey] || '';
      const vb = b[_sortKey] || '';
      const cmp = String(va).localeCompare(String(vb), 'es', { sensitivity: 'base' });
      return _sortDir === 'asc' ? cmp : -cmp;
    });
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:36px; color:var(--text-dim);"><i class="fas fa-user-plus" style="font-size:24px; opacity:0.3; display:block; margin-bottom:10px;"></i>' + (usersCache.length ? 'Ningún usuario coincide con el filtro.' : 'No hay usuarios aún. Tocá "+ Invitar Usuario" para agregar el primero.') + '</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(u => {
      const rbs = ROLE_BADGE_STYLE[u.role] || ROLE_BADGE_STYLE.agente;
      const isSelf = !!(currentUser && u.id === currentUser.id);
      return `
        <tr style="${isSelf ? 'background:rgba(31,200,195,0.03);' : ''}">
          <td style="font-weight:500; color:#fff; font-size:13px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="width:30px; height:30px; border-radius:50%; background:${rbs.bg}; border:1px solid ${rbs.border}; display:flex; align-items:center; justify-content:center; font-size:12px; color:${rbs.color}; flex-shrink:0; position:relative;"><i class="fas ${rbs.icon}" style="font-size:11px;"></i>${_agentIds.has(u.id) ? '<span style="position:absolute; bottom:-1px; right:-1px; width:10px; height:10px; border-radius:50%; background:var(--success); border:2px solid var(--bg-secondary); display:flex; align-items:center; justify-content:center;" title="Agente linkeado — asignable a leads, propiedades y chat"></span>' : u.role !== 'super_admin' ? '<span style="position:absolute; bottom:-1px; right:-1px; width:10px; height:10px; border-radius:50%; background:#ef4444; border:2px solid var(--bg-secondary); display:flex; align-items:center; justify-content:center;" title="SIN agente linkeado — no asignable a leads, propiedades ni chat"></span>' : ''}</span>
              <span>${esc(u.full_name || u.email || 'Sin nombre')}${isSelf ? ' <span style="font-size:10px; color:var(--accent); font-weight:700; margin-left:4px;">(vos)</span>' : ''}</span>
            </div>
          </td>
          <td><button type="button" class="user-email-copy" data-email="${esc(u.email || '')}" style="background:none; border:none; color:var(--text-dim); font-size:12px; cursor:pointer; text-decoration:underline dotted; text-underline-offset:3px; padding:2px 0;" title="Click para copiar">${esc(u.email || '-')}</button></td>
          <td><span style="display:inline-block; padding:3px 12px; border-radius:999px; font-size:11px; font-weight:700; background:${rbs.bg}; color:${rbs.color}; border:1px solid ${rbs.border};">${esc(USER_ROLE_LABELS[u.role] || u.role || 'agente')}</span></td>
          <td>${userStatusCellHtml(u)}</td>
          <td style="color:var(--text-dim); font-size:12px;">${u.created_at ? new Date(u.created_at).toLocaleDateString('es-AR') : '-'}</td>
          <td>${buildRoleSelect(u.id, u.role)}</td>
          <td>${userEditCellHtml(u)}</td>
        </tr>`;
    }).join('');
  }

  async function loadUsers() {
    invalidateSearchCache();
    const tbody = $('#usersTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;
    try {
      const [profilesRes, agentsRes] = await Promise.all([
        client.from('profiles').select('id, full_name, email, phone, role, is_active, created_at, updated_at').order('created_at', { ascending: true }),
        client.from('agents').select('profile_id').not('profile_id', 'is', null),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      usersCache = profilesRes.data || [];
      _agentIds = new Set((agentsRes.data || []).map(a => a.profile_id));
      renderKpis();
      applyFilters();
    } catch (err) {
      logError('Users error:', err);
    }
  }

  async function callManageUsers(payload) {
    if (!window.supabaseClient) throw new Error('Supabase no disponible');
    const { data, error } = await window.supabaseClient.auth.getSession();
    if (error || !data?.session?.access_token) throw new Error('Sesión requerida');
    const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/manage-users`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Error ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }

  function showUserTempPassword(tempPassword, email) {
    const box = $('#userTempPassBox');
    const input = $('#userTempPass');
    if (box && input) {
      box.style.display = '';
      input.value = tempPassword;
      input.focus();
      input.select();
    }
    showToast(`Usuario creado: ${email}. Copiá la contraseña y pasásela por WhatsApp.`, 'warning', 8000);
  }

  on($('#userTempPass'), 'click', function () { this.select(); });
  on($('#userTempPassCopy'), 'click', async function () {
    const input = $('#userTempPass');
    if (!input || !input.value) return;
    try { await navigator.clipboard.writeText(input.value); showToast('Contraseña copiada', 'success'); }
    catch { input.select(); document.execCommand('copy'); showToast('Contraseña copiada', 'success'); }
  });

  on($('#btnExportUsers'), 'click', () => {
    if (!usersCache.length) { showToast('No hay usuarios para exportar', 'warning'); return; }
    const headers = ['ID', 'Nombre', 'Email', 'Teléfono', 'Rol', 'Activo', 'Creado'];
    const rows = usersCache.map(u => [u.id, u.full_name || '', u.email || '', u.phone || '', USER_ROLE_LABELS[u.role] || u.role || '', u.is_active === false ? 'No' : 'Sí', u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : '']);
    downloadCSV(`usuarios-${new Date().toISOString().slice(0, 10)}.csv`, rows, headers);
    showToast(`Usuarios exportados (${rows.length})`, 'success');
  });

  let _usersSearchTimer = null;
  const usersSearchEl = $('#usersSearchInput');
  if (usersSearchEl && !usersSearchEl.dataset.bound) {
    usersSearchEl.dataset.bound = '1';
    usersSearchEl.addEventListener('input', () => {
      clearTimeout(_usersSearchTimer);
      _usersSearchTimer = setTimeout(applyFilters, 200);
    });
  }

  const roleFilterEl = document.getElementById('usersRoleFilter');
  if (roleFilterEl && !roleFilterEl.dataset.bound) {
    roleFilterEl.dataset.bound = '1';
    roleFilterEl.addEventListener('change', () => {
      _roleFilter = roleFilterEl.value;
      applyFilters();
    });
  }

  on($('#usersTableBody'), 'click', async (e) => {
    const emailBtn = e.target.closest('.user-email-copy');
    if (emailBtn && emailBtn.dataset.email) {
      try { await navigator.clipboard.writeText(emailBtn.dataset.email); showToast('Email copiado', 'success'); }
      catch { showToast('No se pudo copiar', 'warning'); }
      return;
    }
    const editBtn = e.target.closest('.user-edit-btn');
    if (editBtn) { openUserEditor(editBtn.dataset.id); return; }
    const toggleBtn = e.target.closest('.user-status-toggle');
    if (toggleBtn && !toggleBtn.disabled) await toggleUserActive(toggleBtn.dataset.id);
  });

  document.querySelectorAll('#usersTableBody th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (_sortKey === k) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      else { _sortKey = k; _sortDir = 'asc'; }
      document.querySelectorAll('#usersTableBody th[data-sort] i').forEach(i => i.className = 'fas fa-sort');
      const icon = th.querySelector('i');
      if (icon) icon.className = 'fas ' + (_sortDir === 'asc' ? 'fa-sort-up' : 'fa-sort-down');
      applyFilters();
    });
  });

  on($('#btnNewUser'), 'click', () => {
    $('#userForm')?.reset();
    const passBox = $('#userTempPassBox');
    if (passBox) passBox.style.display = 'none';
    openModal('userModal');
  });

  const userNoEmailCb = document.querySelector('#userForm input[name="no_email"]');
  const userModeHint = document.getElementById('userModeHint');
  on(userNoEmailCb, 'change', () => {
    const btn = $('#userSaveBtn');
    if (btn) btn.textContent = userNoEmailCb.checked ? 'Crear Usuario' : 'Enviar Invitación';
    if (userModeHint) {
      userModeHint.innerHTML = userNoEmailCb.checked
        ? '<i class="fas fa-key" style="color:var(--success); margin-right:4px;"></i>Sin email: se genera una contraseña temporal que le pasás por WhatsApp. Sin límite de envíos.'
        : '<i class="fas fa-envelope" style="color:var(--accent); margin-right:4px;"></i>Con email: le llega una invitación de Supabase. El usuario define su contraseña. <b style="color:#FFB800;">Límite: 3 emails/hora (plan free).</b>';
    }
  });

  on($('#userForm'), 'submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('#userSaveBtn');
    if (!btn) return;
    const fd = new FormData(form);
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando...';
    try {
      const noEmail = fd.get('no_email') === 'on';
      const out = await callManageUsers({
        action: noEmail ? 'create-direct' : 'invite',
        email: String(fd.get('email') || '').trim(),
        full_name: String(fd.get('full_name') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        role: String(fd.get('role') || 'agente'),
      });
      if (noEmail && out.tempPassword) {
        showUserTempPassword(out.tempPassword, String(fd.get('email') || '').trim());
        loadUsers();
      } else {
        showToast(`Invitación enviada a ${fd.get('email')}. El usuario debe aceptarla desde su correo.`, 'success', 6000);
        closeModal('userModal');
        form.reset();
        loadUsers();
      }
    } catch (err) {
      let msg = err.message || 'No se pudo enviar la invitación';
      if (/rate limit|too many|429/i.test(msg)) {
        msg = 'Límite de emails alcanzado (3/hora en el plan free). Usá "Crear sin email" o esperá una hora.';
      }
      showToast(msg, 'error', 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = userNoEmailCb?.checked ? 'Crear Usuario' : 'Enviar Invitación';
    }
  });

  on($('#usersTableBody'), 'change', async (e) => {
    const select = e.target.closest('.user-role-select');
    if (!select) return;
    const previous = select.dataset.current || 'agente';
    const next = select.value;
    if (next === previous) return;
    const key = previous + '>' + next;
    const contextInfo = ROLE_CHANGE_INFO[key] || '';
    const label = USER_ROLE_LABELS[next] || next;
    const prevLabel = USER_ROLE_LABELS[previous] || previous;
    const confirm = typeof window.showConfirmDialog === 'function'
      ? await window.showConfirmDialog({
          title: 'Cambiar rol',
          message: `¿Cambiar rol de ${prevLabel} a ${label}?${contextInfo ? '\n\n' + contextInfo : ''}`,
          icon: 'fas fa-user-shield',
          confirmText: 'Confirmar',
        })
      : window.confirm(`¿Cambiar rol de ${prevLabel} a ${label}?`);
    if (!confirm) { select.value = previous; return; }
    select.disabled = true;
    try {
      await callManageUsers({ action: 'set-role', userId: select.dataset.id, role: next });
      showToast(`Rol actualizado a ${label}`, 'success');
      loadUsers();
    } catch (err) {
      select.value = previous;
      showToast(err.message || 'No se pudo cambiar el rol', 'error');
    } finally { select.disabled = false; }
  });

  on($('#sidebarUserProfile'), 'click', (e) => {
    if (e.target.closest('#logoutBtn')) return;
    if (e.target.closest('#changePasswordBtn')) return;
    if (currentProfile?.id) openUserEditor(currentProfile.id);
  });

  function openPasswordModal() {
    $('#passwordChangeForm')?.reset();
    const errEl = $('#passwordChangeError');
    if (errEl) { errEl.style.display = 'none'; }
    openModal('passwordModal');
  }

  on($('#changePasswordBtn'), 'click', () => {
    if (!currentUser || !window.supabaseClient) return;
    openPasswordModal();
  });

  function openUserEditor(userId) {
    const row = usersCache.find((u) => u.id === userId);
    const form = $('#userEditForm');
    if (!row || !form || !currentProfile) return;
    form.reset();
    form.elements.userId.value = row.id;
    form.elements.full_name.value = row.full_name || '';
    form.elements.email.value = row.email || '';
    form.elements.phone.value = row.phone || '';
    form.elements.role.value = USER_ROLE_ORDER.includes(row.role) ? row.role : 'agente';
    form.elements.is_active.value = row.is_active === false ? 'false' : 'true';
    const isSelf = row.id === currentProfile.id;
    const lockPrivileged = isSelf || !canManageUsers();
    form.elements.role.disabled = lockPrivileged;
    form.elements.is_active.disabled = lockPrivileged;
    const roleHint = $('#userEditRoleHint');
    const statusHint = $('#userEditStatusHint');
    if (roleHint) roleHint.style.display = isSelf ? '' : 'none';
    if (statusHint) statusHint.style.display = isSelf ? '' : 'none';
    const note = $('#userEditEmailNote');
    if (note) {
      const showNote = isSelf && !canManageUsers();
      note.style.display = showNote ? '' : 'none';
      note.textContent = showNote ? 'Si cambiás tu email vas a recibir una confirmación en la casilla nueva.' : '';
    }
    const delBtn = $('#userEditDeleteBtn');
    if (delBtn) delBtn.style.display = (canManageUsers() && !isSelf) ? '' : 'none';
    openModal('userEditModal');
  }

  async function toggleUserActive(userId) {
    if (!canManageUsers() || userId === currentProfile?.id) return;
    const row = usersCache.find((u) => u.id === userId);
    if (!row) return;
    const nextActive = row.is_active === false;
    const label = row.full_name || row.email || 'este usuario';
    const confirm = typeof window.showConfirmDialog === 'function'
      ? await window.showConfirmDialog({
          title: nextActive ? 'Reactivar acceso' : 'Desactivar acceso',
          message: nextActive ? `¿Reactivar el acceso de ${label}?` : `¿Desactivar el acceso de ${label}? No podrá volver a iniciar sesión.`,
          icon: nextActive ? 'fas fa-user-check' : 'fas fa-user-xmark',
          confirmText: nextActive ? 'Reactivar' : 'Desactivar',
          danger: !nextActive,
        })
      : window.confirm(`¿${nextActive ? 'Reactivar' : 'Desactivar'} el acceso de ${label}?`);
    if (!confirm) return;
    try {
      await callManageUsers({ action: 'update-user', userId, is_active: nextActive });
      showToast(nextActive ? 'Usuario reactivado' : 'Usuario desactivado', 'success');
      loadUsers();
    } catch (err) {
      showToast(err.message || 'No se pudo cambiar el estado', 'error');
    }
  }

  on($('#userEditForm'), 'submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('#userEditSaveBtn');
    if (!btn || !currentProfile) return;
    const fd = new FormData(form);
    const userId = String(fd.get('userId') || '');
    const fullName = String(fd.get('full_name') || '').trim().replace(/\s+/g, ' ');
    const email = String(fd.get('email') || '').trim().toLowerCase();
    const phone = String(fd.get('phone') || '').trim();
    const row = usersCache.find((u) => u.id === userId);
    if (!userId || !row) return;
    if (!fullName || fullName.length < 2) { showToast('El nombre completo es obligatorio (mín. 2 caracteres)', 'error'); return; }
    const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (email && !EMAIL_RX.test(email)) { showToast('Email inválido', 'error'); return; }
    const dup = usersCache.find(u => u.id !== userId && String(u.email || '').toLowerCase() === email);
    if (dup) { showToast('Otro usuario ya usa ese email', 'error'); return; }
    const isSelf = userId === currentProfile.id;
    const isAdmin = canManageUsers();
    if (!isAdmin && !isSelf) { showToast('Solo podés editar tu propio usuario.', 'error'); return; }
    const emailChanged = !!email && email !== String(row.email || '').toLowerCase();
    btn.disabled = true;
    try {
      let emailNotice = '';
      if (!isAdmin && emailChanged) {
        const { error: emailErr } = await window.supabaseClient.auth.updateUser({ email });
        if (emailErr) throw emailErr;
        emailNotice = ' Cambio de email pendiente: revisá la casilla nueva.';
      }
      const payload = isAdmin
        ? { action: 'update-user', userId, full_name: fullName, phone }
        : { action: 'update-self', full_name: fullName, phone };
      if (isAdmin && emailChanged) payload.email = email;
      if (isAdmin && !isSelf) {
        const nextRole = String(fd.get('role') || '');
        if (nextRole && nextRole !== row.role) payload.role = nextRole;
        const nextActive = fd.get('is_active') !== 'false';
        if (nextActive !== (row.is_active !== false)) payload.is_active = nextActive;
      }
      await callManageUsers(payload);
      closeModal('userEditModal');
      showToast(`Usuario actualizado.${emailNotice}`, 'success');
      await loadUsers();
      if (isSelf) {
        currentProfile = { ...currentProfile, full_name: fullName, phone };
        window._bhCurrentProfile = currentProfile;
        updateUserInfo();
      }
    } catch (err) {
      showToast(err.message || 'No se pudo actualizar', 'error');
    } finally { btn.disabled = false; }
  });

  on($('#userEditDeleteBtn'), 'click', async () => {
    const form = $('#userEditForm');
    if (!form) return;
    const userId = form.elements.userId.value;
    if (!userId) return;
    if (!canManageUsers()) { showToast('Solo Super Admin puede eliminar usuarios', 'error'); return; }
    if (userId === currentProfile?.id) { showToast('No podés eliminarte a vos mismo', 'error'); return; }
    const row = usersCache.find(u => u.id === userId);
    const label = row?.full_name || row?.email || 'este usuario';
    const confirm = typeof window.showConfirmDialog === 'function'
      ? await window.showConfirmDialog({
          title: 'Eliminar usuario',
          message: `¿Eliminar definitivamente a ${label}? Se borrará su cuenta y su perfil. Esta acción no se puede deshacer.`,
          icon: 'fas fa-user-xmark',
          confirmText: 'Eliminar',
          danger: true,
        })
      : window.confirm(`¿Eliminar definitivamente a ${label}?`);
    if (!confirm) return;
    const btn = $('#userEditDeleteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Eliminando...';
    try {
      await callManageUsers({ action: 'delete-user', userId });
      closeModal('userEditModal');
      showToast('Usuario eliminado', 'success');
      await loadUsers();
    } catch (err) {
      showToast(err.message || 'No se pudo eliminar el usuario', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Eliminar Usuario';
    }
  });

  on($('#passwordChangeForm'), 'submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const currentPwd = String(fd.get('current_password') || '');
    const pwd = String(fd.get('password') || '');
    const pwd2 = String(fd.get('password2') || '');
    const errEl = $('#passwordChangeError');
    const btn = $('#passwordChangeBtn');
    const fail = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
    if (!currentUser || !window.supabaseClient) return;
    if (!currentPwd) return fail('Ingresá tu contraseña actual.');
    if (pwd.length < 6) return fail('La nueva contraseña debe tener al menos 6 caracteres.');
    if (pwd !== pwd2) return fail('Las contraseñas nuevas no coinciden.');
    const pwned = await checkPasswordPwned(pwd);
    if (pwned.pwned) return fail(`Esta contraseña apareció en ${pwned.count.toLocaleString('es-AR')} filtraciones. Usa otra.`);
    btn.disabled = true;
    try {
      const { error: verifyErr } = await window.supabaseClient.auth.signInWithPassword({ email: currentUser.email, password: currentPwd });
      if (verifyErr) { fail('La contraseña actual es incorrecta.'); return; }
      const { error } = await window.supabaseClient.auth.updateUser({ password: pwd });
      if (error) throw error;
      closeModal('passwordModal');
      showToast('Contraseña actualizada correctamente', 'success');
    } catch (err) {
      fail(err.message || 'No se pudo cambiar la contraseña.');
    } finally { btn.disabled = false; }
  });

  /* ── Password strength en formularios ── */
  bindPasswordStrength($('#inviteSetupForm'), 'input[name="password"]', 'pwdStrengthBar', 'pwdStrengthLabel');
  bindPasswordStrength($('#passwordChangeForm'), 'input[name="password"]', 'pwdStrengthBarChange', 'pwdStrengthLabelChange');

  window.__BH.loadUsers = loadUsers;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadUsers')) Object.defineProperty(window, 'loadUsers', { get: () => loadUsers, configurable: true });
  window.__BH.USER_ROLE_LABELS = USER_ROLE_LABELS;
  if (!Object.prototype.hasOwnProperty.call(window, 'USER_ROLE_LABELS')) Object.defineProperty(window, 'USER_ROLE_LABELS', { get: () => USER_ROLE_LABELS, configurable: true });
  window.__BH.canManageUsers = canManageUsers;
  if (!Object.prototype.hasOwnProperty.call(window, 'canManageUsers')) Object.defineProperty(window, 'canManageUsers', { get: () => canManageUsers, configurable: true });
})();
