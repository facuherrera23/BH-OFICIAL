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
        } catch (_) {}
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
      /* Get total count for pagination */
      const { count: totalCount, error: countError } = await window.supabaseClient
        .from('tasaciones')
        .select('*', { count: 'exact', head: true });
      if (countError) throw countError;
      _tasacionesTotalCount = totalCount || 0;

      const from = (_tasacionesPage - 1) * _tasacionesPageSize;
      const to = from + _tasacionesPageSize - 1;

      const { data, error } = await window.supabaseClient
        .from('tasaciones')
        .select('id, title, status, created_at, property_id, owner_id, type, data, valuation_usd')
        .order('created_at', { ascending: false })
        .range(from, to);
      if (error) throw error;

      const propIds = [...new Set((data || []).map(t => t.property_id).filter(Boolean))];
      const ownerIds = [...new Set((data || []).map(t => t.owner_id).filter(Boolean))];
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const [propsRes, ownersRes, finRes, draftRes, recentRes] = await Promise.all([
        propIds.length ? window.supabaseClient.from('properties').select('id, property_code, title').in('id', propIds) : { data: [] },
        ownerIds.length ? window.supabaseClient.from('owners').select('id, full_name').in('id', ownerIds) : { data: [] },
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).eq('status', 'finalized'),
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
        window.supabaseClient.from('tasaciones').select('*', { count: 'exact', head: true }).gte('created_at', since30)
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
        tbody.innerHTML = '<tr><td colspan="5"><div class="tas-empty"><i class="fas fa-file-invoice"></i><p>No hay tasaciones registradas todavía.</p><span>Creá la primera con “Nueva Tasación”.</span></div></td></tr>';
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
    const open = e.target.closest('[data-open-tasacion]');
    if (open) { window.navigateToTasacion(open.dataset.openTasacion, open.dataset.tasacionTitle || ''); return; }
    const del = e.target.closest('[data-del-tasacion]');
    if (del) _deleteTasacion(del.dataset.delTasacion);
    const pdf = e.target.closest('[data-pdf-tasacion]');
    if (pdf) { _openTasacionPDF(pdf.dataset.pdfTasacion); return; }
  });

  async function createNewTasacion() {
    const propSelect = $('#tasaProperty');
    const ownerSelect = $('#tasaOwner');
    if (!propSelect || !ownerSelect) return;
    _tasacionOwnerCtx = null;
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
    if (_tasacionOwnerCtx) ownerId = _tasacionOwnerCtx;
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
      if (_tasacionOwnerCtx) {
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
