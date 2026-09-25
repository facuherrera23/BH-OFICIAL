/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Agentes y Brokers
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, on, AgentSchema, validateForm, getAuthedClient, uploadToCloudinary, openModal, closeModal, showToast, invalidateSearchCache, updateSidebarBadges, esc, mutate } = window.__BH || {};

  /* ------------------------------------------------
     10. AGENTS CRUD
     ------------------------------------------------ */
  async function loadAgents() {
    invalidateSearchCache();
    const tbody = $('#agentsTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const { data, error } = await client
        .from('agents')
        .select('*')
        .is('deleted_at', null)
        .order('created_at', { ascending: true });

      if (error) throw error;

      if (!data?.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-dim);">No hay agentes cargados</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(a => `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:10px;">
              <img style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid var(--border-subtle);" src="${esc(a.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=100&q=60&fit=crop')}" alt="" />
              <div>
                <div style="font-weight:600; color:#fff; font-size:13px;">${esc(a.full_name || 'Sin nombre')}</div>
                <div style="color:var(--text-dim); font-size:11px;">${esc(a.email || '')}</div>
              </div>
            </div>
          </td>
          <td style="font-size:13px;">${esc(a.matricula || '-')}</td>
          <td style="font-size:12px;">${(a.specialties && a.specialties.length) ? a.specialties.map(s => `<span class="nav-badge" style="background:rgba(16,185,129,0.12); color:#10b981; font-size:10px; margin-right:3px;">${esc(s)}</span>`).join('') : '<span style="color:var(--text-dim);">—</span>'}</td>
          <td style="font-size:13px; color:var(--accent);">${a.commission_rate != null ? esc(a.commission_rate + '%') : '3%'}</td>
          <td><span class="nav-badge" style="background:${a.status === 'activo' ? 'rgba(0,200,120,0.15)' : a.status === 'licencia' ? 'rgba(255,184,0,0.15)' : 'rgba(255,255,255,0.06)'}; color:${a.status === 'activo' ? 'var(--success)' : a.status === 'licencia' ? 'var(--warning)' : 'var(--text-dim)'}; font-size:11px;">${esc(a.status || 'activo')}</span></td>
          <td style="font-size:13px;">${esc(a.phone || '-')}</td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" title="Editar" onclick="window.adminApp.editAgent('${a.id}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteAgent('${a.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      logError('Agents error:', err);
    }
  }

  /* Create agent */
  on($('#btnNewAgent'), 'click', () => {
    editingAgentId = null;
    $('#agentForm')?.reset();
    // form.reset() no limpia multi-selects: quedaba la selección del agente editado
    const specSel = document.querySelector('#agentForm [name="specialties"]');
    if (specSel) Array.from(specSel.options).forEach(o => { o.selected = false; });
    const title = $('#agentModalTitle');
    if (title) title.textContent = 'Registrar Asesor / Broker';
    const profileSelect = document.querySelector('#agentForm [name="profile_id"]');
    if (profileSelect && window.supabaseClient) {
      window.supabaseClient.from('profiles').select('id, full_name, email, role')
        .order('full_name')
        .then(({ data }) => {
          if (data) {
            profileSelect.innerHTML = '<option value="">— Sin vincular —</option>' +
              data.map(u => `<option value="${u.id}">${u.full_name || u.email} (${u.role})</option>`).join('');
          }
        });
    }
    openModal('agentModal');
  });

  /* Save agent */
  on($('#agentForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingAgent) return;
    _submittingAgent = true;
    const btn = $('#agentSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      
      // Zod validation
      const validated = validateForm(AgentSchema, formData);
      const specialtiesSel = e.target.elements.specialties;
      const data = {
        full_name: validated.full_name,
        email: validated.email,
        phone: validated.phone,
        matricula: validated.matricula,
        bio: validated.bio,
        commission_rate: validated.commission_rate,
        specialties: specialtiesSel ? Array.from(specialtiesSel.selectedOptions).map(o => o.value) : [],
        status: validated.status,
      };

      const photoFile = formData.get('photo_file');
      if (photoFile && photoFile.size > 0) {
        data.photo_url = await uploadToCloudinary(photoFile);
      }

      if (editingAgentId) {
        if (!data.photo_url) delete data.photo_url;
        await mutate('agents', async () => {
          const { error } = await window.supabaseClient.from('agents').update(data).eq('id', editingAgentId);
          if (error) throw error;
        });
        showToast('Agente actualizado', 'success');
      } else {
        await mutate('agents', async () => {
          const { error } = await window.supabaseClient.from('agents').insert([data]);
          if (error) throw error;
        });
        showToast('Agente creado', 'success');
      }

      closeModal('agentModal');
      loadAgents();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      _submittingAgent = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Broker'; }
    }
  });

  /* Edit agent */
  window.adminApp.editAgent = async function (id) {
    try {
      const { data, error } = await window.supabaseClient.from('agents').select('*').eq('id', id).single();
      if (error) throw error;
      editingAgentId = id;
      const form = $('#agentForm');
      if (form) {
        form.elements.full_name.value = data.full_name || '';
        form.elements.email.value = data.email || '';
        form.elements.phone.value = data.phone || '';
        form.elements.matricula.value = data.matricula || '';
        form.elements.bio.value = data.bio || '';
form.elements.commission_rate.value = data.commission_rate ?? 3;
        form.elements.status.value = data.status || 'activo';
        form.elements.profile_id.value = data.profile_id || '';
        if (form.elements.specialties && data.specialties) {
          const specSet = new Set(data.specialties);
          Array.from(form.elements.specialties.options).forEach(opt => {
            opt.selected = specSet.has(opt.value);
          });
        }
      }
      const title = $('#agentModalTitle');
      if (title) title.textContent = 'Editar Agente';
      openModal('agentModal');
    } catch (err) {
      showToast('Error al cargar agente', 'error');
    }
  };

  window.adminApp.deleteAgent = async function (id) {
    if (!confirm('¿Eliminar este agente? (soft delete, se puede restaurar)')) return;
    try {
      const { error } = await window.supabaseClient
        .from('agents')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      showToast('Agente eliminado (soft delete)', 'success');
      loadAgents();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };


  window.__BH.loadAgents = loadAgents;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadAgents')) Object.defineProperty(window, 'loadAgents', { get: () => loadAgents, set: (v) => { loadAgents = v; }, configurable: true });
})();
