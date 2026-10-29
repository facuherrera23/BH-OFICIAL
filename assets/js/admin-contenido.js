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
  const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB — límite práctico (sube por chunks resumables)

  /* Plataformas: available=false → tarjeta "próximamente" (fases 2+). */
  const PLATFORM_META = {
    youtube:   { name: 'YouTube',   icon: 'fab fa-youtube',      color: '#FF0000', available: true },
    instagram: { name: 'Instagram', icon: 'fab fa-instagram',   color: '#E1306C', available: true },
    facebook:  { name: 'Facebook',  icon: 'fab fa-facebook-f',   color: '#1877F2', available: false },
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
  /* Studio: canal activo en la vista de administración */
  let _studioAccount = null;   // {id, display_name, avatar_url}
  let _studioChannel = null;   // datos del canal (subs, views, etc.)
  let _studioVideos = [];
  let _studioCanManage = false;

  async function authHeaders() {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token };
  }

  /* ---------- STUDIO: vista del canal (mini YouTube Studio) ---------- */

  async function studioApiCall(body) {
    const res = await fetch(FN_BASE + '/social-youtube-studio', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
  }

  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function isoDurationToText(iso) {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return '';
    const h = Number(m[1] || 0), min = Number(m[2] || 0), s = Number(m[3] || 0);
    return h ? h + ':' + String(min).padStart(2, '0') + ':' + String(s).padStart(2, '0') : min + ':' + String(s).padStart(2, '0');
  }

  async function openStudio(account) {
    _studioAccount = { id: account.id, display_name: account.display_name, avatar_url: account.avatar_url };
    _subTab = 'studio';
    switchSubTab('studio');
    const wrap = $('#contenidoStudio');
    if (wrap) wrap.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:16px 0;"><i class="fas fa-spinner fa-spin"></i> Cargando datos del canal…</p>';
    try {
      const [chInfo, vidsInfo] = await Promise.all([
        studioApiCall({ action: 'channel', account_id: account.id }),
        studioApiCall({ action: 'videos', account_id: account.id }),
      ]);
      _studioChannel = chInfo.channel;
      _studioCanManage = !!chInfo.can_manage;
      _studioVideos = vidsInfo.videos || [];
      renderStudio();
    } catch (err) {
      logError('Contenido: studio', err);
      if (wrap) wrap.innerHTML = '<p style="color:var(--danger);font-size:13px;padding:16px 0;">Error: ' + esc(err.message) + '</p>';
    }
  }

  function renderStudio() {
    const wrap = $('#contenidoStudio');
    if (!wrap || !_studioChannel) return;
    const ch = _studioChannel;
    const handleUrl = ch.handle ? 'https://www.youtube.com/@' + ch.handle.replace(/^@/, '') : 'https://www.youtube.com/channel/' + ch.id;

    const kpi = (icono, valor, label) =>
      '<div class="glass-panel" style="flex:1;min-width:160px;padding:18px;text-align:center;">' +
        '<div style="font-size:26px;color:var(--accent);margin-bottom:4px;"><i class="' + icono + '"></i></div>' +
        '<div style="font-size:22px;font-weight:700;">' + esc(fmtNum(valor)) + '</div>' +
        '<div style="font-size:12px;color:var(--text-dim);margin-top:2px;">' + esc(label) + '</div>' +
      '</div>';

    wrap.innerHTML =
      /* Header del canal — ancho completo */
      '<div class="glass-panel" style="display:flex;align-items:center;gap:20px;padding:22px;margin-bottom:16px;flex-wrap:wrap;">' +
        (ch.avatar ? '<img src="' + esc(ch.avatar) + '" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;flex-shrink:0;">' : '<i class="fab fa-youtube" style="font-size:48px;color:#FF0000;flex-shrink:0;"></i>') +
        '<div style="flex:1;min-width:220px;">' +
          '<div style="font-size:20px;font-weight:700;">' + esc(ch.title) + '</div>' +
          '<div style="font-size:13px;color:var(--text-dim);margin-top:2px;">Canal de YouTube · gestionado desde Bienenhaus</div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
          '<button type="button" id="studioPublishBtn" class="btn-luxury-action" style="padding:10px 18px;font-size:13px;"><i class="fas fa-plus"></i> Publicar</button>' +
          '<a href="' + esc(handleUrl) + '" target="_blank" rel="noopener" class="btn-luxury-action" style="padding:10px 18px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;"><i class="fas fa-arrow-up-right-from-square"></i> Ver canal</a>' +
          '<a href="' + esc(handleUrl + '/community') + '" target="_blank" rel="noopener" title="Los posts de la comunidad no tienen API oficial — se crean desde YouTube" class="btn-luxury-action" style="padding:10px 18px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;"><i class="fas fa-users"></i> Comunidad</a>' +
          '<button type="button" id="studioBackBtn" class="btn-luxury-action" style="padding:10px 18px;font-size:13px;"><i class="fas fa-arrow-left"></i> Volver</button>' +
        '</div>' +
      '</div>' +
      /* KPIs — ancho completo, 3 en fila */
      '<div style="display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap;">' +
        kpi('fas fa-users', ch.subscribers, 'Suscriptores') +
        kpi('fas fa-eye', ch.total_views, 'Vistas totales') +
        kpi('fas fa-video', ch.video_count, 'Videos') +
      '</div>' +
      (!_studioCanManage
        ? '<div class="glass-panel" style="padding:14px 18px;margin-bottom:16px;border-left:3px solid var(--warning);display:flex;align-items:center;gap:10px;">' +
            '<i class="fas fa-triangle-exclamation" style="color:var(--warning);font-size:16px;"></i>' +
            '<span style="font-size:13px;color:var(--text-secondary);">Modo solo lectura: reconectá la cuenta de YouTube desde la pestaña Cuentas para habilitar edición, borrado, programación y miniaturas.</span>' +
          '</div>'
        : '') +
      '<h3 style="margin:0 0 14px;font-size:16px;"><i class="fas fa-list"></i> Contenido del canal (' + _studioVideos.length + ')</h3>' +
      '<div id="studioVideos" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px;">' + renderStudioVideos() + '</div>';

    /* Acciones del header */
    const pubBtn = $('#studioPublishBtn');
    if (pubBtn) pubBtn.addEventListener('click', function () { switchSubTab('create'); });
    const backBtn = $('#studioBackBtn');
    if (backBtn) backBtn.addEventListener('click', function () { switchSubTab('accounts'); });
  }

  function renderStudioVideos() {
    if (!_studioVideos.length) {
      return '<p style="color:var(--text-dim);font-size:13px;padding:12px 0;">El canal no tiene videos todavía.</p>';
    }
    const PRIVACY = { public: ['Público', 'var(--success)'], private: ['Privado', 'var(--danger)'], unlisted: ['Oculto', 'var(--warning)'] };
    return _studioVideos.map(function (v) {
      const priv = PRIVACY[v.privacy] || [v.privacy, 'var(--text-dim)'];
      const fecha = window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(v.published_at) : (v.published_at || '');
      /* Tarjeta en grid: miniatura grande arriba, info + acciones abajo */
      return '<div class="glass-panel" style="padding:0;overflow:hidden;display:flex;flex-direction:column;">' +
        /* Miniatura a ancho completo de la tarjeta */
        (v.thumbnail
          ? '<div style="position:relative;aspect-ratio:16/9;background:rgba(255,255,255,0.03);">' +
              '<img src="' + esc(v.thumbnail) + '" alt="" style="width:100%;height:100%;object-fit:cover;" loading="lazy">' +
              (v.duration ? '<span style="position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,0.8);color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;">' + esc(isoDurationToText(v.duration)) + '</span>' : '') +
            '</div>'
          : '<div style="aspect-ratio:16/9;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;"><i class="fab fa-youtube" style="color:#FF0000;font-size:32px;"></i></div>') +
        /* Info */
        '<div style="padding:12px 14px;flex:1;display:flex;flex-direction:column;gap:8px;">' +
          '<div style="font-size:13.5px;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em;">' + esc(v.title) + '</div>' +
          '<div style="font-size:11.5px;color:var(--text-dim);display:flex;gap:14px;flex-wrap:wrap;">' +
            '<span title="Vistas"><i class="fas fa-eye"></i> ' + fmtNum(v.views) + '</span>' +
            '<span title="Likes"><i class="fas fa-thumbs-up"></i> ' + fmtNum(v.likes) + '</span>' +
            '<span title="Comentarios"><i class="fas fa-comment"></i> ' + fmtNum(v.comments) + '</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-dim);">' + esc(fecha) + '</div>' +
        '</div>' +
        /* Barra de acciones */
        '<div style="padding:8px 14px 12px;display:flex;align-items:center;gap:8px;border-top:1px solid rgba(255,255,255,0.04);">' +
          '<span style="font-size:10.5px;color:' + priv[1] + ';border:1px solid currentColor;border-radius:10px;padding:2px 10px;flex-shrink:0;margin-right:auto;">' + esc(priv[0]) + '</span>' +
          '<button type="button" class="btn-luxury-action" data-studio-edit="' + esc(v.id) + '" title="Editar título, descripción, tags, visibilidad y programación" style="padding:7px 11px;font-size:11px;"><i class="fas fa-pen"></i></button>' +
          '<a href="https://www.youtube.com/watch?v=' + esc(v.id) + '" target="_blank" rel="noopener" title="Ver en YouTube" class="btn-luxury-action" style="padding:7px 11px;font-size:11px;text-decoration:none;"><i class="fas fa-arrow-up-right-from-square"></i></a>' +
          '<button type="button" class="btn-luxury-action" data-studio-delete="' + esc(v.id) + '" data-studio-title="' + esc(v.title) + '" title="Borrar video (permanente)" style="padding:7px 11px;font-size:11px;color:var(--danger);"><i class="fas fa-trash-can"></i></button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function findStudioVideo(videoId) {
    return _studioVideos.find(function (v) { return v.id === videoId; }) || null;
  }

  /* ---------- STUDIO: editar video ---------- */

  function openStudioEditModal(v) {
    closeModalIfExists('studioEditOverlay');
    const ov = document.createElement('div');
    ov.id = 'studioEditOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
    const box = document.createElement('div');
    box.className = 'glass-panel';
    box.style.cssText = 'max-width:560px;width:100%;padding:24px;max-height:85vh;overflow-y:auto;';
    box.innerHTML =
      '<h3 style="margin:0 0 6px;font-size:16px;"><i class="fas fa-pen"></i> Editar video</h3>' +
      '<p style="margin:0 0 16px;font-size:12px;color:var(--text-dim);">' + esc(String(v.title).substring(0, 80)) + '</p>' +
      '<div style="margin-bottom:12px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Título</span>' +
      '<input id="steTitle" type="text" class="crm-field-input" maxlength="100" value="' + esc(v.title) + '" style="width:100%;"></div>' +
      '<div style="margin-bottom:12px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Descripción</span>' +
      '<textarea id="steDesc" rows="4" class="crm-field-input" maxlength="5000" style="width:100%;">' + esc(v.description || '') + '</textarea></div>' +
      '<div style="margin-bottom:12px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Tags SEO (coma)</span>' +
      '<input id="steTags" type="text" class="crm-field-input" value="' + esc((v.tags || []).join(', ')) + '" style="width:100%;"></div>' +
      '<div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:150px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Visibilidad</span>' +
        '<select id="stePrivacy" class="crm-field-input crm-field-input--select" style="width:100%;">' +
          '<option value="public"' + (v.privacy === 'public' ? ' selected' : '') + '>Público</option>' +
          '<option value="unlisted"' + (v.privacy === 'unlisted' ? ' selected' : '') + '>Oculto (link)</option>' +
          '<option value="private"' + (v.privacy === 'private' ? ' selected' : '') + '>Privado</option>' +
        '</select></div>' +
        '<div style="flex:1;min-width:180px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Programar publicación (opcional)</span>' +
        '<input id="stePublishAt" type="datetime-local" class="crm-field-input" style="width:100%;"></div>' +
      '</div>' +
      '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Miniatura (imagen JPG/PNG ≤ 2MB)</span>' +
      '<input id="steThumb" type="file" accept="image/jpeg,image/png" class="crm-field-input" style="width:100%;padding:8px;"></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button type="button" id="steCancel" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;">Cancelar</button>' +
        '<button type="button" id="steSave" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;"><i class="fas fa-floppy-disk"></i> Guardar</button>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModalIfExists('studioEditOverlay'); });
    box.querySelector('#steCancel').addEventListener('click', function () { closeModalIfExists('studioEditOverlay'); });

    box.querySelector('#steSave').addEventListener('click', async function () {
      const btn = this;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando…';
      try {
        const publishAt = (box.querySelector('#stePublishAt').value || '');
        await studioApiCall({
          action: 'video_update',
          account_id: _studioAccount.id,
          video_id: v.id,
          title: box.querySelector('#steTitle').value,
          description: box.querySelector('#steDesc').value,
          tags: box.querySelector('#steTags').value,
          privacy: box.querySelector('#stePrivacy').value,
          publish_at: publishAt || undefined,
        });
        /* Miniatura opcional — el update ya guardó lo demás: un fallo acá no revierte nada */
        const thumbFile = box.querySelector('#steThumb').files && box.querySelector('#steThumb').files[0];
        if (thumbFile) {
          const b64 = await new Promise(function (resolve) {
            const fr = new FileReader();
            fr.onload = function () { resolve(String(fr.result)); };
            fr.readAsDataURL(thumbFile);
          });
          await studioApiCall({ action: 'thumbnail', account_id: _studioAccount.id, video_id: v.id, thumbnail_base64: b64 });
        }
        showToast('Video actualizado.', 'success');
        closeModalIfExists('studioEditOverlay');
        openStudio(_studioAccount); // recargar
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar';
      }
    });
  }

  async function studioDeleteVideo(videoId, title) {
    if (!window.confirm('¿Borrar de YouTube "' + title.substring(0, 60) + '"?\n\nEsta acción es PERMANENTE y no se puede deshacer.')) return;
    try {
      await studioApiCall({ action: 'video_delete', account_id: _studioAccount.id, video_id: videoId });
      showToast('Video borrado del canal.', 'success');
      openStudio(_studioAccount); // recargar
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function closeModalIfExists(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
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
      /* STUDIO: click en la tarjeta del canal abre la administración completa
         del contenido — pedir del dueño 2026-10-27. */
      card.style.cursor = 'pointer';
      card.dataset.contenidoStudio = acc.id;
      card.innerHTML =
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;font-size:14px;">' + esc(acc.display_name) + '</div>' +
        '<div style="font-size:11.5px;color:var(--text-dim);">' + esc(meta.name) + ' · conectada' +
        (acc.last_publish_at ? ' · última: ' + (window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(acc.last_publish_at) : '') : '') +
        ' <i class="fas fa-arrow-right" style="font-size:9px;margin-left:2px;"></i></div>' +
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
    if (!PLATFORM_META[pid] || !PLATFORM_META[pid].available) {
      showToast('Esa red llega en las próximas fases.', 'info');
      return;
    }
    const fnName = pid === 'youtube' ? 'social-auth-youtube' : 'social-auth-' + pid;
    try {
      showToast('Abriendo autorización de ' + PLATFORM_META[pid].name + '...', 'info');
      const res = await fetch(FN_BASE + '/' + fnName, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ action: 'start' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      if (!json.url) throw new Error('La función no devolvió la URL de autorización');

      const w = 620, h = 640;
      const popup = window.open(json.url, 'social_oauth_' + pid,
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
    if (label) {
      const speedTxt = pct > 0 && pct < 100 ? ' — ' + txt : '';
      label.innerHTML = '<span>' + txt + '</span><span>' + pct + '%</span>';
    }
  }

  /* MEJORA 2026-10-27: feedback del archivo seleccionado + contadores de chars */
  function setupCreateFormUX() {
    const titleInput = $('#ytTitle');
    const titleCounter = $('#ytTitleCounter');
    const descInput = $('#ytDesc');
    const descCounter = $('#ytDescCounter');
    const fileInput = $('#ytFile');
    const fileInfo = $('#ytFileInfo');

    if (titleInput && titleCounter) {
      const updateTitle = () => {
        titleCounter.textContent = titleInput.value.length + '/100' + (titleInput.value.length > 90 ? ' ⚠' : '');
        titleCounter.style.color = titleInput.value.length > 90 ? 'var(--warning)' : 'var(--text-dim)';
      };
      titleInput.addEventListener('input', updateTitle);
      updateTitle();
    }
    if (descInput && descCounter) {
      const updateDesc = () => {
        descCounter.textContent = descInput.value.length + '/5000';
      };
      descInput.addEventListener('input', updateDesc);
      updateDesc();
    }
    if (fileInput && fileInfo) {
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) { fileInfo.style.display = 'none'; return; }
        const size = f.size >= 1024 * 1024 * 1024
          ? (f.size / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
          : (f.size / (1024 * 1024)).toFixed(0) + ' MB';
        const isVideo = !f.type || f.type.indexOf('video/') === 0;
        fileInfo.textContent = isVideo
          ? '✓ ' + f.name + ' (' + size + ')'
          : '⚠ "' + f.name + '" no parece ser un video (' + f.type + ')';
        fileInfo.style.color = isVideo ? 'var(--accent)' : 'var(--warning)';
        fileInfo.style.display = '';
      });
    }
  }

  /* ---------- Subida resumable directa a Google ----------
     Protocolo resumable de YouTube: en vez de un solo PUT con TODO el
     archivo (donde un micro-corte de red perdía la subida completa — bug
     de los Shorts "Error de red durante la subida"), se sube por chunks
     de 8 MB y, tras cada fallo, se le pregunta a Google cuántos bytes
     recibió (PUT vacío con header Content-Range "bytes * sobre TOTAL",
     que responde con un header Range) y se reanuda desde ahí.
     Los bytes ya subidos jamás se re-envían. */

  const YT_CHUNK_SIZE = 8 * 1024 * 1024;   // 8 MB (32 × 256 KB, mínimo del protocolo)
  const YT_CHUNK_TIMEOUT = 5 * 60 * 1000;  // por chunk — 8 MB tardan segundos
  const YT_MAX_STALLS = 8;                 // reintentos sin progreso antes de rendirse

  function ytPutChunk(sessionUrl, blob, contentRange) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUrl);
      xhr.setRequestHeader('Content-Range', contentRange);
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      xhr.timeout = YT_CHUNK_TIMEOUT;
      xhr.addEventListener('load', () => resolve(xhr));
      xhr.addEventListener('error', () => reject(new Error('network')));
      xhr.addEventListener('timeout', () => reject(new Error('network')));
      xhr.addEventListener('abort', () => reject(new Error('abort')));
      xhr.send(blob);
    });
  }

  /* ¿Cuántos bytes tiene guardados Google? PUT vacío (sin body) con el
     header Content-Range "bytes * sobre TOTAL". 200/201 = completo,
     308 = parcial con header Range: bytes=0-N. Error de consulta →
     received -1 (el caller reintenta). */
  async function ytQueryUploadStatus(sessionUrl, total) {
    try {
      const xhr = await ytPutChunk(sessionUrl, new Blob([]), 'bytes */' + total);
      if (xhr.status >= 200 && xhr.status < 300) {
        let resource = {};
        try { resource = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
        return { received: total, complete: true, resource };
      }
      const m = (xhr.getResponseHeader('Range') || '').match(/bytes=0-(\d+)/);
      return { received: m ? parseInt(m[1], 10) + 1 : 0, complete: false, resource: {} };
    } catch (_) {
      return { received: -1, complete: false, resource: {} };
    }
  }

  function ytSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function xhrUploadToGoogle(sessionUrl, file, onProgress) {
    const total = file.size;
    let offset = 0;
    let stalls = 0;
    const advance = (to) => { offset = to; stalls = 0; };
    while (offset < total) {
      const end = Math.min(offset + YT_CHUNK_SIZE, total) - 1;
      try {
        const xhr = await ytPutChunk(sessionUrl, file.slice(offset, end + 1), 'bytes ' + offset + '-' + end + '/' + total);
        if (xhr.status >= 200 && xhr.status < 300) {
          /* Último chunk aceptado: Google responde con el recurso del video. */
          advance(total);
          if (onProgress) onProgress(total, total);
          try { return JSON.parse(xhr.responseText || '{}'); } catch (_) { return {}; }
        }
        if (xhr.status === 308) {
          /* Chunk aceptado (o parcial): el header Range dice cuánto quedó. */
          const m = (xhr.getResponseHeader('Range') || '').match(/bytes=0-(\d+)/);
          const serverHas = m ? parseInt(m[1], 10) + 1 : 0;
          if (serverHas > offset) advance(serverHas); else stalls++;
        } else {
          /* 4xx/5xx: consultar cuánto recibió y reanudar. */
          const st = await ytQueryUploadStatus(sessionUrl, total);
          if (st.complete) { advance(total); if (onProgress) onProgress(total, total); return st.resource; }
          if (st.received > offset) advance(st.received); else stalls++;
        }
      } catch (e) {
        if (e.message === 'abort') {
          throw new Error('La subida se interrumpió porque la página se cerró o recargó. Volvé a intentarlo.');
        }
        const st = await ytQueryUploadStatus(sessionUrl, total);
        if (st.complete) { advance(total); if (onProgress) onProgress(total, total); return st.resource; }
        if (st.received > offset) advance(st.received); else stalls++;
      }
      if (onProgress) onProgress(offset, total);
      if (stalls >= YT_MAX_STALLS) {
        throw new Error('La conexión falló varias veces seguidas. Verificá tu red y volvé a intentarlo.');
      }
      if (stalls > 0) await ytSleep(Math.min(1000 * Math.pow(2, stalls - 1), 30000));
    }
    return {};
  }

  async function publishToYoutube() {
    if (_publishing) return;
    const accountId = ($('#ytAccountSelect') || {}).value || '';
    const title = (($('#ytTitle') || {}).value || '').trim();
    const description = (($('#ytDesc') || {}).value || '').trim();
    const tags = (($('#ytTags') || {}).value || '').trim();
    const privacy = (($('#ytPrivacy') || {}).value || 'public');
    const publishAt = (($('#ytPublishAt') || {}).value || '').trim();
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
    /* Programación: si se setea, validar que es futura y usar privacy=private
       + publishAt (YouTube lo pasa a público automáticamente en ese momento). */
    if (publishAt) {
      const d = new Date(publishAt);
      if (isNaN(d.getTime()) || d.getTime() < Date.now() + 5 * 60_000) {
        showToast('La fecha de programación debe ser al menos 5 minutos en el futuro.', 'warning'); return;
      }
    }

    _publishing = true;
    let postId = null;      // registro en social_posts (fail + heartbeat)
    let hbTimer = null;     // heartbeat de updated_at durante la subida
    const btn = $('#ytPublishBtn');
    const btnHtml = btn ? btn.innerHTML : '';
    /* Bloquear todo el form durante la subida */
    ['ytTitle', 'ytDesc', 'ytTags', 'ytFile', 'ytPrivacy', 'ytPublishAt', 'ytAccountSelect'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
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
          publish_at: publishAt || undefined,
        }),
      });
      const init = await initRes.json().catch(() => ({}));
      if (!initRes.ok) throw new Error(init.error || ('HTTP ' + initRes.status));
      if (!init.session_url || !init.post_id) throw new Error('La función no devolvió la sesión de subida');
      postId = init.post_id;

      /* Heartbeat: mientras la subida está viva refresca updated_at del post
         para que el zombie sweep del historial (30 min sin latido) no lo
         marque fallado aunque un video grande tarde horas. */
      hbTimer = setInterval(() => {
        getAuthedClient().then((c) => {
          if (c && postId) return c.from('social_posts').update({ updated_at: new Date().toISOString() }).eq('id', postId);
        }).catch(() => {});
      }, 60000);

      /* 2. subida directa del navegador a Google (los bytes nunca pasan por Supabase) */
      setUploadProgress(2, 'Subiendo a YouTube…');
      const uploaded = await xhrUploadToGoogle(init.session_url, file, (loaded, t) => {
        const pct = Math.min(95, Math.round((loaded / t) * 95));
        setUploadProgress(pct, Math.round((loaded / t) * 100) + '% subido...');
      });
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
      showToast(publishAt ? 'Video programado para ' + new Date(publishAt).toLocaleString('es-AR') + '.' : 'Video publicado en YouTube.', 'success');
      if (done.url && !publishAt) window.open(done.url, '_blank', 'noopener');
      $('#ytTitle').value = '';
      $('#ytDesc').value = '';
      $('#ytTags').value = '';
      if ($('#ytPublishAt')) $('#ytPublishAt').value = '';
      if (fileInput) fileInput.value = '';
      if ($('#ytFileInfo')) $('#ytFileInfo').style.display = 'none';
      loadHistory();
      loadAccounts(); // refresca last_publish_at
    } catch (err) {
      logError('Contenido: publish', err);
      /* Marcar el post como fallado en el acto — sin esto quedaba 'publishing'
         y el historial mostraba un estado mentiroso hasta el zombie sweep. */
      if (postId) {
        try {
          await fetch(FN_BASE + '/social-publish-youtube', {
            method: 'POST',
            headers: await authHeaders(),
            body: JSON.stringify({ action: 'fail', post_id: postId, upload_error: err.message }),
          });
        } catch (_) { /* best-effort — el sweep lo cubre */ }
      }
      showToast(err.message, 'error');
      setUploadProgress(0, '');
      if (progressWrap) progressWrap.style.display = 'none';
    } finally {
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      _publishing = false;
      ['ytTitle', 'ytDesc', 'ytTags', 'ytFile', 'ytPrivacy', 'ytPublishAt', 'ytAccountSelect'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });
      if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
    }
  }

  /* ---------- Historial ---------- */

  async function loadHistory() {
    const wrap = $('#contenidoHistory');
    if (!wrap) return;
    const client = await getAuthedClient();
    if (!client) return;

    /* Posts zombis: una subida viva emite un heartbeat cada 60s (updated_at).
       30 min SIN latido = navegador cerrado/colgado a mitad de la subida →
       failed. No se usa created_at: un video grande legítimo puede tardar
       horas y un sweep por edad lo marcaba fallado en vivo (falso positivo). */
    try {
      await client.from('social_posts')
        .update({ status: 'failed', error: 'Subida interrumpida (el navegador se cerró antes de terminar).' })
        .eq('status', 'publishing')
        .lt('updated_at', new Date(Date.now() - 30 * 60_000).toISOString());
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
    const views = { accounts: '#contenidoAccounts', create: '#contenidoCreate', history: '#contenidoHistory', studio: '#contenidoStudio' };
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
      '<div id="contenidoStudio" style="display:none;"></div>' +
      '<div id="contenidoCreate" style="display:none;">' +
        '<div class="glass-panel" style="padding:24px;max-width:900px;">' +
          '<h3 style="margin:0 0 4px;font-size:16px;"><i class="fab fa-youtube" style="color:#FF0000;"></i> Publicar video en YouTube</h3>' +
          '<p style="margin:0 0 20px;font-size:12px;color:var(--text-dim);">El video sube directo de tu navegador a Google — sin pasar por el servidor.</p>' +
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Canal</span>' +
          '<select id="ytAccountSelect" class="crm-field-input crm-field-input--select" style="width:100%;"></select></div>' +
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Título * <span id="ytTitleCounter" style="color:var(--text-dim);font-size:11px;float:right;"></span></span>' +
          '<input id="ytTitle" type="text" class="crm-field-input" maxlength="100" placeholder="Ej: Departamento 2 ambientes Nueva Córdoba — TOUR COMPLETO" style="width:100%;"></div>' +
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Descripción (con hashtags para SEO) <span id="ytDescCounter" style="color:var(--text-dim);font-size:11px;float:right;"></span></span>' +
          '<textarea id="ytDesc" rows="5" class="crm-field-input" maxlength="5000" placeholder="Descripción del video + #hashtags…" style="width:100%;"></textarea></div>' +
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Tags SEO (separados por coma)</span>' +
          '<input id="ytTags" type="text" class="crm-field-input" placeholder="inmobiliaria córdoba, departamentos, nueva córdoba" style="width:100%;"></div>' +
          '<div style="display:flex;gap:14px;margin-bottom:16px;flex-wrap:wrap;">' +
            '<div style="flex:2;min-width:250px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Video (máx. 2 GB)</span>' +
            '<input id="ytFile" type="file" accept="video/*" class="crm-field-input" style="width:100%;padding:8px;">' +
            '<div id="ytFileInfo" style="font-size:11px;color:var(--accent);margin-top:4px;display:none;"></div></div>' +
            '<div style="flex:1;min-width:140px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Visibilidad</span>' +
            '<select id="ytPrivacy" class="crm-field-input crm-field-input--select">' +
              '<option value="public">Público</option>' +
              '<option value="unlisted">Oculto (link)</option>' +
              '<option value="private">Privado</option>' +
            '</select></div>' +
            '<div style="flex:1;min-width:180px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Programar (opcional)</span>' +
            '<input id="ytPublishAt" type="datetime-local" class="crm-field-input" style="width:100%;"></div>' +
          '</div>' +
          '<div id="ytProgress" style="display:none;margin-bottom:16px;">' +
            '<div style="height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;">' +
              '<div id="ytUploadBar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),#2DE2DA);border-radius:4px;transition:width .3s;"></div>' +
            '</div>' +
            '<div id="ytUploadPct" style="font-size:12px;color:var(--text-dim);margin-top:6px;display:flex;justify-content:space-between;"></div>' +
          '</div>' +
          '<button type="button" id="ytPublishBtn" class="btn-luxury-action" style="padding:12px 28px;font-size:14px;"><i class="fas fa-paper-plane"></i> Publicar en YouTube</button>' +
        '</div>' +
      '</div>' +
      '<div id="contenidoHistory" style="display:none;"></div>';
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
      /* STUDIO: click en la tarjeta del canal → administración del contenido */
      const studioCard = e.target.closest('[data-contenido-studio]');
      if (studioCard) {
        const acc = _accounts.find(a => a.id === studioCard.dataset.contenidoStudio);
        if (acc) openStudio(acc);
        return;
      }
      const sub = e.target.closest('#contenidoSubTabs button[data-sub]');
      if (sub) { switchSubTab(sub.dataset.sub); return; }
      if (e.target.closest('#ytPublishBtn')) publishToYoutube();
      const del = e.target.closest('[data-contenido-delete]');
      if (del) { deletePost(del.dataset.contenidoDelete); return; }
      /* STUDIO: acciones sobre videos del canal */
      const editBtn = e.target.closest('[data-studio-edit]');
      if (editBtn) {
        const v = findStudioVideo(editBtn.dataset.studioEdit);
        if (v) openStudioEditModal(v);
        return;
      }
      const delVid = e.target.closest('[data-studio-delete]');
      if (delVid) { studioDeleteVideo(delVid.dataset.studioDelete, delVid.dataset.studioTitle || ''); return; }
    });
  }

  async function loadContenido() {
    if (!window.supabaseClient) return;
    renderShell();
    bindOnce();
    setupCreateFormUX(); // contadores de chars + feedback de archivo
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
