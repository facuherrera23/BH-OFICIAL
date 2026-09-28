/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Tasaciones (ACM)
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, on, navigateTo, openModal, closeModal, showConfirmDialog, showToast, invalidateSearchCache, updateSidebarBadges, esc, mutate } = window.__BH || {};

  /* ------------------------------------------------
     13C. TASACIONES
     ------------------------------------------------ */
  function showTasacionEditor(id, title) {
    const listView = $('#tasacionesListView');
    const editorView = $('#tasacionesEditorView');
    const iframe = $('#tasacionesIframe');
    const titleEl = $('#tasacionesEditorTitle');
    if (listView) listView.style.display = 'none';
    if (editorView) editorView.style.display = 'block';
    if (titleEl) titleEl.textContent = title || '';
    if (iframe) {
      iframe.src = `tasacion.html?id=${id}`;
      iframe.onload = async () => {
        try {
          const { data: { session } } = await window.supabaseClient.auth.getSession();
          if (session && iframe.contentWindow) {
            /* Security: el iframe carga tasacion.html desde ESTE mismo origen; usar window.location.origin.
               El SUPABASE_URL previo hacia fallar la entrega del token por origin mismatch. */
            iframe.contentWindow.postMessage({ type: 'auth-session', token: session.access_token }, window.location.origin);
          }
        } catch (_) { logError('Tasaciones iframe: falló entregar sesión:', _); }
      };
    }
  }

  function hideTasacionEditor() {
    const listView = $('#tasacionesListView');
    const editorView = $('#tasacionesEditorView');
    const iframe = $('#tasacionesIframe');
    if (editorView) editorView.style.display = 'none';
    if (listView) listView.style.display = 'block';
    if (iframe) iframe.src = '';
    loadTasaciones();
  }

  on($('#btnBackToList'), 'click', hideTasacionEditor);

  on($('#tasacionesPagePrev'), 'click', () => { if (_tasacionesPage > 1) { _tasacionesPage--; loadTasaciones(); } });
  on($('#tasacionesPageNext'), 'click', () => { const totalPages = Math.ceil(_tasacionesTotalCount / _tasacionesPageSize); if (_tasacionesPage < totalPages) { _tasacionesPage++; loadTasaciones(); } });
  on($('#tasacionesPageSize'), 'change', () => { _tasacionesPageSize = parseInt($('#tasacionesPageSize').value, 10); _tasacionesPage = 1; loadTasaciones(); });

  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'tasaciones-back') hideTasacionEditor();
    if (e.data?.type === 'tasaciones-finalized' && e.data?.id) {
      _handleTasacionFinalized(e.data.id);
      loadTasaciones();
    }
  });

  async function _handleTasacionFinalized(tasacionId) {
    try {
      const { data: t, error } = await window.supabaseClient
        .from('tasaciones')
        .select('id, property_id, owner_id, broker_id, type, valuation_usd, title')
        .eq('id', tasacionId)
        .single();
      if (error || !t) return;

      if (t.owner_id) {
        const { data: existingLead } = await window.supabaseClient
          .from('leads')
          .select('id')
          .eq('source', 'tasacion')
          .eq('contact_name', t.title || 'Propietario')
          .maybeSingle();
        if (existingLead) return;

        const ownerRes = t.owner_id ? await window.supabaseClient.from('owners').select('full_name, phone, email').eq('id', t.owner_id).single() : null;
        const owner = ownerRes?.data;
        if (!owner) return;

        await window.supabaseClient.from('leads').insert({
          property_id: t.property_id || null,
          broker_id: t.broker_id || null,
          source: 'tasacion',
          stage: 'contactado',
          tags: ['tasacion', t.type || 'venta'],
          score: 40,
          contact_name: owner.full_name || 'Propietario',
          contact_phone: owner.phone || null,
          contact_email: owner.email || null,
          notes: 'Lead generado desde tasación ' + (t.title || '') + (t.valuation_usd ? '. Valor estimado: USD ' + Number(t.valuation_usd).toLocaleString('es-AR') : ''),
        });
        showToast('Lead creado desde tasación para ' + (owner.full_name || 'propietario'), 'success');
      }
    } catch (_) { /* silent */ }
  }

  async function loadTasaciones() {
    invalidateSearchCache();
    const tbody = $('#tasacionesTableBody');
    const pageInfo = $('#tasacionesPageInfo');
    const pagePrev = $('#tasacionesPagePrev');
    const pageNext = $('#tasacionesPageNext');
    if (!tbody) return;
    if (!currentUser || !window.supabaseClient) return;

    try {
      const q = ($('#tasaSearchText')?.value || '').trim();
      const tipo = $('#tasaFilterTipo')?.value || '';
      const estado = $('#tasaFilterEstado')?.value || '';
      const desde = $('#tasaFilterDesde')?.value || '';
      const hasta = $('#tasaFilterHasta')?.value || '';

      /* Ilke usa comodines %; las comas rompen la sintaxis de filtros PostgREST */
      const qSafe = q.replace(/[%,]/g, ' ');

      const applyFilters = (query) => {
        if (qSafe) query = query.or('title.ilike.%' + qSafe + '%,data->fields->>f_direccion.ilike.%' + qSafe + '%');
        if (tipo) query = query.eq('type', tipo);
        if (estado) query = query.eq('status', estado);
        if (desde) query = query.gte('created_at', desde + 'T00:00:00');
        if (hasta) query = query.lte('created_at', hasta + 'T23:59:59.999');
        return query;
      };

      /* Count total filtrado (paginación) y KPIs globales (sin filtro) en paralelo */
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const [countRes, finRes, draftRes, recentRes, prefsRes] = await Promise.all([
        applyFilters(window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true })),
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).eq('status', 'finalized'),
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).gte('created_at', since30),
        window.supabaseClient.from('app_settings').select('value').eq('key', 'preferences').maybeSingle()
      ]);
      if (countRes.error) throw countRes.error;
      _tasacionesTotalCount = countRes.count || 0;
      window.__BH.tasaUsdRate = Number(prefsRes.data?.value?.usd_rate) || 0;

      const from = (_tasacionesPage - 1) * _tasacionesPageSize;
      const to = from + _tasacionesPageSize - 1;

      const { data, error } = await applyFilters(
        window.supabaseClient
          .from('tasaciones')
          /* Sin 'data' a proposito: el listado no necesita el JSONB (fotos base64 pesan MB).
             Si una tasacion vieja tuviera valuation_usd NULL, buildTasacionRowHtml reconsultaria,
             pero todas las actuales tienen valor guardado. */
          .select('id, title, status, created_at, property_id, owner_id, type, valuation_usd')
          .order(_tasSort.col, { ascending: _tasSort.asc, nullsFirst: false })
      ).range(from, to);
      if (error) throw error;

      const propIds = [...new Set((data || []).map(t => t.property_id).filter(Boolean))];
      const ownerIds = [...new Set((data || []).map(t => t.owner_id).filter(Boolean))];
      const [propsRes, ownersRes] = await Promise.all([
        propIds.length ? window.supabaseClient.from('properties').select('id, property_code, title').in('id', propIds) : { data: [] },
        ownerIds.length ? window.supabaseClient.from('owners').select('id, full_name').in('id', ownerIds) : { data: [] }
      ]);
      const propMap = new Map((propsRes.data || []).map(p => [p.id, { ...p, code: p.property_code || p.code || null }]));
      const ownerMap = new Map((ownersRes.data || []).map(o => [o.id, o]));

      const setKpi = (sel, val) => { const el = $(sel); if (el) el.textContent = val; };
      setKpi('#tasKpiTotal', _tasacionesTotalCount);
      setKpi('#tasKpiFinalizadas', finRes.count || 0);
      setKpi('#tasKpiBorradores', draftRes.count || 0);
      setKpi('#tasKpiRecientes', recentRes.count || 0);

      /* Update pagination UI */
      const totalPages = Math.ceil(_tasacionesTotalCount / _tasacionesPageSize);
      if (pageInfo) pageInfo.textContent = `Página ${_tasacionesPage} de ${totalPages || 1}`;
      if (pagePrev) pagePrev.disabled = _tasacionesPage <= 1;
      if (pageNext) pageNext.disabled = _tasacionesPage >= totalPages;

      if (!data || data.length === 0) {
        const conFiltros = qSafe || tipo || estado || desde || hasta;
        tbody.innerHTML = conFiltros
          ? '<tr><td colspan="5"><div class="tas-empty"><i class="fas fa-filter"></i><p>Sin resultados para esos filtros.</p><span>Probá limpiar o ajustar la búsqueda.</span></div></td></tr>'
          : '<tr><td colspan="5"><div class="tas-empty"><i class="fas fa-file-invoice"></i><p>No hay tasaciones registradas todavía.</p><span>Creá la primera con “Nueva Tasación”.</span></div></td></tr>';
        return;
      }

      tbody.innerHTML = data.map(t => {
        const prop = t.property_id ? propMap.get(t.property_id) : null;
        const propName = prop ? [prop.code, prop.title].filter(Boolean).join(' · ') : null;
        const owner = t.owner_id ? ownerMap.get(t.owner_id) : null;
        const ownerName = owner ? (owner.full_name || null) : null;
        return buildTasacionRowHtml(t, { propName, ownerName });
      }).join('');

    } catch (err) {
      logError('loadTasaciones error:', err);
      tbody.innerHTML = '<tr><td colspan="5" class="tas-empty-cell">Error al cargar tasaciones</td></tr>';
    }
  }

  /* Filtros y ordenamiento del listado */
  const _tasSort = { col: 'created_at', asc: false };
  let _tasSearchTimer = null;
  const _tasReload = () => { _tasacionesPage = 1; loadTasaciones(); };
  const _tasReloadDebounced = () => { clearTimeout(_tasSearchTimer); _tasSearchTimer = setTimeout(_tasReload, 250); };
  on($('#tasaSearchText'), 'input', _tasReloadDebounced);
  on($('#tasaFilterTipo'), 'change', _tasReload);
  on($('#tasaFilterEstado'), 'change', _tasReload);
  on($('#tasaFilterDesde'), 'change', _tasReload);
  on($('#tasaFilterHasta'), 'change', _tasReload);
  on($('#tasaFilterClear'), 'click', () => {
    ['#tasaSearchText', '#tasaFilterTipo', '#tasaFilterEstado', '#tasaFilterDesde', '#tasaFilterHasta']
      .forEach(sel => { const el = $(sel); if (el) el.value = ''; });
    _tasReload();
  });
  on(document, 'click', (e) => {
    const th = e.target.closest('.tas-th-sort');
    if (!th || !th.closest('#tab-tasaciones')) return;
    const col = th.dataset.sort;
    if (!col) return;
    if (_tasSort.col === col) { _tasSort.asc = !_tasSort.asc; } else { _tasSort.col = col; _tasSort.asc = false; }
    document.querySelectorAll('#tab-tasaciones .tas-th-sort').forEach(el => {
      el.removeAttribute('data-dir');
      const icon = el.querySelector('.tas-sort-icon');
      if (icon) icon.className = 'fas fa-sort tas-sort-icon';
    });
    th.dataset.dir = _tasSort.asc ? 'asc' : 'desc';
    const icon = th.querySelector('.tas-sort-icon');
    if (icon) icon.className = 'fas ' + (_tasSort.asc ? 'fa-sort-up' : 'fa-sort-down') + ' tas-sort-icon';
    _tasReload();
  });

  window.navigateToTasacion = function (id, title) {
    showTasacionEditor(id, title);
  };

  async function _deleteTasacion(id) {
    if (!confirm('¿Eliminar esta tasación permanentemente?')) return;
    try {
      await mutate('tasaciones', async () => {
        const { error } = await window.supabaseClient.from('tasaciones').delete().eq('id', id);
        if (error) throw error;
      });
      showToast('Tasación eliminada', 'success');
      loadTasaciones();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  }
  window.deleteTasacion = _deleteTasacion;

  function _openTasacionPDF(id) {
    const url = 'tasacion.html?id=' + encodeURIComponent(id) + '&print=1&token=' + encodeURIComponent(window.__bhAdminToken || '');
    window.open(url, '_blank', 'noopener');
  }

  /* ------------------------------------------------
     Security: delegated handlers (sin onclick inline; datos externos viajan en data-* esc()'
     ------------------------------------------------ */
  on($('#propertiesTableBody'), 'click', (e) => {
    const upd = e.target.closest('[data-ml-update-prop]');
    if (upd) { window.adminApp.mlUpdateProperty(upd.dataset.mlUpdateProp, upd.dataset.mlListing || ''); return; }
    const rem = e.target.closest('[data-ml-remove]');
    if (rem) { window.adminApp.mlRemoveProperty(rem.dataset.mlListing || '', rem.dataset.mlProp || ''); return; }
    const pub = e.target.closest('[data-ml-publish]');
    if (pub) { window.adminApp.mlPublishProperty(pub.dataset.mlPublish); return; }
    const relaBtn = e.target.closest('[data-rela-action]');
    if (relaBtn) { window.adminApp.relaPropertyAction(relaBtn.dataset.relaProp, relaBtn.dataset.relaAction); return; }
    const waBtn = e.target.closest('[data-wa-share]');
    if (waBtn) { window.adminApp.sharePropertyWhatsApp(waBtn.dataset.waShare, waBtn.dataset.waCode || ''); }
  });

  /* Delegado "Agendar visita" desde CRM (kanban, detalle de lead, listado).
     Los datos viajan en data-* con esc(); capture corta el bubble ANTES del onclick
     inline del card (editLead) y abre el modal con el prefill. */
  on(document, 'click', (e) => {
    const btn = e.target.closest('[data-open-visit]');
    if (!btn) return;
    e.stopPropagation();
    window.adminApp.openVisitModal({
      lead_id: btn.dataset.leadId || null,
      client_name: btn.dataset.clientName || '',
      client_phone: btn.dataset.clientPhone || '',
      property_id: btn.dataset.propertyId || ''
    });
  }, true);

  window.adminApp.sharePropertyWhatsApp = async function (propertyId, propertyCode) {
    if (!propertyCode) { showToast('La propiedad no tiene código; no se puede generar la ficha', 'error'); return; }
    try {
      const { data: p, error } = await window.supabaseClient
        .from('properties')
        .select('title, price_usd, price_currency, property_type, zone, address, rooms, bedrooms, bathrooms, surface_covered, surface_total, status')
        .eq('id', propertyId)
        .single();
      if (error || !p) throw new Error('No se pudo leer la propiedad');

      const TYPE = { casa: 'CASA', departamento: 'DEPARTAMENTO', terreno: 'TERRENO', local: 'LOCAL', oficina: 'OFICINA', galpon: 'GALPÓN', quinta: 'QUINTA', otro: 'PROPIEDAD' };
      // Restricción: solo caracteres BMP; wa.me degrada a U+FFFD los emojis fuera del BMP.
      const lines = [];
      lines.push('\u25C6 *' + (TYPE[p.property_type] || 'PROPIEDAD') + ' EN ' + (p.status === 'alquiler' ? 'ALQUILER' : 'VENTA') + '*');
      lines.push('');
      lines.push('\u2605 *' + (p.title || propertyCode) + '*');
      if (p.zone || p.address) lines.push('\u00BB ' + [p.zone, p.address].filter(Boolean).join(' \u00B7 '));
      lines.push('');
      if (p.price_usd) lines.push('\u2713 *' + (p.price_currency === 'ARS' ? '$' : 'USD') + ' ' + Number(p.price_usd).toLocaleString('es-AR') + '*');
      const feats = [];
      if (p.rooms) feats.push('\u2022 ' + p.rooms + ' ambientes');
      if (p.bedrooms) feats.push('\u2022 ' + p.bedrooms + ' dorm.');
      if (p.bathrooms) feats.push('\u2022 ' + p.bathrooms + ' ba\u00F1o' + (p.bathrooms === 1 ? '' : 's'));
      if (p.surface_total || p.surface_covered) feats.push('\u2022 ' + (p.surface_total || p.surface_covered) + ' m\u00B2');
      if (feats.length) { lines.push(''); lines.push(feats.join('  \u00B7  ')); }
      lines.push('');
      lines.push('\u25BC *Ficha completa con fotos*');
      lines.push('https://bienenhaus.com.ar/fichas/' + encodeURIComponent(propertyCode) + '.html');
      lines.push('');
      lines.push('\u2605 *BIENENHAUS PROPIEDADES* \u00B7 C\u00F3d. ' + propertyCode);

      window.open('https://wa.me/?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
    } catch (err) {
      showToast('Error al preparar el mensaje: ' + err.message, 'error');
    }
  };

  on($('#imagePreviewGrid'), 'click', (e) => {
    const starBtn = e.target.closest('.preview-portada-btn');
    if (starBtn) {
      const starItem = starBtn.closest('.image-preview-item');
      if (starItem) setPreviewAsPortada(starItem);
      return;
    }
    const btn = e.target.closest('.preview-remove');
    if (btn) {
      const item = btn.closest('.image-preview-item');
      if (item) {
        if (item.dataset.objUrl) {
          URL.revokeObjectURL(item.dataset.objUrl);
          _newImageFiles = _newImageFiles.filter(x => x.url !== item.dataset.objUrl);
          const fileInput = $('#propImageFilesInput');
          if (fileInput) fileInput.value = '';
        }
        item.remove();
        refreshPreviewBadges();
      }
    }
  });

  on($('#tasacionesTableBody'), 'click', (e) => {
    const linkVinc = e.target.closest('[data-open-owner-vinc]');
    if (linkVinc) { window.adminApp.editOwner(linkVinc.dataset.openOwnerVinc); return; }
    const propVinc = e.target.closest('[data-open-prop-vinc]');
    if (propVinc) { window.adminApp.editProperty(propVinc.dataset.openPropVinc); return; }
    const open = e.target.closest('[data-open-tasacion]');
    if (open) { window.navigateToTasacion(open.dataset.openTasacion, open.dataset.tasacionTitle || ''); return; }
    const del = e.target.closest('[data-del-tasacion]');
    if (del) { _deleteTasacion(del.dataset.delTasacion); return; }
    const pdf = e.target.closest('[data-pdf-tasacion]');
    if (pdf) { _openTasacionPDF(pdf.dataset.pdfTasacion); return; }
    const dup = e.target.closest('[data-dup-tasacion]');
    if (dup) { _duplicateTasacion(dup.dataset.dupTasacion); return; }
    const toggle = e.target.closest('[data-toggle-status]');
    if (toggle) { _toggleTasacionStatus(toggle.dataset.toggleStatus, toggle.dataset.status); return; }
    const link = e.target.closest('[data-link-owner]');
    if (link) { _openLinkOwnerModal(link.dataset.linkOwner); return; }
  });

  async function _duplicateTasacion(id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('tasaciones')
        .select('title, type, data, valuation_usd, property_id, owner_id, broker_id')
        .eq('id', id)
        .single();
      if (error || !data) throw (error || new Error('No se encontró la tasación'));
      await mutate('tasaciones', async () => {
        const { error: insErr } = await window.supabaseClient.from('tasaciones').insert({
          title: (data.title || 'Tasación') + ' (copia)',
          type: data.type || 'venta',
          data: data.data || {},
          valuation_usd: data.valuation_usd || null,
          property_id: data.property_id || null,
          owner_id: data.owner_id || null,
          broker_id: data.broker_id || null,
          created_by: currentUser?.id || null,
          status: 'draft'
        });
        if (insErr) throw insErr;
      });
      showToast('Tasación duplicada como borrador', 'success');
      loadTasaciones();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al duplicar: ' + err.message, 'error');
    }
  }

  async function _toggleTasacionStatus(id, current) {
    const next = current === 'finalized' ? 'draft' : 'finalized';
    const ok = await showConfirmDialog({
      title: next === 'finalized' ? 'Marcar como finalizada' : 'Volver a borrador',
      message: next === 'finalized'
        ? 'La tasación pasará a FINALIZADA (el editor quedará en solo lectura). ¿Continuar?'
        : 'La tasación volverá a BORRADOR y podrá editarse. ¿Continuar?',
      icon: next === 'finalized' ? 'fas fa-check' : 'fas fa-rotate-left',
      confirmText: next === 'finalized' ? 'Finalizar' : 'Volver a borrador',
      danger: next === 'draft'
    });
    if (!ok) return;
    try {
      await mutate('tasaciones', async () => {
        const { error } = await window.supabaseClient.from('tasaciones')
          .update({ status: next, updated_at: new Date().toISOString() })
          .eq('id', id);
        if (error) throw error;
      });
      showToast(next === 'finalized' ? 'Tasación finalizada' : 'Tasación en borrador', 'success');
      loadTasaciones();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al cambiar estado: ' + err.message, 'error');
    }
  }

  let _linkOwnerTasacionId = null;
  async function _openLinkOwnerModal(tasacionId) {
    _linkOwnerTasacionId = tasacionId;
    const sel = $('#tasaLinkOwnerSelect');
    const unlink = $('#tasaLinkOwnerUnlink');
    if (!sel || !window.supabaseClient) return;
    sel.innerHTML = '<option value="">Cargando...</option>';
    if (unlink) unlink.checked = false;
    openModal('tasaLinkOwnerModal');
    try {
      const [tasaRes, ownersRes] = await Promise.all([
        window.supabaseClient.from('tasaciones').select('title, owner_id').eq('id', tasacionId).single(),
        window.supabaseClient.from('owners').select('id, full_name').is('deleted_at', null).order('full_name')
      ]);
      if (ownersRes.error) throw ownersRes.error;
      const sub = $('#tasaLinkOwnerSubtitle');
      if (sub) sub.textContent = 'Elegí el propietario para "' + (tasaRes.data?.title || 'esta tasación') + '".';
      sel.innerHTML = '<option value="">— Seleccionar propietario —</option>' +
        (ownersRes.data || []).map(o => '<option value="' + esc(o.id) + '">' + esc(o.full_name || '') + '</option>').join('');
      if (tasaRes.data?.owner_id) sel.value = tasaRes.data.owner_id;
    } catch (err) {
      showToast('No se pudieron cargar propietarios: ' + err.message, 'error');
      sel.innerHTML = '<option value="">— Seleccionar propietario —</option>';
    }
  }

  on($('#tasaLinkOwnerSave'), 'click', async () => {
    if (!_linkOwnerTasacionId) return;
    const unlink = $('#tasaLinkOwnerUnlink')?.checked;
    const ownerId = $('#tasaLinkOwnerSelect')?.value || '';
    const newOwner = unlink ? null : (ownerId || null);
    if (!unlink && !ownerId) { showToast('Elegí un propietario o marcá "Quitar vínculo"', 'warning'); return; }
    try {
      await mutate('tasaciones', async () => {
        const { error } = await window.supabaseClient.from('tasaciones')
          .update({ owner_id: newOwner, updated_at: new Date().toISOString() })
          .eq('id', _linkOwnerTasacionId);
        if (error) throw error;
      });
      showToast(newOwner ? 'Propietario vinculado' : 'Vínculo eliminado', 'success');
      closeModal('tasaLinkOwnerModal');
      _linkOwnerTasacionId = null;
      loadTasaciones();
    } catch (err) {
      showToast('Error al vincular: ' + err.message, 'error');
    }
  });

  async function createNewTasacion() {
    const propSelect = $('#tasaProperty');
    const ownerSelect = $('#tasaOwner');
    if (!propSelect || !ownerSelect) return;
    window.__BH.tasacionOwnerCtx = null;
    ownerSelect.disabled = false;
      try {
        const [propsRes, ownersRes] = await Promise.all([
          window.supabaseClient.from('properties').select('id, property_code, title').is('deleted_at', null).order('property_code'),
          window.supabaseClient.from('owners').select('id, full_name').is('deleted_at', null).order('full_name')
        ]);
        if (propsRes.error) throw propsRes.error;
        if (ownersRes.error) throw ownersRes.error;
        propSelect.innerHTML = '<option value="">Sin vincular</option>' +
          (propsRes.data || []).map(p => '<option value="' + esc(p.id) + '">' + esc(p.property_code || '') + ' - ' + esc(p.title || '') + '</option>').join('');
        ownerSelect.innerHTML = '<option value="">Sin vincular</option>' +
          (ownersRes.data || []).map(o => '<option value="' + esc(o.id) + '">' + esc(o.full_name || '') + '</option>').join('');
      } catch (err) {
        logError('createNewTasacion error:', err);
        showToast('No se pudieron cargar propiedades/propietarios: ' + (err && err.message ? err.message : err), 'error');
      }
    openModal('newTasacionModal');
  }

  on($('#btnNewTasacion'), 'click', createNewTasacion);

  on($('#newTasacionForm'), 'submit', async (e) => {
    e.preventDefault();
    const userId = currentUser?.id;
    if (!userId) { showToast('No hay sesión activa', 'error'); return; }
    const type = $('#tasaType')?.value || 'venta';
    const propertyId = $('#tasaProperty')?.value || null;
    let ownerId = $('#tasaOwner')?.value || null;
    if (window.__BH.tasacionOwnerCtx) ownerId = window.__BH.tasacionOwnerCtx;
    if (propertyId) {
      try {
        const { data: propRow } = await window.supabaseClient.from('properties').select('title, property_code, owner_id').eq('id', propertyId).single();
        const propOwnerId = propRow?.owner_id || null;
        if (propOwnerId && !ownerId) {
          ownerId = propOwnerId;
        } else if (propOwnerId && ownerId && propOwnerId !== ownerId) {
          const ok = await showConfirmDialog({
            title: 'Conflicto de propietario',
            message: 'La propiedad "' + (propRow.title || propRow.property_code || '') + '" pertenece a otro propietario que el elegido. ¿Crear la tasación de todos modos?',
            icon: 'fas fa-triangle-exclamation',
            confirmText: 'Crear igualmente',
            danger: true
          });
          if (!ok) return;
        }
      } catch (_) { /* si falla el lookup, se crea sin validación extra */ }
    }
    const title = type.charAt(0).toUpperCase() + type.slice(1) + (propertyId ? ' — ' + ($('#tasaProperty')?.selectedOptions?.[0]?.textContent || '') : '');
    try {
      const payload = { title: title, status: 'draft', type: type, created_by: userId };
      if (propertyId) payload.property_id = propertyId;
      if (ownerId) payload.owner_id = ownerId;
      let newTasacionId = null;
      await mutate('tasaciones', async () => {
        const { data, error } = await window.supabaseClient
          .from('tasaciones')
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;
        newTasacionId = data.id;
      });
      closeModal('newTasacionModal');
      if (window.__BH.tasacionOwnerCtx) {
        closeModal('ownerModal');
        navigateTo('tab-tasaciones');
      }
      showTasacionEditor(newTasacionId, title);
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al crear tasación: ' + err.message, 'error');
    }
  });


  window.__BH.loadTasaciones = loadTasaciones;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadTasaciones')) Object.defineProperty(window, 'loadTasaciones', { get: () => loadTasaciones, set: (v) => { loadTasaciones = v; }, configurable: true });
  window.__BH.showTasacionEditor = showTasacionEditor;
  if (!Object.prototype.hasOwnProperty.call(window, 'showTasacionEditor')) Object.defineProperty(window, 'showTasacionEditor', { get: () => showTasacionEditor, set: (v) => { showTasacionEditor = v; }, configurable: true });
})();
