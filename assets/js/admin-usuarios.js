/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Usuarios y Permisos
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, checkPasswordPwned, on, getAuthedClient, updateUserInfo, openModal, closeModal, downloadCSV, showToast, invalidateSearchCache, esc } = window.__BH || {};

  /* ------------------------------------------------
     12. USERS MANAGEMENT
     ------------------------------------------------ */
  const USER_ROLE_LABELS = { super_admin: 'Super Admin', broker: 'Broker', agente: 'Agente' };
  const USER_ROLE_ORDER = ['super_admin', 'broker', 'agente'];
  let usersCache = [];

  function buildRoleSelect(userId, currentRole) {
    const isSelf = currentUser && userId === currentUser.id;
    if (isSelf) {
      return '<span style="color:var(--text-dim); font-size:12px;">Tu usuario</span>';
    }
    const options = USER_ROLE_ORDER.map(r =>
      `<option value="${r}" ${currentRole === r ? 'selected' : ''}>${USER_ROLE_LABELS[r]}</option>`
    ).join('');
    return `<select class="user-role-select" data-id="${esc(userId)}" data-current="${esc(currentRole || 'agente')}" style="background:rgba(255,255,255,0.03); border:1px solid var(--border-input); border-radius:10px; padding:7px 12px; color:#fff; font-size:12.5px;">${options}</select>`;
  }

  function canManageUsers() {
    return !!currentProfile && currentProfile.role === 'super_admin';
  }

  function userStatusCellHtml(u) {
    const isSelf = !!(currentUser && u.id === currentUser.id);
    const active = u.is_active !== false;
    if (!canManageUsers() || isSelf) {
      return '<span class="nav-badge" style="background:' + (active ? 'rgba(0,200,120,0.15)' : 'rgba(255,60,60,0.15)') + '; color:' + (active ? 'var(--success)' : 'var(--danger)') + '; font-size:11px;">' + (active ? 'Activo' : 'Inactivo') + '</span>';
    }
    return '<button type="button" class="nav-badge user-status-toggle" data-id="' + esc(u.id) + '" title="' + (active ? 'Desactivar acceso' : 'Reactivar acceso') + '" style="background:' + (active ? 'rgba(0,200,120,0.15)' : 'rgba(255,60,60,0.15)') + '; color:' + (active ? 'var(--success)' : 'var(--danger)') + '; font-size:11px; border:none; cursor:pointer;">' + (active ? 'Activo' : 'Inactivo') + '</button>';
  }

  function userEditCellHtml(u) {
    const isSelf = !!(currentUser && u.id === currentUser.id);
    if (!(canManageUsers() || isSelf)) {
      return '<span style="color:var(--text-dim); font-size:12px;">-</span>';
    }
    return '<button type="button" class="user-edit-btn" data-id="' + esc(u.id) + '" title="' + (isSelf ? 'Editar mi usuario' : 'Editar usuario') + '" style="background:rgba(255,255,255,0.05); border:1px solid var(--border-input); border-radius:8px; padding:6px 10px; color:var(--accent); cursor:pointer;"><i class="fas fa-pen-to-square"></i></button>';
  }

  async function loadUsers() {
    invalidateSearchCache();
    const tbody = $('#usersTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const { data, error } = await client
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;
      usersCache = data || [];

      if (!usersCache.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-dim);">No hay usuarios</td></tr>';
        return;
      }

      tbody.innerHTML = data.map((u) => `
        <tr>
          <td style="font-weight:500; color:#fff; font-size:13px;">${esc(u.full_name || u.email || 'Sin nombre')}</td>
          <td style="font-size:13px; color:var(--text-dim);">${esc(u.email || '-')}</td>
          <td><span class="nav-badge" style="background:${u.role === 'super_admin' ? 'rgba(31,200,195,0.15)' : 'rgba(255,255,255,0.06)'}; color:${u.role === 'super_admin' ? 'var(--accent)' : 'var(--text-dim)'}; font-size:11px;">${esc(USER_ROLE_LABELS[u.role] || u.role || 'agente')}</span></td>
          <td>${userStatusCellHtml(u)}</td>
          <td style="color:var(--text-dim); font-size:12px;">${u.created_at ? new Date(u.created_at).toLocaleDateString('es-AR') : '-'}</td>
          <td>${buildRoleSelect(u.id, u.role)}</td>
          <td>${userEditCellHtml(u)}</td>
        </tr>`).join('');
    } catch (err) {
      logError('Users error:', err);
    }
  }

  /* User management via edge function manage-users (requiere super_admin). */
  async function getAdminToken() {
    if (!window.supabaseClient) throw new Error('Supabase no disponible');
    const { data, error } = await window.supabaseClient.auth.getSession();
    if (error || !data?.session?.access_token) throw new Error('Sesión requerida');
    return data.session.access_token;
  }

  async function callManageUsers(payload) {
    const token = await getAdminToken();
    const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/manage-users`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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
    showToast(`Usuario creado: ${email}. Copiá la contraseña temporal y pasásela al usuario.`, 'warning');
  }

  on($('#userTempPass'), 'click', function () { this.select(); });
  on($('#userTempPassCopy'), 'click', async function () {
    const input = $('#userTempPass');
    if (!input || !input.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      showToast('Contraseña copiada al portapapeles', 'success');
    } catch {
      input.select();
      document.execCommand('copy');
      showToast('Contraseña copiada', 'success');
    }
  });

  on($('#btnExportUsers'), 'click', () => {
    if (!usersCache.length) { showToast('No hay usuarios para exportar', 'warning'); return; }
    const headers = ['ID', 'Nombre', 'Email', 'Teléfono', 'Rol', 'Activo', 'Creado'];
    const rows = usersCache.map(u => [
      u.id, u.full_name || '', u.email || '', u.phone || '',
      USER_ROLE_LABELS[u.role] || u.role || '', u.is_active === false ? 'No' : 'Sí',
      u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : ''
    ]);
    downloadCSV(`usuarios-${new Date().toISOString().slice(0, 10)}.csv`, rows, headers);
    showToast(`Usuarios exportados (${rows.length})`, 'success');
  });

  let _usersSearchTimer = null;
  const usersSearchEl = $('#usersSearchInput');
  if (usersSearchEl && !usersSearchEl.dataset.bound) {
    usersSearchEl.dataset.bound = '1';
    usersSearchEl.addEventListener('input', () => {
      clearTimeout(_usersSearchTimer);
      _usersSearchTimer = setTimeout(() => {
        const q = usersSearchEl.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        $$('#usersTableBody tr').forEach(tr => {
          const txt = (tr.textContent || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          tr.style.display = !q || txt.includes(q) ? '' : 'none';
        });
      }, 200);
    });
  }

  on($('#btnNewUser'), 'click', () => {
    $('#userForm')?.reset();
    const passBox = $('#userTempPassBox');
    if (passBox) passBox.style.display = 'none';
    openModal('userModal');
  });

  const userNoEmailCb = document.querySelector('#userForm input[name="no_email"]');
  on(userNoEmailCb, 'change', () => {
    const btn = $('#userSaveBtn');
    if (btn) btn.textContent = userNoEmailCb.checked ? 'Crear Usuario' : 'Enviar Invitación';
  });

  on($('#userForm'), 'submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('#userSaveBtn');
    if (!btn) return;
    const fd = new FormData(form);
    btn.disabled = true;
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
        showToast(`Invitación enviada a ${fd.get('email')}. Debe aceptarla desde su email para definir su contraseña.`, 'success');
        closeModal('userModal');
        form.reset();
        loadUsers();
      }
    } catch (err) {
      let msg = err.message || 'No se pudo enviar la invitación';
      if (/rate limit|too many|429/i.test(msg)) {
        msg = 'Se alcanzó el límite de emails por hora del servidor. Usá "Crear sin email" o configurá un SMTP propio (Authentication ? SMTP).';
      }
      showToast(msg, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  on($('#usersTableBody'), 'change', async (e) => {
    const select = e.target.closest('.user-role-select');
    if (!select) return;
    const previous = select.dataset.current || 'agente';
    const next = select.value;
    if (next === previous) return;

    if (previous === 'super_admin' && !window.confirm(`¿Quitar el rol Super Admin a este usuario?`)) {
      select.value = previous;
      return;
    }
    const ROLE_RANK = { agente: 1, broker: 2, super_admin: 3 };
    if ((ROLE_RANK[next] || 0) < (ROLE_RANK[previous] || 0) && !window.confirm(`¿Degradar a este usuario de ${USER_ROLE_LABELS[previous] || previous} a ${USER_ROLE_LABELS[next] || next}?`)) {
      select.value = previous;
      return;
    }
    select.disabled = true;
    try {
      await callManageUsers({ action: 'set-role', userId: select.dataset.id, role: next });
      showToast('Rol actualizado correctamente', 'success');
      loadUsers();
    } catch (err) {
      select.value = previous;
      showToast(err.message || 'No se pudo cambiar el rol', 'error');
    } finally {
      select.disabled = false;
    }
  });

  on($('#usersTableBody'), 'click', async (e) => {
    const editBtn = e.target.closest('.user-edit-btn');
    if (editBtn) {
      openUserEditor(editBtn.dataset.id);
      return;
    }
    const toggleBtn = e.target.closest('.user-status-toggle');
    if (toggleBtn && !toggleBtn.disabled) await toggleUserActive(toggleBtn.dataset.id);
  });

  on($('#sidebarUserProfile'), 'click', (e) => {
    /* Logout y cambio de contraseña viven dentro de la tarjeta:
       ninguno de los dos debe abrir el editor. */
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

    /* Rol y estado propios bloqueados en UI y backend: nadie se auto-degrada
       ni auto-desactiva, y nunca queda el sistema sin super_admin activo. */
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
      note.textContent = showNote
        ? 'Si cambiás tu email vas a recibir una confirmación en la casilla nueva para aplicar el cambio.'
        : '';
    }

    openModal('userEditModal');
  }

  async function toggleUserActive(userId) {
    if (!canManageUsers() || userId === currentProfile?.id) return;
    const row = usersCache.find((u) => u.id === userId);
    if (!row) return;

    const nextActive = row.is_active === false;
    const label = row.full_name || row.email || 'este usuario';
    if (!nextActive) {
      let orphanNote = '';
      try {
        const { count } = await window.supabaseClient.from('leads').select('id', { count: 'exact', head: true }).eq('assigned_to', userId).is('deleted_at', null);
        if (count) orphanNote = ` Tiene ${count} lead${count !== 1 ? 's' : ''} asignado${count !== 1 ? 's' : ''} que quedarán sin atención.`;
      } catch (_) {}
      if (!window.confirm(`¿Desactivar el acceso de ${label}? No podrá volver a iniciar sesión.${orphanNote}`)) return;
    } else {
      if (!window.confirm(`¿Reactivar el acceso de ${label}?`)) return;
    }

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

    if (!fullName || fullName.length < 2) {
      showToast('El nombre completo es obligatorio (mín. 2 caracteres)', 'error');
      return;
    }
    const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (email && !EMAIL_RX.test(email)) {
      showToast('Email inválido', 'error');
      return;
    }
    const dup = usersCache.find(u => u.id !== userId && String(u.email || '').toLowerCase() === email);
    if (dup) {
      showToast('Otro usuario ya usa ese email', 'error');
      return;
    }

    const isSelf = userId === currentProfile.id;
    const isAdmin = canManageUsers();

    /* Sin rol admin solo hay autogestion: defensa extra junto al backend. */
    if (!isAdmin && !isSelf) {
      showToast('Solo podés editar tu propio usuario.', 'error');
      return;
    }
    const emailChanged = !!email && email !== String(row.email || '').toLowerCase();

    btn.disabled = true;
    try {
      let emailNotice = '';

      /* Email propio sin rol admin: flujo estandar de Supabase con
         confirmacion por mail en ambas casillas. */
      if (!isAdmin && emailChanged) {
        const { error: emailErr } = await window.supabaseClient.auth.updateUser({ email });
        if (emailErr) throw emailErr;
        emailNotice = ' Cambio de email pendiente: revisá la casilla nueva para confirmarlo.';
      }

      const payload = isAdmin
        ? { action: 'update-user', userId, full_name: fullName, phone }
        : { action: 'update-self', full_name: fullName, phone };

      if (isAdmin && emailChanged) payload.email = email;

      if (isAdmin && !isSelf) {
        const nextRole = String(fd.get('role') || '');
        if (nextRole && nextRole !== row.role) {
          if (row.role === 'super_admin' && !window.confirm('¿Quitar el rol Super Admin a este usuario?')) {
            return;
          }
          payload.role = nextRole;
        }
        const nextActive = fd.get('is_active') !== 'false';
        if (nextActive !== (row.is_active !== false)) {
          if (row.role === 'super_admin' && !nextActive && !window.confirm(`¿Desactivar a ${row.full_name || 'este Super Admin'}? No podrá volver a iniciar sesión.`)) {
            return;
          }
          payload.is_active = nextActive;
        }
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
      showToast(err.message || 'No se pudo actualizar el usuario', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  /* Eliminar usuario (solo super_admin, nunca uno mismo). Llama a Edge Function manage-users con action=delete-user */
  on($('#userEditDeleteBtn'), 'click', async () => {
    const form = $('#userEditForm');
    if (!form) return;
    const userId = form.elements.userId.value;
    if (!userId) return;

    if (!canManageUsers()) {
      showToast('Solo Super Admin puede eliminar usuarios', 'error');
      return;
    }
    if (userId === currentProfile?.id) {
      showToast('No podés eliminarte a vos mismo', 'error');
      return;
    }

    const row = usersCache.find(u => u.id === userId);
    const label = row?.full_name || row?.email || 'este usuario';
    if (!window.confirm(`¿Eliminar definitivamente a ${label}? Se borrará de auth.users y su perfil.`)) {
      return;
    }

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
      btn.innerHTML = 'Eliminar Usuario';
    }
  });

  /* Cambio de contraseña propia: único flujo permitido. Se re-autentica con
     la contraseña actual antes de aplicar el cambio; Supabase solo actualiza
     la del usuario de la sesión, así nadie puede cambiar la de un tercero. */
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

    // HIBP check (fail-open)
    const pwned = await checkPasswordPwned(pwd);
    if (pwned.pwned) {
      return fail(`Esta contraseña apareció en ${pwned.count.toLocaleString('es-AR')} filtraciones de datos. Usa otra más segura.`);
    }

    btn.disabled = true;
    try {
      /* Verificación de identidad: si la actual no coincide, no se cambia nada. */
      const { error: verifyErr } = await window.supabaseClient.auth.signInWithPassword({
        email: currentUser.email,
        password: currentPwd,
      });
      if (verifyErr) {
        fail('La contraseña actual es incorrecta.');
        return;
      }

      const { error } = await window.supabaseClient.auth.updateUser({ password: pwd });
      if (error) throw error;

      closeModal('passwordModal');
      showToast('Contraseña actualizada correctamente', 'success');
    } catch (err) {
      fail(err.message || 'No se pudo cambiar la contraseña.');
    } finally {
      btn.disabled = false;
    }
  });


  window.__BH.loadUsers = loadUsers;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadUsers')) Object.defineProperty(window, 'loadUsers', { get: () => loadUsers, configurable: true });
  window.__BH.USER_ROLE_LABELS = USER_ROLE_LABELS;
  if (!Object.prototype.hasOwnProperty.call(window, 'USER_ROLE_LABELS')) Object.defineProperty(window, 'USER_ROLE_LABELS', { get: () => USER_ROLE_LABELS, configurable: true });
  window.__BH.canManageUsers = canManageUsers;
  if (!Object.prototype.hasOwnProperty.call(window, 'canManageUsers')) Object.defineProperty(window, 'canManageUsers', { get: () => canManageUsers, configurable: true });
})();
