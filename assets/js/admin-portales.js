/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Portales, Mercado Libre y RELA
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, logWarn, on, openModal, closeModal, showConfirmDialog, showToast, esc, mutate } = window.__BH || {};

  /* ------------------------------------------------
     13. PORTALS
     ------------------------------------------------ */
  const PORTALS = [
    { name: 'ZonaProp', icon: 'fas fa-building', color: '#3B82F6', url: 'https://www.zonaprop.com.ar' },
    { name: 'Argenprop', icon: 'fas fa-home', color: '#10B981', url: 'https://www.argenprop.com' },
    { name: 'Mercado Libre', icon: 'fas fa-shopping-cart', color: '#FFE600', url: 'https://inmuebles.mercadolibre.com.ar' },
    { name: 'Argentpropiedades', icon: 'fas fa-key', color: '#F97316', url: 'https://www.argentpropiedades.com.ar' },
    { name: 'Properati', icon: 'fas fa-map-marker-alt', color: '#8B5CF6', url: 'https://www.properati.com.ar' },
    { name: 'MiArgPropiedad', icon: 'fas fa-house-chimney', color: '#EC4899', url: 'https://www.miargpropiedad.com.ar' },
  ];

  async function loadPortals() {
    const container = $('#portalsContainer');
    if (!container) return;
    if (!window.supabaseClient) return;

    /* Await: sin esto la card renderiza "No configurado" con el estado ML aún
       sin cargar y no se vuelve a renderizar cuando la respuesta llega. */
    await mlCheckStatus(false).catch(() => {});
    updatePortalsBadge();

    const canManagePortals = ['super_admin', 'broker'].includes(currentProfile?.role);

    /* Get published property count + portal settings from DB */
    const [propsRes, settingsRes, mlConnRes, mlQuestionsRes] = await Promise.all([
      window.supabaseClient.from('properties').select('*', { count: 'exact', head: true }).eq('is_published', true).is('deleted_at', null),
      canManagePortals
        ? window.supabaseClient.from('portal_settings').select('*')
        : window.supabaseClient.from('portal_settings').select('portal_name, is_active'),
      window.supabaseClient.from('ml_connection').select('token_expires_at, nickname').limit(1).maybeSingle().then(r => r).catch(() => ({ data: null })),
      ml_connected
        /* el webhook escribe los estados en minúsculas ('unanswered'/'answered') */
      ? window.supabaseClient.from('ml_questions').select('id', { count: 'exact', head: true }).eq('status', 'unanswered').then(r => r).catch(() => ({ count: null }))
        : Promise.resolve({ count: null }),
    ]);
    if (propsRes.error) logWarn('portals: error contando publicados: ' + propsRes.error.message);
    if (settingsRes.error) logWarn('portals: error leyendo portal_settings: ' + settingsRes.error.message);

    const count = propsRes.count || 0;
    const settingsMap = {};
    (settingsRes.data || []).forEach(s => { settingsMap[s.portal_name] = s; });

    container.innerHTML = PORTALS.map((p, i) => {
      const db = settingsMap[p.name] || {};
      const isActive = db.is_active || false;

      if (p.name === 'Mercado Libre') {
        const statusColor = ml_connected ? 'var(--success)' : ml_configured ? '#FFE600' : 'var(--text-dim)';
        const statusText = ml_connected ? 'Conectado' : ml_configured ? 'Configurado' : 'No configurado';
        const statusIcon = ml_connected ? 'fas fa-circle-check' : ml_configured ? 'fas fa-circle-half-stroke' : 'fas fa-circle-xmark';
        const pendingQuestions = ml_connected ? (mlQuestionsRes.count ?? 0) : 0;
        const questionsHtml = ml_connected
          ? `<p style="font-size:11px; color:${pendingQuestions > 0 ? 'var(--warning)' : 'var(--text-dim)'}; margin-top:4px;">${pendingQuestions > 0 ? '⚠ ' : ''}${pendingQuestions} pregunta${pendingQuestions !== 1 ? 's' : ''} sin responder</p>`
          : '';
        const mlBtnHtml = ml_connected
          ? `<button class="btn-action danger" style="font-size:11px; padding:6px 12px; white-space:nowrap;" data-action="mlDisconnect"><i class="fas fa-link-slash"></i> Desconectar</button>`
          : ml_configured
            ? `<button class="btn-action" style="font-size:11px; padding:6px 12px; background:rgba(255,230,0,0.15); color:#FFE600; border:1px solid rgba(255,230,0,0.3);" data-action="mlConnect"><i class="fas fa-link"></i> Conectar ML</button>`
            : '';
        /* ml_listings guarda el estado en la columna ml_status */
        const activeListings = ml_connected ? ml_listings.filter(l => l.ml_status === 'active').length : 0;
        const listingsHtml = ml_connected
          ? `<p style="color:var(--text-dim); font-size:11px; margin-top:2px;">${activeListings} aviso${activeListings !== 1 ? 's' : ''} activo${activeListings !== 1 ? 's' : ''} en ML</p>`
          : '';
        const mlTokenExpiry = mlConnRes?.data?.token_expires_at ? new Date(mlConnRes.data.token_expires_at) : null;
        const expiryHtml = ml_connected && mlTokenExpiry
          ? (() => {
              const daysLeft = Math.floor((mlTokenExpiry.getTime() - Date.now()) / 86400000);
              if (daysLeft < 0) return '<p style="font-size:11px; color:var(--danger); margin-top:6px;">⚠ Token ML vencido — reconectá</p>';
              if (daysLeft < 7) return `<p style="font-size:11px; color:var(--warning); margin-top:6px;">⚠ Token ML vence en ${daysLeft}d</p>`;
              return `<p style="font-size:10px; color:var(--text-dim); margin-top:6px;">Token ML OK (${daysLeft}d)</p>`;
            })()
          : '';
        const userInfoHtml = ml_connected && ml_user
          ? `<p style="color:var(--text-muted); font-size:11px; margin-top:6px;"><i class="fas fa-user" style="margin-right:4px;"></i>${esc(ml_user.nickname || ml_user.email || '')}</p>`
          : '';
        const ML_WEBHOOK_TOPICS = [
          ['questions', 'Consultas'],
          ['orders', 'Órdenes'],
          ['items', 'Avisos'],
          ['payments', 'Pagos'],
          ['shipments', 'Envíos'],
        ];
        let webhooksHtml = '';
        if (ml_connected) {
          /* 'gone' = ML retiró el endpoint de suscripción por API (404): la
             configuración es manual en el gestor de aplicaciones de ML. */
          const gone = ml_webhooks && !ml_webhooks.error && ML_WEBHOOK_TOPICS.some(([k]) => ml_webhooks[k] === 'gone');
          if (gone) {
            webhooksHtml = '<p style="font-size:10px; color:var(--warning); margin-top:8px;">Suscripción de notificaciones: se configura en el <a href="https://applications.mercadolibre.com.ar" target="_blank" rel="noopener" style="color:var(--warning); text-decoration:underline;">panel de aplicaciones de ML</a> (editar la app &rarr; notificaciones &rarr; pegar esta URL y tildar <strong>VIS Leads</strong> — es el que trae las consultas de inmuebles; Questions/Items no aplican a inmuebles):</p>'
              + '<p style="font-size:10px; color:var(--text-dim); margin-top:2px; word-break:break-all; user-select:all;">' + esc(ML_FUNCTIONS_BASE + '/ml-webhook') + '</p>';
          } else if (ml_webhooks && !ml_webhooks.error) {
            webhooksHtml = '<div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:4px; justify-content:center;" title="Tópicos de notificación registrados ante Mercado Libre (sin esto las consultas de ML no llegan al CRM)">'
              + ML_WEBHOOK_TOPICS.map(([k, label]) => {
                  const on = ml_webhooks[k] === true;
                  return `<span style="font-size:10px; padding:2px 8px; border-radius:999px; background:${on ? 'rgba(74,222,128,.12)' : 'rgba(248,113,113,.12)'}; color:${on ? 'var(--success)' : 'var(--danger)'};">${on ? '●' : '○'} ${label}</span>`;
                }).join('')
              + '</div>';
          } else {
            webhooksHtml = '<p style="font-size:10px; color:var(--text-dim); margin-top:8px;">Webhooks ML: estado desconocido</p>';
          }
        }
        const configPanelHtml = !ml_configured ? `
          <div id="mlConfigPanel" class="ml-config-panel" style="display:none; margin-top:12px; text-align:left;">
            <div class="ml-config-field">
              <label>APP ID</label>
              <input type="text" id="mlAppIdInput" placeholder="Ej: 12345678901234" class="ml-config-input" />
            </div>
            <div class="ml-config-field">
              <label>SECRET KEY</label>
              <input type="password" id="mlSecretInput" placeholder="NGRD...tu-secret-key" class="ml-config-input" />
            </div>
            <button class="btn-action" style="width:100%; margin-top:8px; background:rgba(255,230,0,0.15); color:#FFE600; border:1px solid rgba(255,230,0,0.3);" data-action="mlSaveCredentials">
              <i class="fas fa-save"></i> Guardar Credenciales
            </button>
          </div>` : '';

        return `
      <div class="glass-panel portal-card" style="padding:24px; text-align:center;">
        <div style="width:56px; height:56px; border-radius:16px; background:${p.color}20; display:flex; align-items:center; justify-content:center; margin:0 auto 14px;">
          <i class="${p.icon}" style="font-size:24px; color:${p.color};"></i>
        </div>
        <h3 style="color:#fff; font-size:16px; font-weight:700; margin-bottom:4px;">${p.name}</h3>
        <div style="display:flex; align-items:center; justify-content:center; gap:6px; margin-bottom:14px;">
          <i class="${statusIcon}" style="font-size:12px; color:${statusColor};"></i>
          <span style="font-size:12px; color:${statusColor}; font-weight:600;">${statusText}</span>
        </div>
        ${userInfoHtml}
        ${listingsHtml}
        ${questionsHtml}
        ${expiryHtml}
        ${webhooksHtml}
        <div style="display:flex; align-items:center; justify-content:center; gap:8px; margin-top:12px; flex-wrap:wrap; ${canManagePortals ? '' : 'opacity:.5; pointer-events:none;'}">
          ${mlBtnHtml}
          ${ml_connected ? `<button class="btn-action" title="Re-registrar notificaciones (consultas) ante Mercado Libre" style="font-size:11px; padding:6px 12px;" data-action="mlRegisterWebhooks"><i class="fas fa-bell"></i></button>` : ''}
          ${!ml_configured ? `<button class="btn-action" title="Configurar credenciales" style="font-size:11px; padding:6px 12px;" data-action="mlToggleConfig"><i class="fas fa-cog"></i></button>` : ''}
          ${ml_connected ? `<button class="btn-action" title="Importar desde ML" style="font-size:11px; padding:6px 12px;" data-action="mlImportFromML"><i class="fas fa-file-import"></i></button>` : ''}
        </div>
        ${canManagePortals ? configPanelHtml : ''}
        ${canManagePortals ? '' : '<p style="font-size:11px; color:var(--text-dim); margin-top:10px;">Solo lectura para tu rol</p>'}
      </div>`;
      }

      const backendAvailable = ['Mercado Libre', 'ZonaProp'].includes(p.name);
      const isZona = p.name === 'ZonaProp';
      const zonaLinkHtml = isZona
        ? '<p style="font-size:11px; color:var(--text-dim); margin-top:10px;">Se gestiona desde el panel RELA de abajo</p>'
        : '';
      const ghostBadge = !backendAvailable
        ? '<span class="nav-badge" style="background:rgba(255,255,255,0.05); color:var(--text-dim); font-size:10px; margin-bottom:8px; display:inline-block;">Sin integración automática (próximamente)</span>'
        : '';
      return `
      <div class="glass-panel portal-card" style="padding:24px; text-align:center;${backendAvailable ? '' : ' opacity:.75;'}">
        <div style="width:56px; height:56px; border-radius:16px; background:${p.color}20; display:flex; align-items:center; justify-content:center; margin:0 auto 14px;">
          <i class="${p.icon}" style="font-size:24px; color:${p.color};"></i>
        </div>
        <h3 style="color:#fff; font-size:16px; font-weight:700; margin-bottom:4px;">${p.name}</h3>
        ${ghostBadge}
        <p style="color:var(--text-dim); font-size:12px; margin-bottom:14px;">${count} inmuebles publicables</p>
        <div style="display:flex; align-items:center; justify-content:center; gap:10px; ${canManagePortals && backendAvailable ? '' : 'opacity:.5; pointer-events:none;'}">
          <button type="button" role="switch" aria-checked="${isActive}" data-portal-toggle="${esc(p.name)}" class="portal-toggle${isActive ? ' is-on' : ''}" ${canManagePortals && backendAvailable ? '' : 'disabled title="' + (backendAvailable ? 'Solo super_admin o broker' : 'Sin integración todavía') + '"'}>
            <span class="portal-toggle-knob"></span>
          </button>
          <button class="btn-action" title="${canManagePortals ? 'Configurar API' : 'Solo super_admin o broker'}" data-action="openPortalConfig" data-id="${i}"><i class="fas fa-cog"></i></button>
        </div>
        ${zonaLinkHtml}
        ${canManagePortals ? '' : '<p style="font-size:11px; color:var(--text-dim); margin-top:10px;">Solo lectura para tu rol</p>'}
      </div>`;
    }).join('');

    loadRelaPanel();
    loadLavozPanel();
    loadSyncHistory();
    loadMlQuestionsPanel();
  }

  async function loadMlQuestionsPanel() {
    const el = $('#mlQuestionsList');
    if (!el || !window.supabaseClient) return;
    if (!ml_connected) {
      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px;">Conectá Mercado Libre para ver preguntas de clientes.</p>';
      return;
    }
    try {
      const { data, error } = await window.supabaseClient
        .from('ml_questions')
        .select('id, question_id, ml_item_id, question_text, from_user_nickname, date_created, status, answer_text')
        .order('date_created', { ascending: false })
        .limit(20);
      if (error) throw error;
      if (!data || !data.length) {
        el.innerHTML = '<p style="color:var(--text-dim); font-size:12px;">Sin preguntas registradas todavía.</p>';
        return;
      }
      el.innerHTML = data.map(q => `
        <div style="padding:12px 14px; border:1px solid var(--border-subtle); border-radius:10px; background:rgba(255,255,255,0.02);">
          <div style="display:flex; justify-content:space-between; gap:10px; font-size:12px; color:var(--text-dim); margin-bottom:6px;">
            <span>${esc(q.ml_item_id || '')} · ${esc(q.from_user_nickname || 'anónimo')}</span>
            <span>${q.date_created ? new Date(q.date_created).toLocaleString('es-AR') : '—'}</span>
          </div>
          <div style="color:#fff; font-size:13px; margin-bottom:8px;">${esc(q.question_text || '')}</div>
          ${q.status === 'answered'
            ? `<div style="font-size:12px; color:var(--success);"><i class="fas fa-check"></i> ${esc(q.answer_text || 'Respondida')}</div>`
            : `<div style="margin-top:10px; display:flex; gap:8px;">
                 <input type="text" data-ml-answer-input="${q.id}" placeholder="Escribir respuesta..." style="flex:1; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-input); border-radius:8px; color:#fff; font-size:12px;" />
                 <button class="btn-action" data-ml-answer="${q.question_id || q.id}" style="padding:8px 14px; font-size:11px; white-space:nowrap;"><i class="fas fa-paper-plane"></i> Responder</button>
               </div>`}
        </div>
      `).join('');
      el.querySelectorAll('[data-ml-answer]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const input = btn.previousElementSibling;
          const text = input?.value?.trim();
          if (!text) { showToast('Escribí la respuesta primero', 'warning'); return; }
          btn.disabled = true;
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
          try {
            /* ml-answer-question exige {question_id, answer} (la key vieja 'text' daba 400) */
            await mlApiCall('answer-question', { question_id: btn.dataset.mlAnswer, answer: text });
            showToast('Respuesta enviada a ML', 'success');
            loadMlQuestionsPanel();
          }
          catch (err) { showToast('Error: ' + err.message, 'error'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Responder'; }
        });
      });
    } catch (err) {
      logWarn('ml questions: ' + err.message);
      el.innerHTML = '<p style="color:var(--text-dim); font-size:12px;">No se pudieron cargar las preguntas.</p>';
    }
  }

  async function loadSyncHistory() {
    const tbody = $('#syncLogsTableBody');
    if (!tbody || !window.supabaseClient) return;
    try {
      const [histRes, queueRes, relaRes] = await Promise.all([
        window.supabaseClient
          .from('ml_sync_history')
          .select('operation, status, created_at, queue_id, error')
          .order('created_at', { ascending: false })
          .limit(10),
        window.supabaseClient
          .from('ml_sync_queue')
          .select('id, property_id, operation, status, next_attempt_at, attempts, max_attempts, last_error, created_at')
          .in('status', ['pending', 'processing', 'failed'])
          .order('created_at', { ascending: false })
          .limit(10),
        window.supabaseClient
          .from('rela_webhook_events')
          .select('id, tipo_evento, referencia, processed, process_error, received_at')
          .order('received_at', { ascending: false })
          .limit(10)
          .then(r => r).catch(() => ({ data: null })),
      ]);
      if (histRes.error) throw histRes.error;
      const data = histRes.data || [];
      const queue = queueRes.data || [];

      const opLabels = { publish: 'Publicación', update: 'Actualización', delete: 'Eliminación' };
      const queueHtml = queue.map(row => `<tr>
        <td style="font-size:12px;">${new Date(row.created_at).toLocaleString('es-AR')}</td>
        <td><span class="nav-badge" style="background:rgba(255,230,0,0.12); color:#FFE600; font-size:10px;">Mercado Libre</span></td>
        <td style="font-size:12px;">${esc(opLabels[row.operation] || row.operation)} en cola (#${row.id})${row.attempts ? ` · intento ${row.attempts}/${row.max_attempts}` : ''}</td>
        <td><span class="nav-badge" style="background:${row.status === 'failed' ? 'rgba(239,68,68,0.12)' : 'rgba(255,184,0,0.12)'}; color:${row.status === 'failed' ? 'var(--danger)' : 'var(--warning)'}; font-size:10px;"${row.last_error ? ` title="${esc(row.last_error)}"` : ''}>${row.status === 'failed' ? 'Falló' : row.status === 'processing' ? 'Procesando' : 'En cola'}</span></td>
      </tr>`).join('');

      const relaRows = (relaRes?.data || []).map(ev => `<tr>
        <td style="font-size:12px;">${new Date(ev.received_at).toLocaleString('es-AR')}</td>
        <td><span class="nav-badge" style="background:rgba(59,130,246,0.12); color:#3B82F6; font-size:10px;">RELA / ZonaProp</span></td>
        <td style="font-size:12px;">${esc(ev.tipo_evento)}${ev.referencia ? ' · ' + esc(ev.referencia) : ''}</td>
        <td><span class="nav-badge" style="background:${ev.processed ? 'rgba(0,200,120,0.12)' : 'rgba(255,184,0,0.12)'}; color:${ev.processed ? 'var(--success)' : 'var(--warning)'}; font-size:10px;"${ev.process_error ? ` title="${esc(ev.process_error)}"` : ''}>${ev.processed ? 'OK' : 'Pendiente'}</span></td>
      </tr>`);

      if (!data.length && !queue.length && !relaRows.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-dim);">Sin sincronizaciones recientes</td></tr>';
        return;
      }
      tbody.innerHTML = queueHtml + relaRows.join('') + data.map(row => {
        const ok = row.status === 'success';
        return `<tr>
          <td style="font-size:12px;">${new Date(row.created_at).toLocaleString('es-AR')}</td>
          <td><span class="nav-badge" style="background:rgba(255,230,0,0.12); color:#FFE600; font-size:10px;">Mercado Libre</span></td>
          <td style="font-size:12px;">${esc(opLabels[row.operation] || row.operation)}${row.queue_id ? ' #' + row.queue_id : ''}</td>
          <td><span class="nav-badge" style="background:${ok ? 'rgba(0,200,120,0.12)' : 'rgba(239,68,68,0.12)'}; color:${ok ? 'var(--success)' : 'var(--danger)'}; font-size:10px;"${row.error ? ` title="${esc(row.error)}"` : ''}>${ok ? 'OK' : 'Falló'}</span></td>
        </tr>`;
      }).join('');
    } catch (err) {
      logWarn('sync history: ' + err.message);
    }
  }

  window.adminApp.togglePortal = async function (portalName, isActive) {
    const btn = document.querySelector(`[data-portal-toggle="${portalName}"]`);
    if (!btn || btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    try {
      const { error } = await window.supabaseClient
        .from('portal_settings')
        .upsert({ portal_name: portalName, is_active: isActive }, { onConflict: 'portal_name' });
      if (error) throw error;
      btn.classList.toggle('is-on', isActive);
      btn.setAttribute('aria-checked', String(isActive));
      showToast(`${portalName} ${isActive ? 'activado' : 'desactivado'}`, 'success');
    } catch (err) {
      showToast('Error al actualizar portal: ' + err.message, 'error');
    } finally {
      delete btn.dataset.busy;
    }
  };

  const portalsContainerEl = $('#portalsContainer');
  if (portalsContainerEl && !portalsContainerEl.dataset.toggleBound) {
    portalsContainerEl.dataset.toggleBound = '1';
    portalsContainerEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-portal-toggle]');
      if (!btn || btn.disabled) return;
      window.adminApp.togglePortal(btn.dataset.portalToggle, !btn.classList.contains('is-on'));
    });
  }

  /* Portal config field definitions per portal type */
  const PORTAL_CONFIG_FIELDS = {
    'ZonaProp': [
      { name: 'client_id', label: 'Client ID', type: 'text', required: true },
      { name: 'client_secret', label: 'Client Secret', type: 'password', required: true },
      { name: 'username', label: 'Username (opcional)', type: 'text', required: false },
      { name: 'password', label: 'Password (opcional)', type: 'password', required: false }
    ],
    'Argenprop': [
      { name: 'username', label: 'Username / Email', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
      { name: 'api_key', label: 'API Key (opcional)', type: 'text', required: false }
    ],
    'Argentpropiedades': [
      { name: 'client_id', label: 'Client ID', type: 'text', required: true },
      { name: 'client_secret', label: 'Client Secret', type: 'password', required: true }
    ],
    'Properati': [
      { name: 'api_key', label: 'API Key', type: 'text', required: true },
      { name: 'client_id', label: 'Client ID (opcional)', type: 'text', required: false }
    ],
    'MiArgPropiedad': [
      { name: 'username', label: 'Username / Email', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
      { name: 'api_key', label: 'API Key (opcional)', type: 'text', required: false }
    ],
    'Mercado Libre': [
      { name: 'app_id', label: 'APP ID', type: 'text', required: true },
      { name: 'secret_key', label: 'Secret Key', type: 'password', required: true }
    ]
  };

  function renderPortalConfigFields(portalName) {
    const fields = PORTAL_CONFIG_FIELDS[portalName] || [
      { name: 'api_key', label: 'API Key', type: 'text', required: true },
      { name: 'api_secret', label: 'Secret', type: 'password', required: true }
    ];
    const container = $('#portalConfigFields');
    if (!container) return;
    container.innerHTML = fields.map(f => `
      <div class="form-field">
        <label>${f.label} ${f.required ? '<span style="color:var(--danger);">*</span>' : ''}</label>
        <input type="${f.type}" id="portalField_${f.name}" name="${f.name}" ${f.required ? 'required' : ''} />
      </div>
    `).join('');
  }

  window.adminApp.openPortalConfig = async function (index) {
    const portal = PORTALS[index];
    if (!portal) return;
    const title = $('#modalPortalTitle');
    if (title) title.textContent = `Configurar ${portal.name}`;
    const idx = $('#portalIndex');
    if (idx) idx.value = index;

    renderPortalConfigFields(portal.name);

    try {
      const { data } = await window.supabaseClient
        .from('portal_settings')
        .select('*')
        .eq('portal_name', portal.name)
        .single();

      if (data) {
        const fields = PORTAL_CONFIG_FIELDS[portal.name] || [];
        fields.forEach(f => {
          const input = $(`#portalField_${f.name}`);
          if (!input) return;
          if (f.type === 'password') {
            const stored = data[f.name];
            input.value = '';
            input.placeholder = stored ? '•••••••• (guardado — escribí para reemplazar)' : 'Sin configurar';
          } else {
            input.value = data[f.name] || '';
          }
        });
      }
    } catch (_) {
    }

    openModal('portalModal');
  };

  on($('#portalApiForm'), 'submit', async (e) => {
    e.preventDefault();
    if (_submittingPortal) return;
    _submittingPortal = true;
    const index = parseInt($('#portalIndex')?.value, 10);
    const portal = PORTALS[index];
    if (!portal) { _submittingPortal = false; return; }
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }
try {
      const fields = PORTAL_CONFIG_FIELDS[portal.name] || [];
      const upsertData = { portal_name: portal.name };
      fields.forEach(f => {
        const input = $(`#portalField_${f.name}`);
        if (!input) return;
        const val = input.value?.trim() || '';
        // Campos sensibles vacíos = no tocar el valor guardado (evita pisar con "")
        if (f.type === 'password' && val === '') return;
        upsertData[f.name] = val;
      });

      await mutate('portal_settings', async () => {
        const { error } = await window.supabaseClient
          .from('portal_settings')
          .upsert(upsertData, { onConflict: 'portal_name' });
        if (error) throw error;
      });
      showToast(`${portal.name} configurado correctamente`, 'success');
      closeModal('portalModal');
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      _submittingPortal = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Guardar Credenciales'; }
    }
  });

  on($('#syncAllBtn'), 'click', async function () {
    this.disabled = true;
    this.innerHTML = '<i class="fas fa-rotate fa-spin"></i> Sincronizando...';
    const resultados = [];
    try {
      await mlCheckStatus(true);
      resultados.push(ml_connected ? 'ML conectado' : 'ML no configurado');

      const { data: relaCfg } = await window.supabaseClient
        .from('rela_config').select('codigo_inmobiliaria').eq('id', true).maybeSingle();
      if (relaCfg?.codigo_inmobiliaria) {
        try {
          const res = await relaApiCall('reconcile');
          resultados.push(`RELA: ${(res.reconciled || []).length} avisos reconciliados`);
        } catch (err) {
          resultados.push('RELA reconcile falló: ' + err.message);
        }
      } else {
        resultados.push('RELA sin configurar');
      }

      await loadPortals();
      showToast(resultados.join(' · '), 'success');
    } catch (err) {
      showToast('Error al sincronizar: ' + err.message, 'error');
    } finally {
      this.disabled = false;
      this.innerHTML = '<i class="fas fa-arrows-rotate"></i> Sincronizar Todo';
    }
  });

  /* ------------------------------------------------
     13B. MERCADO LIBRE INTEGRATION
     ------------------------------------------------ */
  const ML_FUNCTIONS_BASE = (() => {
    const url = window.BH_CONFIG?.SUPABASE_URL;
    if (!url) throw new Error('BH_CONFIG.SUPABASE_URL no configurado');
    return url + '/functions/v1';
  })();

  const ML_API_TIMEOUT_MS = 15000;
  // Mapeo action -> endpoint. Todas las acciones van a funciones dedicadas ya.
  // (Antes 'update'/'remove'/'sync-import' caían al multiplexor legacy ml-api, que leía
  // tokens en texto plano de portal_settings — camino roto desde la migración a ml_connection.)
  const ML_FUNCTION_PATHS = {
    'publish': 'ml-publish',
    /* ?webhooks=1 pide el estado real de los tópicos registrados ante ML —
       sin esto el panel no puede saber si las notificaciones (consultas) llegan. */
    'portal-status': 'ml-portal-status?webhooks=1',
    'disconnect': 'ml-disconnect',

    'update': 'ml-publish',

    'remove': 'ml-publish',

    'sync-import': 'ml-sync-import',

    'answer-question': 'ml-answer-question',

  };
  async function mlApiCall(action, body = {}) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    if (!window.BH_CONFIG?.SUPABASE_URL) throw new Error('Configuración de Supabase no disponible (BH_CONFIG)');

    const fnPath = ML_FUNCTION_PATHS[action];

    if (!fnPath) throw new Error(`Acción ML no soportada: ${action}`);

    /* ml-publish exige body.action ('create' | 'update' | 'remove') */
    const outBody = fnPath === 'ml-publish'
      ? { ...body, action: action === 'publish' ? 'create' : action }
      : body;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
    try {
      const res = await fetch(`${ML_FUNCTIONS_BASE}/${fnPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(outBody),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Error ML API (${res.status})`);
      }
      const json = await res.json().catch(() => ({}));
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado al contactar Mercado Libre');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function updatePortalsBadge() {
    const el = document.getElementById('sideBadgePortales');
    if (!el) return;
    /* #6: la RPC del sidebar trae la salud real del webhook — el último
       evento recibido prueba que ML está notificando, más fuerte que el
       chequeo de OAuth. Precedencia: errores > recibe > conectado > parcial. */
    const counts = (window.__BH && window.__BH.lastBadgeCounts) || {};
    const lastEv = counts.ml_last_event_at ? new Date(counts.ml_last_event_at).getTime() : 0;
    const failed = counts.ml_failed_24h || 0;
    const receiving = lastEv > 0 && (Date.now() - lastEv) < 48 * 3600 * 1000;
    let label = ' Off', color = 'var(--text-dim)', tip = 'Sin conexión con Mercado Libre';
    if (receiving && failed === 0) {
      label = ' Live'; color = 'var(--success)';
      tip = 'Webhook activo — último evento: ' + new Date(lastEv).toLocaleString('es-AR');
    } else if (receiving && failed > 0) {
      label = ' ' + failed + ' err'; color = 'var(--warning)';
      tip = 'Webhook recibe eventos pero fallaron ' + failed + ' en 24h — ver Centro de Supervisión';
    } else if (ml_connected) {
      label = ' On'; color = 'var(--success)';
      tip = 'OAuth conectado — sin eventos del webhook en 48h';
    } else if (ml_configured) {
      label = ' Parcial'; color = '#FFE600';
      tip = 'Configurado sin conexión activa';
    }
    el.textContent = label;
    el.style.color = color;
    el.dataset.bhTip = tip;
  }

  let _mlStatusFetchedAt = 0;
  /* Tópicos de webhook registrados ante ML ({questions: true, ...} | {error} | null) */
  let ml_webhooks = null;
  const ML_STATUS_TTL_MS = 60_000;
  async function mlCheckStatus(force = false) {
    if (!force && _mlStatusFetchedAt && (Date.now() - _mlStatusFetchedAt) < ML_STATUS_TTL_MS) return;
    try {
      const result = await mlApiCall('portal-status');
      _mlStatusFetchedAt = Date.now();
      ml_connected = !!result.connected;
      ml_configured = !!result.configured;
      ml_user = result.user || null;
      ml_listings = Array.isArray(result.listings) ? result.listings : [];
      ml_webhooks = result.webhooks || null;
      updatePortalsBadge();
      updatePropBulkBar();
    } catch (err) {
      _mlStatusFetchedAt = 0;
      console.warn('[ML] Status check failed:', err.message);
      /* FIX 2026-10-22: NO resetear ml_connected ante errores transitorios
         (timeout, rate limit, red). Antes cualquier fallo del check ponía
         ml_connected = false y los botones de ML desaparecían de la tabla
         de propiedades al re-renderizar (realtime/filtro). Solo un 401/403
         definitivo (sin sesión o cuenta realmente desconectada) justifica
         apagar el flag. El último estado conocido se mantiene hasta que
         el check responda con datos reales. */
      if (/401|403|No hay sesión|no autorizado/i.test(err.message)) {
        ml_connected = false;
        ml_configured = false;
        ml_user = null;
        ml_listings = [];
        ml_webhooks = null;
        updatePortalsBadge();
      } else {
        /* Error transitorio: solo invalidar el cache para reintentar en la
           próxima llamada — el estado de conexión queda como estaba. */
      }
    }
  }

  /* Connect to Mercado Libre — opens OAuth popup via ml-oauth/start Edge Function */
  window.adminApp.mlConnect = async function () {
    try {
      showToast('Abriendo conexión con Mercado Libre...', 'info');
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session) throw new Error('No hay sesión activa');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
      const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-oauth/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action: 'start' }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const result = await res.json();
      if (!res.ok) {
        const msg = result.error || 'Error al generar URL de autenticación';
        if (/no configurad/i.test(msg)) {
          throw new Error('Credenciales de Mercado Libre no configuradas. Un super_admin debe guardarlas en Portales > Mercado Libre.');
        }
        throw new Error(msg);
      }
      const authUrl = result.authorizationUrl || result.authUrl;
      if (!authUrl) throw new Error('ml-oauth/start no devolvió authorizationUrl');

      /* Open popup for OAuth flow */
      const width = 800, height = 600;
      const left = (screen.width - width) / 2;
      const top = (screen.height - height) / 2;
      const popup = window.open(authUrl, 'ml_oauth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`);
      if (!popup) throw new Error('El navegador bloqueó la ventana emergente. Permití popups para este sitio y reintentá.');

      /* Listen for postMessage from ml-oauth Edge Function */
      const ML_MSG_ORIGIN = new URL(window.BH_CONFIG.SUPABASE_URL).origin;
      const handler = async (event) => {
        if (event.origin !== ML_MSG_ORIGIN) return;
        if (event.data?.type === 'ML_AUTH_SUCCESS') {
          _mlStatusFetchedAt = 0;
          window.removeEventListener('message', handler);
          if (popup && !popup.closed) popup.close();
          showToast('¡Cuenta de Mercado Libre conectada exitosamente!', 'success');
          ml_connected = true;
          ml_user = event.data.user || null;
          await mlCheckStatus();
          loadPortals();
        } else if (event.data?.type === 'ML_AUTH_ERROR') {
          window.removeEventListener('message', handler);
          if (popup && !popup.closed) popup.close();
          showToast('Error al conectar con Mercado Libre: ' + (event.data.error || 'Error desconocido'), 'error');
        }
      };
      window.addEventListener('message', handler);

      /* Timeout — close listener after 2 minutes */
      setTimeout(() => { window.removeEventListener('message', handler); }, 120000);
    } catch (err) {
      if (err.name === 'AbortError') {
        showToast('Tiempo de espera agotado al iniciar conexión ML', 'error');
      } else {
        showToast('Error al iniciar conexión ML: ' + err.message, 'error');
      }
    }
  };

  /* Disconnect from Mercado Libre */
  window.adminApp.mlDisconnect = async function () {
    if (!ml_connected) { showToast('No hay una cuenta de Mercado Libre conectada', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Desconectar Mercado Libre',
      message: 'Se desconectará la cuenta de Mercado Libre y se perderán las credenciales de acceso. ¿Continuar?',
      icon: 'fas fa-plug-circle-xmark',
      confirmText: 'Desconectar',
      danger: true,
    }))) return;
    try {
      await mlApiCall('disconnect');
      ml_connected = false;
      ml_user = null;
      ml_listings = [];
      ml_configured = false;
      showToast('Cuenta de Mercado Libre desconectada', 'success');
      await mlCheckStatus();
      loadPortals();
    } catch (err) {
      showToast('Error al desconectar: ' + err.message, 'error');
    }
  };

  /* Re-registrar los tópicos de notificación ante ML (consultas, órdenes, etc.)
     sin pasar por el OAuth completo. Usa el action 'register_webhooks' de ml-oauth. */
  window.adminApp.mlRegisterWebhooks = async function () {
    if (!ml_connected) { showToast('No hay una cuenta de Mercado Libre conectada', 'warning'); return; }
    try {
      showToast('Re-registrando notificaciones de Mercado Libre...', 'info');
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session) throw new Error('No hay sesión activa');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
      try {
        const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-oauth`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ action: 'register_webhooks' }),
          signal: controller.signal,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `Error (${res.status})`);
        const results = Array.isArray(json) ? json : [];
        const failed = results.filter(r => !r.ok);
        /* Si TODOS fallaron por el retiro de la suscripción por API (404): no es un
           error, es la guía necesaria — mostrarla como info con los pasos exactos
           (el toast de error se leía como si el botón estuviera roto). */
        if (failed.length && failed.every(f => /retir[oó] el registro por API/i.test(f.error || ''))) {
          await showConfirmDialog({
            title: 'Suscripción manual en Mercado Libre',
            message: 'Mercado Libre retiró el registro automático por API. Se configura a mano: entrá a applications.mercadolibre.com.ar, editá la aplicación, en notificaciones pegá la callback URL que está en la card de Mercado Libre (abajo) y tildá VIS Leads (es el tópico de las consultas de inmuebles; Questions/Items no aplican a inmuebles). OJO: tildar el tópico solo hace que ML avise; para que lleguen nombre/teléfono/email del interesado ML tiene que habilitar LECTURA de leads a la aplicación — se pide al soporte de integraciones de ML (app 6473600664555938). Si las consultas entran sin datos de contacto, falta esa habilitación.',
            icon: 'fas fa-bell',
            confirmText: 'Entendido',
          });
        } else if (failed.length) {
          /* Incluir el primer error: sin esto el toast no explica el fallo real. */
          const firstErr = failed[0]?.error ? ' — ' + failed[0].error.slice(0, 160) : '';
          showToast(`Webhooks: ${results.length - failed.length}/${results.length} OK — fallaron: ${failed.map(f => f.topic).join(', ')}${firstErr}`, 'error');
        } else if (results.length) {
          showToast(`Webhooks registrados (${results.length} tópicos)`, 'success');
        } else {
          showToast('ml-oauth no devolvió resultados de registro', 'warning');
        }
      } finally {
        clearTimeout(timer);
      }
      await mlCheckStatus(true);
      loadPortals();
    } catch (err) {
      showToast('Error re-registrando webhooks: ' + (err.name === 'AbortError' ? 'tiempo de espera agotado' : err.message), 'error');
    }
  };

  /* Publish a property to Mercado Libre */
  window.adminApp.mlPublishProperty = async function (propertyId) {
    if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Publicar en Mercado Libre',
      message: 'Se publicará esta propiedad en Mercado Libre con los datos actuales. ¿Continuar?',
      icon: 'fab fa-envira',
      confirmText: 'Publicar',
    }))) return;

    try {
      /* Validación previa */
      const { data: prop, error: propErr } = await window.supabaseClient
        .from('properties')
        .select('title, description, image_urls, zone, price_usd, agent_id, status, is_published')
        .eq('id', propertyId)
        .single();
      if (propErr) throw propErr;

      const errors = [];
      if (!prop.image_urls || prop.image_urls.length < 3) errors.push('Mínimo 3 imágenes requeridas');
      if (!prop.description || prop.description.length < 100) errors.push('Descripción debe tener al menos 100 caracteres');
      if (!prop.zone) errors.push('Zona/barrio requerido');
      if (!prop.price_usd || prop.price_usd <= 0) errors.push('Precio válido requerido');
      if (!prop.agent_id) errors.push('Broker asignado requerido');
      if (!prop.is_published) errors.push('La propiedad debe estar publicada');

      if (errors.length) {
        showToast('Validación fallida: ' + errors.join('; '), 'error');
        return;
      }

      showToast('Publicando en Mercado Libre...', 'info');
      const result = await mlApiCall('publish', { property_id: propertyId });
      const listingId = result.listing_id || result.item_id || result.id || '';
      showToast('¡Propiedad publicada en Mercado Libre! ID: ' + listingId, 'success');
      if (result.description_warning) {
        showToast('Publicada sin descripción: ML rechazó el texto (' + result.description_warning + ')', 'warning');
      }
      await mlCheckStatus();
      loadProperties();
    } catch (err) {
      showToast('Error al publicar en ML: ' + err.message, 'error');
    }
  };

  /* Update a property listing on Mercado Libre */
  window.adminApp.mlUpdateProperty = async function (propertyId, listingId) {
    if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Actualizar en Mercado Libre',
      message: 'Se actualizará la publicación de esta propiedad en Mercado Libre. ¿Continuar?',
      icon: 'fas fa-rotate',
      confirmText: 'Actualizar',
    }))) return;
    try {
      showToast('Actualizando en Mercado Libre...', 'info');
      const result = await mlApiCall('update', { property_id: propertyId, listing_id: listingId });
      showToast('¡Propiedad actualizada en Mercado Libre!', 'success');
      if (result.description_warning) {
        showToast('Actualizada sin descripción: ML rechazó el texto (' + result.description_warning + ')', 'warning');
      }
      await mlCheckStatus();
      loadProperties();
    } catch (err) {
      showToast('Error al actualizar en ML: ' + err.message, 'error');
    }
  };

  /* Remove a property listing from Mercado Libre */
  window.adminApp.mlRemoveProperty = async function (listingId, propertyId) {
    if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Eliminar de Mercado Libre',
      message: 'La publicación de esta propiedad se eliminará de Mercado Libre. ¿Continuar?',
      icon: 'fas fa-trash-can',
      confirmText: 'Eliminar',
      danger: true,
    }))) return;
    try {
      showToast('Eliminando de Mercado Libre...', 'info');
      await mlApiCall('remove', { listing_id: listingId, property_id: propertyId });
      showToast('Propiedad eliminada de Mercado Libre', 'success');
      await mlCheckStatus();
      loadProperties();
    } catch (err) {
      showToast('Error al eliminar de ML: ' + err.message, 'error');
    }
  };

  /* Import properties from Mercado Libre */
  window.adminApp.mlImportFromML = async function () {
    if (!ml_connected) { showToast('Conectá tu cuenta de Mercado Libre primero', 'warning'); return; }
    if (!(await showConfirmDialog({
      title: 'Importar desde Mercado Libre',
      message: 'Se importarán las propiedades de Mercado Libre y se crearán como borradores en el sistema. ¿Continuar?',
      icon: 'fas fa-cloud-arrow-down',
      confirmText: 'Importar',
    }))) return;

    try {
      showToast('Importando propiedades desde Mercado Libre...', 'info');
      const result = await mlApiCall('sync-import');
      const count = result.imported || 0;
      showToast(`Se importaron ${count} propiedades desde Mercado Libre`, 'success');
      loadProperties();
    } catch (err) {
      showToast('Error al importar de ML: ' + err.message, 'error');
    }
  };

  /* ------------------------------------------------
     13C. OPEN RELA ARGENTINA (ZonaProp / QuintoAndar)
     ------------------------------------------------ */
  /* Traduce los errores crudos del proxy RELA a algo que se entienda.
     Cloudflare responde "error code: 521" cuando el servidor de origen de
     ZonaProp está caído (nos pasó todo el 7/11): el dueño no debía ver
     "RELA GET /v1/ubicaciones → 521" sin explicación. */
  function relaFriendlyError(msg) {
    const raw = String(msg || '');
    if (/(→\s*521\b|error code:\s*521)/i.test(raw)) return 'La API de ZonaProp está caída (error 521). Es un problema de ZonaProp, no nuestro: probá de nuevo en un rato.';
    if (/RELA red:/.test(raw)) return 'No se pudo conectar con la API de ZonaProp. Probá de nuevo en un rato.';
    if (/login falló/.test(raw)) return 'ZonaProp rechazó las credenciales de la integración (revisalas en Configurar).';
    if (/(→\s*401\b|invalid_token)/i.test(raw)) return 'La sesión con ZonaProp expiró o fue rechazada. Probá de nuevo en un rato.';
    if (/→\s*409\b/.test(raw)) return 'ZonaProp todavía no vinculó esta cuenta a la integración (pendiente de QuintoAndar).';
    return raw;
  }
  async function relaApiCall(action, body = {}) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
    try {
      const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/rela-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ action, ...body }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(relaFriendlyError(errJson.error || `Error ${res.status}`));
      }
      const json = await res.json().catch(() => ({}));
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado al contactar RELA');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  window.adminApp.relaPropertyAction = async function (propertyId, action) {
    const labels = { publish: 'publicar en', update: 'sincronizar con', unpublish: 'despublicar de' };
    if (!confirm(`¿Confirmás ${labels[action] || action} RELA esta propiedad?`)) return;
    try {
      showToast(`RELA: ${action}…`, 'info');
      const result = await relaApiCall(action, { property_id: propertyId });
      if (result.blocked) {
        showToast('RELA bloqueó la publicación: ' + (result.errors || []).join(' | '), 'error');
      } else if (result.dry_run) {
        showToast(`DRY-RUN: el payload es válido (codigo ${result.codigo_aviso}). Desactivá DRY_RUN en Portales → RELA para publicar en serio.`, 'success');
      } else if (result.skipped) {
        showToast('RELA: ' + (result.reason || 'sin cambios'), 'info');
      } else {
        showToast(`RELA OK: ${result.remote_status || 'procesado'}${result.warnings?.length ? ' (warnings: ' + result.warnings.length + ')' : ''}`, 'success');
      }
      loadProperties();
    } catch (err) {
      showToast('Error RELA: ' + err.message, 'error');
    }
  };

  /* Panel RELA dentro del tab Portales */
  async function loadRelaPanel() {
    const el = $('#relaPortalPanel');
    if (!el || !window.supabaseClient) return;
    const canManage = ['super_admin', 'broker'].includes(currentProfile?.role);
    let status = null;
    let events = [];
    try {
      const { data } = await window.supabaseClient.rpc('rela_portal_status');
      status = data;
    } catch (err) { logError('rela_portal_status', err); }
    try {
      const res = await relaApiCall('events_list');
      events = res.events || [];
    } catch (_) { /* requiere sesión/edge fn; se ignora */ }

    const L = status?.listings || {};
    const dot = (ok) => `<span style="width:8px;height:8px;border-radius:50%;background:${ok ? '#4ade80' : '#f87171'};display:inline-block;box-shadow:0 0 6px ${ok ? '#4ade80' : '#f87171'};"></span>`;
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('es-AR') : '—';

    el.innerHTML = `
      <div class="glass-panel" style="padding:24px; margin-top:20px; text-align:left;">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(59,130,246,0.15);display:flex;align-items:center;justify-content:center;">
              <i class="fas fa-cloud" style="color:#3B82F6; font-size:18px;"></i>
            </div>
            <div>
              <h3 style="color:#fff; font-size:16px; font-weight:700; margin:0;">Open RELA (ZonaProp)</h3>
              <div style="font-size:12px; color:var(--text-dim);">${esc(status?.environment || 'sandbox')} · inmobiliaria: ${esc(status?.codigo_inmobiliaria || 'sin configurar')}</div>
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;${canManage ? '' : ' opacity:.5; pointer-events:none;'}" title="${canManage ? '' : 'Solo super_admin o broker'}">
            ${status?.dry_run ? '<span class="nav-badge" style="background:rgba(255,184,0,0.15); color:var(--warning); font-size:11px; flex-shrink:0; white-space:nowrap;"><i class="fas fa-flask"></i> DRY-RUN activo</span>' : ''}
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap; flex-shrink:0;" data-action="relaPreflight"><i class="fas fa-clipboard-check"></i> Validar todos</button>
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap; flex-shrink:0;" data-action="relaSyncCatalogs"><i class="fas fa-rotate"></i> Catálogos</button>
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap; flex-shrink:0;" data-action="relaReconcile"><i class="fas fa-arrows-rotate"></i> Reconciliar</button>
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap; flex-shrink:0;" data-action="openRelaConfig"><i class="fas fa-cog"></i> Configurar</button>
          </div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-top:16px;">
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Estado</div>
            <div style="font-size:13px; color:#fff; display:flex; align-items:center; gap:6px; margin-top:4px;">${dot(!!status?.codigo_inmobiliaria)} ${status?.codigo_inmobiliaria ? 'Configurado' : 'Pendiente credenciales'}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Última sync</div>
            <div style="font-size:13px; color:#fff; margin-top:4px;">${fmtDate(status?.last_sync_at)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Avisos publicados</div>
            <div style="font-size:13px; color:#fff; margin-top:4px;">${L.published ?? 0}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Errores / Bloqueados</div>
            <div style="font-size:13px; color:${(L.errors || L.blocked) ? 'var(--danger)' : '#fff'}; margin-top:4px;">${(L.errors ?? 0)} / ${(L.blocked ?? 0)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Vendidas (fuera de cola)</div>
            <div style="font-size:13px; color:#fff; margin-top:4px;">${(L.not_publishable ?? 0)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Callbacks</div>
            <div style="font-size:13px; color:#fff; margin-top:4px;">${dot(!!status?.callbacks_enabled)} ${status?.callbacks_enabled ? 'Activos' : 'Sin configurar'}</div>
          </div>
        </div>
        ${status?.last_error ? `<div style="margin-top:12px; font-size:12px; color:var(--danger);">Último error: ${esc(status.last_error)}</div>` : ''}
        <div id="relaPreflightResult" style="margin-top:12px;"></div>
        ${events.length ? `
          <details style="margin-top:14px;">
            <summary style="cursor:pointer; font-size:12px; color:var(--text-dim);">Últimos eventos de callback (${events.length})</summary>
            <div style="margin-top:8px; font-size:11px; color:var(--text-muted); max-height:200px; overflow:auto;">
              ${events.map(ev => `<div style="padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                ${esc(ev.tipo_evento)} · ${esc(ev.referencia || '—')} · ${fmtDate(ev.received_at)} · ${ev.processed ? '✓ procesado' : '⏳/⚠ pendiente'}${ev.lead_id ? ' · lead creado' : ''}
              </div>`).join('')}
            </div>
          </details>` : ''}
      </div>`;
  };

  /* "Validar todos": qué avisos quedarían listos para publicar en RELA.
     Sólo lectura (no llama a RELA ni publica nada): clasifica cada
     propiedad en listo / bloqueado (con el motivo) / fuera de cola. */
  window.adminApp.relaPreflight = async function () {
    if (!['super_admin', 'broker'].includes(currentProfile?.role)) { showToast('Solo super_admin o broker pueden validar RELA', 'error'); return; }
    const box = $('#relaPreflightResult');
    if (box) box.innerHTML = '<div style="font-size:12px; color:var(--text-dim);">Validando…</div>';
    try {
      const res = await relaApiCall('preflight');
      if (!box) return;
      const detalle = res.detalle || [];
      const bloqueados = detalle.filter((d) => d.publicable && (d.errores || []).length);
      const listos = detalle.filter((d) => d.publicable && !(d.errores || []).length);
      const fuera = detalle.filter((d) => !d.publicable);
      const zonas = res.zonas_sin_mapeo || [];
      /* Los textos se arman FUERA del template: anidar backticks dentro de
         un ${} rompe el parseo (y `node --check` lo detecta). */
      const zonasTxt = zonas.map((z) => esc(z.zona) + ' (' + (z.codigos || []).length + ')').join(', ');
      const bloqueadosTxt = bloqueados.map((d) =>
        '<div style="padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">' +
        '<strong>' + esc(d.codigo) + '</strong> · ' + esc(d.zona || 'sin zona') + '<br>' +
        (d.errores || []).map((e) => '· ' + esc(e)).join('<br>') +
        '</div>').join('');
      const zonasHtml = zonas.length
        ? '<div style="font-size:12px; color:var(--warning); margin-bottom:8px;">Zonas sin mapear en RELA: ' + zonasTxt + '. Mapealas en Configurar → ubicaciones.</div>'
        : '';
      const bloqueadosHtml = bloqueados.length
        ? '<details open><summary style="cursor:pointer; font-size:12px; color:var(--text-dim);">Bloqueados (' + bloqueados.length + ')</summary>' +
          '<div style="margin-top:6px;">' + bloqueadosTxt + '</div></details>'
        : '<div style="font-size:12px; color:#4ade80;">Todo lo publicable tiene los datos completos.</div>';
      box.innerHTML =
        '<div style="font-size:12px; margin-bottom:8px;">' +
        '<strong style="color:#4ade80;">' + listos.length + ' listos</strong> · ' +
        '<strong style="color:var(--danger);">' + bloqueados.length + ' bloqueados</strong> · ' +
        fuera.length + ' fuera de cola (vendidas o pausadas)' +
        '</div>' + zonasHtml + bloqueadosHtml;
      showToast(`RELA: ${listos.length} aviso(s) listos para publicar`, 'success');
    } catch (err) {
      if (box) box.innerHTML = `<div style="font-size:12px; color:var(--danger);">No se pudo validar: ${esc(err.message)}</div>`;
      showToast('Error validando RELA: ' + err.message, 'error');
    }
  };

  window.adminApp.relaSyncCatalogs = async function () {
    if (!['super_admin', 'broker'].includes(currentProfile?.role)) { showToast('Solo super_admin o broker pueden sincronizar RELA', 'error'); return; }
    try {
      showToast('Sincronizando catálogos RELA (ubicaciones, tipos, planes)…', 'info');
      const res = await relaApiCall('catalogs_sync');
      const okCount = (res.synced || []).length;
      const failed = res.failed || {};
      const failCount = Object.keys(failed).length;
      /* Los 5 catálogos caen a la vez sólo si la API de ZonaProp está caída:
         mostrar el motivo real en vez de un "5 con error" sin explicación. */
      if (!okCount && failCount) {
        showToast('Catálogos RELA: ' + relaFriendlyError(Object.values(failed)[0]), 'error');
      } else {
        showToast(`Catálogos: ${okCount} sincronizados${failCount ? ', ' + failCount + ' con error' : ''}`, failCount ? 'warning' : 'success');
      }
      loadRelaPanel();
    } catch (err) { showToast('Error catálogos RELA: ' + err.message, 'error'); }
  };

  window.adminApp.relaReconcile = async function () {
    if (!['super_admin', 'broker'].includes(currentProfile?.role)) { showToast('Solo super_admin o broker pueden reconciliar RELA', 'error'); return; }
    if (!confirm('¿Reconciliar estados contra RELA? Consulta el estado real de cada aviso online.')) return;
    try {
      showToast('Reconciliando con RELA…', 'info');
      const res = await relaApiCall('reconcile');
      const lista = res.reconciled || [];
      const fallas = lista.filter((r) => r.error);
      /* Toda la lista con error = la API de ZonaProp está caída: no mentir con
         "N avisos consultados" cuando no se pudo consultar ninguno. */
      if (lista.length && fallas.length === lista.length) {
        showToast('Reconciliación: ' + relaFriendlyError(fallas[0].error), 'error');
      } else if (fallas.length) {
        showToast(`Reconciliación: ${(lista.length - fallas.length)} avisos consultados, ${fallas.length} con error`, 'warning');
      } else {
        showToast(`Reconciliación: ${lista.length} avisos consultados`, 'success');
      }
      loadProperties();
      loadRelaPanel();
    } catch (err) { showToast('Error reconciliación: ' + err.message, 'error'); }
  };

  window.adminApp.openRelaConfig = async function () {
    try {
      const res = await relaApiCall('config_get');
      const c = res.config || {};
      const setId = (id, v) => { const el = $(id); if (el) el.value = v ?? ''; };
      setId('#relaCodigoInmobiliaria', c.codigo_inmobiliaria);
      setId('#relaIntegrador', c.integrador);
      setId('#relaPlan', c.plan_default);
      setId('#relaContactoNombre', c.contacto_nombre);
      setId('#relaContactoEmail', c.contacto_email);
      setId('#relaContactoTelefono', c.contacto_telefono);
      setId('#relaBaseUrl', c.base_url);
      setId('#relaEnv', c.environment);
      setId('#relaCatalogMapping', JSON.stringify(c.catalog_mapping || {}, null, 2));
      setId('#relaTipoPropMap', JSON.stringify(c.tipo_propiedad_map || {}, null, 2));
      setId('#relaUbicacionMap', JSON.stringify(c.ubicacion_map || {}, null, 2));
      const dry = $('#relaDryRun'); if (dry) dry.checked = !!c.dry_run;
      openModal('relaConfigModal');
    } catch (err) { showToast('Error al cargar config RELA: ' + err.message, 'error'); }
  };

  on($('#relaConfigForm'), 'submit', async (e) => {
    e.preventDefault();
    const parseJsonField = (id, label) => {
      const raw = $(id)?.value?.trim() || '{}';
      try { return JSON.parse(raw); }
      catch { throw new Error(`JSON inválido en ${label}`); }
    };
    try {
      const patch = {
        codigo_inmobiliaria: $('#relaCodigoInmobiliaria')?.value?.trim() || null,
        integrador: $('#relaIntegrador')?.value?.trim() || null,
        plan_default: $('#relaPlan')?.value?.trim() || 'SIMPLE',
        contacto_nombre: $('#relaContactoNombre')?.value?.trim() || null,
        contacto_email: $('#relaContactoEmail')?.value?.trim() || null,
        contacto_telefono: $('#relaContactoTelefono')?.value?.trim() || null,
        base_url: $('#relaBaseUrl')?.value?.trim() || 'https://api-zp-sandbox-open.navent.com',
        environment: $('#relaEnv')?.value === 'production' ? 'production' : 'sandbox',
        catalog_mapping: parseJsonField('#relaCatalogMapping', 'Mapeo de características'),
        tipo_propiedad_map: parseJsonField('#relaTipoPropMap', 'Mapeo de tipos de propiedad'),
        ubicacion_map: parseJsonField('#relaUbicacionMap', 'Mapeo de ubicaciones'),
        dry_run: !!$('#relaDryRun')?.checked,
      };
      const { error } = await window.supabaseClient.from('rela_config').update(patch).eq('id', true);
      if (error) throw error;
      showToast('Configuración RELA guardada', 'success');
      closeModal('relaConfigModal');
      loadRelaPanel();
    } catch (err) {
      showToast('Error al guardar RELA: ' + err.message, 'error');
    }
  });


  /* ------------------------------------------------
     13D. CLASIFICADOS LA VOZ (publicación asistida)
     ------------------------------------------------
     La Voz NO tiene API ni carga masiva (verificado 2026-11-04: sin API en
     FAQ/Términos/sitemap/bundles, la única ruta JSON del front es
     /api/auth/me; el portal está detrás de Cloudflare Turnstile y su
     robots.txt bloquea AI crawlers). Por eso el flujo es ASISTIDO:
       1) "Preparar"  → el CRM arma el aviso (texto + fotos con la portada
          primero + todos los campos del formulario de La Voz).
       2) El usuario copia los campos y sube las fotos en su panel.
       3) "Marcar publicado" → queda la URL y la fecha de vencimiento
          (los avisos de La Voz duran 10 o 30 días).
     La edge function lavoz-proxy es la que arma el aviso (service_role).
     ------------------------------------------------ */
  const LAVOZ_PORTAL = 'https://clasificados.lavoz.com.ar';

  /* Copia al portapapeles con fallback (la clipboard API exige contexto
     seguro; el panel puede abrirse por http en algunos accesos). */
  async function copiarTexto(texto) {
    const val = String(texto || '');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(val);
        return true;
      }
    } catch (_) { /* fallback abajo */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = val;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) { return false; }
  }

  async function lavozApiCall(action, body = {}) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ML_API_TIMEOUT_MS);
    try {
      const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/lavoz-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ action, ...body }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Error ${res.status}`);
      }
      return await res.json().catch(() => ({}));
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado al contactar La Voz');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Último aviso preparado (para el modal y el ZIP). */
  let _lavozPrepared = null;

  const LAVOZ_STATUS = {
    published: { label: 'Publicado', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
    ready: { label: 'Listo para subir', color: '#1fc8c3', bg: 'rgba(31,200,195,0.12)' },
    failed: { label: 'Faltan datos', color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
    expired: { label: 'Vencido', color: '#FFB800', bg: 'rgba(255,184,0,0.12)' },
    draft: { label: 'Sin preparar', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
  };

  function lavozStatusBadge(status) {
    const s = LAVOZ_STATUS[status] || LAVOZ_STATUS.draft;
    return `<span class="nav-badge" style="background:${s.bg}; color:${s.color}; font-size:10px; white-space:nowrap;">${s.label}</span>`;
  }

  function lavozFecha(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }); }
    catch { return '—'; }
  }

  /* URLs seguras (la del aviso y la miniatura). BHUtils vive en utils.js:
     safeUrl sólo deja http/https/mailto/tel, safeImageUrl sólo http/https. */
  function lavozSafeUrl(u) {
    if (!u) return '';
    const fn = window.BHUtils && window.BHUtils.safeUrl;
    return typeof fn === 'function' ? fn(u) : '';
  }

  function lavozSafeImage(u) {
    if (!u) return '';
    const fn = window.BHUtils && window.BHUtils.safeImageUrl;
    return typeof fn === 'function' ? fn(u) : '';
  }

  async function loadLavozPanel() {
    const el = $('#lavozPortalPanel');
    if (!el || !window.supabaseClient) return;
    let status = null;
    let listings = [];
    try {
      const res = await lavozApiCall('status');
      status = res.status;
    } catch (err) { logError('lavoz status', err); }
    try {
      const res = await lavozApiCall('list');
      listings = res.listings || [];
    } catch (err) { logError('lavoz list', err); }

    const L = status?.listings || {};
    const dias = status?.dias_publicacion || 30;
    const fmt = (n) => Number(n || 0);

    const rows = listings.map((row) => {
      const p = row.properties || {};
      const fotos = Array.isArray(p.image_urls) ? p.image_urls : [];
      // La portada del sistema es la PRIMERA foto: es la que se muestra.
      const thumb = lavozSafeImage(fotos[0] || '');
      const adUrl = lavozSafeUrl(row.ad_url || '');
      const vence = row.expires_at && new Date(row.expires_at) < new Date() ? ' style="color:#f87171;"' : '';
      return `<tr>
        <td>
          <div style="display:flex; align-items:center; gap:10px; min-width:220px;">
            ${thumb ? `<img src="${esc(thumb)}" alt="" style="width:42px;height:30px;object-fit:cover;border-radius:5px;flex-shrink:0;" />` : '<div style="width:42px;height:30px;border-radius:5px;background:rgba(255,255,255,0.05);flex-shrink:0;"></div>'}
            <div style="min-width:0;">
              <div style="font-size:12px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;">${esc(p.title || 'Sin título')}</div>
              <div style="font-size:10.5px;color:var(--text-dim);">${esc(p.property_code || '')}</div>
            </div>
          </div>
        </td>
        <td>${lavozStatusBadge(row.status)}</td>
        <td style="font-size:11.5px;color:var(--text-secondary);">${row.fotos_count || 0}</td>
        <td style="font-size:11.5px;color:var(--text-secondary);">${esc((row.plan || '').replace('_', ' ') || '—')}</td>
        <td style="font-size:11.5px;color:var(--text-secondary);">${lavozFecha(row.published_at)}</td>
        <td style="font-size:11.5px;"${vence}>${lavozFecha(row.expires_at)}</td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn-action" style="padding:5px 8px;font-size:10px;" title="Preparar / ver el aviso" data-lavoz-prep="${esc(row.property_id)}"><i class="fas fa-file-lines"></i></button>
            ${adUrl ? `<a class="btn-action" style="padding:5px 8px;font-size:10px;color:#1fc8c3;" title="Ver el aviso publicado" href="${esc(adUrl)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i></a>` : ''}
            ${row.status === 'published' ? `<button class="btn-action danger" style="padding:5px 8px;font-size:10px;" title="Marcar despublicado" data-lavoz-unpub="${esc(row.property_id)}"><i class="fas fa-link-slash"></i></button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="glass-panel" style="padding:24px; margin-top:20px; text-align:left;">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(228,0,43,0.15);display:flex;align-items:center;justify-content:center;">
              <i class="fas fa-newspaper" style="color:#E4002B; font-size:18px;"></i>
            </div>
            <div>
              <h3 style="color:#fff; font-size:16px; font-weight:700; margin:0;">Clasificados La Voz</h3>
              <div style="font-size:12px; color:var(--text-dim);">Publicación asistida · avisos de ${dias} días · sin pack</div>
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap;" data-lavoz-prepare-all><i class="fas fa-layer-group"></i> Preparar todas</button>
            <button class="btn-action" style="padding:6px 12px; font-size:11px; white-space:nowrap;" data-lavoz-open-portal><i class="fas fa-external-link-alt"></i> Abrir La Voz</button>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin-top:16px;">
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Publicados</div>
            <div style="font-size:13px; color:#4ade80; margin-top:4px;">${fmt(L.published)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Vencen en 7 días</div>
            <div style="font-size:13px; color:#FFB800; margin-top:4px;">${fmt(L.expiring_soon)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Listos para subir</div>
            <div style="font-size:13px; color:#1fc8c3; margin-top:4px;">${fmt(L.ready)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border-radius:10px; padding:12px;">
            <div style="font-size:11px; color:var(--text-dim);">Faltan datos</div>
            <div style="font-size:13px; color:${fmt(L.failed) ? '#f87171' : '#fff'}; margin-top:4px;">${fmt(L.failed)}</div>
          </div>
        </div>

        <p style="font-size:11.5px; color:var(--text-dim); margin:14px 0 0;">
          <i class="fas fa-circle-info" style="color:#1fc8c3;"></i>
          La Voz no tiene API: el CRM arma el aviso completo y el asistente lo publica en su panel.
          <a href="${LAVOZ_PORTAL}/publicar" target="_blank" rel="noopener" style="color:#1fc8c3;">Publicar en La Voz</a>
          · <a href="${LAVOZ_PORTAL}/faq" target="_blank" rel="noopener" style="color:#1fc8c3;">Ayuda de La Voz</a>
        </p>

        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:10px; padding:10px 12px; border:1px solid rgba(31,200,195,0.22); border-radius:10px; background:rgba(31,200,195,0.06);">
          <i class="fas fa-robot" style="color:#1fc8c3;"></i>
          <span style="font-size:11.5px; color:var(--text-secondary);">
            <b>Publicación automática en lote:</b> el asistente abre tu navegador con la sesión de La Voz, llena cada aviso
            (con la <b>portada</b> de primera), lo publica y deja la URL y el vencimiento acá. Corré:
          </span>
          <code style="font-size:11px; background:rgba(0,0,0,0.3); border:1px solid var(--border-subtle); border-radius:6px; padding:3px 7px; color:#1fc8c3;">npm run lavoz</code>
          <button type="button" class="btn-action" style="padding:4px 8px; font-size:10px;" data-lavoz-copy="npm run lavoz" title="Copiar el comando"><i class="fas fa-copy"></i></button>
        </div>

        <ol style="margin:8px 0 0; padding-left:20px; font-size:11.5px; color:var(--text-dim); line-height:1.7;">
          <li>
            <b>La primera vez</b> (y sólo esa): <code style="font-size:11px;">npm run lavoz:discover</code>
            <button type="button" class="btn-action" style="padding:2px 6px; font-size:10px;" data-lavoz-copy="npm run lavoz:discover" title="Copiar el comando"><i class="fas fa-copy"></i></button>
            — se abre el navegador: iniciá sesión en La Voz y en este panel. El perfil las recuerda para siempre.
          </li>
          <li>
            <b>Ver la cola</b> (sin publicar nada): <code style="font-size:11px;">npm run lavoz:estado</code>
            <button type="button" class="btn-action" style="padding:2px 6px; font-size:10px;" data-lavoz-copy="npm run lavoz:estado" title="Copiar el comando"><i class="fas fa-copy"></i></button>
          </li>
          <li>
            <b>Publicar todo</b>: <code style="font-size:11px;">npm run lavoz</code> · <b>renovar vencidos</b>:
            <code style="font-size:11px;">npm run lavoz:renovar</code>
            <button type="button" class="btn-action" style="padding:2px 6px; font-size:10px;" data-lavoz-copy="npm run lavoz:renovar" title="Copiar el comando"><i class="fas fa-copy"></i></button>
          </li>
        </ol>

        <div style="margin-top:16px; overflow-x:auto;">
          ${listings.length ? `<table class="luxury-table" style="width:100%;">
            <thead><tr><th>Propiedad</th><th>Estado</th><th>Fotos</th><th>Plan</th><th>Publicado</th><th>Vence</th><th>Acciones</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>` : '<p style="font-size:12px; color:var(--text-dim); margin:8px 0;">Todavía no hay avisos preparados. Usá <b>Preparar todas</b> o el botón de La Voz en la fila de una propiedad.</p>'}
        </div>
      </div>`;
  }

  /* Abre el modal con el aviso armado de una propiedad. */
  window.adminApp.lavozPrepare = async function (propertyId) {
    try {
      showToast('Preparando aviso para La Voz…', 'info');
      const res = await lavozApiCall('prepare', { property_id: propertyId });
      const r = (res.results || [])[0];
      if (!r) throw new Error(res.error || 'No se pudo preparar el aviso');
      _lavozPrepared = r;

      const p = r.payload || {};
      const avisos = (r.avisos || []).map((a) =>
        `<li style="margin-bottom:4px;">${esc(a)}</li>`).join('');

      const campos = [
        ['Título', p.titulo],
        ['Operación', p.operacion_label],
        ['Tipo de inmueble', p.subrubro_label],
        ['Ciudad', p.ciudad_label],
        ['Barrio / Zona', p.ubicacion_label],
        ['Dormitorios', p.bedrooms],
        ['Baños', p.bathrooms],
        ['Cocheras', p.cocheras],
        ['Superficie total (m²)', p.superficie_total],
        ['Superficie cubierta (m²)', p.superficie_cubierta],
        ['Antigüedad (años)', p.antiguedad],
        ['Expensas', p.expensas],
        ['Precio', p.precio !== null && p.precio !== undefined ? `${p.precio} ${p.moneda || ''}`.trim() : null],
        ['Fotos a subir', `${p.fotos_count} (la primera es la PORTADA)`],
        ['Ficha propia', p.ficha_url],
      ].filter(([, v]) => v !== null && v !== undefined && v !== '');

      const filas = campos.map(([k, v]) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
          <div style="font-size:11px;color:var(--text-dim);min-width:150px;flex-shrink:0;">${esc(k)}</div>
          <div style="font-size:12px;color:var(--text-secondary);flex:1;min-width:0;word-break:break-word;">${esc(String(v))}</div>
          <button type="button" class="btn-action" style="padding:4px 7px;font-size:10px;flex-shrink:0;" data-lavoz-copy="${esc(String(v))}" title="Copiar"><i class="fas fa-copy"></i></button>
        </div>`).join('');

      const sub = document.querySelector('#lavozModalSub');
      const body = document.querySelector('#lavozModalBody');
      if (sub) sub.textContent = `${p.property_code || ''} · ${p.titulo || ''} — ${p.fotos_count || 0} foto(s), la portada primero.`;
      if (body) {
        body.innerHTML = `
          ${avisos ? `<div style="background:rgba(255,184,0,0.08);border:1px solid rgba(255,184,0,0.25);border-radius:10px;padding:10px 12px;margin-bottom:14px;">
            <div style="font-size:11.5px;color:#FFB800;margin-bottom:6px;"><i class="fas fa-triangle-exclamation"></i> Antes de publicar</div>
            <ul style="margin:0;padding-left:18px;font-size:11.5px;color:var(--text-secondary);">${avisos}</ul>
          </div>` : ''}
          <div style="margin-bottom:14px;">${filas}</div>
          <label style="font-size:11px;color:var(--text-dim);display:block;margin-bottom:6px;">Ficha completa (copiá y pegá en el formulario)</label>
          <textarea id="lavozFicha" rows="8" readonly style="width:100%;background:rgba(0,0,0,0.28);border:1px solid var(--border-subtle);border-radius:10px;color:var(--text-secondary);font-size:11.5px;padding:10px;font-family:ui-monospace,Menlo,Consolas,monospace;">${esc(r.ficha || '')}</textarea>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center;">
            <button type="button" class="btn-action" style="padding:6px 11px;font-size:11px;" data-lavoz-copy-ficha><i class="fas fa-clipboard"></i> Copiar ficha</button>
            <button type="button" class="btn-action" style="padding:6px 11px;font-size:11px;" data-lavoz-copy-desc><i class="fas fa-align-left"></i> Copiar descripción</button>
            <button type="button" class="btn-action" style="padding:6px 11px;font-size:11px;" data-lavoz-zip><i class="fas fa-file-zipper"></i> Descargar fotos</button>
          </div>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.07);">
            <label style="font-size:11px;color:var(--text-dim);display:block;margin-bottom:6px;">Ya lo publicaste? Pegá la URL del aviso</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <input type="url" id="lavozAdUrl" placeholder="https://clasificados.lavoz.com.ar/avisos/inmuebles/..." style="flex:1;min-width:220px;background:rgba(0,0,0,0.28);border:1px solid var(--border-subtle);border-radius:8px;color:var(--text-primary);padding:8px 10px;font-size:12px;" />
              <button type="button" class="btn-luxury-action" data-lavoz-confirm style="padding:8px 14px;font-size:12px;">Marcar publicado</button>
            </div>
          </div>`;
      }
      openModal('lavozModal');
      showToast('Aviso preparado para La Voz.', 'success');
      loadLavozPanel();
    } catch (err) {
      logError('lavoz prepare', err);
      showToast('Error preparando el aviso: ' + err.message, 'error');
    }
  };

  /* --- wiring de la sección La Voz --- */
  on($('#lavozPortalPanel'), 'click', async (e) => {
    const copyCmd = e.target.closest('[data-lavoz-copy]');
    if (copyCmd) {
      const ok = await copiarTexto(copyCmd.dataset.lavozCopy);
      showToast(ok ? `Copiado: ${copyCmd.dataset.lavozCopy}` : 'No pude copiar al portapapeles.', ok ? 'success' : 'error');
      return;
    }
    const prep = e.target.closest('[data-lavoz-prep]');
    if (prep) { window.adminApp.lavozPrepare(prep.dataset.lavozPrep); return; }
    const all = e.target.closest('[data-lavoz-prepare-all]');
    if (all) {
      try {
        showToast('Preparando todos los avisos…', 'info');
        const res = await lavozApiCall('prepare_all');
        showToast(`Avisos preparados: ${res.count || 0}.`, 'success');
        loadLavozPanel();
      } catch (err) {
        showToast('Error preparando avisos: ' + err.message, 'error');
      }
      return;
    }
    const open = e.target.closest('[data-lavoz-open-portal]');
    if (open) { window.open(LAVOZ_PORTAL + '/publicar', '_blank', 'noopener'); return; }
    const unpub = e.target.closest('[data-lavoz-unpub]');
    if (unpub) {
      const ok = await showConfirmDialog({
        title: 'Despublicar de La Voz',
        message: '¿Marcamos este aviso como no publicado en el CRM? (El aviso en el portal de La Voz hay que bajarlo a mano.)',
        icon: 'fas fa-link-slash', confirmText: 'Sí, despublicar', danger: true,
      });
      if (!ok) return;
      try {
        await lavozApiCall('unpublish', { property_id: unpub.dataset.lavozUnpub });
        showToast('Aviso marcado como despublicado.', 'success');
        loadLavozPanel();
      } catch (err) { showToast('Error: ' + err.message, 'error'); }
    }
  });

  on($('#lavozModal'), 'click', async (e) => {
    const copy = e.target.closest('[data-lavoz-copy]');
    if (copy) {
      const ok = await copiarTexto(copy.dataset.lavozCopy);
      showToast(ok ? 'Copiado.' : 'No pude copiar al portapapeles.', ok ? 'success' : 'error');
      return;
    }
    const copyFicha = e.target.closest('[data-lavoz-copy-ficha]');
    if (copyFicha) {
      const ta = document.querySelector('#lavozFicha');
      const ok = await copiarTexto(ta ? ta.value : '');
      showToast(ok ? 'Ficha copiada.' : 'No pude copiar al portapapeles.', ok ? 'success' : 'error');
      return;
    }
    const copyDesc = e.target.closest('[data-lavoz-copy-desc]');
    if (copyDesc) {
      const ok = await copiarTexto((_lavozPrepared?.payload?.descripcion) || '');
      showToast(ok ? 'Descripción copiada.' : 'No pude copiar al portapapeles.', ok ? 'success' : 'error');
      return;
    }
    const zip = e.target.closest('[data-lavoz-zip]');
    if (zip) {
      if (typeof window.adminApp.downloadLavozPackage === 'function') {
        window.adminApp.downloadLavozPackage(_lavozPrepared?.payload, _lavozPrepared?.ficha);
      } else {
        showToast('El generador de ZIP no está disponible.', 'error');
      }
      return;
    }
    const confirm = e.target.closest('[data-lavoz-confirm]');
    if (confirm) {
      const input = document.querySelector('#lavozAdUrl');
      const url = (input?.value || '').trim();
      if (!url) { showToast('Pegá la URL del aviso publicado.', 'error'); return; }
      try {
        const res = await lavozApiCall('confirm', { property_id: _lavozPrepared?.property_id, ad_url: url });
        showToast('Aviso publicado. Vence el ' + lavozFecha(res.expires_at) + '.', 'success');
        closeModal('lavozModal');
        loadLavozPanel();
      } catch (err) { showToast('Error: ' + err.message, 'error'); }
      return;
    }
    const close = e.target.closest('[data-lavoz-close]');
    if (close) { closeModal('lavozModal'); return; }
    const portal = e.target.closest('[data-lavoz-open]');
    if (portal) { window.open(LAVOZ_PORTAL + '/publicar', '_blank', 'noopener'); return; }
  });

  /* --- ML Config: get/save credentials from portal_settings --- */
  async function mlConfigGet() {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session || !session.access_token) throw new Error('No hay sesión activa o token inválido');
    const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-config`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error fetching ML config');
    return json;
  }

  async function mlConfigSave(appId, secretKey) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session || !session.access_token) throw new Error('No hay sesión activa o token inválido');
    const res = await fetch(`${ML_FUNCTIONS_BASE}/ml-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ ml_app_id: appId, ml_secret_key: secretKey }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error saving ML config');
    return json;
  }

  window.adminApp.mlSaveCredentials = async function () {
    const appIdInput = $('#mlAppIdInput');
    const secretInput = $('#mlSecretInput');
    const appId = (appIdInput?.value || '').trim();
    const secret = (secretInput?.value || '').trim();

    if (!appId || !secret) {
      showToast('Completá ambos campos: APP_ID y SECRET_KEY', 'warning');
      return;
    }

    try {
      showToast('Guardando credenciales de Mercado Libre...', 'info');
      await mlConfigSave(appId, secret);
      ml_configured = true;
      updatePortalsBadge();
      showToast('Credenciales guardadas. Ahora podés conectar tu cuenta.', 'success');
      loadPortals();
    } catch (err) {
      showToast('Error al guardar credenciales: ' + err.message, 'error');
    }
  };

  window.adminApp.mlToggleConfig = function () {
    const panel = $('#mlConfigPanel');
    if (panel) {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }
  };


  window.__BH.loadPortals = loadPortals;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadPortals')) Object.defineProperty(window, 'loadPortals', { get: () => loadPortals, configurable: true });
  window.__BH.mlCheckStatus = mlCheckStatus;
  if (!Object.prototype.hasOwnProperty.call(window, 'mlCheckStatus')) Object.defineProperty(window, 'mlCheckStatus', { get: () => mlCheckStatus, configurable: true });
  window.__BH.mlApiCall = mlApiCall;
  if (!Object.prototype.hasOwnProperty.call(window, 'mlApiCall')) Object.defineProperty(window, 'mlApiCall', { get: () => mlApiCall, configurable: true });
})();
