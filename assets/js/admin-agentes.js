/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Agentes y Brokers
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, on, AgentSchema, validateForm, getAuthedClient, uploadToCloudinary, openModal, closeModal, showToast, invalidateSearchCache, updateSidebarBadges, esc, mutate } = window.__BH || {};

  /* Estado del módulo (filtros, paginación, sort, papelera, selección) */
  let _agPage = 1, _agPageSize = 25, _agTotalCount = 0;
  let _agSearchQuery = '', _agStatusFilter = '';
  let _agViewTrash = false;
  let _agSortCol = 'full_name', _agSortAsc = true;
  const _agSelected = new Set();
  let _agentsPageCache = [];
  let _agProfilesCache = null; // { at, data } — cache 5 min para el select de profile_id

  /* Opciones predefinidas de especialidades (las no coinciduentes se conservan como chips extra) */
  const AGENT_SPECIALTIES = ['Venta', 'Alquiler', 'Tasaciones', 'Barrios cerrados', 'Campos', 'Emprendimientos', 'Inversiones', 'Comercial'];

  function agInitials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return (parts[0]?.[0] || '?') + (parts.length > 1 ? (parts[parts.length - 1][0] || '') : '');
  }

  // Avatar: foto si existe, iniciales si no (evita depender de stock externo)
  function agAvatarHtml(a) {
    if (a.photo_url) {
      return '<img style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid var(--border-subtle);" src="' + esc(BHUtils?.safeImageUrl(a.photo_url) || a.photo_url) + '" alt="" loading="lazy" />';
    }
    return '<span class="ag-avatar">' + esc(agInitials(a.full_name).toUpperCase()) + '</span>';
  }

  function waLink(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits ? 'https://wa.me/' + digits : '';
  }

  function agStatusPill(status) {
    const map = { activo: ['rgba(0,200,120,0.15)', 'var(--success)'], licencia: ['rgba(255,184,0,0.15)', 'var(--warning)'], inactivo: ['rgba(255,255,255,0.06)', 'var(--text-dim)'] };
    const [bg, fg] = map[status] || map.inactivo;
    return '<span class="nav-badge" style="background:' + bg + '; color:' + fg + '; font-size:11px;">' + esc(status || 'activo') + '</span>';
  }

  /* Consulta común según filtros/papelera; con selectCustom para reutilizar en data/count */
  function agBuildQuery(client, selectCustom, opts = {}) {
    let q = client.from('agents').select(selectCustom, { count: opts.count ? 'exact' : undefined });
    if (_agViewTrash) q = q.not('deleted_at', 'is', null);
    else q = q.is('deleted_at', null);
    if (_agStatusFilter) q = q.eq('status', _agStatusFilter);
    if (_agSearchQuery) {
      const s = _agSearchQuery.replace(/[%_]/g, ' ');
      q = q.or(['full_name', 'email', 'matricula'].map(f => f + '.ilike.%' + s + '%').join(','));
    }
    if (!opts.noOrder) q = q.order(_agSortCol, { ascending: _agSortAsc, nullsFirst: false });
    return q;
  }

  function agRenderPagination() {
    const totalPages = Math.max(1, Math.ceil(_agTotalCount / _agPageSize));
    const info = $('#agPageInfo');
    if (info) info.textContent = 'Página ' + _agPage + ' de ' + totalPages;
    const prev = $('#agPagePrev'), next = $('#agPageNext');
    if (prev) prev.disabled = _agPage <= 1;
    if (next) next.disabled = _agPage >= totalPages;
  }

  function agRenderKpis(agents) {
    const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = String(v); };
    set('agKpiTotal', agents.length);
    set('agKpiActivos', agents.filter(a => a.status === 'activo').length);
    set('agKpiLicencia', agents.filter(a => a.status === 'licencia').length);
    set('agKpiVentas', agents.reduce((s, a) => s + (Number(a.sales_ytd) || 0), 0));
  }

  function agRenderTable(data, propsCount) {
    const tbody = $('#agentsTableBody');
    if (!tbody) return;
    _agentsPageCache = data || [];
    if (!_agentsPageCache.length) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:40px; color:var(--text-dim);">' +
        (_agViewTrash ? 'La papelera está vacía' : ((_agSearchQuery || _agStatusFilter) ? 'Sin resultados para los filtros aplicados' : 'No hay agentes cargados')) + '</td></tr>';
      return;
    }
    tbody.innerHTML = _agentsPageCache.map(a => {
      const specs = (a.specialties && a.specialties.length)
        ? a.specialties.map(s => '<span class="nav-badge" style="background:rgba(16,185,129,0.12); color:#10b981; font-size:10px; margin-right:3px;">' + esc(s) + '</span>').join('')
        : '<span style="color:var(--text-dim);">—</span>';
      const wa = waLink(a.phone);
      const contacto = (a.phone ? '<a href="tel:' + esc(String(a.phone).replace(/[^+0-9]/g, '')) + '" title="Llamar" style="color:var(--accent); font-size:12px;"><i class="fas fa-phone"></i></a>' : '') +
        (wa ? ' <a href="' + esc(wa) + '" target="_blank" rel="noopener" title="WhatsApp" style="color:#25d366; font-size:12px;"><i class="fab fa-whatsapp"></i></a>' : '') +
        (a.email ? ' <a href="mailto:' + esc(a.email) + '" title="Email" style="color:var(--text-muted); font-size:12px;"><i class="fas fa-envelope"></i></a>' : '') || '-';
      const acciones = _agViewTrash
        ? '<button class="btn-action" data-ag-act="restore" data-ag-id="' + esc(a.id) + '" title="Restaurar"><i class="fas fa-rotate-left"></i></button>' +
          '<button class="btn-action danger" data-ag-act="destroy" data-ag-id="' + esc(a.id) + '" title="Eliminar definitivamente"><i class="fas fa-xmark"></i></button>'
        : '<button class="btn-action" data-ag-act="detail" data-ag-id="' + esc(a.id) + '" title="Ver detalle"><i class="fas fa-eye"></i></button>' +
          '<button class="btn-action" data-ag-act="ical" data-ag-id="' + esc(a.id) + '" title="Copiar feed de calendario (ICS)"><i class="fas fa-calendar-days"></i></button>' +
          '<button class="btn-action" data-ag-act="edit" data-ag-id="' + esc(a.id) + '" title="Editar"><i class="fas fa-pen"></i></button>' +
          '<button class="btn-action danger" data-ag-act="delete" data-ag-id="' + esc(a.id) + '" title="Enviar a papelera"><i class="fas fa-trash"></i></button>';
      return '<tr data-ag-row="' + esc(a.id) + '" style="cursor:pointer;">' +
        '<td><input type="checkbox" class="ag-row-check" data-ag-id="' + esc(a.id) + '"' + (_agSelected.has(a.id) ? ' checked' : '') + ' /></td>' +
        '<td><div style="display:flex; align-items:center; gap:10px;">' + agAvatarHtml(a) +
        '<div><div style="font-weight:600; color:#fff; font-size:13px;">' + esc(a.full_name || 'Sin nombre') + '</div>' +
        '<div style="color:var(--text-dim); font-size:11px;">' + esc(a.email || '') + '</div></div></div></td>' +
        '<td style="font-size:13px;">' + esc(a.matricula || '-') + '</td>' +
        '<td style="font-size:12px; max-width:200px;">' + specs + '</td>' +
        '<td style="font-size:13px; color:var(--accent);">' + (a.commission_rate != null ? esc(a.commission_rate + '%') : '3%') + '</td>' +
        '<td>' + agStatusPill(a.status) + '</td>' +
        '<td style="text-align:center; font-size:13px;">' + (propsCount[a.id] || 0) + '</td>' +
        '<td style="text-align:right; font-size:13px;">' + Number(a.sales_ytd || 0).toLocaleString('es-AR') + '</td>' +
        '<td style="font-size:13px; white-space:nowrap;">' + contacto + '</td>' +
        '<td><div style="display:flex; gap:6px; justify-content:flex-end;">' + acciones + '</div></td></tr>';
    }).join('');
    agRenderBulkBar();
    agHighlightSort();
  }

  async function loadAgents() {
    invalidateSearchCache();
    const tbody = $('#agentsTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px; color:var(--text-dim);"><i class="fas fa-circle-notch fa-spin"></i> Cargando...</td></tr>';

    try {
      const from = (_agPage - 1) * _agPageSize;
      const q = agBuildQuery(client, '*', { count: true });
      const { data, error, count } = await q.range(from, from + _agPageSize - 1);
      if (error) throw error;
      _agTotalCount = count || 0;

      // KPIs del padron completo (pocos registros: una query liviana sin paginar)
      const { data: allAgents } = await client.from('agents').select('id, status, sales_ytd').is('deleted_at', null);
      if (allAgents) agRenderKpis(allAgents);

      // Props activas asignadas por agente de la página actual
      const propsCount = {};
      const ids = (data || []).map(a => a.id);
      if (ids.length) {
        const { data: props } = await client.from('properties').select('agent_id').is('deleted_at', null).in('agent_id', ids);
        (props || []).forEach(p => { propsCount[p.agent_id] = (propsCount[p.agent_id] || 0) + 1; });
      }
      const kpiProps = $('#agKpiProps');
      if (kpiProps && allAgents) {
        const { data: allProps } = await client.from('properties').select('agent_id').is('deleted_at', null).not('agent_id', 'is', null);
        kpiProps.textContent = String((allProps || []).length);
      }

      // Estado del botón papelera
      const { count: trashCount } = await client.from('agents').select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null);
      const trashBtn = $('#agTrashToggle');
      if (trashBtn) trashBtn.innerHTML = '<i class="fas fa-trash-can"></i> Papelera (' + (trashCount || 0) + ')';

      agRenderTable(data, propsCount);
      agRenderPagination();
    } catch (err) {
      logError('Agents error:', err);
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px; color:var(--warning);">No se pudo cargar el padrón de agentes. Reintentá o revisá la consola.</td></tr>';
    }
  }

  /* ------------------------------------------------
     Modal: foto (preview/quitar), especialidades (chips) y profiles
     ------------------------------------------------ */
  let _agPhotoRemove = false; // marcada cuando el usuario quita la foto actual sin subir otra

  async function agPopulateProfileSelect(selectedId) {
    const sel = document.querySelector('#agentForm [name="profile_id"]');
    if (!sel) return;
    if (!_agProfilesCache || Date.now() - _agProfilesCache.at > 300000) {
      const { data } = await window.supabaseClient.from('profiles').select('id, full_name, email, role').order('full_name');
      _agProfilesCache = { at: Date.now(), data: data || [] };
    }
    sel.innerHTML = '<option value="">— Sin vincular —</option>' +
      _agProfilesCache.data.map(u => '<option value="' + u.id + '">' + esc(u.full_name || u.email) + ' (' + esc(u.role) + ')</option>').join('');
    if (selectedId) sel.value = selectedId;
  }

  // Chips toggle; las especialidades no predefinidas del registro se agregan como chips extra ya marcados
  function agRenderSpecChips(selected) {
    const wrap = $('#agentSpecialtiesWrap');
    if (!wrap) return;
    const all = [...AGENT_SPECIALTIES];
    (selected || []).forEach(s => { if (s && !all.includes(s)) all.push(s); });
    const selSet = new Set(selected || []);
    wrap.innerHTML = all.map(s =>
      '<label class="ag-spec-chip' + (selSet.has(s) ? ' is-on' : '') + '"><input type="checkbox" value="' + esc(s) + '"' + (selSet.has(s) ? ' checked' : '') + ' />' + esc(s) + '</label>'
    ).join('');
  }

  function agGetSpecSelection() {
    return Array.from(document.querySelectorAll('#agentSpecialtiesWrap input:checked')).map(i => i.value);
  }

  function agSetPhotoPreview(url) {
    const wrap = $('#agentPhotoPreviewWrap'), img = $('#agentPhotoPreview');
    if (!wrap || !img) return;
    if (url) { img.src = url; wrap.style.display = 'block'; }
    else { img.src = ''; wrap.style.display = 'none'; }
  }

  // Reduce cualquier imagen a 512x512 antes de subir a Cloudinary (tamaño uniforme de avatar)
  function agResizeImage(file, size = 512) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext('2d');
          const minSide = Math.min(img.width, img.height);
          const sx = (img.width - minSide) / 2, sy = (img.height - minSide) / 2;
          ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
          canvas.toBlob(blob => resolve(blob ? new File([blob], file.name, { type: 'image/jpeg' }) : file), 'image/jpeg', 0.85);
        };
        img.onerror = () => resolve(file); // fallback: subir tal cual
        img.src = ev.target.result;
      };
      reader.onerror = () => resolve(file);
      reader.readAsDataURL(file);
    });
  }

  on($('#agentPhotoRemove'), 'click', () => {
    _agPhotoRemove = true;
    agSetPhotoPreview(null);
    const file = $('#agentPhotoFile');
    if (file) file.value = '';
  });

  // Toggle visual de chips (delegación dentro del wrap)
  on($('#agentSpecialtiesWrap'), 'change', (e) => {
    const chip = e.target.closest('.ag-spec-chip');
    if (chip) chip.classList.toggle('is-on', e.target.checked);
  });

  /* Create agent */
  on($('#btnNewAgent'), 'click', () => {
    editingAgentId = null;
    _agPhotoRemove = false;
    $('#agentForm')?.reset();
    agRenderSpecChips([]);
    agSetPhotoPreview(null);
    const title = $('#agentModalTitle');
    if (title) title.textContent = 'Registrar Agente';
    const btn = $('#agentSaveBtn');
    if (btn) btn.textContent = 'Guardar Agente';
    agPopulateProfileSelect('');
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
      const validated = validateForm(AgentSchema, formData);
      const data = {
        full_name: validated.full_name,
        email: validated.email,
        phone: validated.phone,
        matricula: validated.matricula,
        bio: validated.bio,
        commission_rate: validated.commission_rate,
        specialties: agGetSpecSelection(),
        status: validated.status,
        profile_id: validated.profile_id || null,
      };

      const photoFile = formData.get('photo_file');
      if (photoFile && photoFile.size > 0) {
        if (!/^image\/(jpeg|png|webp)$/.test(photoFile.type)) throw new Error('La foto debe ser JPG, PNG o WebP');
        if (photoFile.size > 2 * 1024 * 1024) throw new Error('La foto no puede superar 2 MB');
        data.photo_url = await uploadToCloudinary(await agResizeImage(photoFile));
      } else if (_agPhotoRemove) {
        data.photo_url = null;
      }

      if (editingAgentId) {
        if (data.photo_url === undefined) delete data.photo_url;
        await mutate('agents', async () => {
          const { error } = await window.supabaseClient.from('agents').update(data).eq('id', editingAgentId);
          if (error) throw error;
        });
        showToast('Agente actualizado', 'success');
      } else {
        const { data: { user } } = await window.supabaseClient.auth.getUser();
        data.created_by = user?.id || null;
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
      // 23505 = unique violation (email duplicado)
      const msg = err.code === '23505' ? 'Ya existe un agente con ese email' : err.message;
      showToast('Error: ' + msg, 'error');
    } finally {
      _submittingAgent = false;
      if (btn) { btn.disabled = false; btn.innerHTML = editingAgentId ? 'Guardar cambios' : 'Guardar Agente'; }
    }
  });

  /* Edit agent: repuebla profiles, chips y preview de foto */
  window.adminApp.editAgent = async function (id) {
    try {
      const { data, error } = await window.supabaseClient.from('agents').select('*').eq('id', id).single();
      if (error) throw error;
      editingAgentId = id;
      _agPhotoRemove = false;
      await agPopulateProfileSelect(data.profile_id || '');
      const form = $('#agentForm');
      if (form) {
        form.elements.full_name.value = data.full_name || '';
        form.elements.email.value = data.email || '';
        form.elements.phone.value = data.phone || '';
        form.elements.matricula.value = data.matricula || '';
        form.elements.bio.value = data.bio || '';
        form.elements.commission_rate.value = data.commission_rate ?? 3;
        form.elements.status.value = data.status || 'activo';
      }
      agRenderSpecChips(data.specialties || []);
      agSetPhotoPreview(data.photo_url || null);
      const fileInput = $('#agentPhotoFile');
      if (fileInput) fileInput.value = '';
      const title = $('#agentModalTitle');
      if (title) title.textContent = 'Editar Agente';
      const btn = $('#agentSaveBtn');
      if (btn) btn.textContent = 'Guardar cambios';
      openModal('agentModal');
    } catch (err) {
      showToast('Error al cargar agente', 'error');
    }
  };

  window.adminApp.deleteAgent = async function (id) {
    if (!confirm('¿Enviar este agente a la papelera? Podés restaurarlo después.')) return;
    try {
      await mutate('agents', async () => {
        const { error } = await window.supabaseClient
          .from('agents')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', id);
        if (error) throw error;
      });
      showToast('Agente enviado a la papelera', 'success');
      loadAgents();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  async function restoreAgent(id) {
    try {
      await mutate('agents', async () => {
        const { error } = await window.supabaseClient.from('agents').update({ deleted_at: null }).eq('id', id);
        if (error) throw error;
      });
      showToast('Agente restaurado', 'success');
      loadAgents();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  // Borrado físico: irreversible, por eso doble confirmación
  async function destroyAgent(id) {
    if (!confirm('⚠ Esto elimina DEFINITIVAMENTE el agente de la base de datos. ¿Continuar?')) return;
    if (!confirm('Última confirmación: ¿eliminar el registro de forma permanente?')) return;
    try {
      await mutate('agents', async () => {
        const { error } = await window.supabaseClient.from('agents').delete().eq('id', id);
        if (error) throw error;
      });
      showToast('Agente eliminado definitivamente', 'success');
      loadAgents();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  // Duplica ficha sin email ni vínculo de usuario (evita colisiones por unique)
  async function duplicateAgent(id) {
    try {
      const { data: src, error } = await window.supabaseClient.from('agents').select('*').eq('id', id).single();
      if (error) throw error;
      await mutate('agents', async () => {
        const { error: err2 } = await window.supabaseClient.from('agents').insert([{
          full_name: (src.full_name || 'Agente') + ' (copia)',
          email: null, phone: src.phone, matricula: null, bio: src.bio,
          specialties: src.specialties || [], status: 'inactivo',
          commission_rate: src.commission_rate, photo_url: src.photo_url,
          sales_ytd: 0,
        }]);
        if (err2) throw err2;
      });
      showToast('Agente duplicado (inactivo, sin email/matrícula)', 'success');
      loadAgents();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  async function agCopyIcs(id) {
    try {
      const { data, error } = await window.supabaseClient.from('agents').select('full_name, ics_token').eq('id', id).single();
      if (error) throw error;
      if (!data?.ics_token) { showToast('Este agente no tiene token ICS', 'warning'); return; }
      const feed = (window.BH_CONFIG?.SUPABASE_URL || '') + '/functions/v1/ics-feed?token=' + data.ics_token;
      await navigator.clipboard.writeText(feed).catch(() => prompt('Copiá la URL:', feed));
      showToast('Link del calendario copiado', 'success');
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  /* ------------------------------------------------
     Drawer de detalle (datos, cartera, visitas, comisiones)
     ------------------------------------------------ */
  function agCloseDrawer() {
    $('#agentDrawer')?.classList.remove('is-open');
    $('#agentDrawer')?.setAttribute('aria-hidden', 'true');
  }

  async function openAgentDetail(id) {
    const drawer = $('#agentDrawer'), body = $('#agentDrawerBody');
    if (!drawer || !body) return;
    try {
      const { data: a, error } = await window.supabaseClient.from('agents').select('*').eq('id', id).single();
      if (error) throw error;
      const [props, visits, comms] = await Promise.all([
        window.supabaseClient.from('properties').select('id, title, status, price_usd, price_currency').eq('agent_id', id).is('deleted_at', null).order('created_at', { ascending: false }).limit(10),
        window.supabaseClient.from('visits').select('id, visit_date, status, lead_id, client_name').eq('agent_id', id).gte('visit_date', new Date().toISOString()).order('visit_date', { ascending: true }).limit(5),
        window.supabaseClient.from('commissions').select('id, commission_amount_usd, commission_amount_ars, status, created_at').eq('broker_id', id).order('created_at', { ascending: false }).limit(5),
      ]);
      const kv = (k, v) => '<div class="ag-d-kv"><span>' + k + '</span><strong>' + (v || '—') + '</strong></div>';
      const wa = waLink(a.phone);
      body.innerHTML =
        '<div style="display:flex; align-items:center; gap:12px; margin-bottom:4px;">' +
        (a.photo_url ? '<img src="' + esc(a.photo_url) + '" alt="" style="width:52px; height:52px; border-radius:50%; object-fit:cover;" />' : '<span class="ag-avatar" style="width:52px; height:52px; font-size:17px;">' + esc(agInitials(a.full_name).toUpperCase()) + '</span>') +
        '<div><h3>' + esc(a.full_name || 'Sin nombre') + '</h3><div class="ag-d-sub">' + esc(a.email || 'Sin email') + '</div></div></div>' +
        '<div style="display:flex; gap:8px; flex-wrap:wrap; margin:8px 0 4px;">' +
        (a.phone ? '<a class="status-pill" href="tel:' + esc(String(a.phone).replace(/[^+0-9]/g, '')) + '"><i class="fas fa-phone"></i> Llamar</a>' : '') +
        (wa ? '<a class="status-pill win" href="' + esc(wa) + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> WhatsApp</a>' : '') +
        (a.ics_token ? '<button type="button" class="status-pill pending" data-ag-act="ical" data-ag-id="' + esc(a.id) + '"><i class="fas fa-calendar-days"></i> Copiar ICS</button>' : '') +
        '<button type="button" class="status-pill pending" data-ag-act="edit" data-ag-id="' + esc(a.id) + '"><i class="fas fa-pen"></i> Editar</button>' +
        '<button type="button" class="status-pill pending" data-ag-act="duplicate" data-ag-id="' + esc(a.id) + '"><i class="fas fa-copy"></i> Duplicar</button>' +
        '</div>' +
        '<div class="ag-d-section"><h4>Datos</h4>' +
        kv('Matrícula', esc(a.matricula || '—')) + kv('Estado', esc(a.status || 'activo')) +
        kv('Comisión', (a.commission_rate != null ? a.commission_rate + '%' : '3%')) +
        kv('Ventas YTD', Number(a.sales_ytd || 0).toLocaleString('es-AR')) +
        kv('Especialidades', (a.specialties || []).join(', ') || '—') + '</div>' +
        (a.bio ? '<div class="ag-d-section"><h4>Bio</h4><p style="color:var(--text-muted); font-size:12.5px;">' + esc(a.bio) + '</p></div>' : '') +
        '<div class="ag-d-section"><h4>Cartera (' + (props.data?.length || 0) + ')</h4>' +
        ((props.data || []).length ? props.data.map(p => '<div class="ag-d-item"><span>' + esc(p.title || 'Propiedad') + '</span><span>' + esc(p.status || '') + '</span></div>').join('') : '<div class="ag-d-empty">Sin propiedades asignadas</div>') + '</div>' +
        '<div class="ag-d-section"><h4>Próximas visitas</h4>' +
        ((visits.data || []).length ? visits.data.map(v => '<div class="ag-d-item"><span>' + esc(v.client_name || v.status || '') + '</span><span>' + new Date(v.visit_date).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</span></div>').join('') : '<div class="ag-d-empty">Sin visitas próximas</div>') + '</div>' +
        '<div class="ag-d-section"><h4>Comisiones recientes</h4>' +
        ((comms.data || []).length ? comms.data.map(c => '<div class="ag-d-item"><span>' + (c.commission_amount_usd != null ? 'USD ' + Number(c.commission_amount_usd).toLocaleString('es-AR') : '$ ' + Number(c.commission_amount_ars || 0).toLocaleString('es-AR')) + '</span><span>' + esc(c.status || '') + '</span></div>').join('') : '<div class="ag-d-empty">Sin comisiones registradas</div>') +
        '</div>';
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
    } catch (err) {
      showToast('Error al cargar detalle: ' + err.message, 'error');
    }
  }

  on($('#agentDrawerClose'), 'click', agCloseDrawer);
  on($('#agentDrawer'), 'click', (e) => { if (e.target.id === 'agentDrawer') agCloseDrawer(); });

  /* ------------------------------------------------
     Filtros, búsqueda, paginación, sort, papelera
     ------------------------------------------------ */
  /* readonly al cargar: evita que el autofill del navegador llene el buscador
     con el email del login (se quita al primer focus) */
  (function () {
    const inp = $('#agSearchInput');
    if (inp && inp.hasAttribute('readonly')) {
      inp.addEventListener('focus', () => inp.removeAttribute('readonly'), { once: true });
    }
  })();

  on($('#agSearchInput'), 'input', (e) => {
    clearTimeout(window._agSearchTimer);
    window._agSearchTimer = setTimeout(() => { _agSearchQuery = e.target.value.trim(); _agPage = 1; loadAgents(); }, 300);
  });
  on($('#agStatusFilter'), 'change', (e) => { _agStatusFilter = e.target.value; _agPage = 1; loadAgents(); });
  on($('#agFilterClear'), 'click', () => {
    _agSearchQuery = ''; _agStatusFilter = ''; _agPage = 1;
    const inp = $('#agSearchInput'); if (inp) inp.value = '';
    const st = $('#agStatusFilter'); if (st) st.value = '';
    loadAgents();
  });
  on($('#agTrashToggle'), 'click', () => {
    _agViewTrash = !_agViewTrash;
    _agPage = 1;
    _agSelected.clear();
    const btn = $('#agTrashToggle');
    if (btn) btn.classList.toggle('active', _agViewTrash);
    const newBtn = $('#btnNewAgent');
    if (newBtn) newBtn.style.display = _agViewTrash ? 'none' : '';
    loadAgents();
  });
  on($('#agPagePrev'), 'click', () => { if (_agPage > 1) { _agPage--; loadAgents(); } });
  on($('#agPageNext'), 'click', () => {
    if (_agPage < Math.ceil(_agTotalCount / _agPageSize)) { _agPage++; loadAgents(); }
  });
  on($('#agPageSize'), 'change', (e) => { _agPageSize = parseInt(e.target.value, 10) || 25; _agPage = 1; loadAgents(); });

  function agHighlightSort() {
    document.querySelectorAll('#tab-agentes .ag-th-sort').forEach(th => {
      const active = th.dataset.sort === _agSortCol;
      th.classList.toggle('sorted-asc', active && _agSortAsc);
      th.classList.toggle('sorted-desc', active && !_agSortAsc);
    });
  }
  document.querySelectorAll('#tab-agentes .ag-th-sort').forEach(el => {
    el.addEventListener('click', () => {
      const col = el.dataset.sort;
      if (_agSortCol === col) _agSortAsc = !_agSortAsc;
      else { _agSortCol = col; _agSortAsc = true; }
      _agPage = 1;
      loadAgents();
    });
  });

  /* ------------------------------------------------
     Selección múltiple + acciones masivas
     ------------------------------------------------ */
  function agRenderBulkBar() {
    const bar = $('#agentBulkBar');
    if (!bar) return;
    bar.classList.toggle('is-visible', _agSelected.size > 0 && !_agViewTrash);
    const cnt = $('#agentBulkCount');
    if (cnt) cnt.textContent = _agSelected.size + ' seleccionados';
    const selAll = $('#agentSelectAll');
    if (selAll) {
      selAll.checked = _agentsPageCache.length > 0 && _agentsPageCache.every(a => _agSelected.has(a.id));
    }
  }
  on($('#agentSelectAll'), 'change', (e) => {
    _agentsPageCache.forEach(a => { if (e.target.checked) _agSelected.add(a.id); else _agSelected.delete(a.id); });
    loadAgents();
  });
  on($('#agentBulkClear'), 'click', () => { _agSelected.clear(); loadAgents(); });
  on($('#agentBulkApplyStatus'), 'click', async () => {
    const sel = $('#agentBulkStatusSelect');
    const status = sel?.value;
    if (!status || !_agSelected.size) return;
    try {
      await mutate('agents', async () => {
        const { error } = await window.supabaseClient.from('agents').update({ status }).in('id', [..._agSelected]);
        if (error) throw error;
      });
      showToast('Estado actualizado en ' + _agSelected.size + ' agentes', 'success');
      _agSelected.clear();
      if (sel) sel.value = '';
      loadAgents();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
  on($('#agentBulkDelete'), 'click', async () => {
    if (!_agSelected.size) return;
    if (!confirm('¿Enviar ' + _agSelected.size + ' agentes a la papelera?')) return;
    try {
      await mutate('agents', async () => {
        const { error } = await window.supabaseClient.from('agents').update({ deleted_at: new Date().toISOString() }).in('id', [..._agSelected]);
        if (error) throw error;
      });
      showToast('Agentes enviados a la papelera', 'success');
      _agSelected.clear();
      loadAgents();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  /* Delegación de clics en la tabla (acciones + checkboxes + fila → drawer) */
  const tbodyEl = $('#agentsTableBody');
  if (tbodyEl) {
    tbodyEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ag-act]');
      if (btn) {
        const id = btn.dataset.agId;
        const act = btn.dataset.agAct;
        if (act === 'edit') window.adminApp.editAgent(id);
        else if (act === 'delete') window.adminApp.deleteAgent(id);
        else if (act === 'restore') restoreAgent(id);
        else if (act === 'destroy') destroyAgent(id);
        else if (act === 'ical') agCopyIcs(id);
        else if (act === 'detail') openAgentDetail(id);
        else if (act === 'duplicate') duplicateAgent(id);
        return;
      }
      if (e.target.closest('a, input, label, select')) return; // no abrir drawer desde links/checkbox
      const row = e.target.closest('[data-ag-row]');
      if (row && !_agViewTrash) openAgentDetail(row.dataset.agRow);
    });
    tbodyEl.addEventListener('change', (e) => {
      const chk = e.target.closest('.ag-row-check');
      if (!chk) return;
      if (chk.checked) _agSelected.add(chk.dataset.agId); else _agSelected.delete(chk.dataset.agId);
      agRenderBulkBar();
    });
  }

  /* Clics dentro del drawer (editar/ical) */
  on($('#agentDrawer'), 'click', (e) => {
    const btn = e.target.closest('[data-ag-act]');
    if (!btn) return;
    const id = btn.dataset.agId;
    if (btn.dataset.agAct === 'edit') { agCloseDrawer(); window.adminApp.editAgent(id); }
    else if (btn.dataset.agAct === 'ical') agCopyIcs(id);
    else if (btn.dataset.agAct === 'duplicate') { if (confirm('¿Duplicar este agente? Se creará inactivo, sin email ni matrícula.')) { agCloseDrawer(); duplicateAgent(id); } }
  });

  /* Export CSV del padrón filtrado */
  function agExportCSV() {
    // Va con filtros activos pero sin paginar: descarga lo que ves
    getAuthedClient().then(async (client) => {
      if (!client) return;
      const { data, error } = await agBuildQuery(client, 'full_name, email, phone, matricula, specialties, commission_rate, status, sales_ytd, created_at', { noOrder: false });
      if (error) { showToast('Error exportando: ' + error.message, 'error'); return; }
      const escCsv = (v) => {
        let s = String(v ?? '');
        s = s.replace(/"/g, '""');
        return (/[",\n]/).test(s) ? '"' + s + '"' : s;
      };
      const headers = ['Nombre', 'Email', 'Teléfono', 'Matrícula', 'Especialidades', 'Comisión %', 'Estado', 'Ventas YTD', 'Alta'];
      let csv = headers.join(',') + '\n' + (data || []).map(a =>
        [a.full_name, a.email, a.phone, a.matricula, (a.specialties || []).join(' | '), a.commission_rate, a.status, a.sales_ytd, a.created_at].map(escCsv).join(',')
      ).join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const al = document.createElement('a');
      al.href = url;
      al.download = 'agentes-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(al);
      al.click();
      document.body.removeChild(al);
      URL.revokeObjectURL(url);
      showToast('Exportados ' + (data?.length || 0) + ' agentes', 'success');
    });
  }
  on($('#agExportCsv'), 'click', agExportCSV);

  window.adminApp.openAgentDetail = openAgentDetail;
  window.adminApp.restoreAgent = restoreAgent;
  window.adminApp.duplicateAgent = duplicateAgent;


  window.__BH.loadAgents = loadAgents;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadAgents')) Object.defineProperty(window, 'loadAgents', { get: () => loadAgents, set: (v) => { loadAgents = v; }, configurable: true });
})();
