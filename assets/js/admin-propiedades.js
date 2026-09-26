/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Propiedades CRUD
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, logWarn, on, PropertySchema, validateForm, getAuthedClient, loadAgentSelect, openModal, closeModal, showToast, invalidateSearchCache, updateSidebarBadges, formatPrice, esc, mutate } = window.__BH || {};

  /* ------------------------------------------------
     5. PROPERTIES CRUD
     ------------------------------------------------ */
  async function loadProperties() {
    invalidateSearchCache();
    const tbody = $('#propertiesTableBody');
    const pageInfo = $('#propPageInfo');
    const pagePrev = $('#propPagePrev');
    const pageNext = $('#propPageNext');
    const pageSize = $('#propPageSize');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const applyPropFilters = (q) => {
        let query = q;
        if (_propViewTrash) query = query.not('deleted_at', 'is', null);
        else query = query.is('deleted_at', null);
        if (_propStatusFilter) query = query.eq('status', _propStatusFilter);
        if (_propPubFilter === 'published') query = query.eq('is_published', true);
        else if (_propPubFilter === 'draft') query = query.eq('is_published', false);
        if (_propAgentFilter) query = query.eq('agent_id', _propAgentFilter);
        if (_propSearchQuery) {
          const safe = _propSearchQuery.replace(/[%_,()]/g, ' ');
          query = query.or(`title.ilike.%${safe}%,zone.ilike.%${safe}%,address.ilike.%${safe}%,property_code.ilike.%${safe}%,locality.ilike.%${safe}%`);
        }
        return query;
      };

      const { count: totalCount, error: countError } = await applyPropFilters(
        client.from('properties').select('*', { count: 'exact', head: true })
      );
      if (countError) throw countError;
      _propTotalCount = totalCount || 0;

      const from = (_propPage - 1) * _propPageSize;
      const to = from + _propPageSize - 1;

      const [, trashRes] = await Promise.all([
        Promise.resolve(null),
        client.from('properties').select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null)
      ]);
      _propTrashCount = trashRes.count || 0;
      const trashBtn = $('#propTrashToggle');
      if (trashBtn) {
        trashBtn.innerHTML = '<i class="fas fa-trash-can"></i> Papelera' + (_propTrashCount ? ' (' + _propTrashCount + ')' : '');
        trashBtn.classList.toggle('is-active', _propViewTrash);
      }

      const [propsRes, listingsRes, ownersRes, relaRes] = await Promise.all([
        applyPropFilters(client.from('properties').select('*')).order('created_at', { ascending: false }).range(from, to),
        ml_connected
          ? client.from('ml_listings').select('property_id, ml_listing_id:ml_item_id, status:ml_status')
          : Promise.resolve({ data: [] }),
        client.from('owners').select('id, full_name').is('deleted_at', null).order('full_name'),
        client.from('rela_listings').select('property_id, codigo_aviso, status, remote_status, last_error'),
      ]);

      const data = propsRes.data;
      const error = propsRes.error;
      if (error) throw error;

      const mlMap = {};
      (listingsRes.data || []).forEach(l => { if (l.property_id) mlMap[l.property_id] = l; });

      const relaMap = {};
      (relaRes.data || []).forEach(l => { if (l.property_id) relaMap[l.property_id] = l; });

      const ownerMap = {};
      (ownersRes.data || []).forEach(o => { ownerMap[o.id] = o.full_name; });

      const ownerSelect = $('#propOwnerSelect');
      if (ownerSelect) {
        const currentVal = ownerSelect.value;
        ownerSelect.innerHTML = '<option value="">Sin propietario asignado</option>' +
          (ownersRes.data || []).map(o => `<option value="${esc(o.id)}">${esc(o.full_name)}</option>`).join('');
        if (currentVal) ownerSelect.value = currentVal;
      }

      // Update pagination UI
      const totalPages = Math.ceil(_propTotalCount / _propPageSize);
      if (pageInfo) pageInfo.textContent = `Página ${_propPage} de ${totalPages || 1}`;
      if (pagePrev) pagePrev.disabled = _propPage <= 1;
      if (pageNext) pageNext.disabled = _propPage >= totalPages;

      if (!data?.length) {
        const emptyMsg = _propViewTrash
          ? 'La papelera está vacía'
          : (_propSearchQuery || _propStatusFilter || _propPubFilter || _propAgentFilter)
            ? 'No hay propiedades que coincidan con los filtros'
            : 'No hay propiedades cargadas';
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:40px; color:var(--text-dim);">' + emptyMsg + '</td></tr>';
        const selectAll = $('#propSelectAll');
        if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
        updatePropBulkBar();
        return;
      }

      tbody.innerHTML = data.map(p => {
        const rawThumb = p.image_urls?.[0] || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=200&q=60&fit=crop';
        const thumb = rawThumb.includes('res.cloudinary.com') && rawThumb.includes('/upload/')
          ? rawThumb.replace('/upload/', '/upload/w_200,h_200,c_fill,')
          : rawThumb;
        const loc = [p.zone, p.address].filter(Boolean).join(', ');
        const mlInfo = mlMap[p.id];
        let mlBadge = '';
        let mlButtons = '';

        if (mlInfo && mlInfo.status !== 'closed') {
          const mlStatusColor = mlInfo.status === 'active' ? 'var(--success)' : mlInfo.status === 'paused' ? 'var(--warning)' : 'var(--text-dim)';
          const mlStatusText = esc(mlInfo.status === 'active' ? 'En ML' : mlInfo.status === 'paused' ? 'Pausado' : mlInfo.status || 'ML');
          mlBadge = `<span class="nav-badge status-pill ${mlInfo.status === 'active' ? 'active' : 'paused'}" style="font-size:10px; margin-left:4px;">${mlStatusText}</span>`;
          /* Security: ml_listing_id es texto externo (API de ML): viaja en data-* + delegacion, NUNCA dentro de onclick */
          mlButtons = `
              <button class="btn-action" style="font-size:11px; color:#FFE600;" title="Actualizar en ML" data-ml-update-prop="${esc(p.id)}" data-ml-listing="${esc(mlInfo.ml_listing_id)}"><i class="fas fa-arrows-rotate"></i></button>
              <button class="btn-action danger" style="font-size:11px;" title="Quitar de ML" data-ml-remove data-ml-prop="${esc(p.id)}" data-ml-listing="${esc(mlInfo.ml_listing_id)}"><i class="fas fa-link-slash"></i></button>`;
        } else if (ml_connected) {
          mlButtons = `<button class="btn-action" style="font-size:11px; color:#FFE600;" title="Publicar en ML" data-ml-publish="${esc(p.id)}"><i class="fas fa-shopping-cart"></i></button>`;
        }

        const relaInfo = relaMap[p.id];
        let relaBadge = '';
        let relaButtons = '';
        if (relaInfo) {
          const relaColor = relaInfo.status === 'PUBLISHED' ? 'var(--success)' : relaInfo.status === 'ERROR' || relaInfo.status === 'BLOCKED' ? 'var(--danger)' : 'var(--warning)';
          const relaText = relaInfo.status === 'PUBLISHED' ? 'RELA' : relaInfo.status === 'ERROR' ? 'RELA Error' : relaInfo.status === 'BLOCKED' ? 'RELA Bloqueado' : 'RELA ' + relaInfo.status;
          relaBadge = `<span class="nav-badge" style="background:rgba(59,130,246,0.15); color:${relaColor}; font-size:10px; margin-left:4px;" title="${esc(relaInfo.last_error || relaInfo.remote_status || '')}">${esc(relaText)}</span>`;
          relaButtons = `
              <button class="btn-action" style="font-size:11px; color:#3B82F6;" title="Sincronizar RELA" data-rela-action="update" data-rela-prop="${esc(p.id)}"><i class="fas fa-arrows-rotate"></i></button>
              <button class="btn-action danger" style="font-size:11px;" title="Despublicar de RELA" data-rela-action="unpublish" data-rela-prop="${esc(p.id)}"><i class="fas fa-cloud-arrow-down"></i></button>`;
        } else {
          relaButtons = `<button class="btn-action" style="font-size:11px; color:#3B82F6;" title="Publicar en RELA (ZonaProp)" data-rela-action="publish" data-rela-prop="${esc(p.id)}"><i class="fas fa-cloud-arrow-up"></i></button>`;
        }

        const codeBadge = p.property_code
          ? `<span class="props-code">${esc(p.property_code)}</span>`
          : '<span style="color:var(--text-dim); font-size:11px;">—</span>';

        const stateBadges = [
          `<span class="props-badge" style="background:${p.is_published ? 'rgba(0,200,120,0.15)' : 'rgba(255,255,255,0.06)'}; color:${p.is_published ? 'var(--success)' : 'var(--text-dim)'};">${p.is_published ? 'Publicada' : 'Borrador'}</span>`,
          p.featured ? '<span class="props-badge" style="background:rgba(255,184,0,0.15); color:var(--warning);"><i class="fas fa-star"></i>Destacada</span>' : '',
          p.is_retasada ? '<span class="props-badge" style="background:rgba(139,92,246,0.15); color:#8b5cf6;"><i class="fas fa-tag"></i>Retasada</span>' : '',
          p.is_oportunidad ? '<span class="props-badge" style="background:rgba(239,68,68,0.15); color:#ef4444;"><i class="fas fa-bolt"></i>Oportunidad</span>' : '',
          p.is_shared ? '<span class="props-badge" style="background:rgba(6,182,212,0.15); color:#06b6d4;"><i class="fas fa-share-nodes"></i>Compartido</span>' : '',
          p.is_vendida ? '<span class="props-badge" style="background:rgba(75,85,99,0.18); color:#9ca3af;"><i class="fas fa-check-circle"></i>Vendida</span>' : '',
          p.is_reservada ? '<span class="props-badge" style="background:rgba(234,179,8,0.18); color:#ca8a04;"><i class="fas fa-lock"></i>Reservada</span>' : ''
        ].filter(Boolean).join('');

        return `
        <tr>
          <td><input type="checkbox" class="prop-row-check props-check" data-prop-id="${esc(p.id)}" ${_propSelected.has(p.id) ? 'checked' : ''} /></td>
          <td>${codeBadge}</td>
          <td>
            <div class="props-prop">
              <img class="props-thumb" src="${esc(thumb)}" alt="${esc(p.title || '')}" loading="lazy" />
              <div class="props-prop-body">
                <span class="props-title" title="${esc(p.title || '')}">${esc(p.title || 'Sin título')}${mlBadge}${relaBadge}</span>
                <span class="props-loc" title="${esc(loc)}"><i class="fas fa-location-dot"></i>${esc(loc || 'Sin ubicación')}</span>
              </div>
            </div>
          </td>
          <td class="props-num">${p.area_m2 ? p.area_m2 + ' m²' : '—'}</td>
          <td class="props-num">${p.rooms || '—'}</td>
          <td class="props-price">${formatPrice(p.price_usd, p.price_currency)}</td>
          <td><span class="props-badge" style="background:${p.status === 'venta' ? 'rgba(31,200,195,0.15)' : 'rgba(255,184,0,0.15)'}; color:${p.status === 'venta' ? 'var(--accent)' : 'var(--warning)'};">${esc(p.status || 'venta')}</span></td>
          <td><span class="props-owner${p.owner_id ? '' : ' is-empty'}" title="${esc(ownerMap[p.owner_id] || '')}">${esc(ownerMap[p.owner_id] || '—')}</span></td>
          <td><div class="props-state">${stateBadges}</div></td>
            <td data-col-actions>
            ${_propViewTrash ? `
            <div class="props-actions">
              <button class="btn-action" style="color:var(--success);" title="Restaurar propiedad" data-prop-act="restore" data-prop-id="${esc(p.id)}"><i class="fas fa-trash-arrow-up"></i></button>
              <button class="btn-action danger" title="Eliminar definitivamente (solo Super Admin; borra fotos y documentos)" data-prop-act="destroy" data-prop-id="${esc(p.id)}"><i class="fas fa-ban"></i></button>
            </div>` : `
            <div class="props-actions">
              ${mlButtons}
              ${relaButtons}
              ${p.is_published ? `<button class="btn-action" style="color:#25D366;" title="Compartir ficha por WhatsApp" data-wa-share="${esc(p.id)}" data-wa-code="${esc(p.property_code || '')}"><i class="fab fa-whatsapp"></i></button>` : ''}
              ${p.is_published && p.property_code ? `<a class="btn-action" title="Ver ficha pública" href="fichas/${encodeURIComponent(p.property_code)}.html" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i></a>` : ''}
              <button class="btn-action" title="Duplicar propiedad" data-prop-act="duplicate" data-prop-id="${esc(p.id)}"><i class="fas fa-copy"></i></button>
              <button class="btn-action" title="Editar" data-prop-act="edit" data-prop-id="${esc(p.id)}"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar (va a la papelera)" data-prop-act="delete" data-prop-id="${esc(p.id)}"><i class="fas fa-trash"></i></button>
            </div>`}
          </td>
        </tr>`;
      }).join('');
} catch (err) {
      logError('Error loading properties:', err);
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:40px; color:var(--danger);">Error al cargar propiedades</td></tr>';
    }

      bindPropertyToolbar();
      loadPropAgentFilter();
      syncPropSelectAll();
      updatePropBulkBar();

    // Pagination controls — se registran una sola vez (fix: antes se duplicaban en cada carga)
    if (!_propPaginationBound) {
      _propPaginationBound = true;
      on(pagePrev, 'click', () => { if (_propPage > 1) { _propPage--; loadProperties(); } });
      on(pageNext, 'click', () => { const totalPages = Math.ceil(_propTotalCount / _propPageSize); if (_propPage < totalPages) { _propPage++; loadProperties(); } });
      on(pageSize, 'change', () => { _propPageSize = parseInt(pageSize.value); _propPage = 1; loadProperties(); });
    }

  } // end loadProperties

  /* Create button */
  on($('#btnNewProp'), 'click', () => {
    editingPropertyId = null;
    resetPropertyForm();
    loadAgentSelect($('#propAgentSelect'));
    openModal('propertyModal');
  });

  /* Topbar create button */
  on($('#topbarNewProp'), 'click', () => {
    editingPropertyId = null;
    resetPropertyForm();
    loadAgentSelect($('#propAgentSelect'));
    openModal('propertyModal');
  });

  function resetPropertyForm() {
    const form = $('#propertyForm');
    if (form) form.reset();
    const previews = $('#imagePreviewGrid');
    if (previews) previews.innerHTML = '';
    const codeInput = $('#propCode');
    if (codeInput) { codeInput.value = ''; codeInput.removeAttribute('readonly'); }
    const title = $('#propModalTitle');
    if (title) title.textContent = 'Nueva Propiedad';

    const docsSection = $('#propertyDocsSection');

    if (docsSection) docsSection.style.display = 'none';
    const histSection = $('#propertyHistorySection');
    if (histSection) histSection.style.display = 'none';
    const histList = $('#propertyHistoryList');
    if (histList) histList.innerHTML = '';
    const notesSection = $('#propertyNotesSection');
    if (notesSection) notesSection.style.display = 'block';
    const notesList = $('#propertyNotesList');
    if (notesList) notesList.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:16px;">Todavía no hay notas</p>';
    const noteInput = $('#propertyNoteInput');
    if (noteInput) noteInput.value = '';
    _pendingPropertyNotes = [];
    _newImageFiles = [];
  }

  /* Vista previa inmediata de las imágenes nuevas seleccionadas (antes de guardar) */
  let _newImageFiles = [];

  const PREVIEW_STAR_BASE = 'position:absolute; bottom:4px; right:4px; width:20px; height:20px; border-radius:50%; border:1px solid rgba(255,255,255,0.25); cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center; color:#fff;';
  const PREVIEW_STAR_IDLE = 'rgba(0,0,0,0.55)';
  const PREVIEW_STAR_ACTIVE = 'rgba(250,204,21,0.92)';

  function refreshPreviewBadges() {
    const previews = $('#imagePreviewGrid');
    if (!previews) return;
    const items = previews.querySelectorAll('.image-preview-item');
    items.forEach((item, idx) => {
      let badge = item.querySelector('.preview-portada-badge');
      const star = item.querySelector('.preview-portada-btn');
      if (idx === 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'preview-portada-badge';
          badge.style.cssText = 'position:absolute; top:4px; left:4px; background:rgba(250,204,21,0.92); color:#1a1a1a; font-size:9px; font-weight:700; padding:1px 6px; border-radius:4px; pointer-events:none;';
          badge.textContent = 'PORTADA';
          item.appendChild(badge);
        }
        if (star) { star.style.background = PREVIEW_STAR_ACTIVE; star.style.color = '#1a1a1a'; }
      } else {
        if (badge) badge.remove();
        if (star) { star.style.background = PREVIEW_STAR_IDLE; star.style.color = '#fff'; }
      }
    });
  }

  function setPreviewAsPortada(item) {
    const previews = $('#imagePreviewGrid');
    if (!previews || !item || item.parentNode !== previews) return;
    if (previews.firstElementChild !== item) previews.insertBefore(item, previews.firstElementChild);
    refreshPreviewBadges();
  }

  function previewPortadaBtnHtml() {
    return '<button type="button" class="preview-portada-btn" title="Usar como foto de portada" style="' + PREVIEW_STAR_BASE + PREVIEW_STAR_IDLE + '"><i class="fas fa-star"></i></button>';
  }

  function initPreviewDnD() {
    const previews = $('#imagePreviewGrid');
    if (!previews || previews.dataset.dndBound) return;
    previews.dataset.dndBound = '1';
    let dragging = null;
    previews.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.image-preview-item');
      if (!item) return;
      dragging = item;
      e.dataTransfer.effectAllowed = 'move';
      item.style.opacity = '0.4';
    });
    previews.addEventListener('dragend', () => {
      if (dragging) dragging.style.opacity = '';
      dragging = null;
      refreshPreviewBadges();
    });
    previews.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragging) return;
      const target = e.target.closest('.image-preview-item');
      if (!target || target === dragging) return;
      const rect = target.getBoundingClientRect();
      const after = (e.clientX - rect.left) > rect.width / 2;
      target.parentNode.insertBefore(dragging, after ? target.nextSibling : target);
    });
    previews.addEventListener('drop', (e) => { e.preventDefault(); refreshPreviewBadges(); });
  }
  initPreviewDnD();

  on($('#propImageFilesInput'), 'change', (e) => {
    const previews = $('#imagePreviewGrid');
    if (!previews) return;

    previews.querySelectorAll('.image-preview-item[data-new-file]').forEach(el => el.remove());
    _newImageFiles = [];

    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    files.forEach(file => {
      const objectUrl = URL.createObjectURL(file);
      _newImageFiles.push({ url: objectUrl, file });
      const item = document.createElement('div');
      item.className = 'image-preview-item';
      item.dataset.newFile = 'true';
      item.dataset.objUrl = objectUrl;
      item.draggable = true;
      item.style.cssText = 'position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--accent); cursor:grab;';
      item.innerHTML = `
        <img src="${objectUrl}" alt="" style="width:100%; height:100%; object-fit:cover;" />
        <span style="position:absolute; bottom:0; left:0; right:0; background:rgba(31,200,195,0.85); color:#04121a; font-size:8px; font-weight:700; text-align:center; padding:1px 0; text-transform:uppercase; letter-spacing:0.5px;">Nueva</span>
        ${previewPortadaBtnHtml()}
        <button type="button" class="preview-remove" title="Quitar" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
      `;
      previews.appendChild(item);
    });
    refreshPreviewBadges();
  });

  /* Toggle USD/ARS del campo precio (el label vive en cada field, se alterna display + required) */
  function togglePriceFields() {
    const currency = $('#priceCurrencySelect')?.value || 'USD';
    const usdField = document.getElementById('priceUsdField');
    const arsField = document.getElementById('priceArsField');
    if (!usdField || !arsField) return;
    const isArs = currency === 'ARS';
    usdField.style.display = isArs ? 'none' : '';
    arsField.style.display = isArs ? '' : 'none';
    const usdInput = usdField.querySelector('input');
    const arsInput = arsField.querySelector('input');
    if (usdInput) { usdInput.required = !isArs; usdInput.disabled = isArs; }
    if (arsInput) { arsInput.required = isArs; arsInput.disabled = !isArs; }
  }
  const currencySelBind = document.getElementById('priceCurrencySelect');
  if (currencySelBind) {
    currencySelBind.addEventListener('change', togglePriceFields);
    togglePriceFields();
  }

  /* Save property */
  on($('#propertyForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingProperty) return;
    _submittingProperty = true;
    const btn = $('#propertySaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      
      // Zod validation
      const validated = validateForm(PropertySchema, formData);
      const { price_currency, price_ars: _formArs, ...rest } = validated;
      
      let priceUsd;
      if (price_currency === 'ARS' && validated.price_ars > 0) {
        priceUsd = validated.price_ars;
      } else {
        priceUsd = validated.price_usd;
      }
      
      if (!priceUsd || priceUsd <= 0) {
        throw new Error('El precio de la propiedad debe ser mayor a 0');
      }
      
      const data = {
        ...rest,
        price_usd: priceUsd,
        price_currency,
        area_m2: validated.surface_covered,
        owner_id: validated.owner_id || null,
        created_by: currentUser?.id || null,
      };
      if (!data.property_code) delete data.property_code;
      if (editingPropertyId) delete data.property_code;
      if (data.year_built == null) delete data.year_built;
      if (data.maintenance_fee == null) delete data.maintenance_fee;

      if (validated.is_vendida || validated.is_reservada) {
        data.is_published = false;
      }

      const previewItems = Array.from(document.querySelectorAll('#imagePreviewGrid .image-preview-item'));
      const orderedExistingUrls = [];
      const orderedNewFiles = [];
      previewItems.forEach(item => {
        if (item.dataset.newFile) {
          const entry = _newImageFiles.find(x => x.url === item.dataset.objUrl);
          if (entry) orderedNewFiles.push(entry.file);
        } else {
          const hidden = item.querySelector('input[name="existing_image_urls"]');
          if (hidden && hidden.value) orderedExistingUrls.push(hidden.value);
        }
      });
      const uploadPromises = orderedNewFiles.map(f => uploadToCloudinary(f));
      const newUrls = await Promise.all(uploadPromises);
      data.image_urls = [...orderedExistingUrls, ...newUrls];

      if (editingPropertyId) {
        await mutate('properties', async () => {
          const { error } = await window.supabaseClient
            .from('properties')
            .update(data)
            .eq('id', editingPropertyId);
          if (error) throw error;
        });
        showToast('Propiedad actualizada correctamente', 'success');
        fichaPublishOnSave(editingPropertyId);
      
      } else {
        const newPropId = await mutate('properties', async () => {
          const { data: inserted, error } = await window.supabaseClient
            .from('properties')
            .insert([data])
            .select('id');
          if (error) throw error;
          return inserted?.[0]?.id || null;
        });
        showToast('Propiedad creada correctamente', 'success');
        fichaPublishOnSave(newPropId);
      
        if (_pendingPropertyNotes.length && newPropId) await flushPendingPropertyNotes(newPropId);
      }

      closeModal('propertyModal');
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      logError('Error saving property:', err);
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      _submittingProperty = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Inmueble'; }
    }
  });


  /* Generar/regenerar ficha HTML tras guardar una propiedad */

  const fichaPublishOnSave = async (propertyId) => {
    if (!propertyId) return;
    if (!window.BH_CONFIG?.SUPABASE_URL) return;
    try {
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session) return;
      const res = await fetch(window.BH_CONFIG.SUPABASE_URL + '/functions/v1/ficha-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ property_id: propertyId })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { logWarn('ficha-publish falló (' + res.status + '): ' + (out.error || 'desconocido')); return; }
      console.log('[ficha] generada para', propertyId, out.url || '');
    } catch (e) {
      logWarn('ficha-publish fetch error: ' + e.message);
    }
  };


    /* Edit property */
  window.adminApp = window.adminApp || {};
  window.adminApp.loadSupervision = loadSupervision;
  window.adminApp.loadAnomaliesTable = loadAnomaliesTable;
  window.adminApp.editProperty = async function (id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;

        editingPropertyId = id;
      const form = $('#propertyForm');
      if (form) {
        form.reset();
        const codeInput = $('#propCode');
        if (codeInput) codeInput.value = data.property_code || '';
        form.elements.title.value = data.title || '';
        form.elements.description.value = data.description || '';
        form.elements.price_currency.value = data.price_currency || 'USD';
        if (data.price_currency === 'ARS') {
          form.elements.price_usd.value = '';
          form.elements.price_ars.value = data.price_usd || '';
        } else {
          form.elements.price_usd.value = data.price_usd || '';
          form.elements.price_ars.value = '';
        }
        form.elements.property_type.value = data.property_type || '';
        form.elements.status.value = data.status || 'venta';
        form.elements.zone.value = data.zone || '';
        form.elements.locality.value = data.locality || '';
        form.elements.address.value = data.address || '';
        form.elements.bedrooms.value = data.bedrooms || '';
        form.elements.bathrooms.value = data.bathrooms || '';
        form.elements.surface_covered.value = data.surface_covered || data.area_m2 || '';
        form.elements.surface_total.value = data.surface_total || '';
        form.elements.garage_spaces.value = data.garage_spaces || '';
        form.elements.rooms.value = data.rooms || '';
        form.elements.is_published.checked = data.is_published || false;
        form.elements.featured.checked = data.featured || false;
        form.elements.is_retasada.checked = data.is_retasada || false;
        form.elements.is_oportunidad.checked = data.is_oportunidad || false;
        form.elements.is_shared.checked = data.is_shared || false;
        form.elements.is_vendida.checked = data.is_vendida || false;
        form.elements.is_reservada.checked = data.is_reservada || false;
        form.elements.video_url.value = data.video_url || '';
        form.elements.facebook_url.value = data.facebook_url || '';
        form.elements.tiktok_url.value = data.tiktok_url || '';
        if (form.elements.year_built) form.elements.year_built.value = data.year_built || '';
        if (form.elements.inscription_number) form.elements.inscription_number.value = data.inscription_number || '';
        if (form.elements.maintenance_fee) form.elements.maintenance_fee.value = data.maintenance_fee || '';
        if (form.elements.pets_allowed) form.elements.pets_allowed.checked = data.pets_allowed || false;
        if (form.elements.furnished) form.elements.furnished.checked = data.furnished || false;

        const ownerSel = $('#propOwnerSelect');
        if (ownerSel) ownerSel.value = data.owner_id || '';

        const agentSel = $('#propAgentSelect');
        if (agentSel) {
          await loadAgentSelect(agentSel, data.agent_id);
        }

        // Trigger currency field toggle
        const currencySelect = document.getElementById('priceCurrencySelect');
        if (currencySelect) {
          currencySelect.dispatchEvent(new Event('change'));
        }

        const previews = $('#imagePreviewGrid');
        if (previews) {
          previews.innerHTML = data.image_urls?.length
            ? data.image_urls.map(url => `
              <div class="image-preview-item" draggable="true" style="position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--border-subtle); cursor:grab;">
              <img src="${esc(url)}" alt="" style="width:100%; height:100%; object-fit:cover;" />
              <input type="hidden" name="existing_image_urls" value="${esc(url)}" />
              ${previewPortadaBtnHtml()}
              <button type="button" class="preview-remove" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
            </div>
          `).join('')
            : '';
          refreshPreviewBadges();
        }
      }

      const title = $('#propModalTitle');
      if (title) title.textContent = 'Editar Propiedad';

      const docsSection = $('#propertyDocsSection');

      if (docsSection) docsSection.style.display = 'block';

      loadPropertyDocs(editingPropertyId);
      _pendingPropertyNotes = [];
      loadPropertyNotes(editingPropertyId);
      loadPropertyHistory(editingPropertyId);
      openModal('propertyModal');
    } catch (err) {
      showToast('Error al cargar propiedad', 'error');
    }
  };

  /* Delete property → soft-delete (va a la papelera, recuperable) */
  window.adminApp.deleteProperty = async function (id) {
    if (!confirm('¿Enviar esta propiedad a la papelera?\nSe puede restaurar después desde la vista Papelera.')) return;
    try {
      const { error } = await window.supabaseClient
        .from('properties')
        .update({ deleted_at: new Date().toISOString(), is_published: false })
        .eq('id', id)
        .is('deleted_at', null);
      if (error) throw error;
      showToast('Propiedad movida a la papelera', 'success');
      _propSelected.delete(id);
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  window.adminApp.restoreProperty = async function (id) {
    try {
      const { error } = await window.supabaseClient
        .from('properties')
        .update({ deleted_at: null })
        .eq('id', id)
        .not('deleted_at', 'is', null);
      if (error) throw error;
      showToast('Propiedad restaurada como borrador', 'success');
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al restaurar: ' + err.message, 'error');
    }
  };

  window.adminApp.destroyProperty = async function (id) {
    if (currentProfile?.role !== 'super_admin') {
      showToast('Solo un Super Admin puede eliminar definitivamente', 'error');
      return;
    }
    if (!confirm('⚠️ ELIMINACIÓN DEFINITIVA\n\nSe borra la propiedad y todos sus documentos, y NO se puede recuperar.\n¿Confirmás?')) return;
    if (!confirm('Última confirmación: ¿eliminar permanentemente esta propiedad?')) return;
    try {
      const { data: propDocs } = await window.supabaseClient
        .from('property_documents')
        .select('storage_path')
        .eq('property_id', id);
      if (propDocs?.length) {
        await window.supabaseClient.storage.from('property-documents').remove(propDocs.map(d => d.storage_path));
      }
      const { error } = await window.supabaseClient.from('properties').delete().eq('id', id);
      if (error) throw error;
      showToast('Propiedad eliminada definitivamente', 'success');
      loadProperties();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error al eliminar definitivamente: ' + err.message, 'error');
    }
  };

  window.adminApp.duplicateProperty = async function (id) {
    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('*')
        .eq('id', id)
        .is('deleted_at', null)
        .single();
      if (error || !data) throw error || new Error('No se encontró la propiedad');

      editingPropertyId = null;
      resetPropertyForm();
      const form = $('#propertyForm');
      if (form) {
        form.elements.title.value = 'Copia de ' + (data.title || '');
        form.elements.description.value = data.description || '';
        form.elements.price_currency.value = data.price_currency || 'USD';
        if (data.price_currency === 'ARS') {
          form.elements.price_usd.value = '';
          form.elements.price_ars.value = data.price_usd || '';
        } else {
          form.elements.price_usd.value = data.price_usd || '';
          form.elements.price_ars.value = '';
        }
        form.elements.property_type.value = data.property_type || '';
        form.elements.status.value = data.status || 'venta';
        form.elements.zone.value = data.zone || '';
        form.elements.locality.value = data.locality || '';
        form.elements.address.value = data.address || '';
        form.elements.bedrooms.value = data.bedrooms || '';
        form.elements.bathrooms.value = data.bathrooms || '';
        form.elements.surface_covered.value = data.surface_covered || data.area_m2 || '';
        form.elements.surface_total.value = data.surface_total || '';
        form.elements.garage_spaces.value = data.garage_spaces || '';
        form.elements.rooms.value = data.rooms || '';
        form.elements.is_published.checked = false;
        form.elements.featured.checked = false;
        form.elements.is_retasada.checked = data.is_retasada || false;
        form.elements.is_oportunidad.checked = data.is_oportunidad || false;
        form.elements.is_shared.checked = data.is_shared || false;
        form.elements.is_vendida.checked = false;
        form.elements.is_reservada.checked = false;
        form.elements.video_url.value = data.video_url || '';
        form.elements.facebook_url.value = data.facebook_url || '';
        form.elements.tiktok_url.value = data.tiktok_url || '';
        if (form.elements.year_built) form.elements.year_built.value = data.year_built || '';
        if (form.elements.inscription_number) form.elements.inscription_number.value = data.inscription_number || '';
        if (form.elements.maintenance_fee) form.elements.maintenance_fee.value = data.maintenance_fee || '';
        if (form.elements.pets_allowed) form.elements.pets_allowed.checked = data.pets_allowed || false;
        if (form.elements.furnished) form.elements.furnished.checked = data.furnished || false;

        const ownerSel = $('#propOwnerSelect');
        if (ownerSel) ownerSel.value = data.owner_id || '';
        const agentSel = $('#propAgentSelect');
        if (agentSel) await loadAgentSelect(agentSel, data.agent_id);
        const previews = $('#imagePreviewGrid');
        if (previews) {
          previews.innerHTML = (data.image_urls || []).map(url => `
            <div class="image-preview-item" draggable="true" style="position:relative; width:80px; height:80px; border-radius:8px; overflow:hidden; border:1px solid var(--border-subtle); cursor:grab;">
              <img src="${esc(url)}" alt="" style="width:100%; height:100%; object-fit:cover;" />
              <input type="hidden" name="existing_image_urls" value="${esc(url)}" />
              ${previewPortadaBtnHtml()}
              <button type="button" class="preview-remove" title="Quitar" style="position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.7); color:#fff; border:none; cursor:pointer; font-size:10px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-times"></i></button>
            </div>
          `).join('');
          refreshPreviewBadges();
        }
        const currencySelect = $('#priceCurrencySelect');
        if (currencySelect) currencySelect.dispatchEvent(new Event('change'));
      }
      const title = $('#propModalTitle');
      if (title) title.textContent = 'Duplicar propiedad (nueva ficha, sin publicar)';
      const notesSection = $('#propertyNotesSection');
      if (notesSection) notesSection.style.display = 'block';
      openModal('propertyModal');
      showToast('Completá y guardá — se crea como borrador con código nuevo', 'info');
    } catch (err) {
      showToast('Error al duplicar: ' + err.message, 'error');
    }
  };

  function updatePropBulkBar() {
    const bar = $('#propBulkBar');
    if (!bar) return;
    const n = _propSelected.size;
    if (n === 0 || _propViewTrash) { bar.classList.remove('is-visible'); return; }
    bar.classList.add('is-visible');
    const lbl = $('#propBulkCount');
    if (lbl) lbl.textContent = n + ' seleccionada' + (n !== 1 ? 's' : '');
    const mlBtn = $('#propBulkPublishMl');
    if (mlBtn) mlBtn.style.display = ml_connected ? '' : 'none';
  }

  function resetPropSelection() {
    _propSelected.clear();
    const selectAll = $('#propSelectAll');
    if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
    updatePropBulkBar();
  }

  async function propBulkAction(action) {
    const ids = [..._propSelected];
    if (!ids.length) return;
    if (action === 'assign_agent') {
      const sel = $('#propBulkAgentSelect');
      const agentId = sel ? sel.value : '';
      if (!agentId) { showToast('Elegí un broker en el selector', 'error'); return; }
      const res = await window.supabaseClient.from('properties').update({ agent_id: agentId }).in('id', ids);
      if (res.error) { showToast('Error: ' + res.error.message, 'error'); return; }
      showToast('Broker asignado a ' + ids.length + ' propiedades', 'success');
    } else if (action === 'publish_ml') {
      if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
      const bar = $('#propBulkPublishMl');
      if (bar) { bar.disabled = true; bar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Publicando en ML…'; }
      let ok = 0; const fails = [];
      for (const id of ids) {
        try { await mlApiCall('publish', { property_id: id }); ok++; }
        catch (err) { fails.push(err.message); }
      }
      if (bar) { bar.disabled = false; bar.innerHTML = '<i class="fas fa-shopping-cart"></i> Publicar en ML'; }
      showToast(`ML: ${ok} publicadas${fails.length ? ', ' + fails.length + ' con error' : ''}`, fails.length ? 'warning' : 'success');
      await mlCheckStatus(true);
    } else {
      const publish = action === 'publish';
      const res = await window.supabaseClient.from('properties').update({ is_published: publish }).in('id', ids);
      if (res.error) { showToast('Error: ' + res.error.message, 'error'); return; }
      showToast(ids.length + (publish ? ' publicadas' : ' pasadas a borrador'), 'success');
    }
    resetPropSelection();
    loadProperties();
    updateSidebarBadges();
  }

  let _propSearchTimer = null;
  function bindPropertyToolbar() {
    const search = $('#propSearchInput');
    if (search && !search.dataset.boundServer) {
      search.dataset.boundServer = '1';
      search.addEventListener('input', () => {
        clearTimeout(_propSearchTimer);
        _propSearchTimer = setTimeout(() => {
          _propSearchQuery = search.value.trim();
          _propPage = 1;
          loadProperties();
        }, 350);
      });
    }
    const status = $('#propStatusFilter');
    if (status && !status.dataset.bound) {
      status.dataset.bound = '1';
      status.addEventListener('change', () => { _propStatusFilter = status.value; _propPage = 1; loadProperties(); });
    }
    const pub = $('#propPubFilter');
    if (pub && !pub.dataset.bound) {
      pub.dataset.bound = '1';
      pub.addEventListener('change', () => { _propPubFilter = pub.value; _propPage = 1; loadProperties(); });
    }
    const agent = $('#propAgentFilter');
    if (agent && !agent.dataset.bound) {
      agent.dataset.bound = '1';
      agent.addEventListener('change', () => { _propAgentFilter = agent.value; _propPage = 1; loadProperties(); });
    }
    const trashToggle = $('#propTrashToggle');
    if (trashToggle && !trashToggle.dataset.bound) {
      trashToggle.dataset.bound = '1';
      trashToggle.addEventListener('click', () => {
        _propViewTrash = !_propViewTrash;
        _propPage = 1;
        resetPropSelection();
        loadProperties();
      });
    }

    const tbodyEl = $('#propertiesTableBody');
    if (tbodyEl && !tbodyEl.dataset.propDelegation) {
      tbodyEl.dataset.propDelegation = '1';
      tbodyEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-prop-act]');
        if (!btn) return;
        const id = btn.dataset.propId;
        const act = btn.dataset.propAct;
        if (!id) return;
        if (act === 'edit') window.adminApp.editProperty(id);
        else if (act === 'delete') window.adminApp.deleteProperty(id);
        else if (act === 'restore') window.adminApp.restoreProperty(id);
        else if (act === 'destroy') window.adminApp.destroyProperty(id);
        else if (act === 'duplicate') window.adminApp.duplicateProperty(id);
      });
      tbodyEl.addEventListener('change', (e) => {
        const chk = e.target.closest('.prop-row-check');
        if (!chk) return;
        const id = chk.dataset.propId;
        if (chk.checked) _propSelected.add(id); else _propSelected.delete(id);
        syncPropSelectAll();
        updatePropBulkBar();
      });
    }

    const selectAll = $('#propSelectAll');
    if (selectAll && !selectAll.dataset.bound) {
      selectAll.dataset.bound = '1';
      selectAll.addEventListener('change', () => {
        const checks = $$('#propertiesTableBody .prop-row-check');
        checks.forEach(c => {
          c.checked = selectAll.checked;
          const id = c.dataset.propId;
          if (selectAll.checked) _propSelected.add(id); else _propSelected.delete(id);
        });
        updatePropBulkBar();
      });
    }

    [['propBulkPublish', 'publish'], ['propBulkUnpublish', 'unpublish'], ['propBulkAssign', 'assign_agent'], ['propBulkPublishMl', 'publish_ml']].forEach(([id, act]) => {
      const b = $(`#${id}`);
      if (b && !b.dataset.bound) {
        b.dataset.bound = '1';
        b.addEventListener('click', () => propBulkAction(act));
      }
    });
    const clearBtn = $('#propBulkClear');
    if (clearBtn && !clearBtn.dataset.bound) {
      clearBtn.dataset.bound = '1';
      clearBtn.addEventListener('click', resetPropSelection);
    }
  }

  function syncPropSelectAll() {
    const selectAll = $('#propSelectAll');
    if (!selectAll) return;
    const checks = $$('#propertiesTableBody .prop-row-check');
    const checked = checks.filter(c => c.checked);
    selectAll.checked = checks.length > 0 && checked.length === checks.length;
    selectAll.indeterminate = checked.length > 0 && checked.length < checks.length;
  }

  async function loadPropAgentFilter() {
    const sel = $('#propAgentFilter');
    if (!sel || sel.dataset.filled) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('agents')
        .select('id, full_name')
        .eq('status', 'activo')
        .order('full_name');
      if (error) throw error;
      sel.dataset.filled = '1';
      (data || []).forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.full_name;
        sel.appendChild(opt);
      });
      const bulkSel = $('#propBulkAgentSelect');
      if (bulkSel && !bulkSel.dataset.filled) {
        bulkSel.dataset.filled = '1';
        (data || []).forEach(a => {
          const opt = document.createElement('option');
          opt.value = a.id;
          opt.textContent = a.full_name;
          bulkSel.appendChild(opt);
        });
      }
    } catch (_) {}
  }

  /* ------------------------------------------------
     6. CLOUDINARY UPLOAD
     ------------------------------------------------ */
  async function uploadToCloudinary(file) {
    if (!window.BH_Cloudinary) throw new Error('BH_Cloudinary no disponible');
    return window.BH_Cloudinary.uploadImage(file, 'bienenhaus/properties');
  }

  function computeLeadScore(lead) {
    let score = 0;

    const sourceScores = { walkin: 15, referido: 13, tasacion: 12, chat: 10, ml: 8, landing: 6, manual: 4 };
    score += sourceScores[lead.source] || 4;

    if (lead.budget_usd > 0) score += 5;
    if (lead.budget_usd > 100000) score += 5;
    if (lead.budget_usd > 300000) score += 5;
    if (lead.budget_usd > 500000) score += 5;

    if (lead.phone || lead.whatsapp) score += 5;
    if (lead.email) score += 5;
    if (lead.full_name) score += 5;

    if (lead.preferred_type) score += 4;
    if (lead.preferred_zone) score += 4;
    if (lead.preferred_rooms) score += 3;
    if (lead.notes && lead.notes.length > 10) score += 5;

    const stageScores = { nuevo: 4, contactado: 8, visita: 14, oferta: 18, cerrado: 20, perdido: 2 };
    score += stageScores[lead.stage] || 4;

    if (lead.assigned_to) score += 3;
    if (lead.property_id) score += 2;

    return Math.min(100, Math.max(0, score));
  }


  window.__BH.loadProperties = loadProperties;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadProperties')) Object.defineProperty(window, 'loadProperties', { get: () => loadProperties, set: (v) => { loadProperties = v; }, configurable: true });
  window.__BH.updatePropBulkBar = updatePropBulkBar;
  if (!Object.prototype.hasOwnProperty.call(window, 'updatePropBulkBar')) Object.defineProperty(window, 'updatePropBulkBar', { get: () => updatePropBulkBar, set: (v) => { updatePropBulkBar = v; }, configurable: true });
  window.__BH.refreshPreviewBadges = refreshPreviewBadges;
  if (!Object.prototype.hasOwnProperty.call(window, 'refreshPreviewBadges')) Object.defineProperty(window, 'refreshPreviewBadges', { get: () => refreshPreviewBadges, set: (v) => { refreshPreviewBadges = v; }, configurable: true });
  window.__BH.setPreviewAsPortada = setPreviewAsPortada;
  if (!Object.prototype.hasOwnProperty.call(window, 'setPreviewAsPortada')) Object.defineProperty(window, 'setPreviewAsPortada', { get: () => setPreviewAsPortada, set: (v) => { setPreviewAsPortada = v; }, configurable: true });
  window.__BH._newImageFiles = _newImageFiles;
  if (!Object.prototype.hasOwnProperty.call(window, '_newImageFiles')) Object.defineProperty(window, '_newImageFiles', { get: () => _newImageFiles, set: (v) => { _newImageFiles = v; }, configurable: true });
  window.__BH.uploadToCloudinary = uploadToCloudinary;
  if (!Object.prototype.hasOwnProperty.call(window, 'uploadToCloudinary')) Object.defineProperty(window, 'uploadToCloudinary', { get: () => uploadToCloudinary, set: (v) => { uploadToCloudinary = v; }, configurable: true });
  window.__BH.computeLeadScore = computeLeadScore;
  if (!Object.prototype.hasOwnProperty.call(window, 'computeLeadScore')) Object.defineProperty(window, 'computeLeadScore', { get: () => computeLeadScore, set: (v) => { computeLeadScore = v; }, configurable: true });
  window.__BH.resetPropertyForm = resetPropertyForm;
  if (!Object.prototype.hasOwnProperty.call(window, 'resetPropertyForm')) Object.defineProperty(window, 'resetPropertyForm', { get: () => resetPropertyForm, set: (v) => { resetPropertyForm = v; }, configurable: true });
})();
