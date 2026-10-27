/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Módulo: CONTENIDO (Redes)
   Publicación de videos/posts a YouTube (v1) desde el panel.
   Fase 1: cuentas + alta de video con progreso + historial.
   Las plataformas pendientes (FB/IG/TikTok) se muestran como
   "próximamente" hasta que se implementen.
   Helpers via window.__BH (patrón de los demás módulos).
   ============================================================ */
(function () {
  'use strict';
  const { $, $$, esc, logError, showToast, getAuthedClient } = window.__BH || {};

  const FN_BASE = (window.BH_CONFIG && window.BH_CONFIG.SUPABASE_URL) + '/functions/v1';
  const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB — el PUT único de v1

  /* Plataformas: available=false → tarjeta "próximamente" (fases 2+). */
  const PLATFORM_META = {
    youtube:   { name: 'YouTube',   icon: 'fab fa-youtube',      color: '#FF0000', available: true },
    facebook:  { name: 'Facebook',  icon: 'fab fa-facebook-f',   color: '#1877F2', available: false },
    instagram: { name: 'Instagram', icon: 'fab fa-instagram',   color: '#E1306C', available: false },
    tiktok:    { name: 'TikTok',    icon: 'fab fa-tiktok',       color: '#F5F5F5', available: false },
  };
  const STATUS_META = {
    publishing: { label: 'Publicando', color: 'var(--warning)' },
    published:  { label: 'Publicado',  color: 'var(--success)' },
    failed:     { label: 'Falló',       color: 'var(--danger)' },
    draft:      { label: 'Borrador',    color: 'var(--text-dim)' },
    scheduled:  { label: 'Programado', color: 'var(--accent)' },
  };

  let _accounts = [];
  let _subTab = 'accounts';
  let _bound = false;
  let _publishing = false;

  async function authHeaders() {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token };
  }

  /* ---------- Cuentas ---------- */

  async function loadAccounts() {
    const client = await getAuthedClient();
    if (!client) return;
    const { data, error } = await client
      .from('social_accounts')
      .select('id, platform, display_name, avatar_url, status, last_publish_at')
      .order('created_at', { ascending: true });
    if (error) { logError('Contenido: loadAccounts', error); return; }
    _accounts = data || [];
    renderAccounts();
    renderCreateAccountOptions();
  }

  function renderAccounts() {
    const wrap = $('#contenidoAccounts');
    if (!wrap) return;
    /* AUDIT 2026-10-27: una tarjeta por CUENTA ACTIVA (soporta varios canales
       de la misma plataforma) + una tarjeta de "conectar" por plataforma sin
       cuentas activas. Antes: una tarjeta fija por plataforma que ocultaba
       cuentas adicionales conectadas. */
    const cards = [];
    // 1. Todas las cuentas activas, en tarjetas propias
    _accounts.filter(a => a.status === 'active').forEach((acc) => {
      const meta = PLATFORM_META[acc.platform] || { name: acc.platform, icon: 'fas fa-share', color: 'var(--text-dim)' };
      const card = document.createElement('div');
      card.className = 'glass-panel';
      card.style.cssText = 'display:flex;align-items:center;gap:14px;padding:16px;flex:1;min-width:260px;';
      const iconHtml = acc.avatar_url
        ? '<img src="' + esc(acc.avatar_url) + '" alt="" style="width:42px;height:42px;border-radius:50%;object-fit:cover;">'
        : '<i class="' + esc(meta.icon) + '" style="font-size:26px;color:' + meta.color + ';width:42px;text-align:center;"></i>';
      card.innerHTML =
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;font-size:14px;">' + esc(acc.display_name) + '</div>' +
        '<div style="font-size:11.5px;color:var(--text-dim);">' + esc(meta.name) + ' · conectada' +
        (acc.last_publish_at ? ' · última: ' + (window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(acc.last_publish_at) : '') : '') +
        '</div>' +
        '</div>' +
        '<button type="button" data-contenido-disconnect="' + esc(acc.id) + '" class="btn-luxury-action" style="padding:8px 14px;font-size:11px;">Desconectar</button>';
      card.insertAdjacentHTML('afterbegin', iconHtml);
      cards.push(card);
    });
    // 2. Plataformas sin ninguna cuenta activa: conectar o "próximamente"
    Object.entries(PLATFORM_META).forEach(([pid, meta]) => {
      if (_accounts.some(a => a.platform === pid && a.status === 'active')) return;
      const card = document.createElement('div');
      card.className = 'glass-panel';
      card.style.cssText = 'display:flex;align-items:center;gap:14px;padding:16px;flex:1;min-width:260px;';
      card.innerHTML =
        '<i class="' + esc(meta.icon) + '" style="font-size:26px;color:' + meta.color + ';width:42px;text-align:center;"></i>' +
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;font-size:14px;">' + esc(meta.name) + '</div>' +
        '<div style="font-size:11.5px;color:var(--text-dim);">' + (meta.available ? 'Sin conectar' : 'Próximamente') + '</div>' +
        '</div>' +
        (meta.available
          ? '<button type="button" data-contenido-connect="' + esc(pid) + '" class="btn-luxury-action" style="padding:8px 14px;font-size:11px;"><i class="fas fa-plug"></i> Conectar</button>'
          : '<span style="font-size:11px;color:var(--text-dim);"><i class="fas fa-clock"></i></span>');
      cards.push(card);
    });
    wrap.replaceChildren(...cards);
  }

  /* ---------- Conexión (popup + postMessage, patrón ML) ---------- */

  async function connectPlatform(pid) {
    if (pid !== 'youtube') { showToast('Esa red llega en las próximas fases.', 'info'); return; }
    try {
      showToast('Abriendo autorización de YouTube...', 'info');
      const res = await fetch(FN_BASE + '/social-auth-youtube', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ action: 'start' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      if (!json.url) throw new Error('La función no devolvió la URL de autorización');

      const w = 620, h = 640;
      const popup = window.open(json.url, 'social_yt_oauth',
        'width=' + w + ',height=' + h + ',left=' + ((screen.width - w) / 2) + ',top=' + ((screen.height - h) / 2) + ',scrollbars=yes');
      if (!popup) throw new Error('El navegador bloqueó la ventana emergente — permití popups y reintentá.');
    } catch (err) {
      logError('Contenido: connect', err);
      showToast(err.message, 'error');
    }
  }

  function listenOAuthMessages() {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || (d.type !== 'SOCIAL_AUTH_SUCCESS' && d.type !== 'SOCIAL_AUTH_ERROR')) return;
      if (d.type === 'SOCIAL_AUTH_SUCCESS') {
        showToast('Cuenta conectada: ' + (d.message || 'listo'), 'success');
        loadAccounts();
      } else {
        showToast('No se pudo conectar: ' + (d.error || 'error desconocido'), 'error');
      }
    });
  }

  async function disconnectAccount(accountId) {
    if (!window.confirm('¿Desconectar esta cuenta? Podés volver a conectarla cuando quieras.')) return;
    const client = await getAuthedClient();
    if (!client) return;
    const { error } = await client.from('social_accounts')
      .update({ status: 'disconnected' }).eq('id', accountId);
    if (error) { showToast('No se pudo desconectar: ' + error.message, 'error'); return; }
    showToast('Cuenta desconectada.', 'success');
    loadAccounts();
  }

  /* ---------- Crear publicación (YouTube v1) ---------- */

  function renderCreateAccountOptions() {
    const sel = $('#ytAccountSelect');
    if (!sel) return;
    const active = _accounts.filter(a => a.platform === 'youtube' && a.status === 'active');
    sel.innerHTML = active.length
      ? active.map(a => '<option value="' + esc(a.id) + '">' + esc(a.display_name) + '</option>').join('')
      : '<option value="">— Conectá un canal primero —</option>';
  }

  function fmtBytes(n) {
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(0) + ' MB';
    return (n / 1024).toFixed(0) + ' KB';
  }

  function setUploadProgress(pct, txt) {
    const bar = $('#ytUploadBar');
    const label = $('#ytUploadPct');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = txt;
  }

  /* PUT directo a Google con progreso (XHR: fetch no expone progreso de subida). */
  function xhrUploadToGoogle(sessionUrl, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 95), Math.round((e.loaded / e.total) * 95) + '% subido…');
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText || '{}')); } catch (_) { resolve({}); }
        } else {
          reject(new Error('Google ' + xhr.status + ': ' + (xhr.responseText || '').substring(0, 180)));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Error de red durante la subida.')));
      xhr.send(file);
    });
  }

  async function publishToYoutube() {
    if (_publishing) return;
    const accountId = ($('#ytAccountSelect') || {}).value || '';
    const title = (($('#ytTitle') || {}).value || '').trim();
    const description = (($('#ytDesc') || {}).value || '').trim();
    const tags = (($('#ytTags') || {}).value || '').trim();
    const privacy = (($('#ytPrivacy') || {}).value || 'public');
    const fileInput = $('#ytFile');

    if (!accountId) { showToast('Conectá primero un canal de YouTube (pestaña Cuentas).', 'warning'); return; }
    if (!title) { showToast('Poné un título al video.', 'warning'); return; }
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { showToast('Elegí el archivo de video.', 'warning'); return; }
    /* AUDIT 2026-10-27: el accept="video/*" filtra el picker pero no es
       garantía (algunos selectores permiten "todos los archivos"). */
    if (file.type && file.type.indexOf('video/') !== 0) {
      showToast('El archivo no es un video (' + file.type + ').', 'error'); return;
    }
    if (file.size > MAX_FILE_BYTES) { showToast('El video supera el máximo de 2 GB.', 'error'); return; }

    _publishing = true;
    const btn = $('#ytPublishBtn');
    const btnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Publicando…'; }
    setUploadProgress(0, 'Preparando…');
    const progressWrap = $('#ytProgress');
    if (progressWrap) progressWrap.style.display = '';

    try {
      /* 1. init: sesión de subida en Google + registro del post */
      const initRes = await fetch(FN_BASE + '/social-publish-youtube', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          action: 'init',
          account_id: accountId,
          title,
          description,
          tags,
          privacy,
          file_size: file.size,
          file_type: file.type || 'video/mp4',
        }),
      });
      const init = await initRes.json().catch(() => ({}));
      if (!initRes.ok) throw new Error(init.error || ('HTTP ' + initRes.status));
      if (!init.session_url || !init.post_id) throw new Error('La función no devolvió la sesión de subida');

      /* 2. subida directa del navegador a Google (los bytes nunca pasan por Supabase) */
      setUploadProgress(2, 'Subiendo a YouTube…');
      const uploaded = await xhrUploadToGoogle(init.session_url, file);
      const videoId = uploaded.id || '';
      if (!videoId) throw new Error('YouTube no devolvió el id del video');

      /* 3. complete: verifica y marca publicado */
      setUploadProgress(97, 'Verificando…');
      const doneRes = await fetch(FN_BASE + '/social-publish-youtube', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ action: 'complete', post_id: init.post_id, video_id: videoId }),
      });
      const done = await doneRes.json().catch(() => ({}));
      if (!doneRes.ok) throw new Error(done.error || ('HTTP ' + doneRes.status));

      setUploadProgress(100, '¡Publicado!');
      showToast('Video publicado en YouTube.', 'success');
      if (done.url) window.open(done.url, '_blank', 'noopener');
      $('#ytTitle').value = '';
      $('#ytDesc').value = '';
      $('#ytTags').value = '';
      if (fileInput) fileInput.value = '';
      loadHistory();
      loadAccounts(); // refresca last_publish_at
    } catch (err) {
      logError('Contenido: publish', err);
      showToast(err.message, 'error');
      setUploadProgress(0, '');
      if (progressWrap) progressWrap.style.display = 'none';
    } finally {
      _publishing = false;
      if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
    }
  }

  /* ---------- Historial ---------- */

  async function loadHistory() {
    const wrap = $('#contenidoHistory');
    if (!wrap) return;
    const client = await getAuthedClient();
    if (!client) return;

    /* AUDIT 2026-10-27: posts zombis — si el navegador se cerró a mitad de la
       subida, el post queda 'publishing' para siempre. >2h en ese estado =
       subida abandonada: marcar failed (idempotente, una sola query). */
    try {
      await client.from('social_posts')
        .update({ status: 'failed', error: 'Subida interrumpida (el navegador se cerró antes de terminar).' })
        .eq('status', 'publishing')
        .lt('created_at', new Date(Date.now() - 2 * 3600_000).toISOString());
    } catch (e) { logError('Contenido: zombie sweep', e); }

    const { data, error } = await client
      .from('social_posts')
      .select('id, platform, status, post_type, content, published_at, created_at, external_url, error, social_accounts(display_name)')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) { logError('Contenido: loadHistory', error); return; }
    if (!data || !data.length) {
      wrap.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:12px 0;">Todavía no hay publicaciones.</p>';
      return;
    }
    wrap.innerHTML = data.map(p => {
      const c = p.content || {};
      const st = STATUS_META[p.status] || { label: p.status, color: 'var(--text-dim)' };
      const fecha = window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(p.published_at || p.created_at) : (p.published_at || p.created_at || '');
      const accName = p.social_accounts && p.social_accounts.display_name ? p.social_accounts.display_name : '';
      const removable = p.status === 'failed' || p.status === 'draft';
      return '<div class="glass-panel" style="display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:8px;">' +
        '<i class="' + esc((PLATFORM_META[p.platform] || {}).icon || 'fas fa-share') + '" style="font-size:18px;"></i>' +
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.title || '(sin título)') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim);">' + esc(accName) + ' · ' + esc(fecha) + (p.status === 'failed' && p.error ? ' · <span style="color:var(--danger);">' + esc(String(p.error).substring(0, 80)) + '</span>' : '') + '</div>' +
        '</div>' +
        (p.external_url ? '<a href="' + esc(p.external_url) + '" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);text-decoration:none;flex-shrink:0;">Ver <i class="fas fa-arrow-up-right-from-square"></i></a>' : '') +
        '<span style="font-size:10.5px;color:' + st.color + ';flex-shrink:0;">' + esc(st.label) + '</span>' +
        (removable ? '<button type="button" data-contenido-delete="' + esc(p.id) + '" title="Borrar registro fallido" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:4px;flex-shrink:0;"><i class="fas fa-trash-can" style="font-size:12px;"></i></button>' : '') +
        '</div>';
    }).join('');
  }

  async function deletePost(postId) {
    if (!window.confirm('¿Borrar este registro del historial? (si el video llegó a publicarse en YouTube, no se borra de YouTube)')) return;
    const client = await getAuthedClient();
    if (!client) return;
    const { error } = await client.from('social_posts').delete().eq('id', postId);
    if (error) { showToast('No se pudo borrar: ' + error.message, 'error'); return; }
    showToast('Registro borrado.', 'success');
    loadHistory();
  }

  /* ---------- Shell + sub-tabs ---------- */

  function switchSubTab(sub) {
    _subTab = sub;
    $$('#contenidoSubTabs button').forEach(b => b.classList.toggle('is-active', b.dataset.sub === sub));
    const views = { accounts: '#contenidoAccounts', create: '#contenidoCreate', history: '#contenidoHistory' };
    Object.values(views).forEach(sel => { const el = $(sel); if (el) el.style.display = 'none'; });
    const el = $(views[sub]);
    if (el) el.style.display = '';
    if (sub === 'history') loadHistory();
  }

  function renderShell() {
    const root = $('#contenidoRoot');
    if (!root || root.dataset.rendered === '1') return;
    root.dataset.rendered = '1';
    root.innerHTML =
      '<div id="contenidoSubTabs" style="display:flex;gap:8px;margin-bottom:18px;">' +
        '<button type="button" data-sub="accounts" class="btn-luxury-action is-active" style="padding:9px 16px;font-size:12px;"><i class="fas fa-link"></i> Cuentas</button>' +
        '<button type="button" data-sub="create" class="btn-luxury-action" style="padding:9px 16px;font-size:12px;"><i class="fas fa-plus"></i> Crear publicación</button>' +
        '<button type="button" data-sub="history" class="btn-luxury-action" style="padding:9px 16px;font-size:12px;"><i class="fas fa-clock-rotate-left"></i> Historial</button>' +
      '</div>' +
      '<div id="contenidoAccounts" style="display:flex;flex-wrap:wrap;gap:12px;"></div>' +
      '<div id="contenidoCreate" style="display:none;max-width:720px;">' +
        '<div class="glass-panel" style="padding:20px;">' +
          '<h3 style="margin:0 0 4px;font-size:15px;"><i class="fab fa-youtube" style="color:#FF0000;"></i> Publicar video en YouTube</h3>' +
          '<p style="margin:0 0 16px;font-size:12px;color:var(--text-dim);">El video sube directo de tu navegador a Google — sin pasar por el servidor.</p>' +
          '<div style="margin-bottom:12px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Canal</span>' +
          '<select id="ytAccountSelect" class="crm-field-input crm-field-input--select" style="width:100%;"></select></div>' +
          '<div style="margin-bottom:12px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Título *</span>' +
          '<input id="ytTitle" type="text" class="crm-field-input" maxlength="100" placeholder="Ej: Departamento 2 ambientes Nueva Córdoba — TOUR COMPLETO" style="width:100%;"></div>' +
          '<div style="margin-bottom:12px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Descripción (con hashtags para SEO)</span>' +
          '<textarea id="ytDesc" rows="5" class="crm-field-input" maxlength="5000" placeholder="Descripción del video + #hashtags…" style="width:100%;"></textarea></div>' +
          '<div style="margin-bottom:12px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Tags SEO (separados por coma)</span>' +
          '<input id="ytTags" type="text" class="crm-field-input" placeholder="inmobiliaria córdoba, departamentos, nueva córdoba" style="width:100%;"></div>' +
          '<div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap;">' +
            '<div style="flex:1;min-width:220px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Video (máx. 2 GB)</span>' +
            '<input id="ytFile" type="file" accept="video/*" class="crm-field-input" style="width:100%;padding:8px;"></div>' +
            '<div><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Visibilidad</span>' +
            '<select id="ytPrivacy" class="crm-field-input crm-field-input--select">' +
              '<option value="public">Público</option>' +
              '<option value="unlisted">Oculto (link)</option>' +
              '<option value="private">Privado</option>' +
            '</select></div>' +
          '</div>' +
          '<div id="ytProgress" style="display:none;margin-bottom:14px;">' +
            '<div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">' +
              '<div id="ytUploadBar" style="height:100%;width:0%;background:var(--accent);border-radius:3px;transition:width .2s;"></div>' +
            '</div>' +
            '<div id="ytUploadPct" style="font-size:11px;color:var(--text-dim);margin-top:5px;"></div>' +
          '</div>' +
          '<button type="button" id="ytPublishBtn" class="btn-luxury-action" style="padding:12px 24px;font-size:13px;"><i class="fas fa-paper-plane"></i> Publicar en YouTube</button>' +
        '</div>' +
      '</div>' +
      '<div id="contenidoHistory" style="display:none;max-width:860px;"></div>';
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;
    listenOAuthMessages();
    document.addEventListener('click', (e) => {
      const connect = e.target.closest('[data-contenido-connect]');
      if (connect) { connectPlatform(connect.dataset.contenidoConnect); return; }
      const disconnect = e.target.closest('[data-contenido-disconnect]');
      if (disconnect) { disconnectAccount(disconnect.dataset.contenidoDisconnect); return; }
      const sub = e.target.closest('#contenidoSubTabs button[data-sub]');
      if (sub) { switchSubTab(sub.dataset.sub); return; }
      if (e.target.closest('#ytPublishBtn')) publishToYoutube();
      const del = e.target.closest('[data-contenido-delete]');
      if (del) { deletePost(del.dataset.contenidoDelete); return; }
    });
  }

  async function loadContenido() {
    if (!window.supabaseClient) return;
    renderShell();
    bindOnce();
    switchSubTab(_subTab);
    await Promise.all([loadAccounts(), loadHistory()]);
  }

  /* Exposición con el patrón de los demás módulos (guard de defineProperty) */
  window.__BH.loadContenido = loadContenido;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadContenido')) {
    Object.defineProperty(window, 'loadContenido', {
      get: () => loadContenido,
      set: (v) => { loadContenido = v; },
      configurable: true,
    });
  }
})();
