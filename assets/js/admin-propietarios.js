/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Propietarios
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, on, formatDateTimeWithTZ, validateForm, getAuthedClient, navigateTo, setKPI, refreshOwnerSelect, openModal, closeModal, showConfirmDialog, showInputPrompt, showToast, invalidateSearchCache, updateSidebarBadges, formatNumber, OwnerSchema, esc, mutate } = window.__BH || {};

  /* ------------------------------------------------
     11. OWNERS CRUD
     ------------------------------------------------ */
  let _ownersTrashMode = false;
  window.adminApp.toggleOwnersTrash = function () {
    _ownersTrashMode = !_ownersTrashMode;
    const btn = $('#ownerTrashToggle');
    if (btn) {
      btn.classList.toggle('is-active', _ownersTrashMode);
      btn.innerHTML = _ownersTrashMode ? '<i class="fas fa-arrow-left"></i> Volver a activos' : '<i class="fas fa-trash-can"></i> Papelera';
    }
    loadOwners();
  };

  async function loadOwners() {
    invalidateSearchCache();
    const tbody = $('#ownersTableBody');
    if (!tbody) return;
    const client = await getAuthedClient();
    if (!client) return;

    try {
      const q = client.from('owners').select('*');
      const { data: owners, error } = _ownersTrashMode
        ? await q.not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
        : await q.is('deleted_at', null).order('created_at', { ascending: true });

      if (error) throw error;

      /* Próxima tarea activa por propietario: una sola query (order asc por due_date) y map a owner_id */

      const { data: openTasks } = await client
        .from('owner_tasks')
        .select('owner_id, description, due_date')
        .in('status', ['pendiente', 'en_progreso'])
        .order('due_date', { ascending: true });

      const nextTaskByOwner = {};
      (openTasks || []).forEach(t => {
        if (!nextTaskByOwner[t.owner_id]) nextTaskByOwner[t.owner_id] = t;
      });

      /* Orden del padrón: próxima tarea más cercana a vencer primero (vencidas arriba de todo); sin tareas activas al final conservando el orden previo */

      (owners || []).sort((a, b) => {
        const ta = nextTaskByOwner[a.id] ? new Date(nextTaskByOwner[a.id].due_date).getTime() : Infinity;
        const tb = nextTaskByOwner[b.id] ? new Date(nextTaskByOwner[b.id].due_date).getTime() : Infinity;
        return ta - tb;
      });

      /* Load property counts per owner for KPIs */
      const { data: props } = await client
        .from('properties')
        .select('owner_id, price_usd, is_published');

      const ownerProps = {};
      const ownerPublishedValue = {};
      (props || []).forEach(p => {
        if (p.owner_id) {
          ownerProps[p.owner_id] = (ownerProps[p.owner_id] || 0) + 1;
          if (p.is_published) {
            ownerPublishedValue[p.owner_id] = (ownerPublishedValue[p.owner_id] || 0) + (p.price_usd || 0);
          }
        }
      });

      /* KPIs */
      const totalCount = (owners || []).length;
      const exclusiveCount = (owners || []).filter(o => o.exclusive).length;
      const exclusiveValue = (owners || [])
        .filter(o => o.exclusive)
        .reduce((sum, o) => sum + (ownerPublishedValue[o.id] || 0), 0);

      /* Expiring exclusivities (next 30 days) */
      const now = new Date();
      const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const expiringSoon = (owners || []).filter(o => o.exclusive && o.exclusive_end && new Date(o.exclusive_end) <= in30 && new Date(o.exclusive_end) >= now).length;
      const expiredExcl = (owners || []).filter(o => o.exclusive && o.exclusive_end && new Date(o.exclusive_end) < now).length;

      /* DNI/CUIT expiry alerts (next 90 days) */
      const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const dniExpiring = (owners || []).filter(o => o.dni_expiry && new Date(o.dni_expiry) <= in90 && new Date(o.dni_expiry) >= now).length;
      const dniExpired = (owners || []).filter(o => o.dni_expiry && new Date(o.dni_expiry) < now).length;
      const cuitExpiring = (owners || []).filter(o => o.cuit_expiry && new Date(o.cuit_expiry) <= in90 && new Date(o.cuit_expiry) >= now).length;
      const cuitExpired = (owners || []).filter(o => o.cuit_expiry && new Date(o.cuit_expiry) < now).length;

      setKPI('ownerKpiTotal', totalCount);
      setKPI('ownerKpiValue', 'USD ' + formatNumber(exclusiveValue));
      setKPI('ownerKpiExpiring', expiringSoon + expiredExcl);

      /* Update sidebar badge for expiring exclusivities + DNI/CUIT */
      const exclBadge = $('#sideBadgeOwners');
      const totalDocAlerts = dniExpiring + dniExpired + cuitExpiring + cuitExpired;
      const tasksOverdue = (openTasks || []).filter(t => new Date(t.due_date).getTime() < Date.now()).length;

      const totalAlerts = expiringSoon + expiredExcl + totalDocAlerts + tasksOverdue;
      if (exclBadge) {
        if (totalAlerts > 0) {
          exclBadge.textContent = (owners || []).length + ' Activos' + (totalAlerts > 0 ? ' · ' + totalAlerts + ' alertas' : '') + (tasksOverdue > 0 ? ' · ' + tasksOverdue + ' tareas vencidas' : '');
          exclBadge.style.color = tasksOverdue > 0 ? 'var(--danger)' : 'var(--warning)';
        } else {
          exclBadge.textContent = (owners || []).length + ' Activos';
          exclBadge.style.color = '';
        }
      }

      /* Show DNI/CUIT alerts in dashboard if any */
      const docAlertEl = $('#ownerDocAlert');
      if (docAlertEl && totalDocAlerts > 0) {
        docAlertEl.style.display = 'flex';
        docAlertEl.innerHTML = `
          <i class="fas fa-id-card"></i>
          <div>
            <h4>?? Documentos por vencer</h4>
            <p>${dniExpiring + cuitExpiring} DNI/CUIT vencen en =90 días${dniExpired + cuitExpired > 0 ? ' · ' + (dniExpired + cuitExpired) + ' vencidos' : ''}.</p>
          </div>
        `;
      } else if (docAlertEl) {
        docAlertEl.style.display = 'none';
      }

      if (_ownersTrashMode) {
        if (!owners?.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim);">La papelera está vacía</td></tr>';
          return;
        }
        tbody.innerHTML = owners.map(o => `
          <tr>
            <td><strong>${esc(o.full_name || 'Sin nombre')}</strong><br><small style="color:var(--text-dim);">${esc(o.dni_cuit || 'S/DNI')}</small></td>
            <td colspan="3" style="color:var(--text-dim);">Eliminado el ${o.deleted_at ? new Date(o.deleted_at).toLocaleDateString('es-AR') : '?'}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <button class="btn-action" title="Restaurar" onclick="window.adminApp.restoreOwner('${o.id}')"><i class="fas fa-rotate-left"></i></button>
              </div>
            </td>
          </tr>`).join('');
        return;
      }

      if (!owners?.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-dim);">No hay propietarios cargados</td></tr>';
        return;
      }

      tbody.innerHTML = owners.map(o => `
        <tr>
          <td>
            <div>
              <div style="font-weight:600; color:#fff; font-size:13px;">${esc(o.full_name || 'Sin nombre')}</div>
              <div style="color:var(--text-dim); font-size:11px;">${esc(o.dni_cuit || 'S/DNI')}</div>
            </div>
          </td>
          <td>
            <div style="font-size:13px;">${esc(o.phone || '-')}</div>
            <div style="color:var(--text-dim); font-size:11px;">${esc(o.email || '')}</div>
          </td>
          <td><span class="nav-badge" style="background:${o.exclusive ? 'rgba(31,200,195,0.15)' : 'rgba(255,255,255,0.06)'}; color:${o.exclusive ? 'var(--accent)' : 'var(--text-dim)'}; font-size:11px;">${o.exclusive ? 'Exclusivo' : 'Normal'}</span></td>
          <td>
${(() => { const t = nextTaskByOwner[o.id]; if (!t) return '<div style="font-size:12px; color:var(--text-dim);">—</div>'; const tl = fmtTaskTimeLeft(t.due_date); const chipColor = tl.overdue ? 'var(--danger)' : tl.soon ? 'var(--warning)' : 'var(--accent)'; return `<div style="font-size:12px; color:var(--text-main); font-weight:500;">${esc(t.description.length > 42 ? t.description.slice(0, 42) + '…' : t.description)}</div><div style="font-size:11px; font-weight:600; color:${chipColor}; margin-top:2px;"><i class="fas fa-clock" style="font-size:10px; margin-right:4px;"></i>${tl.text}</div>`; })()}

          </td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" title="Editar" onclick="window.adminApp.editOwner('${o.id}')"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteOwner('${o.id}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      logError('Owners error:', err);
    }
  }


  /* Create owner */
  on($('#btnNewOwner'), 'click', () => {
    editingOwnerId = null;
    $('#ownerForm')?.reset();
    const title = $('#ownerModalTitle');
    if (title) title.textContent = 'Expediente de Propietario';

    refreshOwnerTaskPrioAuto();
openModal('ownerModal');

  });

  on($('#btnAddOwnerInline'), 'click', () => {
    _ownerFormSourcePropertyModal = true;
    editingOwnerId = null;
    $('#ownerForm')?.reset();
    const title = $('#ownerModalTitle');
    if (title) title.textContent = 'Nuevo Propietario';
    openModal('ownerModal');
  });
  /* Save owner */
  on($('#ownerForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingOwner) return;
    _submittingOwner = true;
    const btn = $('#ownerSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const formData = new FormData(e.target);
      
      // Zod validation
      const validated = validateForm(OwnerSchema, formData);

      /* validación de formato CUIT/CUIL (Argentina): 11 dígitos */
      if (validated.dni_cuit && validated.dni_cuit.length >= 13) {
        const digits = validated.dni_cuit.replace(/\D/g, '');
        if (digits.length === 11) {
          const mult = [5,4,3,2,7,6,5,4,3,2];
          const sum = digits.slice(0, 10).split('').reduce((a, d, i) => a + (+d) * mult[i], 0);
          const checkDigit = 11 - (sum % 11);
          const expected = checkDigit === 11 ? 0 : checkDigit === 10 ? 9 : checkDigit;
          if (+digits[10] !== expected) throw new Error('CUIT/CUIL inválido (dígito verificador incorrecto)');
        }
      }

      /* dup check por DNI/CUIT solo si no estamos editando */
      if (!editingOwnerId && validated.dni_cuit) {
        const digits = validated.dni_cuit.replace(/\D/g, '');
        if (digits.length >= 7) {
          const last4 = digits.slice(-4);
          const cand = await window.supabaseClient.from('owners')
            .select('id, full_name')
            .is('deleted_at', null)
            .ilike('dni_cuit', '%' + last4 + '%')
            .limit(1);
          if (!cand.error && cand.data && cand.data.length) {
            throw new Error('Ya existe un propietario con DNI/CUIT similar: ' + cand.data[0].full_name);
          }
        }
      }

      /* commission_split: JSON válido o vacío */
      let splitJson = null;
      const splitRaw = (validated.commission_split || '').trim();
      if (splitRaw) {
        try {
          splitJson = JSON.parse(splitRaw);
        } catch (_) {
          throw new Error('Comisión Split: el JSON no es válido');
        }
      }

      const data = {
        full_name: validated.full_name,
        email: validated.email,
        phone: validated.phone,
        dni_cuit: validated.dni_cuit,
        address: validated.address,
        preferred_contact: validated.preferred_contact || 'whatsapp',
        bank_name: validated.bank_name || '',
        cbu_cvu: validated.cbu_cvu || '',
        alias_cbu: validated.alias_cbu || '',
        exclusive: validated.exclusive || false,
        exclusive_start: validated.exclusive_start || null,
        exclusive_end: validated.exclusive_end || null,
        commission_sale: validated.commission_sale ?? null,
        commission_rent: validated.commission_rent ?? null,
        commission_split: splitJson,
        contract_notes: validated.contract_notes || null,
        dni_expiry: validated.dni_expiry || null,
        cuit_expiry: validated.cuit_expiry || null,
        notes: validated.notes,
      };

      if (editingOwnerId) {
        await mutate('owners', async () => {
          const { error } = await window.supabaseClient.from('owners').update(data).eq('id', editingOwnerId);
          if (error) throw error;
        });
        showToast('Propietario actualizado', 'success');
      } else {
        await mutate('owners', async () => {
const { data: created, error } = await window.supabaseClient.from('owners').insert([data]).select('id').single();
          if (error) throw error;
          _createdOwnerId = created?.id || null;
        });
        showToast('Propietario creado', 'success');
      }
closeModal('ownerModal');

      if (_ownerFormSourcePropertyModal) {
        _ownerFormSourcePropertyModal = false;
        await refreshOwnerSelect($('#propOwnerSelect'), _createdOwnerId);
        _createdOwnerId = null;
      }

      loadOwners();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      _submittingOwner = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Expediente'; }
    }
  });

  /* Edit owner. Opción: initialTab (data/tasks/props/tasaciones/timeline/contract) */
  window.adminApp.editOwner = async function (id, initialTab) {
    try {
      const { data, error } = await window.supabaseClient.from('owners').select('*').eq('id', id).single();
      if (error) throw error;
      editingOwnerId = id;
      const form = $('#ownerForm');
      if (form) {
        form.elements.full_name.value = data.full_name || '';
        form.elements.email.value = data.email || '';
        form.elements.phone.value = data.phone || '';
        form.elements.dni_cuit.value = data.dni_cuit || '';
        form.elements.address.value = data.address || '';
        form.elements.preferred_contact.value = data.preferred_contact || 'whatsapp';
        form.elements.bank_name.value = data.bank_name || '';
        form.elements.cbu_cvu.value = data.cbu_cvu || '';
        form.elements.alias_cbu.value = data.alias_cbu || '';
        form.elements.exclusive.checked = data.exclusive || false;
        if (form.elements.exclusive_start) form.elements.exclusive_start.value = data.exclusive_start || '';
        if (form.elements.exclusive_end) form.elements.exclusive_end.value = data.exclusive_end || '';
        if (form.elements.commission_sale) form.elements.commission_sale.value = data.commission_sale ?? '';
        if (form.elements.commission_rent) form.elements.commission_rent.value = data.commission_rent ?? '';
        if (form.elements.commission_split) form.elements.commission_split.value = data.commission_split ? (typeof data.commission_split === 'string' ? data.commission_split : JSON.stringify(data.commission_split)) : '';
        if (form.elements.contract_notes) form.elements.contract_notes.value = data.contract_notes || '';
        if (form.elements.dni_expiry) form.elements.dni_expiry.value = data.dni_expiry || '';
        if (form.elements.cuit_expiry) form.elements.cuit_expiry.value = data.cuit_expiry || '';
        form.elements.notes.value = data.notes || '';
      }
      const title = $('#ownerModalTitle');
      if (title) {
        title.textContent = 'Editar Propietario';
        let contactRow = title.parentElement && title.parentElement.querySelector('.owner-contact-row');
        if (!contactRow) {
          contactRow = document.createElement('div');
          contactRow.className = 'owner-contact-row';
          contactRow.style.cssText = 'display:flex; gap:8px; margin:-6px 0 12px; flex-wrap:wrap;';
          title.parentElement.insertBefore(contactRow, title.nextSibling);
        }
        const wa = (window.BH_CRM && window.BH_CRM.waNumber) ? (window.BH_CRM.waNumber(data.phone) || window.BH_CRM.waNumber(data.whatsapp)) : null;
        const tel = (window.BH_CRM && window.BH_CRM.telNumber) ? window.BH_CRM.telNumber(data.phone) : (data.phone || null);
        contactRow.innerHTML =
          (wa ? '<a class="crm-contact-btn crm-contact-btn--wa" href="https://wa.me/' + wa + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> WhatsApp</a>' : '') +
          (tel ? '<a class="crm-contact-btn" href="tel:+' + tel + '"><i class="fas fa-phone"></i> Llamar</a>' : '') +
          (data.email ? '<a class="crm-contact-btn" href="mailto:' + esc(data.email) + '"><i class="fas fa-envelope"></i> Email</a>' : '');
        contactRow.style.display = contactRow.innerHTML ? 'flex' : 'none';
      }

      /* Reset tabs to first */
      $$('#ownerModal .owner-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('is-active', i === 0);
        btn.style.background = i === 0 ? 'rgba(31,200,195,0.15)' : 'none';
        btn.style.color = i === 0 ? 'var(--accent)' : 'var(--text-dim)';
      });
      $$('#ownerModal .owner-tab-content').forEach((c, i) => c.style.display = i === 0 ? 'block' : 'none');

      openModal('ownerModal');

      if (initialTab) {
        const tabBtn = document.querySelector('#ownerModal .owner-tab-btn[data-owner-tab="' + initialTab + '"]');
        if (tabBtn) tabBtn.click();
      }

      /* Load tab data in background */
      loadOwnerProperties(id);
      loadOwnerTasaciones(id);
      loadOwnerTimeline(id);

      loadOwnerTasks(id);

      refreshOwnerTaskPrioAuto();
    } catch (err) {
      showToast('Error al cargar propietario', 'error');
    }
  };

  /* Generate Portal Link for Owner */
  window.adminApp.generateOwnerPortalLink = async function() {

    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');

    if (!window.supabaseClient) return;

    try {

      /* El agente elige cuántos días el acceso queda válido */
      const daysStr = prompt('Días de validez del acceso del propietario (ej: 30, 90, 180)', '90');

      if (daysStr === null) return;

      const days = parseInt(daysStr, 10);

      if (!days || days < 1) { showToast('Duración inválida', 'error'); return; }

      /* Código corto legible: sin 0/O ni 1/I/L para no confundir leyendo por teléfono */
      const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

      const rnd = crypto.getRandomValues(new Uint8Array(5));

      let token = '';

      for (let i = 0; i < 5; i++) token += CHARS[rnd[i] % CHARS.length];

      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

      const { error } = await window.supabaseClient

        .from('owner_portal_tokens')

        .upsert([{

          owner_id: editingOwnerId,

          token: token,

          scopes: ['read_properties', 'read_commissions', 'read_documents'],

          expires_at: expiresAt,

          created_by: currentUser?.id || null

        }], { onConflict: 'owner_id' });

      if (error) throw error;

      const portalUrl = window.location.origin + '/portal-propietario.html?token=' + token;

      const msg = 'Código: ' + token + '  ·  Válido hasta: ' + new Date(expiresAt).toLocaleDateString('es-AR') + '. Link directo: ' + portalUrl;

      navigator.clipboard.writeText(msg).then(() => {

        showToast('Código copiado: ' + token, 'success', 8000);

      }).catch(() => {

        showToast('Código: ' + token + ' (copie manualmente)', 'info', 8000);

      });

    } catch (err) {

      showToast('Error: ' + err.message, 'error');

    }

  };

$('#btnGeneratePortalLink')?.addEventListener('click', window.adminApp.generateOwnerPortalLink);

  /* Owner Checklist */
  // react-doctor-disable-next-line supabase-client-owned-authz-field — created_by sale de auth del usuario logueado; RLS valida
  async function loadOwnerChecklist(ownerId) {
    const select = $('#checklistOperationType');
    const list = $('#ownerChecklistList');
    if (!select || !list) return;
    if (!window.supabaseClient) return;

    const type = select.value;
    try {
      const [reqRes, ownerRes] = await Promise.all([
        window.supabaseClient
          .from('document_requirements')
          .select('*')
          .eq('operation_type', type)
          .order('sort_order'),
        window.supabaseClient
          .from('owners')
          .select('documents')
          .eq('id', ownerId)
          .single()
      ]);

      const requirements = reqRes.data || [];
      const ownerDocs = ownerRes.data?.documents || [];

      if (!requirements.length) {
        list.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin requisitos configurados para este tipo</p>';
        return;
      }

      const doneCount = requirements.filter(req => ownerDocs.some(d => (d.document_key === req.document_key) || (d.name && d.name.toLowerCase().includes(req.document_key.toLowerCase())))).length;
      const pct = Math.round((doneCount / requirements.length) * 100);
      const barColor = pct === 100 ? 'var(--success)' : pct >= 60 ? 'var(--accent)' : 'var(--warning)';
      let barHtml = '<div style="margin-bottom:14px; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px;">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; font-size:12px;">' +
        '<span style="color:var(--text-dim);">Progreso del expediente</span>' +
        '<span style="color:' + barColor + '; font-weight:700;">' + doneCount + '/' + requirements.length + ' (' + pct + '%)</span>' +
        '</div>' +
        '<div style="height:6px; background:rgba(255,255,255,0.06); border-radius:999px; overflow:hidden;">' +
        '<div style="width:' + pct + '%; height:100%; background:' + barColor + '; transition:width .4s ease;"></div></div></div>';

      // pct/barColor vienen de números y mapa estático; no entran strings de usuario
      list.innerHTML = barHtml + requirements.map(req => {
        const hasDoc = ownerDocs.some(d => (d.document_key === req.document_key) || (d.name && d.name.toLowerCase().includes(req.document_key.toLowerCase())));
        const isMissing = req.is_mandatory && !hasDoc;
        let cls = 'check-done', label = 'Completo';
        if (isMissing) { cls = 'check-missing'; label = 'Falta (Obligatorio)'; }
        else if (!hasDoc) { cls = 'check-pending'; label = 'Pendiente'; }
        return `
          <div class="doc-item">
            <div class="doc-main">
              <div class="doc-icon other"><i class="fas ${getReqIcon(req.document_key)}"></i></div>
              <div class="doc-info">
                <div class="doc-name">${esc(req.label)}${req.is_mandatory ? ' <span style="color:#ef4444; font-size:10px;">*</span>' : ''}</div>
                <div class="doc-meta">${esc(req.description || '')}</div>
              </div>
            </div>
            <div class="doc-status">
              <span class="check-icon ${cls}"><i class="fas ${cls === 'check-done' ? 'fa-check' : cls === 'check-missing' ? 'fa-times' : 'fa-clock'}"></i></span>
              <span style="font-size:11px; color:var(--text-dim);">${label}</span>
            </div>
          </div>
        `;
      }).join('');
    } catch (_) {
      list.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:20px;">Error cargando checklist</p>';
    }
  }

  function getReqIcon(key) {
    const icons = {
      escritura: 'fa-file-signature',
      dni: 'fa-id-card',
      servicios: 'fa-file-invoice',
      planos: 'fa-drafting-compass',
      certificado_dominio: 'fa-certificate',
      inhibiciones: 'fa-gavel',
      plano_mensura: 'fa-ruler-combined',
      reglamento_copropiedad: 'fa-book',
      expensas: 'fa-receipt',
      libre_deuda: 'fa-check-circle'
    };
    return icons[key] || 'fa-file-alt';
  }

  $('#checklistOperationType')?.addEventListener('change', function() {
    if (editingOwnerId) loadOwnerChecklist(editingOwnerId);
  });

  /* Tab switching for owner modal */
  $$('#ownerModal .owner-tab-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const tab = this.dataset.ownerTab;
      $$('#ownerModal .owner-tab-btn').forEach(b => {
        b.classList.remove('is-active');
        b.style.background = 'none';
        b.style.color = 'var(--text-dim)';
      });
      this.classList.add('is-active');
      this.style.background = 'rgba(31,200,195,0.15)';
      this.style.color = 'var(--accent)';
      $$('#ownerModal .owner-tab-content').forEach(c => c.style.display = 'none');
      const target = $('#ownerTab-' + tab);
      if (target) target.style.display = 'block';
    });
  });

  /* Owner Tasks — CRM de seguimiento */

  const OWNER_TASK_TYPE_LABEL = { contact: 'Contacto', document: 'Documento', commission: 'Comisión', alert: 'Alerta', note: 'Nota' };
  const OWNER_TASK_CONTACT_LABEL = { telefono: 'Teléfono', whatsapp: 'WhatsApp', email: 'Mail' };
  const OWNER_TASK_PRIORITY_LABEL = { baja: 'Baja', media: 'Media', alta: 'Alta' };
  const OWNER_TASK_STATUS_LABEL = { pendiente: 'Pendiente', en_progreso: 'En progreso', completada: 'Completada', cancelada: 'Cancelada' };

  function fmtTaskDate(iso) {
    try {
      return new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return iso; }
  }

  function fmtTaskTimeLeft(iso) {
    const diff = new Date(iso).getTime() - Date.now();
    const abs = Math.abs(diff);
    const days = Math.floor(abs / 86400000);
    const hours = Math.floor((abs % 86400000) / 3600000);
    const mins = Math.floor((abs % 3600000) / 60000);
    const human = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    if (diff < 0) return { text: `Vencida hace ${human}`, overdue: true };
    if (diff < 24 * 3600000) return { text: `Vence hoy · ${human}`, soon: true };
    return { text: `Vence en ${human}`, soon: false };
  }

  async function loadOwnerTasks(ownerId) {
    const list = $('#ownerTasksList');
    if (!list || !window.supabaseClient || !ownerId) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('owner_tasks')
        .select('id, type, contact_type, description, due_date, status, priority, assigned_to, result_notes, agent:agents!assigned_to(full_name)')
        .eq('owner_id', ownerId)
        .order('due_date', { ascending: true });

      if (error) throw error;

      if (!data || !data.length) {
        list.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:14px;">Sin tareas registradas</p>';
        return;
      }

      data.sort((a, b) => {
        const done = t => ['completada', 'cancelada'].includes(t.status) ? 1 : 0;
        return done(a) - done(b) || new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      });

      list.innerHTML = data.map(t => {
        const isOverdue = ['pendiente', 'en_progreso'].includes(t.status) && new Date(t.due_date).getTime() < Date.now();
        const isDone = ['completada', 'cancelada'].includes(t.status);
        const priorityColor = t.priority === 'alta' ? 'var(--danger)' : t.priority === 'media' ? 'var(--warning)' : 'var(--accent)';
        return `
          <div style="display:flex; align-items:center; gap:10px; padding:8px 12px; margin-bottom:6px; background:rgba(255,255,255,0.02); border:1px solid ${isOverdue ? 'var(--danger)' : 'var(--border-subtle)'}; border-radius:9px; ${isDone ? 'opacity:0.55;' : ''}">
            <div style="flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span style="color:#fff; font-size:12.5px; font-weight:600; ${isDone ? 'text-decoration:line-through;' : ''}">${esc(t.description)}</span>
                ${isOverdue ? '<span style="font-size:10px; font-weight:700; color:var(--danger); background:var(--danger-bg); border-radius:999px; padding:1px 7px;">VENCIDA</span>' : ''}
              </div>
              <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:2px; font-size:11px; color:var(--text-dim);">
                <span>${esc(OWNER_TASK_TYPE_LABEL[t.type] || t.type)}</span>
                ${t.contact_type ? `<span>${esc(OWNER_TASK_CONTACT_LABEL[t.contact_type] || t.contact_type)}</span>` : ''}
                <span style="color:${priorityColor}; font-weight:600;">${esc(OWNER_TASK_PRIORITY_LABEL[t.priority] || t.priority)}</span>
                <span>Vence: ${fmtTaskDate(t.due_date)}</span>
                ${t.agent?.full_name ? `<span>→ ${esc(t.agent.full_name)}</span>` : ''}
                <span style="color:${isDone ? 'var(--success)' : 'var(--text-dim)'};">${esc(OWNER_TASK_STATUS_LABEL[t.status] || t.status)}</span>
              </div>
              ${t.result_notes ? `<div style="margin-top:5px; font-size:11.5px; line-height:1.4; color:var(--text-secondary); background:rgba(31,200,195,0.06); border-left:2px solid var(--accent); border-radius:0 6px 6px 0; padding:4px 9px;"><i class="fas fa-note-sticky" style="margin-right:6px; color:var(--accent); font-size:10px;"></i>${esc(t.result_notes)}</div>` : ''}
            </div>
            ${!isDone ? `
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button type="button" class="btn-icon btn-icon--accent" title="Completar" onclick="window.adminApp.completeOwnerTask('${t.id}')"><i class="fas fa-check"></i></button>
              <button type="button" class="btn-icon" title="Cancelar" onclick="window.adminApp.cancelOwnerTask('${t.id}')"><i class="fas fa-ban"></i></button>
              <button type="button" class="btn-icon" title="Eliminar" style="color:var(--danger);" onclick="window.adminApp.deleteOwnerTask('${t.id}')"><i class="fas fa-trash"></i></button>
            </div>` : ''}
          </div>
        `;
      }).join('');
    } catch (_) {
      list.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:20px;">Error cargando tareas</p>';
    }
  }

  /* Prioridad automática + recordatorio ligado para tareas de propietario.
     Mismo criterio que el panel del lead: urgente ≤24 h, alta ≤72 h, media ≤7 días, baja >7 días.
     El recordatorio solo ofrece opciones que entran dentro del tiempo restante. */
  function refreshOwnerTaskPrioAuto() {
    const dueInput = $('#ownerTaskDueDate');
    const prioInput = $('#ownerTaskPriority');
    const prioBadge = $('#ownerTaskPrioBadge');
    const prioText = $('#ownerTaskPrioText');
    const remSel = $('#ownerTaskRemind');
    const remHint = $('#ownerTaskRemindHint');
    const PRIO_META = {
      urgente: { text: 'Urgente (menos de 24 h)', cls: 'is-urgente' },
      alta: { text: 'Alta (menos de 3 días)', cls: 'is-alta' },
      media: { text: 'Media (menos de 7 días)', cls: 'is-media' },
      baja: { text: 'Baja (más de 7 días)', cls: 'is-baja' }
    };
    let h = null;
    if (dueInput && dueInput.value) {
      const t = new Date(dueInput.value).getTime();
      if (!isNaN(t)) h = (t - Date.now()) / 3600000;
    }
    const key = h == null ? null : (h <= 24 ? 'urgente' : h <= 72 ? 'alta' : h <= 168 ? 'media' : 'baja');
    if (prioInput) prioInput.value = key || 'media';
    if (prioBadge) {
      prioBadge.classList.remove('is-urgente', 'is-alta', 'is-media', 'is-baja');
      if (!key) {
        if (prioText) prioText.textContent = 'Se asigna según la fecha límite';
      } else {
        prioBadge.classList.add(PRIO_META[key].cls);
        if (prioText) prioText.textContent = PRIO_META[key].text;
      }
    }
    if (remSel) {
      const limitMin = h == null ? Infinity : Math.max(0, h * 60);
      let firstOk = null;
      Array.prototype.forEach.call(remSel.options, function (o) {
        const ok = parseInt(o.value, 10) <= limitMin;
        o.disabled = !ok;
        if (ok && firstOk == null) firstOk = o.value;
        if (ok) remSel.value = o.value; // quedarse con la opción más grande que todavía entra
      });
      if (!firstOk) {
        Array.prototype.forEach.call(remSel.options, function (o) { o.disabled = false; });
        remSel.value = '30';
      }
    }
    if (remHint) {
      const msg = h != null && h <= 0 ? 'La fecha ya venció: elegí una fecha futura.' : '';
      remHint.textContent = msg;
      remHint.style.display = msg ? '' : 'none';
    }
  }
  (function bindOwnerTaskPrio() {
    const dueInput = $('#ownerTaskDueDate');
    if (!dueInput) return;
    dueInput.addEventListener('change', refreshOwnerTaskPrioAuto);
    dueInput.addEventListener('input', refreshOwnerTaskPrioAuto);
  })();

  window.adminApp.createOwnerTask = async function () {
    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');
    if (!window.supabaseClient) return;

    const description = $('#ownerTaskDescription')?.value?.trim();
    const dueDateLocal = $('#ownerTaskDueDate')?.value;
    const type = 'contact';
    const contactType = $('#ownerTaskContactType')?.value || null;
    const priority = $('#ownerTaskPriority')?.value || 'media';
    const remindBefore = parseInt($('#ownerTaskRemind')?.value, 10) || 1440;

    if (!description) return showToast('Ingresá una descripción', 'warning');
    if (!dueDateLocal) return showToast('Ingresá la fecha límite', 'warning');

    // Dup-check: misma descripción para el mismo propietario el mismo día
    const dayStart = new Date(dueDateLocal); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dueDateLocal); dayEnd.setHours(23, 59, 59, 999);
    const { data: existingTask } = await window.supabaseClient
      .from('owner_tasks')
      .select('id')
      .eq('owner_id', editingOwnerId)
      .ilike('description', description)
      .gte('due_date', dayStart.toISOString())
      .lte('due_date', dayEnd.toISOString())
      .in('status', ['pendiente', 'en_progreso'])
      .limit(1)
      .maybeSingle();
    if (existingTask) {
      showToast('Esa tarea ya existe para este propietario ese día.', 'warning');
      return;
    }

    try {
      const { error } = await mutate('owner_tasks', () =>
        window.supabaseClient.from('owner_tasks').insert([{
          owner_id: editingOwnerId,
          description,
          type,
          contact_type: contactType,
          priority,
          due_date: new Date(dueDateLocal).toISOString(),
          remind_before_minutes: remindBefore,
          created_by: currentUser?.id || null
        }])
      );

      if (error) throw error;

      $('#ownerTaskDescription').value = '';
      $('#ownerTaskDueDate').value = '';
      $('#ownerTaskContactType').value = 'whatsapp';
      refreshOwnerTaskPrioAuto();

      showToast('Tarea creada', 'success');
      loadOwnerTasks(editingOwnerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.completeOwnerTask = async function (taskId) {
    if (!window.supabaseClient) return;
    const resultNotes = await showInputPrompt({
      title: 'Completar tarea',
      message: 'Nota de cierre (opcional):',
      icon: 'fas fa-check',
      placeholder: 'Ej: El propietario confirmó que envía la documentación...',
      confirmText: 'Completar'
    });
    if (resultNotes === null) return;

    try {
      const task = await mutate('owner_tasks', async () => {
        const { data, error } = await window.supabaseClient
          .from('owner_tasks')
          .update({ status: 'completada', result_notes: resultNotes || null })
          .eq('id', taskId)
          .select()
          .single();
        if (error) throw error;

        const { error: tlError } = await window.supabaseClient
          .from('owner_timeline_entries')
          .insert([{
            owner_id: data.owner_id,
            type: data.type,
            text: `Tarea completada: ${data.description}${resultNotes ? ' — ' + resultNotes : ''}`,
            created_by: currentUser?.id || null
          }]);
        if (tlError) throw tlError;

        return data;
      });

      showToast('Tarea completada', 'success');
      loadOwnerTasks(task.owner_id);
      loadOwnerTimeline(task.owner_id);
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.cancelOwnerTask = async function (taskId) {
    if (!window.supabaseClient) return;
    if (!(await showConfirmDialog({ title: 'Cancelar tarea', message: '¿Cancelar esta tarea?', icon: 'fas fa-ban', confirmText: 'Sí, cancelar', danger: true }))) return;

    try {
      await mutate('owner_tasks', () =>
        window.supabaseClient.from('owner_tasks').update({ status: 'cancelada' }).eq('id', taskId)
      );
      showToast('Tarea cancelada', 'success');
      if (editingOwnerId) loadOwnerTasks(editingOwnerId);
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.deleteOwnerTask = async function (taskId) {
    if (!window.supabaseClient) return;
    if (!(await showConfirmDialog({ title: 'Eliminar tarea', message: '¿Eliminar esta tarea? Esta acción no se puede deshacer.', icon: 'fas fa-trash', confirmText: 'Eliminar', danger: true }))) return;

    try {
      await mutate('owner_tasks', () =>
        window.supabaseClient.from('owner_tasks').delete().eq('id', taskId)
      );
      showToast('Tarea eliminada', 'success');
      if (editingOwnerId) loadOwnerTasks(editingOwnerId);
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };



  /* Owner Documents */
  async function loadOwnerDocuments(ownerId) {
    const el = $('#ownerDocsList');
    if (!el) return;
    if (!window.supabaseClient) return;
    try {
      const { data: owner } = await window.supabaseClient.from('owners').select('documents').eq('id', ownerId).single();
      const docs = (owner?.documents || []).sort((a, b) => new Date(b.uploaded_at || 0) - new Date(a.uploaded_at || 0));
      if (!docs.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin documentos cargados</p>';
        return;
      }
      el.innerHTML = docs.map(d => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:13px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <i class="fas fa-file-${d.type === 'pdf' ? 'pdf' : d.type === 'image' ? 'image' : 'alt'} ${getDocIcon(d.type)}" style="color:var(--accent); font-size:18px;"></i>
            <div>
              <div style="font-weight:500; color:#fff;">${esc(d.name || 'Documento')}</div>
              <div style="font-size:11px; color:var(--text-dim);">${d.type?.toUpperCase() || 'FILE'} · ${d.size ? (d.size / 1024).toFixed(1) + ' KB' : ''} · ${d.uploaded_at ? new Date(d.uploaded_at).toLocaleDateString('es-AR') : ''}${d.expiry ? ' · Vence: ' + new Date(d.expiry).toLocaleDateString('es-AR') : ''}</div>
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            ${d.url ? `<a href="${esc(d.url)}" target="_blank" class="btn-action" title="Ver"><i class="fas fa-eye"></i></a>` : ''}
            <button class="btn-action danger" title="Eliminar" onclick="window.adminApp.deleteOwnerDoc('${ownerId}', '${esc(d.id)}')"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      `).join('');
    } catch (_) { /* silent */ }
  }

  function getDocIcon(type) {
    if (!type) return '';
    if (type.includes('pdf')) return 'fa-file-pdf';
    if (type.includes('image') || type.includes('photo')) return 'fa-file-image';
    if (type.includes('word') || type.includes('doc')) return 'fa-file-word';
    return 'fa-file-alt';
  }

  window.adminApp.deleteOwnerDoc = async function (ownerId, docId) {
    if (!confirm('¿Eliminar este documento?')) return;
    try {
      const { data: owner } = await window.supabaseClient.from('owners').select('documents').eq('id', ownerId).single();
      const docs = (owner?.documents || []).filter(d => d.id !== docId);
      const { error } = await window.supabaseClient.from('owners').update({ documents: docs }).eq('id', ownerId);
      if (error) throw error;
      showToast('Documento eliminado', 'success');
      loadOwnerDocuments(ownerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Document upload handler */
  $('#btnAddOwnerDoc')?.addEventListener('click', async () => {
    if (!editingOwnerId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.heic';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) return showToast('Máx 10 MB', 'warning');
      try {
        const ext = file.name.split('.').pop();
        const path = `owners/${editingOwnerId}/${Date.now()}.${ext}`;
        const { error: upErr } = await window.supabaseClient.storage.from('documents').upload(path, file);
        if (upErr) throw upErr;
          const { data: urlData } = window.supabaseClient.storage.from('documents').getPublicUrl(path);
          const autoKey = (() => {
            const n = file.name.toLowerCase();
            const rules = [
              ['dni_frente', /^dni.*frente|frente.*dni/],
              ['dni_dorso', /dorso/],
              ['dni', /dni|documento/],
              ['cuit', /cuit|cuil/],
              ['escritura', /escritura|titulo/],
              ['contrato', /contrato/],
              ['reglamento', /reglamento/],
              ['plano', /plano/],
            ];
            for (const [key, re] of rules) { if (re.test(n)) return key; }
            return null;
          })();
          const doc = {
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type,
            size: file.size,
            url: urlData.publicUrl,
            uploaded_at: new Date().toISOString(),
            expiry: null,
            document_key: autoKey
          };
        const { data: owner } = await window.supabaseClient.from('owners').select('documents').eq('id', editingOwnerId).single();
        const docs = (owner?.documents || []).concat(doc);
        await window.supabaseClient.from('owners').update({ documents: docs }).eq('id', editingOwnerId);
        showToast('Documento subido', 'success');
        loadOwnerDocuments(editingOwnerId);
      } catch (err) {
        showToast('Error subiendo: ' + err.message, 'error');
      }
    };
    input.click();
  });
/* Property Documents */

  const PROPERTY_DOC_TYPES = [

    { key: 'dni_frente', label: 'DNI Titular · Frente', icon: 'fa-id-card' },

    { key: 'dni_dorso', label: 'DNI Titular · Dorso', icon: 'fa-id-card' },

    { key: 'escritura', label: 'Escritura', icon: 'fa-file-signature' },

    { key: 'rentas_provincial', label: 'Rentas Provincial', icon: 'fa-file-invoice' },

    { key: 'tasa_municipal', label: 'Tasa Municipal', icon: 'fa-city' },

    { key: 'planos_aprobados', label: 'Planos Aprobados', icon: 'fa-drafting-compass' },

    { key: 'factura_luz', label: 'Factura de Luz', icon: 'fa-bolt' },

    { key: 'factura_gas', label: 'Factura de Gas', icon: 'fa-fire' },

    { key: 'factura_agua', label: 'Factura de Agua', icon: 'fa-tint' },

    { key: 'expensas', label: 'Expensas', icon: 'fa-receipt' },

    { key: 'autorizacion_venta', label: 'Autorización de Venta', icon: 'fa-file-signature' },

    { key: 'reserva', label: 'Reserva', icon: 'fa-handshake' }

  ];



  function propertyDocStateMarkup(doc) {

    return doc

      ? '<span class="status-pill active" style="font-size:10px; padding:3px 8px;">Subido</span>'

      : '<span class="status-pill pending" style="font-size:10px; padding:3px 8px;">Falta</span>';

  }



  function propertyDocMetaMarkup(doc) {

    if (!doc) return '<div style="font-size:11px; color:var(--text-dim);">Sin archivo cargado</div>';

    const size = doc.size ? (doc.size / 1024).toFixed(1) + ' KB' : '';

    const date = doc.uploaded_at ? ' · ' + new Date(doc.uploaded_at).toLocaleDateString('es-AR') : '';

    return `<div style="font-size:11px; color:var(--text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(doc.name)} · ${size}${date}</div>`;

  }



  async function loadPropertyDocs(propertyId) {

    const el = $('#propertyDocsChecklist');

    if (!el) return;

    if (!window.supabaseClient) return;

    if (!propertyId) {

      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Guardá la propiedad para gestionar la documentación</p>';

      return;

    }

    try {

      const { data, error } = await window.supabaseClient

        .from('property_documents')

        .select('*')

        .eq('property_id', propertyId);

      if (error) throw error;

      const byKey = {};

      (data || []).forEach(d => { byKey[d.document_key] = d; });

      const uploaded = (data || []).length;

      const header = document.querySelector('#propertyDocsSection h4');

      if (header) header.textContent = `Documentación de la Propiedad (${uploaded}/${PROPERTY_DOC_TYPES.length})`;

      el.innerHTML = PROPERTY_DOC_TYPES.map(t => {

        const doc = byKey[t.key];

        const actions = doc

          ? '<a href="#" class="btn-action" title="Ver" onclick="event.preventDefault(); window.adminApp.openPropertyDoc(\'' + propertyId + '\', \'' + t.key + '\')"><i class="fas fa-eye"></i></a>' +

            '<button type="button" class="btn-action danger" title="Eliminar" onclick="window.adminApp.deletePropertyDoc(\'' + propertyId + '\', \'' + t.key + '\')"><i class="fas fa-trash"></i></button>'

          : '';

        const uploadBtn = '<button type="button" class="btn-action" title="' + (doc ? 'Reemplazar' : 'Subir') + '" onclick="window.adminApp.uploadPropertyDoc(\'' + propertyId + '\', \'' + t.key + '\')"><i class="fas fa-upload"></i></button>';

        return `

          <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:13px;">

            <div style="display:flex; align-items:center; gap:10px; min-width:0;">

              <i class="fas ${t.icon}" style="color:var(--accent); font-size:16px; flex-shrink:0;"></i>

              <div style="min-width:0;">

                <div style="font-weight:500; color:#fff;">${esc(t.label)}</div>

                ${propertyDocMetaMarkup(doc)}

              </div>

            </div>

            <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">

              ${propertyDocStateMarkup(doc)}

              ${actions}

              ${uploadBtn}

            </div>

          </div>

        `;

      }).join('');

    } catch (err) {

      showToast('Error al cargar documentación', 'error');

    }

  }



  window.adminApp.uploadPropertyDoc = async function (propertyId, key) {

    if (!propertyId) return;

    const input = document.createElement('input');

    input.type = 'file';

    input.accept = '.pdf,.jpg,.jpeg,.png,.heic,.webp';

    input.onchange = async () => {

      const file = input.files[0];

      if (!file) return;

      if (file.size > 10 * 1024 * 1024) return showToast('Máx 10 MB', 'warning');

      try {

        const ext = file.name.split('.').pop();

        const path = `properties/${propertyId}/${key}-${Date.now()}.${ext}`;

        const { error: upErr } = await window.supabaseClient.storage.from('property-documents').upload(path, file);

        if (upErr) throw upErr;

        const { error: insErr } = await window.supabaseClient.from('property_documents').upsert({

          property_id: propertyId,

          document_key: key,

          name: file.name,

          type: file.type,

          size: file.size,

          storage_path: path,

          created_by: currentUser?.id || null

        }, { onConflict: 'property_id,document_key' });

        if (insErr) throw insErr;

        showToast('Documento subido', 'success');

        loadPropertyDocs(propertyId);

      } catch (err) {

        showToast('Error subiendo: ' + err.message, 'error');

      }

    };

    input.click();

  };



  window.adminApp.openPropertyDoc = async function (propertyId, key) {

    try {

      const { data: doc } = await window.supabaseClient

        .from('property_documents')

        .select('storage_path')

        .eq('property_id', propertyId)

        .eq('document_key', key)

        .single();

      if (!doc?.storage_path) return showToast('Documento no encontrado', 'warning');

      const { data: signed } = await window.supabaseClient.storage

        .from('property-documents')

        .createSignedUrl(doc.storage_path, 3600);

      if (signed?.signedUrl) window.open(signed.signedUrl, '_blank', 'noopener');

      else showToast('No se pudo generar el enlace', 'warning');

    } catch (err) {

      showToast('Error: ' + err.message, 'error');

    }

  };



  window.adminApp.deletePropertyDoc = async function (propertyId, key) {

    if (!confirm('¿Eliminar este documento?')) return;

    try {

      const { data: doc } = await window.supabaseClient

        .from('property_documents')

        .select('id, storage_path')

        .eq('property_id', propertyId)

        .eq('document_key', key)

        .single();

      if (!doc) return;

      if (doc.storage_path) {

        await window.supabaseClient.storage.from('property-documents').remove([doc.storage_path]);

      }

      const { error } = await window.supabaseClient.from('property_documents').delete().eq('id', doc.id);

      if (error) throw error;

      showToast('Documento eliminado', 'success');

      loadPropertyDocs(propertyId);

    } catch (err) {

      showToast('Error: ' + err.message, 'error');

    }

  };




  /* Notas internas de la propiedad */
  function pendingPropertyNoteMarkup(text) {
    return '<div style="padding:10px 12px; background:rgba(31,200,195,0.06); border:1px dashed var(--accent); border-radius:10px; margin-bottom:8px; font-size:13px;">'
      + '<span style="font-size:11px; color:var(--accent); font-weight:600;">Pendiente de guardar</span>'
      + '<div style="white-space:pre-wrap; word-break:break-word; color:#fff; margin-top:4px;">' + esc(text) + '</div>'
      + '</div>';
  }

  function propertyNoteMarkup(note, author) {
    return '<div style="padding:10px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:10px; margin-bottom:8px; font-size:13px;">'
      + '<div style="display:flex; justify-content:space-between; gap:8px; margin-bottom:4px;">'
      + '<span style="font-size:11px; color:var(--accent); font-weight:600;">' + esc(author) + '</span>'
      + '<span style="font-size:11px; color:var(--text-dim);">' + esc(formatDateTimeWithTZ(note.created_at)) + '</span>'
      + '</div>'
      + '<div style="white-space:pre-wrap; word-break:break-word; color:#fff;">' + esc(note.note) + '</div>'
      + '</div>';
  }

  function renderPendingPropertyNotes() {
    const listEl = $('#propertyNotesList');
    if (!listEl) return;
    if (!_pendingPropertyNotes.length) {
      listEl.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:16px;">Todavía no hay notas</p>';
      return;
    }
    listEl.innerHTML = _pendingPropertyNotes.map(pendingPropertyNoteMarkup).join('');
  }

  async function loadPropertyHistory(propertyId) {
    const section = $('#propertyHistorySection');
    const listEl = $('#propertyHistoryList');
    if (!section || !listEl) return;
    if (!propertyId) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    listEl.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:12px;"><i class="fas fa-spinner fa-spin"></i> Cargando historial...</p>';
    try {
      const { data, error } = await window.supabaseClient
        .from('audit_log')
        .select('action, changed_fields, status, created_at, user_id')
        .eq('record_id', propertyId)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      if (!data || !data.length) {
        listEl.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:12px;">Sin cambios registrados</p>';
        return;
      }
      const userIds = [...new Set(data.map(function(a) { return a.user_id; }).filter(Boolean))];
      let nameMap = {};
      if (userIds.length) {
        const pres = await window.supabaseClient.from('profiles').select('id, full_name').in('id', userIds);
        if (!pres.error && pres.data) nameMap = Object.fromEntries(pres.data.map(function(p) { return [p.id, p.full_name || '']; }));
      }
      const VERB = { insert: 'Creó', create: 'Creó', update: 'Editó', delete: 'Eliminó', update_sensitive: 'Modificó (sensible)' };
      listEl.innerHTML = data.map(function(a) {
        const who = a.user_id ? (nameMap[a.user_id] || '') : '';
        const whoTxt = who ? ' · ' + esc(who) : '';
        const dt = formatDateTimeWithTZ ? formatDateTimeWithTZ(a.created_at) : new Date(a.created_at).toLocaleString('es-AR');
        const changes = (a.changed_fields || []).filter(function(f) { return f !== 'updated_at'; });
        const changesTxt = changes.length ? ' <span style="color:var(--text-dim);">(' + esc(changes.join(', ')) + ')</span>' : '';
        const failed = a.status && a.status !== 'success' && a.status !== 'ok';
        return '<div style="padding:8px 10px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:6px; font-size:12px; color:#fff;' + (failed ? ' border-left:3px solid var(--danger);' : '') + '">'
          + '<strong>' + esc(VERB[a.action] || a.action) + '</strong>' + changesTxt
          + '<div style="color:var(--text-dim); font-size:11px; margin-top:2px;">' + esc(dt) + esc(whoTxt) + '</div>'
          + '</div>';
      }).join('');
    } catch (err) {
      logError('loadPropertyHistory error:', err);
      listEl.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:12px;">Historial no disponible</p>';
    }
  }

  async function loadPropertyNotes(propertyId) {
    const listEl = $('#propertyNotesList');
    if (!listEl) return;
    _pendingPropertyNotes = [];
    if (!propertyId) { renderPendingPropertyNotes(); return; }
    try {
      const { data: notes, error } = await window.supabaseClient
        .from('property_notes')
        .select('*')
        .eq('property_id', propertyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!notes || !notes.length) { renderPendingPropertyNotes(); return; }
      const userIds = [...new Set(notes.map(n => n.created_by).filter(Boolean))];
      let nameMap = {};
      if (userIds.length) {
        const { data: profiles, error: pErr } = await window.supabaseClient
          .from('profiles')
          .select('id, full_name')
          .in('id', userIds);
        if (!pErr && profiles) nameMap = Object.fromEntries(profiles.map(p => [p.id, p.full_name || '']));
      }
      listEl.innerHTML = notes.map(n =>
        propertyNoteMarkup(n, n.created_by ? (nameMap[n.created_by] || 'Usuario') : 'Usuario')
      ).join('');
    } catch (err) {
      logError('loadPropertyNotes error:', err);
      renderPendingPropertyNotes();
    }
  }

  async function flushPendingPropertyNotes(propertyId) {
    const notes = _pendingPropertyNotes.splice(0, _pendingPropertyNotes.length);
    if (!notes.length || !propertyId) return;
    try {
      const { error } = await window.supabaseClient
        .from('property_notes')
        .insert(notes.map(text => ({
          property_id: propertyId,
          note: text,
          created_by: (currentUser && currentUser.id) ? currentUser.id : null,
        })));
      if (error) throw error;
    } catch (err) {
      logError('flushPendingPropertyNotes error:', err);
      showToast('La propiedad se creó, pero falló al guardar las notas', 'error');
    }
  }

  on($('#propertyNoteAddBtn'), 'click', async () => {
    const input = $('#propertyNoteInput');
    const text = input && input.value ? input.value.trim() : '';
    if (!text) {
      showToast('Escribí una nota antes de guardarla', 'warning');
      return;
    }
    if (input) input.value = '';
    if (!editingPropertyId) {
      _pendingPropertyNotes.push(text);
      renderPendingPropertyNotes();
      return;
    }
    try {
      const { error } = await window.supabaseClient
        .from('property_notes')
        .insert([{ property_id: editingPropertyId, note: text, created_by: (currentUser && currentUser.id) ? currentUser.id : null }]);
      if (error) throw error;
      showToast('Nota agregada', 'success');
      loadPropertyNotes(editingPropertyId);
    } catch (err) {
      logError('propiedad nota error:', err);
      showToast('No se pudo guardar la nota', 'error');
    }
  });

  /* Owner Properties */

  async function loadOwnerProperties(ownerId) {
    const el = $('#ownerPropsList');
    if (!el) return;
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('id, property_code, title, status, price_usd, price_currency, zone, created_at')
        .eq('owner_id', ownerId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!data?.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin propiedades vinculadas</p>';
        return;
      }
      el.innerHTML = data.map(p => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:13px;">
          <div>
            <div style="font-weight:500; color:#fff;">${esc(p.property_code || 'S/Código')} · ${esc(p.title || 'Sin título')}</div>
            <div style="font-size:11px; color:var(--text-dim);">${esc(p.zone || 'S/Zona')} · ${p.price_usd ? 'USD ' + formatNumber(p.price_usd) : 'S/Precio'} · ${esc(p.status || 'draft')}</div>
          </div>
          <button class="btn-action" title="Ver Propiedad" onclick="window.adminApp.editProperty('${p.id}')"><i class="fas fa-external-link-alt"></i></button>
        </div>
      `).join('');
    } catch (_) { /* silent */ }
  }

  /* Owner Tasaciones */
  async function loadOwnerTasaciones(ownerId) {
    const el = $('#ownerTasacionesList');
    if (!el) return;
    if (!window.supabaseClient) return;
    try {
      const { data: ownProps } = await window.supabaseClient
        .from('properties')
        .select('id, property_code, title')
        .eq('owner_id', ownerId)
        .is('deleted_at', null);
      const ownPropIds = new Set((ownProps || []).map(p => p.id));
      let q = window.supabaseClient
        .from('tasaciones')
        .select('id, type, status, valuation_usd, created_at, expires_at, property_id, owner_id, title')
        .order('created_at', { ascending: false });
      q = ownPropIds.size
        ? q.or(`owner_id.eq.${ownerId},property_id.in.(${[...ownPropIds].join(',')})`)
        : q.eq('owner_id', ownerId);
      const { data, error } = await q;
      if (error) throw error;
      const propMap = {};
      (ownProps || []).forEach(p => { propMap[p.id] = p; });
      const foreignPropIds = [...new Set((data || []).map(t => t.property_id).filter(id => id && !propMap[id]))];
      if (foreignPropIds.length) {
        const { data: fprops } = await window.supabaseClient
          .from('properties')
          .select('id, property_code, title')
          .in('id', foreignPropIds);
        (fprops || []).forEach(p => { propMap[p.id] = p; });
      }
      const rows = (data || []).map(t => ({ ...t, properties: propMap[t.property_id] || null, _direct: t.owner_id === ownerId }));
      if (!rows.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin tasaciones registradas</p>';
        return;
      }
      el.innerHTML = rows.map(t => {
        const originBadge = t._direct
          ? '<span style="font-size:10px; font-weight:700; color:var(--accent); background:rgba(31,200,195,0.12); border-radius:999px; padding:1px 8px; margin-left:6px;">Directa</span>'
          : '<span style="font-size:10px; font-weight:700; color:var(--warning); background:rgba(255,184,0,0.12); border-radius:999px; padding:1px 8px; margin-left:6px;" title="Vinculada porque la propiedad es de este propietario">Por propiedad</span>';
        const unlinkBtn = t._direct
          ? `<button class="btn-action" title="Desvincular del propietario" onclick="window.adminApp.unlinkTasacion('${ownerId}', '${t.id}')"><i class="fas fa-link-slash"></i></button>`
          : '';
        return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:13px;">
          <div>
            <div style="font-weight:500; color:#fff;">${esc(t.type)} · ${esc(t.properties?.title || t.properties?.property_code || t.title || 'Propiedad')}${originBadge}</div>
            <div style="font-size:11px; color:var(--text-dim);">USD ${t.valuation_usd ? formatNumber(t.valuation_usd) : '—'} · ${esc(t.status)} · ${t.created_at ? new Date(t.created_at).toLocaleDateString('es-AR') : ''}${t.expires_at ? ' · Vence: ' + new Date(t.expires_at).toLocaleDateString('es-AR') : ''}</div>
          </div>
          <div style="display:flex; gap:6px;">
            ${unlinkBtn}
            <button class="btn-action" title="Ver Tasación" onclick="window.adminApp.editTasacion?.('${t.id}')"><i class="fas fa-external-link-alt"></i></button>
          </div>
        </div>`;
      }).join('');
    } catch (err) {
      logError('loadOwnerTasaciones error:', err);
      el.innerHTML = '<p style="color:var(--danger); font-size:12px; text-align:center; padding:20px;">Error cargando tasaciones</p>';
    }
  }

  window.adminApp.editTasacion = function (id) {
    closeModal('ownerModal');
    navigateTo('tab-tasaciones');
    showTasacionEditor(id, '');
  };

  window.adminApp.unlinkTasacion = async function (ownerId, tasacionId) {
    if (!confirm('¿Desvincular esta tasación del propietario? La tasación no se borra; si tiene propiedad de este propietario seguirá apareciendo "Por propiedad".')) return;
    try {
      const { error } = await window.supabaseClient.from('tasaciones').update({ owner_id: null }).eq('id', tasacionId);
      if (error) throw error;
      showToast('Tasación desvinculada', 'success');
      loadOwnerTasaciones(ownerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  let _tasacionOwnerCtx = null;
  window.adminApp.createTasacionForOwner = async function (ownerId) {
    const propSelect = $('#tasaProperty');
    const ownerSelect = $('#tasaOwner');
    if (!propSelect || !ownerSelect || !window.supabaseClient) return;
    _tasacionOwnerCtx = ownerId || null;
    try {
      const [propsRes, ownerRes] = await Promise.all([
        window.supabaseClient.from('properties').select('id, property_code, title').eq('owner_id', ownerId).is('deleted_at', null).order('property_code'),
        window.supabaseClient.from('owners').select('id, full_name').eq('id', ownerId).single()
      ]);
      propSelect.innerHTML = '<option value="">Sin vincular</option>' +
        (propsRes.data || []).map(p => '<option value="' + esc(p.id) + '">' + esc(p.property_code || '') + ' - ' + esc(p.title || '') + '</option>').join('');
      const o = ownerRes.data;
      ownerSelect.innerHTML = o
        ? '<option value="' + esc(o.id) + '">' + esc(o.full_name || '') + '</option>'
        : '<option value="">Sin propietario</option>';
      ownerSelect.disabled = !!o;
      _tasacionOwnerCtx = o ? o.id : null;
    } catch (err) {
      showToast('No se pudieron cargar los datos: ' + err.message, 'error');
      return;
    }
    openModal('newTasacionModal');
  };

  on($('#ownerTasaNewBtn'), 'click', () => {
    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');
    window.adminApp.createTasacionForOwner(editingOwnerId);
  });
  on($('#ownerTasaLinkBtn'), 'click', () => {
    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');
    openLinkTasacionModal(editingOwnerId);
  });

  let _linkTasacionOwnerId = null;
  function openLinkTasacionModal(ownerId) {
    _linkTasacionOwnerId = ownerId;
    const search = $('#linkTasacionSearch');
    const includeLinked = $('#linkTasacionIncludeLinked');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      let debounce;
      search.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => loadTasacionLinkCandidates(_linkTasacionOwnerId), 300);
      });
      includeLinked?.addEventListener('change', () => loadTasacionLinkCandidates(_linkTasacionOwnerId));
    }
    if (search) search.value = '';
    if (includeLinked) includeLinked.checked = false;
    openModal('linkTasacionModal');
    loadTasacionLinkCandidates(ownerId);
  }

  async function loadTasacionLinkCandidates(ownerId) {
    const box = $('#linkTasacionResults');
    if (!box || !window.supabaseClient) return;
    const search = ($('#linkTasacionSearch')?.value || '').trim();
    const includeLinked = !!$('#linkTasacionIncludeLinked')?.checked;
    box.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:16px;">Buscando...</p>';
    try {
      const { data: ownProps } = await window.supabaseClient
        .from('properties')
        .select('id, property_code, title')
        .eq('owner_id', ownerId)
        .is('deleted_at', null);
      const ownPropIds = new Set((ownProps || []).map(p => p.id));
      let q = window.supabaseClient
        .from('tasaciones')
        .select('id, title, type, status, valuation_usd, created_at, owner_id, property_id')
        .order('created_at', { ascending: false })
        .limit(30);
      q = includeLinked ? q.neq('owner_id', ownerId) : q.is('owner_id', null);
      if (search) q = q.ilike('title', '%' + search.replace(/[%_]/g, ' ') + '%');
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []).filter(t => t.owner_id !== ownerId);
      rows.sort((a, b) => Number(b.property_id && ownPropIds.has(b.property_id)) - Number(a.property_id && ownPropIds.has(a.property_id)));
      if (!rows.length) {
        box.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:16px;">Sin tasaciones disponibles para vincular.</p>';
        return;
      }
      const propIds = [...new Set(rows.map(t => t.property_id).filter(Boolean))];
      let propMap = {};
      if (propIds.length) {
        const { data: props } = await window.supabaseClient.from('properties').select('id, property_code, title, owner_id').in('id', propIds);
        (props || []).forEach(p => { propMap[p.id] = p; });
      }
      const ownerIds = [...new Set(rows.map(t => t.owner_id).filter(Boolean))];
      let ownerMap = {};
      if (ownerIds.length) {
        const { data: owners } = await window.supabaseClient.from('owners').select('id, full_name').in('id', ownerIds);
        (owners || []).forEach(o => { ownerMap[o.id] = o; });
      }
      box.innerHTML = rows.map(t => {
        const detected = t.property_id && ownPropIds.has(t.property_id);
        const reassigned = !!t.owner_id;
        const p = t.property_id ? propMap[t.property_id] : null;
        const badges = [];
        if (detected) badges.push('<span style="font-size:10px; font-weight:700; color:var(--accent); background:rgba(31,200,195,0.12); border-radius:999px; padding:1px 8px; margin-left:6px;">Detectada por propiedad</span>');
        if (reassigned) badges.push('<span style="font-size:10px; font-weight:700; color:var(--warning); background:rgba(255,184,0,0.12); border-radius:999px; padding:1px 8px; margin-left:6px;" title="Actualmente vinculada a ' + esc(ownerMap[t.owner_id]?.full_name || 'otro propietario') + '">Se reasignará</span>');
        return '<button type="button" data-link-tasacion="' + esc(t.id) + '" style="display:block; width:100%; text-align:left; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; cursor:pointer; color:#fff;">' +
          '<div style="font-weight:500; font-size:12.5px;">' + esc(t.title || t.type || 'Tasación') + badges.join('') + '</div>' +
          '<div style="font-size:11px; color:var(--text-dim);">' + esc(t.status) + (p ? ' · ' + esc(p.property_code || p.title || '') : '') + (t.created_at ? ' · ' + new Date(t.created_at).toLocaleDateString('es-AR') : '') + '</div>' +
          '</button>';
      }).join('');
      box.querySelectorAll('[data-link-tasacion]').forEach(btn => {
        btn.addEventListener('click', () => {
          const t = rows.find(x => x.id === btn.dataset.linkTasacion);
          if (t) linkTasacionToOwner(ownerId, t, propMap);
        });
      });
    } catch (err) {
      box.innerHTML = '<p style="color:var(--danger); font-size:12px; text-align:center; padding:16px;">Error: ' + esc(err.message) + '</p>';
    }
  }

  async function linkTasacionToOwner(ownerId, t, propMap) {
    const prop = t.property_id ? (propMap || {})[t.property_id] : null;
    if (prop && prop.owner_id && prop.owner_id !== ownerId) {
      if (!confirm('La propiedad "' + (prop.title || prop.property_code || '') + '" pertenece a otro propietario. ¿Vincular la tasación igualmente?')) return;
    } else if (t.owner_id && t.owner_id !== ownerId) {
      if (!confirm('Esta tasación ya está vinculada a otro propietario. ¿Reasignarla?')) return;
    }
    try {
      const { error } = await window.supabaseClient.from('tasaciones').update({ owner_id: ownerId }).eq('id', t.id);
      if (error) throw error;
      showToast('Tasación vinculada', 'success');
      closeModal('linkTasacionModal');
      loadOwnerTasaciones(ownerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  /* Owner Timeline */
  async function loadOwnerTimeline(ownerId) {
    const el = $('#ownerTimelineList');
    if (!el) return;
    if (!window.supabaseClient) return;
    try {
      const { data: timeline, error } = await window.supabaseClient
        .from('owner_timeline_entries')
        .select('id, type, text, created_at')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!timeline?.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px; text-align:center; padding:20px;">Sin comunicaciones registradas</p>';
        return;
      }
      el.innerHTML = timeline.map(entry => `
        <div style="display:flex; gap:10px; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:8px; margin-bottom:8px; font-size:12px;">
          <div style="width:32px; height:32px; border-radius:50%; background:rgba(31,200,195,0.15); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            <i class="fas ${getTimelineIcon(entry.type)}" style="color:var(--accent); font-size:12px;"></i>
          </div>
          <div style="flex:1;">
            <div style="font-weight:500; color:#fff;">${esc(entry.text || '')}</div>
            <div style="font-size:10px; color:var(--text-dim);">${(entry.type || 'note').toUpperCase()} · ${entry.created_at ? new Date(entry.created_at).toLocaleString('es-AR') : ''}</div>
          </div>
          <button class="btn-action" title="Eliminar" onclick="window.adminApp.deleteTimelineEntry('${ownerId}', '${entry.id}')"><i class="fas fa-trash" style="font-size:10px;"></i></button>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = '<p style="color:var(--danger); text-align:center; padding:20px;">Error cargando timeline</p>';
    }
  }

  function getTimelineIcon(type) {
    const icons = { note: 'fa-sticky-note', whatsapp: 'fa-whatsapp', email: 'fa-envelope', call: 'fa-phone', meeting: 'fa-handshake' };
    return icons[type] || 'fa-comment';
  }

  window.adminApp.deleteTimelineEntry = async function (ownerId, entryId) {
    if (!confirm('¿Eliminar esta entrada?')) return;
    try {
      const { error } = await window.supabaseClient.from('owner_timeline_entries').delete().eq('id', entryId);
      if (error) throw error;
      showToast('Entrada eliminada', 'success');
      loadOwnerTimeline(ownerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  /* Add timeline entry */
  $('#btnAddTimelineEntry')?.addEventListener('click', async () => {
    const text = $('#ownerTimelineNote')?.value?.trim();
    const type = $('#ownerTimelineType')?.value || 'note';
    if (!text) return showToast('Ingresá una nota', 'warning');
    if (!editingOwnerId) return showToast('Primero guarde el propietario', 'warning');
    try {
      const { error } = await window.supabaseClient
        .from('owner_timeline_entries')
        .insert([{ owner_id: editingOwnerId, type, text, created_by: currentUser?.id || null }]);
      if (error) throw error;
      $('#ownerTimelineNote').value = '';
      showToast('Comunicación agregada', 'success');
      loadOwnerTimeline(editingOwnerId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  /* Delete owner */
  window.adminApp.deleteOwner = async function (id) {
    let conProps = 0;
    try {
      const { count } = await window.supabaseClient.from('properties').select('id', { count: 'exact', head: true }).eq('owner_id', id).is('deleted_at', null);
      conProps = count || 0;
    } catch (_) {}
    const extra = conProps > 0 ? '\n⚠ Tiene ' + conProps + ' propiedad(es) a su nombre. Quedan vinculadas pero el propietario se oculta.' : '';
    if (!confirm('¿Eliminar este propietario? Baja lógica restaurable.' + extra)) return;
    try {
      const { error } = await window.supabaseClient.from('owners').update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      showToast('Propietario eliminado (baja lógica)', 'success');
      loadOwners();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.adminApp.restoreOwner = async function (id) {
    try {
      const { error } = await window.supabaseClient.from('owners').update({ deleted_at: null }).eq('id', id);
      if (error) throw error;
      showToast('Propietario restaurado.', 'success');
      loadOwners();
      updateSidebarBadges();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  on($('#ownerTrashToggle'), 'click', () => window.adminApp.toggleOwnersTrash && window.adminApp.toggleOwnersTrash());

  /* Owner search */
  on($('#ownerSearchInput'), 'input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('#ownersTableBody tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  /* Export Owners CSV / PDF */
  window.adminApp.exportOwnersCSV = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('owners')
        .select('*')
        .is('deleted_at', null)
        .order('full_name');
      if (error) throw error;
      const headers = ['Nombre', 'DNI/CUIT', 'Teléfono', 'Email', 'Dirección', 'Banco', 'CBU/CVU', 'Alias CBU', 'Preferencia Contacto', 'Exclusivo', 'Fecha Inicio Excl.', 'Fecha Fin Excl.', 'Comisión Venta %', 'Comisión Alquiler %', 'Notas'];
      const rows = (data || []).map(o => [
        o.full_name || '',
        o.dni_cuit || '',
        o.phone || '',
        o.email || '',
        o.address || '',
        o.bank_name || '',
        o.cbu_cvu || '',
        o.alias_cbu || '',
        o.preferred_contact || '',
        o.exclusive ? 'Sí' : 'No',
        o.exclusive_start || '',
        o.exclusive_end || '',
        o.commission_sale || '',
        o.commission_rent || '',
        (o.notes || '').replace(/\n/g, ' ')
      ].map(c => '"' + String(c).replace(/"/g, '""') + '"').join(','));
      const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'propietarios-' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Archivo .csv descargado', 'success');
    } catch (err) {
      showToast('Error exportando CSV: ' + err.message, 'error');
    }
  };

  window.adminApp.exportOwnersPDF = async function() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('owners')
        .select('*')
        .is('deleted_at', null)
        .order('full_name');
      if (error) throw error;
      const content = (data || []).map(o => `
        <div style="page-break-inside: avoid; margin-bottom: 24px; padding: 16px; border: 1px solid #ddd; border-radius: 8px;">
          <h3 style="margin: 0 0 12px; color: #1a1a2e;">${esc(o.full_name || 'Sin nombre')}</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px;">
            <div><strong>DNI/CUIT:</strong> ${esc(o.dni_cuit || '—')}</div>
            <div><strong>Teléfono:</strong> ${esc(o.phone || '—')}</div>
            <div><strong>Email:</strong> ${esc(o.email || '—')}</div>
            <div><strong>Dirección:</strong> ${esc(o.address || '—')}</div>
            <div><strong>Banco:</strong> ${esc(o.bank_name || '—')}</div>
            <div><strong>CBU/CVU:</strong> ${esc(o.cbu_cvu || '—')}</div>
            <div><strong>Alias CBU:</strong> ${esc(o.alias_cbu || '—')}</div>
            <div><strong>Contacto:</strong> ${esc(o.preferred_contact || 'whatsapp')}</div>
            <div><strong>Exclusivo:</strong> ${o.exclusive ? 'Sí' : 'No'}</div>
            <div><strong>Ini. Exclusividad:</strong> ${o.exclusive_start || '—'}</div>
            <div><strong>Fin Exclusividad:</strong> ${o.exclusive_end || '—'}</div>
            <div><strong>Com. Venta:</strong> ${o.commission_sale || '—'}%</div>
            <div><strong>Com. Alquiler:</strong> ${o.commission_rent || '—'}%</div>
          </div>
          ${o.notes ? `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #eee;"><strong>Notas:</strong><br>${esc(o.notes).replace(/\n/g, '<br>')}</div>` : ''}
        </div>
      `).join('');
      const html = `
        <!DOCTYPE html>
        <html><head>
          <meta charset="UTF-8">
          <title>Reporte Propietarios</title>
          <style>
            body { font-family: Inter, sans-serif; padding: 24px; color: #1a1a2e; }
            h1 { color: #1a1a2e; border-bottom: 2px solid #1fc8c3; padding-bottom: 8px; }
            @media print { body { padding: 0; } }
          </style>
        </head><body onload="setTimeout(function(){ window.print(); }, 300)">
          <h1>Reporte de Propietarios — ${new Date().toLocaleDateString('es-AR')}</h1>
          ${content}
        </body></html>
      `;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank', 'noopener');
      if (!w) {
        showToast('El navegador bloqueó la ventana emergente. Permití las ventanas emergentes para generar el PDF.', 'warning');
      } else {
        showToast('PDF generado (imprimir/guardar)', 'success');
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      showToast('Error generando PDF: ' + err.message, 'error');
    }
  };

  /* Event listeners for export buttons */
  $('#btnExportOwnersCSV')?.addEventListener('click', window.adminApp.exportOwnersCSV);
  $('#btnExportOwnersPDF')?.addEventListener('click', window.adminApp.exportOwnersPDF);


  window.__BH.loadOwners = loadOwners;
  window.__BH.loadPropertyDocs = loadPropertyDocs;
  window.__BH.loadPropertyNotes = loadPropertyNotes;
  window.__BH.loadPropertyHistory = loadPropertyHistory;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadPropertyDocs')) Object.defineProperty(window, 'loadPropertyDocs', { get: () => loadPropertyDocs, configurable: true });
  if (!Object.prototype.hasOwnProperty.call(window, 'loadPropertyNotes')) Object.defineProperty(window, 'loadPropertyNotes', { get: () => loadPropertyNotes, configurable: true });
  if (!Object.prototype.hasOwnProperty.call(window, 'loadPropertyHistory')) Object.defineProperty(window, 'loadPropertyHistory', { get: () => loadPropertyHistory, configurable: true });
  if (!Object.prototype.hasOwnProperty.call(window, 'loadOwners')) Object.defineProperty(window, 'loadOwners', { get: () => loadOwners, configurable: true });
  window.__BH.loadOwnerTasks = loadOwnerTasks;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadOwnerTasks')) Object.defineProperty(window, 'loadOwnerTasks', { get: () => loadOwnerTasks, configurable: true });
  window.__BH.flushPendingPropertyNotes = flushPendingPropertyNotes;
  if (!Object.prototype.hasOwnProperty.call(window, 'flushPendingPropertyNotes')) Object.defineProperty(window, 'flushPendingPropertyNotes', { get: () => flushPendingPropertyNotes, configurable: true });
})();
