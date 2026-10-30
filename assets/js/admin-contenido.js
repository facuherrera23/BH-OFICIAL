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

  /* ============================================================
     MEJORAS 2026-10-30 — lote pedido por el dueño. Estado + consts.
     Todo lo persistente usa localStorage/sessionStorage o claves
     existentes (social_posts.content JSONB, app_settings): NO hay
     migraciones en este lote (MCP Supabase caído ese día).
     ============================================================ */
  let _studioQ = '';          // #25: búsqueda de la grilla del studio
  let _studioSort = 'recent'; // #25: orden
  let _studioFilter = 'all';  // #25: filtro (incluye "sin vistas" #27)
  let _ytHistory = [];        // #22/#23: snapshots diarios [{d, v:{videoId:views}}]
  let _createProps = [];      // #1: listado para el vínculo con propiedades
  let _lastHistory = [];      // #3/#42: data cruda del historial para copiar/reintentar

  const YT_TPL_KEY = 'bh_yt_templates';   // #2: plantillas locales
  const YT_QUOTA_KEY = 'bh_yt_quota';     // #44: HUD de cuota (estimación local)
  const YT_SNAP_DAY_KEY = 'bh_yt_snapshot_day'; // #22: 1 snapshot por día
  const YT_CTA_AUTO_KEY = 'bh_yt_cta_auto';     // #11: preferencia del auto-CTA
  const YT_LAST_ACCOUNT_KEY = 'bh_yt_last_account'; // MEJORA: recordar el último canal

  /* Subida en curso (para cancelar) */
  let _uploadCancelled = false;
  let _activeXhr = null;

  /* #18: campos bloqueados durante la subida (UNA constante para las dos
     pasadas lock/unlock — antes eran arrays repetidos que divergían). */
  const LOCK_IDS = ['ytTitle', 'ytDesc', 'ytTags', 'ytFile', 'ytPrivacy', 'ytPublishAt',
    'ytAccountSelect', 'ytProperty', 'ytPropertySearch', 'ytTemplateSel', 'ytKeyword', 'ytCtaAuto', 'ytTitleBank'];

  /* #45/#46...: frases probadas para el final del título (#16). */
  const TITLE_BANK = [
    'TOUR COMPLETO 4K', 'Recorrida completa habitaciones', '¿Cuánto cuesta? El precio al final',
    'PROS y CONTRAS reales', 'Antes de viajar, mirá esto', '3 razones para elegirla',
    'Consejos de inversión inmobiliaria', 'Todo lo que hay que saber', 'Visitala sin salir de casa',
  ];

  /* #11/#17: hashtags institucionales fijos (contrato con el motor: 3, dentro de 3–5). */
  const CTA_HASHTAGS = '#bienenhaus #inmobiliariacordoba #propiedades';

  /* #44: unidades estimadas por acción (Google cobra así: todo request suma,
     incluso los que fallan). Estimación conservadora para el HUD local. */
  const STUDIO_QUOTA = {
    channel: 3, videos: 6, video_update: 50, video_delete: 55, thumbnail: 52,
    playlists: 25, playlist_create: 50, playlist_item_add: 50, playlist_item_remove: 50,
    snapshot: 8, analytics: 5, platforms_config: 1,
  };

  let _accounts = [];
  let _platformConfig = {};   // { youtube: true, instagram: false, ... } — redes con app OAuth configurada
  let _pendingPropertyId = null; // propiedad a re-seleccionar cuando carga el picker
  let _subTab = 'accounts';
  let _bound = false;
  let _publishing = false;
  let _seoBound = false;   // listeners del panel Score SEO ya colgados (shell no se re-renderiza)
  /* Studio: canal activo en la vista de administración */
  let _studioAccount = null;   // {id, display_name, avatar_url}
  let _studioChannel = null;   // datos del canal (subs, views, etc.)
  let _studioVideos = [];
  let _studioCanManage = false;
  let _studioTotal = 0;      // videos reales del canal (el server pagina hasta 100)
  let _studioTruncated = false;
  let _studioViews = 'all';  // filtro por cantidad de vistas
  let _studioAge = 'all';    // filtro por antigüedad de publicación

  async function authHeaders() {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('No hay sesión activa');
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token };
  }

  /* ---------- STUDIO: vista del canal (mini YouTube Studio) ---------- */

  /* Timeout de las llamadas al Edge Function: sin él, un request colgado
     (o una Edge Function dormida) deja la UI en "Cargando…" para siempre. */
  const YT_FN_TIMEOUT = 30000;

  /* #44: cuota estimada — trackea la unidad de la acción recién hecha
     (Google suma unidades aunque el request falle en su lado). */
  async function studioApiCall(body) {
    const units = STUDIO_QUOTA[body.action] || 5;
    const headers = await authHeaders();
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, YT_FN_TIMEOUT);
    let res;
    try {
      res = await fetch(FN_BASE + '/social-youtube-studio', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      trackQuota(units); // el request ya salió: la unidad se consume esté o no OK de Google
      if (err && err.name === 'AbortError') throw new Error('La consulta a YouTube tardó demasiado — revisá la conexión e intentá de nuevo.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
    trackQuota(units); // el request ya salió: la unidad se consume esté o no OK de Google
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
  }

  /* ---------- helpers de mejoras 2026-10-30 ---------- */

  /* normalización decrecida/insensible — mismo criterio que el motor SEO */
  function bhNorm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /* seteo programático de un campo + dispara 'input' para que los
     contadores y el score SEO reaccionen igual que al escribir. */
  function setFieldValue(id, v) {
    const el = document.getElementById(id);
    if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }

  /* #9: formateo de ETA y velocidad */
  function fmtEta(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    if (sec < 90) return '≈ ' + Math.round(sec) + ' s restantes';
    if (sec < 5400) return '≈ ' + Math.round(sec / 60) + ' min restantes';
    return '≈ ' + (sec / 3600).toFixed(1) + ' h restantes';
  }
  function fmtSpeed(bps) {
    if (!bps || bps <= 0) return '';
    if (bps >= 1024 * 1024) return (bps / (1024 * 1024)).toFixed(1) + ' MB/s';
    return Math.round(bps / 1024) + ' KB/s';
  }

  /* ISO → valor de <input type="datetime-local"> (hora local del navegador) */
  function toLocalInput(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '';
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* Copiar texto al portapapeles con fallback (clipboard API exige contexto
     seguro; el panel puede abrirse por http en algunos accesos). */
  async function copyText(text) {
    const val = String(text || '');
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

  /* #44: HUD de cuota — acumulador LOCAL por día (no hay API de quota
     con OAuth de canal: la proyección es del lado del navegador). */
  function getQuotaToday() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const q = JSON.parse(localStorage.getItem(YT_QUOTA_KEY) || 'null');
      return q && q.date === today && typeof q.used === 'number' ? q.used : 0;
    } catch (_) { return 0; }
  }
  function trackQuota(units) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const q = { date: today, used: getQuotaToday() + units };
      localStorage.setItem(YT_QUOTA_KEY, JSON.stringify(q));
      renderQuotaHud();
    } catch (_) { /* la cuota HUD jamás rompe el flujo */ }
  }
  function renderQuotaHud() {
    const el = $('#ytQuotaHud');
    if (!el) return;
    const used = getQuotaToday();
    const pct = Math.min(100, Math.round(used / 100));
    const color = used >= 9000 ? 'var(--danger)' : (used >= 6000 ? 'var(--warning)' : 'var(--accent)');
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-bottom:4px;">' +
        '<span><i class="fas fa-gauge-high"></i> Cuota API estimada hoy (local)</span>' +
        '<span style="color:' + color + ';">' + used + ' / 10.000</span>' +
      '</div>' +
      '<div style="height:5px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden;">' +
        '<div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:3px;"></div>' +
      '</div>';
  }

  /* #30: cache del studio en sessionStorage (5 min) — edit/borrar/miniatura/
     publicar la invalidan. Refresca sin re-descargar en navegación ida y vuelta. */
  const STUDIO_CACHE_PREFIX = 'bh_yt_studio_';
  const STUDIO_CACHE_TTL = 5 * 60 * 1000;
  function studioCacheRead(accountId) {
    try {
      const raw = sessionStorage.getItem(STUDIO_CACHE_PREFIX + accountId);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || typeof c.ts !== 'number' || Date.now() - c.ts > STUDIO_CACHE_TTL) return null;
      return c && c.chan ? c : null;
    } catch (_) { return null; }
  }
  function studioCacheWrite(accountId, chan, vids, can) {
    try {
      sessionStorage.setItem(STUDIO_CACHE_PREFIX + accountId, JSON.stringify({ ts: Date.now(), chan: chan, vids: vids, can: !!can }));
    } catch (_) { /* storage lleno → sigue sin cache */ }
  }
  function studioInvalidate() {
    try {
      const drop = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.indexOf(STUDIO_CACHE_PREFIX) === 0) drop.push(k);
      }
      drop.forEach(function (k) { sessionStorage.removeItem(k); });
    } catch (_) {}
  }

  /* #22: carga la historia del snapshot diaria (app_settings JSONB). */
  async function loadYtHistory() {
    try {
      const client = await getAuthedClient();
      if (!client) return;
      const { data, error } = await client
        .from('app_settings')
        .select('value')
        .eq('key', 'social_yt_stats_history')
        .maybeSingle();
      if (error) return;
      const v = data && data.value;
      _ytHistory = Array.isArray(v) ? v : [];
    } catch (_) { /* best-effort */ }
  }

  /* #22: snapshot diario — 1× por día por navegador (guard sessionStorage).
     El trabajo pesado corre server-side en el studio; el cliente solo lo
     dispara y refresca la historia para los sparklines. Best-effort:
     el fallo de la captura jamás rompe la navegación. */
  async function maybeDailySnapshot() {
    try {
      if (!_studioAccount) return;
      const today = new Date().toISOString().slice(0, 10);
      if (sessionStorage.getItem(YT_SNAP_DAY_KEY) === today) return;
      await studioApiCall({ action: 'snapshot', account_id: _studioAccount.id });
      sessionStorage.setItem(YT_SNAP_DAY_KEY, today);
      _ytHistory = [];
      await loadYtHistory();
      renderTrendPanel();
    } catch (_) { /* snapshot best-effort — no molestar ante fallos */ }
  }

  /* serie de views para sparkline: los snapshots donde aparece el video */
  function sparkPointsFor(videoId, maxDays) {
    const data = _ytHistory.slice(-(maxDays || 14))
      .map(function (e) { return e && e.v ? e.v[videoId] : undefined; })
      .filter(function (x) { return typeof x === 'number'; });
    return data.length >= 2 ? data : null;
  }

  function buildSparkSvg(vals, w, h, color) {
    if (!vals || vals.length < 2) return '';
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);
    const span = (max - min) || 1;
    const n = vals.length;
    const pts = vals.map(function (val, i) {
      const x = n === 1 ? w / 2 : (i / (n - 1)) * (w - 2) + 1;
      const y = h - 2 - ((val - min) / span) * (h - 4);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const up = vals[n - 1] >= vals[0];
    const col = color || (up ? 'var(--success)' : 'var(--warning)');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" style="flex-shrink:0;" aria-hidden="true">' +
      '<polyline fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" points="' + pts + '"></polyline></svg>';
  }

  /* #22: tendencia del canal — SVG simple desde los snapshots */
  function renderTrendPanel() {
    const el = $('#ytTrend');
    if (!el) return;
    const vals = _ytHistory.slice(-30)
      .map(function (e) { return e && e.v ? Object.keys(e.v).reduce(function (a, k) { return a + (e.v[k] || 0); }, 0) : 0; })
      .filter(function (x) { return x > 0; });
    if (vals.length < 2) {
      el.innerHTML =
        '<div class="glass-panel" style="padding:14px 18px;font-size:12px;color:var(--text-dim);">' +
        '<i class="fas fa-chart-line"></i> Tendencia diaria del canal: se llena sola con los snapshots diarios (1 captura por día).</div>';
      return;
    }
    const delta = vals[vals.length - 1] - vals[0];
    el.innerHTML =
      '<div class="glass-panel" style="padding:14px 18px;margin-bottom:16px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;flex-wrap:wrap;">' +
          '<span style="font-size:12.5px;color:var(--text-dim);"><i class="fas fa-chart-line"></i> Vistas acumuladas (' + vals.length + ' días de historia)</span>' +
          '<span style="font-size:12px;color:' + (delta >= 0 ? 'var(--success)' : 'var(--danger)') + ';">' + (delta >= 0 ? '+' : '') + fmtNum(delta) + ' en el período</span>' +
        '</div>' +
        '<div style="width:100%">' + buildSparkSvgWide(vals, 200, 44) + '</div>' +
      '</div>';
  }

  /* sparkline ancho del trend: mismo builder, viewBox estirado a 100% */
  function buildSparkSvgWide(vals, w, h) {
    const svg = buildSparkSvg(vals, w, h);
    return svg ? svg.replace('<svg ', '<svg preserveAspectRatio="none" style="width:100%;height:44px;display:block;" ') : '';
  }

  /* #14: top de tags históricos del canal (con vistas arriba = más peso).
     Fuente: inventario del studio cargado + posts del historial. */
  function channelTopTags() {
    const freq = new Map(); // clave normalizada → {raw, w}
    const add = function (tag, w) {
      tag = String(tag || '').trim();
      const n = bhNorm(tag);
      if (!n) return;
      const cur = freq.get(n) || { raw: tag, w: 0 };
      cur.w += w;
      freq.set(n, cur);
    };
    _studioVideos.forEach(function (v) {
      const bonus = 1 + Math.min(4, Math.log10(1 + (v.views || 0)) / 2);
      (v.tags || []).forEach(function (t, i) { add(t, (i === 0 ? 3 : 1) * bonus); });
    });
    _lastHistory.forEach(function (p) {
      const c = p && p.content;
      if (c && Array.isArray(c.tags)) c.tags.forEach(function (t, i) { add(t, i === 0 ? 2 : 1); });
    });
    return Array.from(freq.values()).sort(function (a, b) { return b.w - a.w; }).slice(0, 12).map(function (e) { return e.raw; });
  }

  /* MEJORA: los tags que YA rindieron en el canal, como chips de un clic
     (antes había que acordarse de ellos o copiarlos del Studio a mano). */
  function renderChannelTags() {
    const box = $('#ytChannelTags');
    if (!box) return;
    const tags = channelTopTags();
    if (!tags.length) { box.innerHTML = ''; return; }
    box.innerHTML =
      '<div style="font-size:10.5px;color:var(--text-dim);margin-bottom:5px;"><i class="fas fa-tags"></i> Tags que ya rindieron en tu canal (clic para agregar):</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
      tags.map(function (t) {
        return '<button type="button" class="btn-luxury-action" data-yt-tag="' + esc(t) + '" style="padding:4px 9px;font-size:10.5px;">' + esc(t) + '</button>';
      }).join('') +
      '</div>';
  }

  /* Si el Studio ya se abrió (o quedó cacheado en esta sesión), los tags del
     canal están disponibles sin volver a pegarle a la API de YouTube. */
  function restoreStudioCacheForTags() {
    if (_studioVideos.length) return;
    const acc = _accounts.find(function (a) { return a.platform === 'youtube' && a.status === 'active'; });
    if (!acc) return;
    const cached = studioCacheRead(acc.id);
    if (cached && Array.isArray(cached.vids) && cached.vids.length) _studioVideos = cached.vids;
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

  /* #30: openStudio usa cache sessionStorage de 5 min (studioCacheRead) —
     force=true saltea el cache (se pasa tras editar/borrar/miniatura/publicar).
     postload: historia del canal (sparklines), panel de métricas #21 y el
     snapshot diario #22 — todos best-effort en paralelo. */
  async function openStudio(account, force) {
    _studioAccount = { id: account.id, display_name: account.display_name, avatar_url: account.avatar_url };
    _subTab = 'studio';
    _studioQ = '';
    _studioSort = 'recent';
    _studioFilter = 'all';
    switchSubTab('studio');
    const wrap = $('#contenidoStudio');

    const cached = force ? null : studioCacheRead(account.id);
    if (cached && cached.chan && Array.isArray(cached.vids)) {
      _studioChannel = cached.chan;
      _studioCanManage = !!cached.can;
      _studioVideos = cached.vids;
      _studioTotal = cached.vids.length;
      _studioTruncated = false;
      renderStudio();
      renderChannelTags();
      loadStudioAux();
      return;
    }

    if (wrap) wrap.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:16px 0;"><i class="fas fa-spinner fa-spin"></i> Cargando datos del canal…</p>';
    try {
      const [chInfo, vidsInfo] = await Promise.all([
        studioApiCall({ action: 'channel', account_id: account.id }),
        studioApiCall({ action: 'videos', account_id: account.id, max: 100 }),
      ]);
      _studioChannel = chInfo.channel;
      _studioCanManage = !!chInfo.can_manage;
      _studioVideos = vidsInfo.videos || [];
      /* REPARACIÓN: el inventario antes se truncaba a 50 sin avisar. Ahora el
         server pagina hasta 100 y devuelve el total real del canal. */
      _studioTotal = Number(vidsInfo.total || _studioVideos.length);
      _studioTruncated = !!vidsInfo.truncated;
      studioCacheWrite(account.id, _studioChannel, _studioVideos, _studioCanManage);
      renderStudio();
      renderChannelTags(); // MEJORA: el inventario real del canal alimenta los chips de tags
      loadStudioAux();
    } catch (err) {
      logError('Contenido: studio', err);
      if (wrap) wrap.innerHTML = '<p style="color:var(--danger);font-size:13px;padding:16px 0;">Error: ' + esc(err.message) + '</p>';
    }
  }

  /* follow-ups del studio que no bloquean el render */
  function loadStudioAux() {
    maybeDailySnapshot();
    loadYtHistory().then(function () {
      renderTrendPanel();
      renderStudioVideosGrid(); // los sparklines por-card necesitan la historia (#23)
    });
    loadAnalyticsPanel();
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
          /* MEJORA: forzar el refresh del inventario (el cache de 5 min
             escondía los videos recién publicados en YouTube Studio). */
          '<button type="button" id="studioRefreshBtn" class="btn-luxury-action" title="Volver a pedir el inventario a YouTube (ignora el caché)" style="padding:10px 18px;font-size:13px;"><i class="fas fa-rotate"></i> Actualizar</button>' +
          '<a href="' + esc(handleUrl) + '" target="_blank" rel="noopener" class="btn-luxury-action" style="padding:10px 18px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;"><i class="fas fa-arrow-up-right-from-square"></i> Ver canal</a>' +
          '<a href="' + esc(handleUrl + '/community') + '" target="_blank" rel="noopener" title="Los posts de la comunidad no tienen API oficial — se crean desde YouTube" class="btn-luxury-action" style="padding:10px 18px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;"><i class="fas fa-users"></i> Comunidad</a>' +
          '<button type="button" id="studioBackBtn" class="btn-luxury-action" style="padding:10px 18px;font-size:13px;"><i class="fas fa-arrow-left"></i> Volver</button>' +
        '</div>' +
      '</div>' +
      /* KPIs — ancho completo, 3 en fila */
      '<div style="display:flex;gap:14px;margin-bottom:16px;flex-wrap:wrap;">' +
        kpi('fas fa-users', ch.subscribers, 'Suscriptores') +
        kpi('fas fa-eye', ch.total_views, 'Vistas totales') +
        kpi('fas fa-video', ch.video_count, 'Videos') +
      '</div>' +
      /* MEJORAS 2026-10-30: métricas #21, tendencia #22 y calendario #46 */
      '<div id="ytAnalyticsPanel" style="margin-bottom:16px;"></div>' +
      '<div id="ytTrend" style="margin-bottom:16px;"></div>' +
      studioMonthGridHtml() +
      (!_studioCanManage
        ? '<div class="glass-panel" style="padding:14px 18px;margin-bottom:16px;border-left:3px solid var(--warning);display:flex;align-items:center;gap:10px;">' +
            '<i class="fas fa-triangle-exclamation" style="color:var(--warning);font-size:16px;"></i>' +
            '<span style="font-size:13px;color:var(--text-secondary);">Modo solo lectura: reconectá la cuenta de YouTube desde la pestaña Cuentas para habilitar edición, borrado, programación y miniaturas.</span>' +
          '</div>'
        : '') +
      /* #25: barra de búsqueda/orden/filtro y export (#28) */
      (_studioTruncated
        ? '<div class="glass-panel" style="padding:10px 14px;margin-bottom:12px;border-left:3px solid var(--warning);font-size:12px;color:var(--text-secondary);">' +
            '<i class="fas fa-triangle-exclamation" style="color:var(--warning);margin-right:6px;"></i>Mostrando ' + _studioVideos.length + ' de ' + _studioTotal + ' videos del canal (el inventario carga hasta 100 por vez).' +
          '</div>'
        : '') +
      '<div style="display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap;">' +
        '<h3 style="margin:0;font-size:16px;flex-shrink:0;"><i class="fas fa-list"></i> Contenido (<span id="studioCount">' + _studioVideos.length + '</span>)</h3>' +
        '<div style="flex:1;"></div>' +
        '<input id="studioSearch" type="text" placeholder="Buscar título o tag…" class="crm-field-input" style="max-width:220px;padding:8px 12px;font-size:12px;">' +
        '<select id="studioSort" class="crm-field-input crm-field-input--select" style="width:auto;font-size:12px;padding:8px;">' +
          '<option value="recent">Más recientes</option>' +
          '<option value="old">Más antiguos</option>' +
          '<option value="views">Más vistas</option>' +
          '<option value="likes">Más likes</option>' +
          '<option value="comments">Más comentarios</option>' +
        '</select>' +
        '<select id="studioFilter" class="crm-field-input crm-field-input--select" style="width:auto;font-size:12px;padding:8px;">' +
          '<option value="all">Todos</option>' +
          '<option value="public">Públicos</option>' +
          '<option value="private">Privados</option>' +
          '<option value="unlisted">Ocultos</option>' +
          '<option value="processing">Procesando</option>' +
          '<option value="dead">Sin vistas +30 días</option>' +
        '</select>' +
        /* MEJORA: filtros por rendimiento y antigüedad (el dueño pregunta
           "¿cuáles rinden?" — con 100 videos no se filtraba a mano). */
        '<select id="studioViews" class="crm-field-input crm-field-input--select" style="width:auto;font-size:12px;padding:8px;" title="Filtrar por cantidad de vistas">' +
          '<option value="all">Vistas: todas</option>' +
          '<option value="0">0 vistas</option>' +
          '<option value="1-999">1 – 999</option>' +
          '<option value="1k-9k">1.000 – 9.999</option>' +
          '<option value="10k+">10.000+</option>' +
        '</select>' +
        '<select id="studioAge" class="crm-field-input crm-field-input--select" style="width:auto;font-size:12px;padding:8px;" title="Filtrar por antigüedad">' +
          '<option value="all">Antigüedad: todas</option>' +
          '<option value="7">Últimos 7 días</option>' +
          '<option value="30">Últimos 30 días</option>' +
          '<option value="90">Últimos 90 días</option>' +
          '<option value="365">Último año</option>' +
        '</select>' +
        '<button type="button" id="studioCsv" class="btn-luxury-action" title="Descargar inventario filtrado en CSV" style="padding:8px 12px;font-size:11px;"><i class="fas fa-file-csv"></i> CSV</button>' +
      '</div>' +
      '<div id="studioVideos" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:14px;">' + renderStudioVideos() + '</div>';

    /* Acciones del header */
    const pubBtn = $('#studioPublishBtn');
    if (pubBtn) pubBtn.addEventListener('click', function () { switchSubTab('create'); });
    const refreshBtn = $('#studioRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      studioInvalidate();
      if (_studioAccount) openStudio(_studioAccount, true);
    });
    const backBtn = $('#studioBackBtn');
    if (backBtn) backBtn.addEventListener('click', function () { switchSubTab('accounts'); });

    /* #25: toolbar — re-render SOLO de la grilla (el resto del studio queda) */
    const search = $('#studioSearch');
    if (search) search.addEventListener('input', function () {
      _studioQ = this.value;
      renderStudioVideosGrid();
    });
    const sortSel = $('#studioSort');
    if (sortSel) sortSel.addEventListener('change', function () { _studioSort = this.value; renderStudioVideosGrid(); });
    const filterSel = $('#studioFilter');
    if (filterSel) filterSel.addEventListener('change', function () { _studioFilter = this.value; renderStudioVideosGrid(); });
    const viewsSel = $('#studioViews');
    if (viewsSel) viewsSel.addEventListener('change', function () { _studioViews = this.value; renderStudioVideosGrid(); });
    const ageSel = $('#studioAge');
    if (ageSel) ageSel.addEventListener('change', function () { _studioAge = this.value; renderStudioVideosGrid(); });
    const csvBtn = $('#studioCsv');
    if (csvBtn) csvBtn.addEventListener('click', downloadStudioCsv);
  }

  /* #25: filtro/orden de la grilla; #27 "dead" = 0 vistas con más de 30 días */
  function filteredStudioVideos() {
    let list = _studioVideos.slice();
    const q = bhNorm(_studioQ).trim();
    if (q) {
      list = list.filter(function (v) {
        return bhNorm(v.title || '').indexOf(q) >= 0 ||
          (v.tags || []).some(function (t) { return bhNorm(t).indexOf(q) >= 0; });
      });
    }
    if (_studioFilter === 'public') list = list.filter(function (v) { return v.privacy === 'public'; });
    else if (_studioFilter === 'private') list = list.filter(function (v) { return v.privacy === 'private'; });
    else if (_studioFilter === 'unlisted') list = list.filter(function (v) { return v.privacy === 'unlisted'; });
    else if (_studioFilter === 'processing') list = list.filter(function (v) { return v.upload_status && v.upload_status !== 'processed'; });
    else if (_studioFilter === 'dead') {
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      list = list.filter(function (v) { return v.views === 0 && v.published_at && new Date(v.published_at).getTime() < cutoff; });
    }
    /* MEJORA: filtro por volumen de vistas */
    if (_studioViews && _studioViews !== 'all') {
      list = list.filter(function (v) {
        const n = Number(v.views || 0);
        if (_studioViews === '0') return n === 0;
        if (_studioViews === '1-999') return n >= 1 && n < 1000;
        if (_studioViews === '1k-9k') return n >= 1000 && n < 10000;
        if (_studioViews === '10k+') return n >= 10000;
        return true;
      });
    }
    /* MEJORA: filtro por antigüedad de publicación */
    if (_studioAge && _studioAge !== 'all') {
      const days = Number(_studioAge);
      const cutoff = Date.now() - days * 24 * 3600 * 1000;
      list = list.filter(function (v) {
        if (!v.published_at) return false;
        const t = new Date(v.published_at).getTime();
        return !isNaN(t) && t >= cutoff;
      });
    }
    const sorters = {
      recent: function (a, b) { return new Date(b.published_at || 0) - new Date(a.published_at || 0); },
      old: function (a, b) { return new Date(a.published_at || 0) - new Date(b.published_at || 0); },
      views: function (a, b) { return (b.views || 0) - (a.views || 0); },
      likes: function (a, b) { return (b.likes || 0) - (a.likes || 0); },
      comments: function (a, b) { return (b.comments || 0) - (a.comments || 0); },
    };
    if (sorters[_studioSort]) list.sort(sorters[_studioSort]);
    return list;
  }

  /* re-render SOLO de la grilla + contador (toolbar ya está colgada) */
  function renderStudioVideosGrid() {
    const grid = document.getElementById('studioVideos');
    if (!grid) return;
    const filtered = filteredStudioVideos();
    grid.innerHTML = renderStudioVideos(filtered);
    const count = document.getElementById('studioCount');
    if (count) count.textContent = filtered.length === _studioVideos.length
      ? String(_studioVideos.length)
      : filtered.length + ' de ' + _studioVideos.length;
  }

  function renderStudioVideos(source) {
    const list = (Array.isArray(source) && source) ? source : filteredStudioVideos();
    if (!_studioVideos.length) {
      return '<p style="color:var(--text-dim);font-size:13px;padding:12px 0;">El canal no tiene videos todavía.</p>';
    }
    if (!list.length) {
      return '<p style="color:var(--text-dim);font-size:13px;padding:12px 0;">Ningún video coincide con la búsqueda o el filtro.</p>';
    }
    const PRIVACY = { public: ['Público', 'var(--success)'], private: ['Privado', 'var(--danger)'], unlisted: ['Oculto', 'var(--warning)'] };
    return list.map(function (v) {
      const priv = PRIVACY[v.privacy] || [v.privacy, 'var(--text-dim)'];
      const fecha = window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(v.published_at) : (v.published_at || '');
      /* #24: badge de subida en procesamiento (upload_status del server) */
      const processing = v.upload_status && v.upload_status !== 'processed';
      const sparkData = sparkPointsFor(v.id, 14); // #23
      /* REPARACIÓN: sin youtube.force-ssl (can_manage=false) los botones de
         editar/borrar se mostraban igual → el server respondía 403 y el dueño
         veía un error. Ahora se ocultan y el aviso de "solo lectura" explica
         cómo habilitarlo. */
      const manageActions = _studioCanManage
        ? '<button type="button" class="btn-luxury-action" data-studio-edit="' + esc(v.id) + '" title="Editar título, descripción, tags, visibilidad y programación" style="padding:7px 11px;font-size:11px;"><i class="fas fa-pen"></i></button>' +
          '<button type="button" class="btn-luxury-action" data-studio-delete="' + esc(v.id) + '" data-studio-title="' + esc(v.title) + '" title="Borrar video (permanente)" style="padding:7px 11px;font-size:11px;color:var(--danger);"><i class="fas fa-trash-can"></i></button>'
        : '';
      /* Tarjeta en grid: miniatura grande arriba, info + acciones abajo */
      return '<div class="glass-panel" style="padding:0;overflow:hidden;display:flex;flex-direction:column;">' +
        /* Miniatura a ancho completo de la tarjeta */
        (v.thumbnail
          ? '<div data-studio-detail="' + esc(v.id) + '" style="position:relative;aspect-ratio:16/9;background:rgba(255,255,255,0.03);cursor:pointer;">' +
              '<img src="' + esc(v.thumbnail) + '" alt="" style="width:100%;height:100%;object-fit:cover;" loading="lazy">' +
              (v.duration ? '<span style="position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,0.8);color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;">' + esc(isoDurationToText(v.duration)) + '</span>' : '') +
              (processing ? '<span style="position:absolute;top:8px;left:8px;background:rgba(30,44,60,0.9);color:#fff;font-size:10.5px;padding:3px 10px;border-radius:999px;"><i class="fas fa-spinner fa-spin"></i> Procesando…</span>' : '') +
            '</div>'
          : '<div data-studio-detail="' + esc(v.id) + '" style="aspect-ratio:16/9;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;cursor:pointer;"><i class="fab fa-youtube" style="color:#FF0000;font-size:32px;"></i></div>') +
        /* Info */
        '<div style="padding:12px 14px;flex:1;display:flex;flex-direction:column;gap:8px;cursor:pointer;" data-studio-detail="' + esc(v.id) + '">' +
          '<div style="font-size:13.5px;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em;">' + esc(v.title) + '</div>' +
          '<div style="display:flex;align-items:center;gap:12px;font-size:11.5px;color:var(--text-dim);flex-wrap:wrap;">' +
            '<span title="Vistas"><i class="fas fa-eye"></i> ' + fmtNum(v.views) + '</span>' +
            '<span title="Likes"><i class="fas fa-thumbs-up"></i> ' + fmtNum(v.likes) + '</span>' +
            '<span title="Comentarios"><i class="fas fa-comment"></i> ' + fmtNum(v.comments) + '</span>' +
            (sparkData ? '<span title="Tendencia de las últimas 2 semanas">' + buildSparkSvg(sparkData, 62, 18) + '</span>' : '') +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-dim);">' + esc(fecha) + '</div>' +
        '</div>' +
        /* Barra de acciones */
        '<div style="padding:8px 14px 12px;display:flex;align-items:center;gap:8px;border-top:1px solid rgba(255,255,255,0.04);">' +
          '<span style="font-size:10.5px;color:' + priv[1] + ';border:1px solid currentColor;border-radius:10px;padding:2px 10px;flex-shrink:0;margin-right:auto;">' + esc(priv[0]) + '</span>' +
          '<button type="button" class="btn-luxury-action" data-studio-detail="' + esc(v.id) + '" title="Detalles, playlists y métricas del video" style="padding:7px 11px;font-size:11px;"><i class="fas fa-circle-info"></i></button>' +
          /* MEJORA: copiar el link desde la card (sin abrir el detalle) */
          '<button type="button" class="btn-luxury-action" data-studio-copy="' + esc(v.id) + '" title="Copiar el link del video" style="padding:7px 11px;font-size:11px;"><i class="fas fa-link"></i></button>' +
          manageActions +
          '<a href="https://www.youtube.com/watch?v=' + esc(v.id) + '" target="_blank" rel="noopener" title="Ver en YouTube" class="btn-luxury-action" style="padding:7px 11px;font-size:11px;text-decoration:none;"><i class="fas fa-arrow-up-right-from-square"></i></a>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* #28: export CSV del inventario filtrado (sep ';' + BOM = Excel es-AR) */
  function downloadStudioCsv() {
    const rows = [
      ['Titulo', 'Video ID', 'URL', 'Fecha', 'Privacidad', 'Estado upload', 'Duracion', 'Vistas', 'Likes', 'Comentarios', 'Tags'],
    ];
    filteredStudioVideos().forEach(function (v) {
      rows.push([
        v.title || '', v.id || '', 'https://www.youtube.com/watch?v=' + v.id,
        v.published_at || '', v.privacy || '', v.upload_status || '',
        isoDurationToText(v.duration || ''), v.views || 0, v.likes || 0, v.comments || 0,
        (v.tags || []).join(' | '),
      ]);
    });
    if (rows.length <= 1) { showToast('Nada para exportar con este filtro.', 'warning'); return; }
    const csv = '\uFEFF' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(';');
    }).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'youtube-inventario-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* #46: grilla del mes en curso — solo lectura; estrena = fecha publishedAt
     (para programas privados con publishAt, YouTube setea publishedAt a la
     fecha programada, así que la grilla también los muestra). Sin estrenos
     no ocupa espacio. */
  function studioMonthGridHtml() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const byDay = {};
    let estrenos = 0;
    _studioVideos.forEach(function (v) {
      const d = v.published_at ? new Date(v.published_at) : null;
      if (d && d.getFullYear() === y && d.getMonth() === m) {
        const dd = d.getDate();
        byDay[dd] = (byDay[dd] || 0) + 1;
        estrenos++;
      }
    });
    if (!estrenos) return '';
    const monthName = now.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // lunes primero
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < offset; i++) cells += '<div></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      cells += '<div style="font-size:10.5px;color:var(--text-dim);text-align:center;position:relative;padding:2px 0;">' + d +
        (byDay[d] ? '<i class="fas fa-circle" style="position:absolute;left:50%;transform:translateX(-50%);bottom:0;font-size:5px;color:var(--accent);"></i>' : '') +
        '</div>';
    }
    return '<div id="ytMonthGrid" class="glass-panel" style="padding:14px 18px;margin-bottom:16px;">' +
      '<div style="font-size:12.5px;color:var(--text-dim);margin-bottom:10px;"><i class="fas fa-calendar"></i> ' + esc(monthName) + ' · ' + estrenos + ' estreno(s)</div>' +
      '<div style="display:grid;grid-template-columns:repeat(7,34px);gap:2px;max-width:300px;">' + cells + '</div>' +
      '</div>';
  }

  /* #21: métricas del canal (28 días). Sin scope de analytics → banner de
     reconexión (needs_reconnect, contrato del Edge Function). El panel vacío
     en otros errores: la métrica es un extra, no un bloqueante. */
  async function loadAnalyticsPanel() {
    const el = $('#ytAnalyticsPanel');
    if (!el || !_studioAccount) return;
    el.innerHTML = '<p style="font-size:12px;color:var(--text-dim);"><i class="fas fa-spinner fa-spin"></i> Cargando métricas…</p>';
    try {
      const res = await studioApiCall({ action: 'analytics', account_id: _studioAccount.id });
      const t = res.totals || {};
      const stat = function (val, label) {
        return '<div style="flex:1;min-width:110px;">' +
          '<div style="font-size:20px;font-weight:700;">' + esc(fmtNum(Number(val) || 0)) + '</div>' +
          '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + esc(label) + '</div>' +
        '</div>';
      };
      const statRaw = function (text, label) {
        return '<div style="flex:1;min-width:110px;">' +
          '<div style="font-size:20px;font-weight:700;">' + esc(text) + '</div>' +
          '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + esc(label) + '</div>' +
        '</div>';
      };
      const avgNum = Number(t.avg_view_seconds) || 0;
      const avgTxt = Math.floor(avgNum / 60) + ':' + String(Math.round(avgNum % 60)).padStart(2, '0');
      el.innerHTML =
        '<div class="glass-panel" style="padding:14px 18px;">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap;">' +
            '<span style="font-size:12.5px;color:var(--text-dim);"><i class="fas fa-chart-simple"></i> Últimos 28 días' + (res.range ? ' (' + esc(res.range.start) + ' → ' + esc(res.range.end) + ')' : '') + '</span>' +
            '<span style="font-size:11px;color:var(--text-dim);">YouTube Analytics</span>' +
          '</div>' +
          '<div style="display:flex;gap:14px;flex-wrap:wrap;">' +
            stat(t.views, 'Vistas') +
            stat(t.watch_minutes, 'Minutos vistos') +
            statRaw(avgTxt, 'Duración prom. vista') +
            stat(t.subscribers_gained, 'Suscriptores ganados') +
          '</div>' +
        '</div>';
    } catch (err) {
      if (/needs_reconnect/.test(String(err.message))) {
        el.innerHTML =
          '<div class="glass-panel" style="padding:14px 18px;border-left:3px solid var(--info,var(--accent));display:flex;align-items:center;gap:10px;">' +
            '<i class="fas fa-plug-circle-exclamation" style="color:var(--accent);font-size:16px;"></i>' +
            '<span style="font-size:12.5px;color:var(--text-secondary);">Las métricas avanzadas piden un permiso nuevo (analítica). Desconectá la cuenta y conectala de nuevo en Cuentas — es una sola vez; el resto del canal sigue funcionando.</span>' +
          '</div>';
      } else {
        el.innerHTML = '';
      }
    }
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
    box.style.cssText = 'max-width:640px;width:100%;padding:24px;max-height:85vh;overflow-y:auto;';
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
        '<input id="stePublishAt" type="datetime-local" class="crm-field-input" style="width:100%;">' +
        '<span id="steSchedHint" style="display:block;font-size:10.5px;color:var(--text-dim);margin-top:4px;line-height:1.4;"></span></div>' +
      '</div>' +
      '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Miniatura (imagen JPG/PNG ≤ 2MB)</span>' +
      '<input id="steThumb" type="file" accept="image/jpeg,image/png" class="crm-field-input" style="width:100%;padding:8px;"></div>' +
      /* MEJORA #13: keyword + competencia del canal + delta de score (#20) */
      '<div id="steKwInfo" style="font-size:11px;color:var(--text-dim);border-top:1px solid rgba(255,255,255,0.06);margin-top:2px;padding-top:8px;"></div>' +
      /* MEJORA 2026-10-30: Score SEO en vivo dentro del modal (motor yt-seo-score.js) */
      '<div id="steSeoBody" style="border-top:1px solid rgba(255,255,255,0.06);margin-top:2px;padding-top:10px;"></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button type="button" id="steCancel" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;">Cancelar</button>' +
        '<button type="button" id="steSave" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;"><i class="fas fa-floppy-disk"></i> Guardar</button>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModalIfExists('studioEditOverlay'); });
    box.querySelector('#steCancel').addEventListener('click', function () { closeModalIfExists('studioEditOverlay'); });

    /* REPARACIÓN: la programación real del video no se veía nunca (el server
       no la devolvía y el input quedaba vacío) → el dueño no sabía si un
       video estaba programado. Ahora se muestra la fecha real, y si cambia
       la visibilidad a pública la programación se limpia (si no, YouTube
       deja el video en "privado programado" que nunca se publica). */
    const schedInput = box.querySelector('#stePublishAt');
    const schedHint = box.querySelector('#steSchedHint');
    const privSel = box.querySelector('#stePrivacy');
    if (schedInput) {
      schedInput.value = toLocalInput(v.publish_at);
      const syncSchedHint = function () {
        if (!schedHint) return;
        const val = schedInput.value;
        if (val) {
          const d = new Date(val);
          if (isNaN(d.getTime())) { schedHint.textContent = ''; return; }
          schedHint.textContent = 'Se publica el ' + d.toLocaleString('es-AR') + ' — YouTube lo hace público solo en ese momento.';
          return;
        }
        schedHint.textContent = v.publish_at
          ? 'Este video estaba programado. Si borrás la fecha, queda privado.'
          : '';
      };
      syncSchedHint();
      schedInput.addEventListener('change', syncSchedHint);
      if (privSel) {
        privSel.addEventListener('change', function () {
          if (this.value !== 'private' && schedInput.value) schedInput.value = '';
          syncSchedHint();
        });
      }
    }

    /* Score SEO en vivo dentro del modal: título/desc/tags del video → score + sugerencias.
       La SERP preview muestra el nombre del canal real del Studio.
       MEJORAS #13/#20: cannibalización (keyword vs resto del canal) + delta
       contra el score guardado al publicar (social_posts.content.seo_score). */
    const steSeoBody = box.querySelector('#steSeoBody');
    const steKwInfo = box.querySelector('#steKwInfo');
    let stePrevScore = null;

    recomputeStudioSeoPrevScore();
    async function recomputeStudioSeoPrevScore() {
      try {
        const client = await getAuthedClient();
        if (!client) return;
        const { data, error } = await client
          .from('social_posts')
          .select('content')
          .eq('external_post_id', v.id)
          .order('created_at', { ascending: false })
          .limit(1);
        if (!error && data && data[0] && data[0].content) {
          const prev = data[0].content.seo_score;
          stePrevScore = typeof prev === 'number' ? prev : null;
          renderSteKwInfo();
        }
      } catch (_) { /* el delta es best-effort */ }
    }

    function renderSteKwInfo() {
      if (!steKwInfo || !window.BH_YT_SEO || typeof window.BH_YT_SEO.calc !== 'function') return;
      const r = window.BH_YT_SEO.calc({
        title: box.querySelector('#steTitle').value,
        description: box.querySelector('#steDesc').value,
        tags: box.querySelector('#steTags').value,
        keyword: '',
      });
      const parts = [];
      if (r.keyword) {
        /* #13: ¿la keyword choca con otros videos del canal? (título/tags) */
        const kw = bhNorm(r.keyword);
        const conflicts = _studioVideos.filter(function (o) {
          if (o.id === v.id) return false;
          const hay = bhNorm(String(o.title || '') + ' ' + (o.tags || []).join(' '));
          return hay.indexOf(kw) >= 0;
        }).length;
        parts.push('Keyword «' + esc(r.keyword) + '»' + (conflicts > 0
          ? ' · <span style="color:var(--warning);">coincide con ' + conflicts + ' otro(s) video(s) del canal — variá el enfoque para no competir entre ustedes</span>'
          : ' · sin competencia dentro del canal'));
      }
      if (stePrevScore !== null && r.score > 0) {
        const delta = r.score - stePrevScore;
        parts.push('Al publicar: ' + stePrevScore + '/100 → ahora: ' + r.score + '/100 (' + (delta >= 0 ? '+' : '') + delta + ')');
      }
      steKwInfo.innerHTML = parts.length ? parts.join(' · ') : '';
    }

    const recomputeStudioSeo = function () {
      if (!steSeoBody || !window.BH_YT_SEO || typeof window.BH_YT_SEO.render !== 'function') return;
      window.BH_YT_SEO.render(steSeoBody, {
        title: box.querySelector('#steTitle').value,
        description: box.querySelector('#steDesc').value,
        tags: box.querySelector('#steTags').value,
        keyword: '',
        channelName: (_studioChannel && _studioChannel.title) || 'Bienenhaus Propiedades',
        onTagsChange: function (newTags) {
          const t = box.querySelector('#steTags');
          if (t) { t.value = newTags; recomputeStudioSeo(); }
        },
      });
      renderSteKwInfo();
    };
    ['steTitle', 'steDesc', 'steTags'].forEach(function (id) {
      const el = box.querySelector('#' + id);
      if (el) el.addEventListener('input', recomputeStudioSeo);
    });
    recomputeStudioSeo();

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
        studioInvalidate(); // #30: el cache ya es obsoleto tras una edición
        openStudio(_studioAccount, true); // recargar con datos frescos
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar';
      }
    });
  }

  async function studioDeleteVideo(videoId, title) {
    /* MEJORA #45: confirmación con consecuencias en claro (links muertos). */
    if (!window.confirm('Borrar "' + title.substring(0, 60) + '" de YouTube.\n\nPERMANENTE: los links compartidos hacia este video quedan muertos y no hay papelera. ¿Seguro?')) return;
    try {
      await studioApiCall({ action: 'video_delete', account_id: _studioAccount.id, video_id: videoId });
      showToast('Video borrado del canal.', 'success');
      studioInvalidate(); // #30
      openStudio(_studioAccount, true); // recargar
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /* ---------- STUDIO: detalle de video (#26) ----------
     Modal completo del video: miniatura grande, stats, tags, sparkline
     histórico, métricas por video (analytics con filters=video==ID),
     playlists (agregar/quitar/crear) y acciones de compartir/admin. */
  function openStudioVideoDetail(v) {
    closeModalIfExists('studioDetailOverlay');
    const ov = document.createElement('div');
    ov.id = 'studioDetailOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
    const box = document.createElement('div');
    box.className = 'glass-panel';
    box.style.cssText = 'max-width:760px;width:100%;padding:24px;max-height:88vh;overflow-y:auto;';
    const PRIVACY_TXT = { public: 'Público', private: 'Privado', unlisted: 'Oculto (link)' };
    const priv = PRIVACY_TXT[v.privacy] || String(v.privacy || '');
    const fecha = window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(v.published_at) : (v.published_at || '');
    const sparkFull = sparkPointsFor(v.id, 30);
    const tagsChips = (v.tags || []).map(function (t) {
      return '<span style="font-size:10.5px;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);color:var(--text-secondary);">' + esc(t) + '</span>';
    }).join('');
    const watchUrl = 'https://www.youtube.com/watch?v=' + v.id;
    const processing = v.upload_status && v.upload_status !== 'processed';

    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;">' +
        '<div style="min-width:0;">' +
          '<h3 style="margin:0 0 4px;font-size:16px;line-height:1.35;">' + esc(v.title) + '</h3>' +
          '<span style="font-size:11px;color:var(--text-dim);">' + esc(fecha) + ' · ' + esc(priv) +
            (processing ? ' · <span style="color:var(--warning);"><i class="fas fa-spinner fa-spin"></i> procesando</span>' : '') + '</span>' +
        '</div>' +
        '<button type="button" id="steDetailClose" class="btn-luxury-action" title="Cerrar" style="padding:7px 11px;font-size:11px;flex-shrink:0;"><i class="fas fa-times"></i></button>' +
      '</div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px;">' +
        '<div style="flex:2;min-width:280px;">' +
          '<a href="' + esc(watchUrl) + '" target="_blank" rel="noopener" title="Ver en YouTube">' +
          (v.thumbnail
            ? '<img src="' + esc(v.thumbnail) + '" alt="" style="width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:10px;">'
            : '<div style="width:100%;aspect-ratio:16/9;border-radius:10px;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;"><i class="fab fa-youtube" style="color:#FF0000;font-size:40px;"></i></div>') +
          '</a>' +
          '<div style="display:flex;gap:16px;font-size:12px;color:var(--text-dim);margin-top:10px;flex-wrap:wrap;">' +
            '<span><i class="fas fa-eye"></i> <b>' + esc(fmtNum(v.views)) + '</b> vistas</span>' +
            '<span><i class="fas fa-thumbs-up"></i> <b>' + esc(fmtNum(v.likes)) + '</b> likes</span>' +
            '<span><i class="fas fa-comment"></i> <b>' + esc(fmtNum(v.comments)) + '</b> comentarios</span>' +
            '<span><i class="fas fa-clock"></i> ' + esc(isoDurationToText(v.duration || '')) + '</span>' +
          '</div>' +
        '</div>' +
        '<div style="flex:3;min-width:260px;">' +
          '<div style="font-size:10.5px;color:var(--text-dim);font-weight:600;margin-bottom:6px;"><i class="fas fa-tags"></i> TAGS (' + (v.tags || []).length + ')</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">' + (tagsChips || '<span style="font-size:11px;color:var(--text-dim);">sin tags</span>') + '</div>' +
          (sparkFull
            ? '<div style="font-size:10.5px;color:var(--text-dim);margin-bottom:4px;"><i class="fas fa-chart-line"></i> Vistas · ' + sparkFull.length + ' puntos de historia</div>' +
              '<div>' + buildSparkSvgWide(sparkFull, 200, 44) + '</div>'
            : '') +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
            (_studioCanManage
              ? '<button type="button" id="steDetailOpen" class="btn-luxury-action" style="padding:8px 14px;font-size:11.5px;"><i class="fas fa-pen"></i> Editar datos</button>'
              : '') +
            '<a href="https://studio.youtube.com/video/' + esc(v.id) + '/edit" target="_blank" rel="noopener" title="Abrir en YouTube Studio" class="btn-luxury-action" style="padding:8px 14px;font-size:11.5px;text-decoration:none;"><i class="fas fa-sliders"></i> Studio</a>' +
            '<button type="button" id="steCopyLink" class="btn-luxury-action" title="Copiar link del video" style="padding:8px 14px;font-size:11.5px;"><i class="fas fa-link"></i> Copiar link</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="steDetailAna" style="margin:10px 0 6px;border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;"></div>' +
      '<div id="stePlaylists" style="border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;margin-top:6px;"></div>';

    ov.appendChild(box);
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModalIfExists('studioDetailOverlay'); });
    box.querySelector('#steDetailClose').addEventListener('click', function () { closeModalIfExists('studioDetailOverlay'); });

    /* #26 lazy: métricas del video + playlists a pedido */
    loadVideoAnalytics(box, v);
    loadPlaylistsBlock(box, v);

    /* delegación de acciones dentro del modal */
    box.addEventListener('click', async function (e) {
      const addBtn = e.target.closest('[data-pl-add]');
      if (addBtn) {
        addBtn.disabled = true;
        try {
          await studioApiCall({ action: 'playlist_item_add', account_id: _studioAccount.id, playlist_id: addBtn.dataset.plAdd, video_id: v.id });
          showToast('Video agregado a la playlist.', 'success');
          studioInvalidate(); // el cache de playlists ya no sirve
          loadPlaylistsBlock(box, v);
        } catch (err) { addBtn.disabled = false; showToast(err.message, 'error'); }
        return;
      }
      const remBtn = e.target.closest('[data-pl-remove]');
      if (remBtn) {
        remBtn.disabled = true;
        try {
          await studioApiCall({ action: 'playlist_item_remove', account_id: _studioAccount.id, item_id: remBtn.dataset.plRemove });
          showToast('Video quitado de la playlist.', 'success');
          studioInvalidate();
          loadPlaylistsBlock(box, v);
        } catch (err) { remBtn.disabled = false; showToast(err.message, 'error'); }
        return;
      }
      if (e.target.closest('#stePlCreate')) {
        const btn = box.querySelector('#stePlCreate');
        const input = box.querySelector('#stePlTitle');
        const plTitle = (input && input.value.trim()) || '';
        if (!plTitle) { showToast('Poné un nombre a la playlist.', 'warning'); return; }
        btn.disabled = true;
        try {
          const res = await studioApiCall({ action: 'playlist_create', account_id: _studioAccount.id, playlist_title: plTitle });
          if (res.playlist_id) {
            await studioApiCall({ action: 'playlist_item_add', account_id: _studioAccount.id, playlist_id: res.playlist_id, video_id: v.id });
          }
          showToast('Playlist creada con el video dentro.', 'success');
          studioInvalidate();
          loadPlaylistsBlock(box, v);
        } catch (err) { btn.disabled = false; showToast(err.message, 'error'); }
        return;
      }
      if (e.target.closest('#steCopyLink')) {
        try {
          await navigator.clipboard.writeText(watchUrl);
          showToast('Link copiado.', 'success');
        } catch (_) { showToast('No se pudo copiar el link.', 'error'); }
        return;
      }
      if (e.target.closest('#steDetailOpen')) {
        closeModalIfExists('studioDetailOverlay');
        openStudioEditModal(v);
      }
    });
  }

  /* #26 lazy: métricas del video individual (filters=video==ID en server) */
  async function loadVideoAnalytics(box, v) {
    const wrap = box.querySelector('#steDetailAna');
    if (!wrap) return;
    wrap.innerHTML =
      '<button type="button" id="steAnaBtn" class="btn-luxury-action" style="padding:8px 14px;font-size:11.5px;"><i class="fas fa-chart-simple"></i> Métricas de YouTube Analytics (28 días)</button>' +
      '<div id="steDetailAnaBody" style="margin-top:8px;"></div>';
    wrap.querySelector('#steAnaBtn').addEventListener('click', async function () {
      const btn = this;
      btn.disabled = true;
      const body = box.querySelector('#steDetailAnaBody');
      if (body) body.innerHTML = '<p style="font-size:11.5px;color:var(--text-dim);"><i class="fas fa-spinner fa-spin"></i> Consultando…</p>';
      try {
        const res = await studioApiCall({ action: 'analytics', account_id: _studioAccount.id, video_id: v.id });
        const t = res.totals || {};
        const avgNum = Number(t.avg_view_seconds) || 0;
        if (body) {
          body.innerHTML =
            '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;">' +
              '<span><b>' + esc(fmtNum(Number(t.views) || 0)) + '</b> <span style="color:var(--text-dim);">vistas</span></span>' +
              '<span><b>' + esc(fmtNum(Number(t.watch_minutes) || 0)) + '</b> <span style="color:var(--text-dim);">min vistos</span></span>' +
              '<span><b>' + esc(Math.floor(avgNum / 60) + ':' + String(Math.round(avgNum % 60)).padStart(2, '0')) + '</b> <span style="color:var(--text-dim);">dur. prom.</span></span>' +
              '<span><b>' + esc(fmtNum(Number(t.subscribers_gained) || 0)) + '</b> <span style="color:var(--text-dim);">subs</span></span>' +
            '</div>' +
            '<div style="font-size:10.5px;color:var(--text-dim);margin-top:4px;">28 días · YouTube Analytics</div>';
        }
        btn.style.display = 'none';
      } catch (err) {
        if (body) {
          body.innerHTML = /needs_reconnect/.test(String(err.message))
            ? '<p style="font-size:11.5px;color:var(--text-dim);">Sin permiso de analítica — reconectá la cuenta (ver aviso del canal).</p>'
            : '<p style="font-size:11.5px;color:var(--danger);">' + esc(err.message) + '</p>';
        }
        btn.disabled = false;
      }
    });
  }

  /* #26 lazy: playlists del canal con estado del video en cada una.
     Reordenar posición nativa del item se hace con remove+insert del item. */
  async function loadPlaylistsBlock(box, video) {
    const wrap = box.querySelector('#stePlaylists');
    if (!wrap) return;
    wrap.innerHTML = '<p style="font-size:11.5px;color:var(--text-dim);"><i class="fas fa-spinner fa-spin"></i> Cargando playlists…</p>';
    try {
      const res = await studioApiCall({ action: 'playlists', account_id: _studioAccount.id });
      const pls = res.playlists || [];
      const rows = pls.map(function (p) {
        const mine = (p.items || []).find(function (it) { return it.video_id === video.id; });
        /* REPARACIÓN: sin permiso de administración los botones de quitar/
           agregar fallaban con 403 → se muestran solo si se puede administrar. */
        const action = !_studioCanManage
          ? (mine ? '<span style="font-size:10px;color:var(--text-dim);">En la lista</span>' : '')
          : (mine
            ? '<button type="button" data-pl-remove="' + esc(String(mine.item_id || '')) + '" class="btn-luxury-action" style="padding:6px 10px;font-size:10.5px;color:var(--warning);"><i class="fas fa-circle-minus"></i> En la lista — quitar</button>'
            : '<button type="button" data-pl-add="' + esc(String(p.id || '')) + '" class="btn-luxury-action" style="padding:6px 10px;font-size:10.5px;"><i class="fas fa-circle-plus"></i> Agregar</button>');
        return '<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed rgba(255,255,255,0.05);">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:12.5px;font-weight:600;">' + esc(p.title) + '</div>' +
            '<div style="font-size:10.5px;color:var(--text-dim);">' + Number(p.video_count || 0) + ' videos</div>' +
          '</div>' + action +
        '</div>';
      }).join('');
      wrap.innerHTML =
        '<div style="font-size:10.5px;color:var(--text-dim);font-weight:600;margin-bottom:6px;"><i class="fas fa-layer-group"></i> PLAYLISTS DEL CANAL</div>' +
        (rows || '<p style="font-size:12px;color:var(--text-dim);padding:2px 0 8px;">El canal no tiene playlists — creá la primera acá abajo.</p>') +
        (_studioCanManage
          ? '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;">' +
              '<input id="stePlTitle" type="text" class="crm-field-input" maxlength="60" placeholder="Nueva playlist (queda privada)…" style="flex:1;min-width:180px;">' +
              '<button type="button" id="stePlCreate" class="btn-luxury-action" style="padding:8px 12px;font-size:11px;"><i class="fas fa-plus"></i> Crear</button>' +
            '</div>'
          : '<p style="font-size:11px;color:var(--text-dim);margin-top:10px;"><i class="fas fa-lock"></i> Reconectá la cuenta para modificar las playlists.</p>');
    } catch (err) {
      wrap.innerHTML = '<p style="font-size:12px;color:var(--danger);">No se pudieron cargar las playlists: ' + esc(err.message) + '</p>';
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
    /* REPARACIÓN: el estado de "configurada" de cada red se consulta antes de
       pintar las tarjetas (si no, "Conectar" aparecía para redes sin app).
       NO bloquea el render: si la Edge Function está lenta, las cuentas
       conectadas se ven igual (y el estado de redes se actualiza al rato). */
    renderAccounts();
    renderCreateAccountOptions();
    loadPlatformsConfig().then(function () { renderAccounts(); });
  }

  /* ¿Qué redes tienen credenciales OAuth configuradas? (app_settings
     social_<plataforma> o env). Best-effort: si la consulta falla se asume
     que están configuradas (comportamiento anterior). */
  async function loadPlatformsConfig() {
    try {
      const res = await studioApiCall({ action: 'platforms_config' });
      const map = {};
      (res.platforms || []).forEach(function (p) { map[p.platform] = !!p.configured; });
      _platformConfig = map;
    } catch (_) {
      _platformConfig = {};
    }
  }

  function platformConfigured(pid) {
    if (!_platformConfig || !Object.keys(_platformConfig).length) return true;
    return _platformConfig[pid] !== false;
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
      const configured = platformConfigured(pid);
      const card = document.createElement('div');
      card.className = 'glass-panel';
      card.style.cssText = 'display:flex;align-items:center;gap:14px;padding:16px;flex:1;min-width:260px;';
      card.innerHTML =
        '<i class="' + esc(meta.icon) + '" style="font-size:26px;color:' + meta.color + ';width:42px;text-align:center;"></i>' +
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;font-size:14px;">' + esc(meta.name) + '</div>' +
        '<div style="font-size:11.5px;color:var(--text-dim);">' + (!meta.available ? 'Próximamente' : (configured ? 'Sin conectar' : 'Sin app configurada')) + '</div>' +
        '</div>' +
        (!meta.available
          ? '<span style="font-size:11px;color:var(--text-dim);"><i class="fas fa-clock"></i></span>'
          : (configured
            ? '<button type="button" data-contenido-connect="' + esc(pid) + '" class="btn-luxury-action" style="padding:8px 14px;font-size:11px;"><i class="fas fa-plug"></i> Conectar</button>'
            : '<span style="font-size:10.5px;color:var(--text-dim);text-align:right;max-width:140px;" title="Faltan las credenciales OAuth de esta red (app_settings social_' + esc(pid) + ')."><i class="fas fa-sliders"></i> Sin configurar</span>'));
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
    /* MEJORA: se recuerda el último canal usado (con 2+ canales el dueño
       tenía que elegirlo de nuevo en cada publicación). */
    let last = null;
    try { last = localStorage.getItem(YT_LAST_ACCOUNT_KEY); } catch (_) {}
    if (last && active.some(function (a) { return a.id === last; })) sel.value = last;
    if (sel.dataset.bound !== '1') {
      sel.dataset.bound = '1';
      sel.addEventListener('change', function () {
        if (!this.value) return;
        try { localStorage.setItem(YT_LAST_ACCOUNT_KEY, this.value); } catch (_) {}
      });
    }
  }

  function fmtBytes(n) {
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(0) + ' MB';
    return (n / 1024).toFixed(0) + ' KB';
  }

  /* ---------- Score SEO (estilo vidIQ) — motor en assets/js/yt-seo-score.js ----------
     MEJORA 2026-10-30: panel del tab Crear (formulario a la izquierda, score a la
     derecha) + bloque dentro del modal de edición del Studio. El motor es puro:
     solo lo alimentamos con lo que hay en los inputs en vivo. */
  function activeYoutubeChannelName() {
    /* REPARACIÓN: usaba la PRIMERA cuenta activa, no la SELECCIONADA en el
       form → con 2+ canales el preview SERP y el nombre mostraban el
       canal equivocado. */
    const sel = $('#ytAccountSelect');
    const selected = sel && sel.value ? _accounts.find(function (a) { return a.id === sel.value; }) : null;
    const acc = selected || _accounts.find(function (a) { return a.platform === 'youtube' && a.status === 'active'; });
    return (acc && acc.display_name) || 'Bienenhaus Propiedades';
  }

  function recomputeSeoPanel() {
    const body = $('#ytSeoBody');
    if (!body || !window.BH_YT_SEO || typeof window.BH_YT_SEO.render !== 'function') return;
    const kwEl = $('#ytKeyword');
    window.BH_YT_SEO.render(body, {
      title: ($('#ytTitle') || {}).value || '',
      description: ($('#ytDesc') || {}).value || '',
      tags: ($('#ytTags') || {}).value || '',
      keyword: kwEl ? (kwEl.value || '') : '',
      channelName: activeYoutubeChannelName(),
      extraPresets: channelTopTags(), // #14: top histórico del canal primero
      onTagsChange: function (newTags) {
        const t = $('#ytTags');
        if (t) { t.value = newTags; recomputeSeoPanel(); }
      },
    });
  }

  /* #9/#41: progreso de subida — barra del panel + ETA (muestreo de bytes/seg
     que hace el uploader) + panel flotante chico visible aunque cambies de tab. */
  function setUploadProgress(pct, txt, extra) {
    const bar = $('#ytUploadBar');
    const label = $('#ytUploadPct');
    if (bar) bar.style.width = pct + '%';
    if (label) label.innerHTML = '<span>' + txt + '</span><span>' + pct + '%</span>';
    const etaEl = $('#ytUploadEta');
    if (etaEl) {
      const head = extra && extra.bps > 0 ? ' ' + fmtSpeed(extra.bps) : '';
      const tail = extra && extra.etaSec > 0 ? ' · ' + fmtEta(extra.etaSec) : '';
      etaEl.textContent = (pct > 0 && pct < 100) ? head + tail : '';
    }
    /* #41: flotante (el panel con la barra puede quedar bajo el fold) */
    if (_publishing) {
      let float = document.getElementById('ytUploadFloat');
      if (!float) float = createUploadFloat();
      float.style.display = 'flex'; // tras hideUploadFloat() hay que volver a mostrarlo
      const fPct = float.querySelector('#ytFloatPct');
      const fBar = float.querySelector('#ytFloatBar');
      if (fBar) fBar.style.width = pct + '%';
      if (fPct) fPct.textContent = txt ? txt + ' · ' + pct + '%' : pct + '%';
    }
  }

  /* #41: crea (1 vez) el panel flotante de progreso a nivel body */
  function createUploadFloat() {
    const float = document.createElement('div');
    float.id = 'ytUploadFloat';
    float.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9998;display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:12px;background:rgba(2,6,12,0.92);border:1px solid rgba(255,255,255,0.14);box-shadow:0 12px 30px rgba(0,0,0,.45);';
    float.innerHTML =
      '<i class="fas fa-cloud-arrow-up" style="color:var(--accent);font-size:16px;"></i>' +
      '<div style="min-width:150px;">' +
        '<div id="ytFloatPct" style="font-size:11.5px;font-weight:600;"></div>' +
        '<div style="height:5px;border-radius:3px;background:rgba(255,255,255,0.1);margin-top:4px;overflow:hidden;">' +
          '<div id="ytFloatBar" style="height:100%;width:0%;background:var(--accent);border-radius:3px;transition:width .3s;"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(float);
    return float;
  }
  function hideUploadFloat() {
    const float = document.getElementById('ytUploadFloat');
    if (float) float.style.display = 'none';
  }

  /* MEJORA 2026-10-27/30: feedback del archivo (+dims/duración/vertical), contadores,
     banco de frases, plantillas y preferencia de CTA — todo colgado UNA vez. */
  function setupCreateFormUX() {
    /* El shell nunca se re-renderiza (guard en renderShell): los listeners de
       contadores + Score SEO se cuelgan UNA vez (si no, cada loadContenido duplicaría). */
    if (_seoBound) return;
    _seoBound = true;
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
        if (!isVideo) return;
        /* MEJORAS #4/#5: metadata real del archivo — dims + duración, y
           aviso de Shorts si es vertical (resolución del video, no del name). */
        try {
          const probeUrl = URL.createObjectURL(f);
          const probe = document.createElement('video');
          probe.preload = 'metadata';
          probe.muted = true;
          probe.src = probeUrl;
          probe.addEventListener('loadeddata', function () {
            const dur = isFinite(probe.duration) ? Math.round(probe.duration) : 0;
            const vertical = probe.videoHeight > probe.videoWidth;
            const extra = [];
            if (probe.videoWidth) extra.push(probe.videoWidth + '×' + probe.videoHeight);
            if (dur) extra.push(Math.floor(dur / 60) + ':' + String(dur % 60).padStart(2, '0'));
            if (vertical) extra.push('<i class="fas fa-mobile-screen"></i> vertical: formato ideal para <b>Shorts</b> (sugerí #shorts en la descripción)');
            fileInfo.innerHTML = '✓ ' + esc(f.name) + ' (' + size + (extra.length ? ' · ' + extra.join(' · ') : '') + ')';
            URL.revokeObjectURL(probeUrl);
          });
          probe.addEventListener('error', function () { URL.revokeObjectURL(probeUrl); });
        } catch (_) { /* el probe es solo informativo */ }
      });
    }

    /* MEJORA: arrastrar el archivo de video a la zona (sin usar el picker) */
    const dropZone = $('#ytFileDrop');
    if (dropZone && fileInput) {
      const highlight = function (on) {
        dropZone.style.borderColor = on ? 'var(--accent)' : 'rgba(255,255,255,0.18)';
        dropZone.style.background = on ? 'rgba(45,212,191,0.06)' : '';
      };
      dropZone.addEventListener('dragover', function (e) { e.preventDefault(); highlight(true); });
      dropZone.addEventListener('dragenter', function (e) { e.preventDefault(); highlight(true); });
      dropZone.addEventListener('dragleave', function () { highlight(false); });
      dropZone.addEventListener('drop', function (e) {
        e.preventDefault();
        highlight(false);
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        const f = files[0];
        if (f.type && f.type.indexOf('video/') !== 0) {
          showToast('El archivo soltado no es un video.', 'warning');
          return;
        }
        try { fileInput.files = files; } catch (_) { /* algunos navegadores no lo permiten */ }
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    /* MEJORA: cancelar la subida en curso */
    const cancelUpload = $('#ytCancelUpload');
    if (cancelUpload) {
      cancelUpload.addEventListener('click', function () {
        if (!_publishing) return;
        _uploadCancelled = true;
        this.disabled = true;
        this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelando…';
        if (_activeXhr) { try { _activeXhr.abort(); } catch (_) {} }
      });
    }

    /* MEJORA: buscador de propiedades (filtra el <select> en vivo) */
    const propSearch = $('#ytPropertySearch');
    if (propSearch) {
      propSearch.addEventListener('input', function () {
        renderPropertyOptions(this.value);
      });
    }
    /* Score SEO en vivo: recalcula al escribir en título/descripción/tags/keyword */
    ['ytTitle', 'ytDesc', 'ytTags', 'ytKeyword'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', recomputeSeoPanel);
    });
    recomputeSeoPanel();

    /* #16: banco de frases probadas — click agrega al final del título */
    const bank = $('#ytTitleBank');
    if (bank) {
      bank.innerHTML = '<option value="">＋ Frases probadas…</option>' +
        TITLE_BANK.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + '</option>'; }).join('');
      bank.addEventListener('change', function () {
        const add = this.value || '';
        this.value = '';
        if (!add) return;
        const t = $('#ytTitle');
        if (!t) return;
        const next = t.value.trim() ? t.value.replace(/\s+$/, '') + ' — ' + add : add;
        if (next.length > 100) { showToast('El título ya está cerca del límite de 100 caracteres.', 'warning'); return; }
        setFieldValue('ytTitle', next);
      });
    }

    /* #2: plantillas locales (localStorage) */
    const tpl = $('#ytTemplateSel');
    if (tpl) {
      renderTemplateOptions();
      tpl.addEventListener('change', function () {
        const id = this.value || '';
        /* REPARACIÓN: antes se reseteaba el select al aplicar → "Borrar la
           plantilla seleccionada" nunca encontraba selección y era inusable.
           Ahora la selección queda (y por eso el borrado funciona). */
        if (id) applyTemplateById(id);
      });
    }

    /* #11: auto-CTA + hashtags al publicar (preferencia persistente) */
    const ctaAuto = $('#ytCtaAuto');
    if (ctaAuto) {
      let saved = null;
      try { saved = localStorage.getItem(YT_CTA_AUTO_KEY); } catch (_) {}
      ctaAuto.checked = saved === null ? true : saved === '1';
      ctaAuto.addEventListener('change', function () {
        try { localStorage.setItem(YT_CTA_AUTO_KEY, this.checked ? '1' : '0'); } catch (_) {}
      });
    }
    renderQuotaHud();
  }

  /* ---------- MEJORAS 2026-10-30: form create ----------
     Vínculo con propiedades (#1), plantillas (#2), CTA auto (#11),
     capítulos (#12), schedules rápidos (#10), banco de títulos (#16),
     clonado de metadata a otro canal (#8) y quick-fix de tags (#7). */

  function fichaUrlFor(code) {
    /* REPARACIÓN: sin property_code NO existe ficha (se generan por código) →
       antes se publicaba un link roto "fichas/.html" en la descripción. */
    const c = String(code || '').trim();
    if (!c) return '';
    return 'https://bienenhaus.com.ar/fichas/' + encodeURIComponent(c) + '.html';
  }

  /* #1: listado de propiedades para el vínculo (crea → social_posts.property_id) */
  async function loadPropertiesForPicker() {
    const sel = $('#ytProperty');
    if (!sel || sel.dataset.loaded === '1') return;
    const client = await getAuthedClient();
    if (!client) return;
    sel.dataset.loaded = '1';
    let data = null, error = null;
    try {
      const res = await client.from('properties')
        .select('id, property_code, title, property_type, status, zone, address, surface_total, rooms, bedrooms, bathrooms, is_published')
        .order('created_at', { ascending: false })
        .limit(300);
      data = res.data; error = res.error;
    } catch (e) { error = e; }
    if (error) {
      sel.dataset.loaded = '0'; // permite reintentar en el próximo switch
      logError('Contenido: properties picker', error);
      sel.innerHTML = '<option value="">— Sin propiedad vinculada —</option>';
      return;
    }
    _createProps = data || [];
    renderPropertyOptions('');
  }

  /* MEJORA: el <select> con 300 propiedades era inmanejable → buscador por
     código / título / zona que filtra las opciones en vivo. */
  function renderPropertyOptions(query) {
    const sel = $('#ytProperty');
    if (!sel) return;
    const selected = sel.value;
    const q = bhNorm(String(query || '')).trim();
    const label = function (p) {
      const parts = [p.property_code || '', p.title || p.address || p.zone || ''];
      return parts.filter(Boolean).join(' — ') || '(sin título)';
    };
    const list = q
      ? _createProps.filter(function (p) {
        const hay = bhNorm([p.property_code, p.title, p.address, p.zone].filter(Boolean).join(' '));
        return hay.indexOf(q) >= 0;
      })
      : _createProps.slice();
    sel.innerHTML = '<option value="">— Sin propiedad vinculada —</option>' +
      list.map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(label(p)) + (p.is_published ? '' : ' (sin publicar)') + '</option>';
      }).join('');
    /* Si el reintento/copia pidió una propiedad que no está en el picker
       (no está entre las 300 más recientes), se re-agrega y queda seleccionada
       → el reintento conserva el vínculo con la ficha. */
    const wanted = _pendingPropertyId || selected;
    if (wanted) {
      const exists = Array.prototype.some.call(sel.options, function (o) { return o.value === wanted; });
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = wanted;
        opt.textContent = 'Propiedad vinculada';
        sel.appendChild(opt);
      }
      sel.value = wanted;
    }
    /* La pendiente se aplica UNA vez: si no, cada búsqueda del picker
       volvería a seleccionar la propiedad del reintento. */
    _pendingPropertyId = null;
    const cnt = $('#ytPropertyCount');
    if (cnt) cnt.textContent = list.length + ' de ' + _createProps.length + (q ? ' (filtrado)' : '');
  }

  /* #1: coaching del form — SOLO llena campos vacíos (nunca pisa lo escrito) */
  function fillFromProperty() {
    const sel = $('#ytProperty');
    if (!sel || !sel.value) { showToast('Elegí primero una propiedad.', 'warning'); return; }
    const p = _createProps.find(function (x) { return x.id === sel.value; });
    if (!p) return;
    const dets = [
      p.rooms ? p.rooms + ' ambientes' : (p.bedrooms ? p.bedrooms + ' dormitorios' : ''),
      p.bathrooms ? p.bathrooms + ' baño(s)' : '',
      p.surface_total ? p.surface_total + ' m²' : '',
      p.zone || '',
    ].filter(Boolean);
    if (!$('#ytTitle').value) {
      setFieldValue('ytTitle', ((p.property_type || 'Propiedad') + (dets.length ? ' en ' + dets.join(', ') : '') + ' — Tour completo 4K').substring(0, 100));
    }
    if ($('#ytKeyword') && !$('#ytKeyword').value) {
      const kw = ((p.property_type || '') + (p.zone ? ' en ' + p.zone : '')).toLowerCase().trim();
      if (kw) setFieldValue('ytKeyword', kw);
    }
    if ($('#ytDesc') && !$('#ytDesc').value.trim()) {
      setFieldValue('ytDesc', buildPropDesc(p));
    }
    if ($('#ytTags') && !$('#ytTags').value.trim()) {
      const suggested = [
        p.property_type || '', p.zone || '', dets[0] || '',
        'bienenhaus', 'inmobiliaria córdoba',
      ].map(function (t) { return String(t).trim().toLowerCase(); }).filter(Boolean);
      const uniq = [];
      suggested.forEach(function (t) { if (uniq.every(function (u) { return bhNorm(u) !== bhNorm(t); })) uniq.push(t); });
      setFieldValue('ytTags', uniq.join(', '));
    }
    showToast('Datos base cargados (solo campos vacíos).', 'info');
  }

  /* descripción base desde la ficha real (bullets que siempre son ciertos) */
  function buildPropDesc(p) {
    const dets = [
      p.rooms ? p.rooms + ' ambientes' : (p.bedrooms ? p.bedrooms + ' dormitorios' : ''),
      p.bathrooms ? p.bathrooms + ' baño(s)' : '',
      p.surface_total ? p.surface_total + ' m²' : '',
      p.zone ? 'en ' + p.zone : '',
    ].filter(Boolean).join(', ');
    const ficha = fichaUrlFor(p.property_code);
    /* REPARACIÓN: el link a la ficha solo se incluye si la propiedad tiene
       código (si no, el texto publicaba una URL rota). */
    const fichaBlock = ficha
      ? 'Ficha completa con fotos, medidas y precio actualizado:\n' + ficha + '\n\n'
      : 'Ficha completa con fotos, medidas y precio actualizado en bienenhaus.com.ar.\n\n';
    return 'Recorremos paso a paso esta ' + (p.property_type || 'propiedad') + (dets ? ': ' + dets + '.' : '.') + '\n' +
      'En el video mostramos todos los ambientes y detalles de construcción.\n\n' +
      fichaBlock +
      'Consultas y visitas sin compromiso — respondemos por WhatsApp o desde bienenhaus.com.ar.\n\n' +
      CTA_HASHTAGS;
  }

  /* #11: bloque de CTA + hashtags institucionales (#17) */
  function buildCtaBlock(p) {
    const link = (p && p.property_code)
      ? (fichaUrlFor(p.property_code) || 'https://bienenhaus.com.ar/#propiedades')
      : 'https://bienenhaus.com.ar/#propiedades';
    const head = p ? 'Conocé la ficha completa de esta propiedad con fotos y precio actualizado:'
      : 'Conocé la lista completa de propiedades con fotos y precio:';
    return '\n\n' + head + '\n' + link + '\nConsultas y visitas sin compromiso — respondemos rápido por WhatsApp.\n' + CTA_HASHTAGS;
  }
  function insertCtaBlock() {
    const descEl = $('#ytDesc');
    if (!descEl) return;
    if (/#[A-Za-zÀ-ÿ][\w-]*\s/i.test(descEl.value) && /bienenhaus/i.test(descEl.value)) {
      showToast('La descripción ya trae el bloque de contacto/hashtags.', 'info');
      return;
    }
    const p = _createProps.find(function (x) { return x.id === (($('#ytProperty') || {}).value || ''); });
    descEl.value = descEl.value.replace(/\s*$/, '') + buildCtaBlock(p);
    descEl.dispatchEvent(new Event('input', { bubbles: true }));
    showToast('CTA + hashtags agregados al final.', 'success');
  }

  /* #2: plantillas locales (localStorage bh_yt_templates, tope 20) */
  function getTemplates() {
    try {
      const arr = JSON.parse(localStorage.getItem(YT_TPL_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function renderTemplateOptions() {
    const sel = $('#ytTemplateSel');
    if (!sel) return;
    const tpls = getTemplates();
    sel.innerHTML = '<option value="">— Plantillas locales (' + tpls.length + ') —</option>' +
      tpls.map(function (t) { return '<option value="' + esc(String(t.id)) + '">' + esc(String(t.name)) + '</option>'; }).join('');
  }
  function applyTemplateById(id) {
    const t = getTemplates().find(function (x) { return String(x.id) === String(id); });
    if (!t) return;
    setFieldValue('ytTitle', t.title || '');
    setFieldValue('ytDesc', t.description || '');
    setFieldValue('ytTags', t.tags || '');
    const pr = document.getElementById('ytPrivacy');
    if (pr && ['public', 'unlisted', 'private'].indexOf(t.privacy) >= 0) pr.value = t.privacy;
    recomputeSeoPanel();
    showToast('Plantilla aplicada: ' + String(t.name).substring(0, 40), 'success');
  }
  function saveTemplateFromForm() {
    const title = (($('#ytTitle') || {}).value || '').trim();
    const desc = (($('#ytDesc') || {}).value || '').trim();
    const tags = (($('#ytTags') || {}).value || '').trim();
    if (!title && !desc && !tags) { showToast('El formulario está vacío — nada para guardar.', 'warning'); return; }
    const name = window.prompt('Nombre de la plantilla:', 'Plantilla ' + new Date().toLocaleDateString('es-AR'));
    if (name === null) return;
    const tpls = getTemplates();
    tpls.unshift({
      id: 'tpl_' + Date.now(),
      name: (String(name || '').trim() || 'Plantilla').substring(0, 40),
      title: title, description: desc, tags: tags,
      privacy: (($('#ytPrivacy') || {}).value || 'public'),
    });
    try {
      localStorage.setItem(YT_TPL_KEY, JSON.stringify(tpls.slice(0, 20)));
    } catch (_) { showToast('No se pudo guardar (almacenamiento lleno).', 'error'); return; }
    renderTemplateOptions();
    showToast('Plantilla guardada.', 'success');
  }
  function deleteCurrentTemplate() {
    const sel = $('#ytTemplateSel');
    const id = sel && sel.value;
    if (!id || String(id).indexOf('tpl_') !== 0) { showToast('Elegí una plantilla de la lista para borrarla.', 'warning'); return; }
    if (!window.confirm('¿Borrar esta plantilla? (no toca el formulario)')) return;
    localStorage.setItem(YT_TPL_KEY, JSON.stringify(getTemplates().filter(function (t) { return String(t.id) !== String(id); })));
    renderTemplateOptions();
    showToast('Plantilla borrada.', 'success');
  }

  /* #10: schedules rápidos — hoy 18:00 / mañana 12:00 / próximo jueves 18:00 */
  function applyQuickSchedule(kind) {
    const input = document.getElementById('ytPublishAt');
    if (!input) return;
    const d = new Date();
    if (kind === 'hoy18') {
      d.setHours(18, 0, 0, 0);
      if (d.getTime() < Date.now() + 10 * 60 * 1000) d.setDate(d.getDate() + 1);
    } else if (kind === 'manana12') {
      d.setDate(d.getDate() + 1);
      d.setHours(12, 0, 0, 0);
    } else { // jueves18
      while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
      d.setHours(18, 0, 0, 0);
      if (d.getTime() < Date.now() + 10 * 60 * 1000) d.setDate(d.getDate() + 7);
    }
    const pad = function (n) { return String(n).padStart(2, '0'); };
    input.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    input.dispatchEvent(new Event('input', { bubbles: true }));
    showToast('Programación: ' + d.toLocaleString('es-AR') + '.', 'info');
  }

  /* #7: completar tags con los presets que el motor ya sugiere (hasta 15) */
  function quickFixTags() {
    const body = $('#ytSeoBody');
    const input = $('#ytTags');
    if (!body || !input) return;
    const presets = Array.prototype.map.call(body.querySelectorAll('.yts-preset'), function (el) {
      return el.getAttribute('data-yts-preset') || '';
    }).filter(Boolean);
    if (!presets.length) { recomputeSeoPanel(); showToast('No hay sugerencias nuevas para agregar.', 'info'); return; }
    const tags = String(input.value || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    for (let i = 0; i < presets.length && tags.length < 15; i++) {
      if (tags.every(function (t) { return bhNorm(t) !== bhNorm(presets[i]); })) tags.push(presets[i]);
    }
    /* recorte progresivo — mismo contrato que el server: nunca por debajo de 1 */
    while (tags.length > 1 && tags.join(',').length > 480) tags.pop();
    setFieldValue('ytTags', tags.join(', '));
    showToast('Tags completados: ' + tags.length + ' tags.', 'success');
  }

  /* #3/#42: prefill del form desde un post del historial.
     retry=true → viene de un intento fallado (deja TODO listo para reenviar). */
  function prefillFromPost(p, retry) {
    if (!p) return;
    const c = p.content || {};
    setFieldValue('ytTitle', c.title || '');
    setFieldValue('ytDesc', c.description || '');
    setFieldValue('ytTags', Array.isArray(c.tags) ? c.tags.join(', ') : (c.tags ? String(c.tags) : ''));
    const pr = document.getElementById('ytPrivacy');
    if (pr && ['public', 'unlisted', 'private'].indexOf(c.privacy) >= 0) pr.value = c.privacy;
    /* REPARACIÓN: al copiar/reintentar se perdían la keyword, la
       programación y la propiedad vinculada — el reintento quedaba sin el
       tour en la ficha y sin la fecha de publicación. */
    setFieldValue('ytKeyword', c.keyword || '');
    const pa = document.getElementById('ytPublishAt');
    if (pa) pa.value = toLocalInput(c.publish_at);
    restoreLinkedProperty(p.property_id);
    switchSubTab('create');
  }

  /* Vuelve a seleccionar la propiedad vinculada (agregando la opción si el
     picker todavía no la cargó) → el reintento conserva el vínculo. */
  function restoreLinkedProperty(propertyId) {
    if (!propertyId) return;
    const sel = document.getElementById('ytProperty');
    if (!sel) return;
    const known = _createProps.some(function (x) { return x.id === propertyId; });
    if (known) { sel.value = propertyId; return; }
    /* Si el picker todavía no cargó, su render pisa el <select> → la opción
       se re-agrega al final (ver renderPropertyOptions). */
    if (sel.dataset.loaded !== '1') { _pendingPropertyId = propertyId; return; }
    const opt = document.createElement('option');
    opt.value = propertyId;
    opt.textContent = 'Propiedad vinculada';
    sel.appendChild(opt);
    sel.value = propertyId;
  }

  /* #12: capítulos — modal con validación del formato de YouTube
     (primero 0:00, en orden creciente, mínimo 3 para que YouTube los active). */
  function stripChaptersBlock(desc) {
    const i = desc.indexOf('\nCAPÍTULOS:');
    return i === -1 ? desc : desc.slice(0, i);
  }
  function parseChapters(text) {
    const lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return { error: 'Agregá al menos un capítulo (ej: "0:00 Entrada").' };
    if (lines.length > 50) return { error: 'Máximo 50 capítulos por video.' };
    const chap = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
      if (!m) return { error: 'La línea ' + (i + 1) + ' no va "m:ss texto" (ej: "0:45 Cocina").' };
      const parts = m[1].split(':').map(Number);
      let sec;
      if (parts.length === 3) {
        sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else {
        sec = parts[0] * 60 + parts[1];
      }
      if (parts[parts.length - 1] > 59 || (parts.length === 3 ? parts[1] > 59 : parts[0] > 59)) {
        return { error: 'Minutos o segundos inválidos en "' + m[1] + '".' };
      }
      if (i === 0 && parts[0] !== 0) return { error: 'El primer capítulo debe ir en 0:00 (exigido por YouTube).' };
      if (i === 0 && sec !== 0) return { error: 'El primer capítulo debe arrancar exactamente en 0:00.' };
      if (i > 0 && sec <= chap[chap.length - 1].t) return { error: 'Los tiempos deben ir creciendo (revisá "' + m[1] + '").' };
      chap.push({ t: sec, stamp: m[1], label: m[2] });
    }
    return { chap: chap };
  }
  function openChaptersModal() {
    closeModalIfExists('ytChaptersOverlay');
    const descEl = $('#ytDesc');
    if (!descEl) return;
    const ov = document.createElement('div');
    ov.id = 'ytChaptersOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
    const box = document.createElement('div');
    box.className = 'glass-panel';
    box.style.cssText = 'max-width:560px;width:100%;padding:24px;';
    const cur = descEl.value || '';
    const idx = cur.indexOf('\nCAPÍTULOS:');
    const existing = idx === -1 ? '' : cur.slice(idx + '\nCAPÍTULOS:\n'.length);
    box.innerHTML =
      '<h3 style="margin:0 0 6px;font-size:16px;"><i class="fas fa-list-check"></i> Capítulos del video</h3>' +
      '<p style="margin:0 0 12px;font-size:12px;color:var(--text-dim);line-height:1.5;">Una línea por capítulo con el tiempo y su nombre. YouTube los exige: arrancar en 0:00, en orden ascendente y mínimo 3. El bloque va al final de la descripción.</p>' +
      '<textarea id="ytChapText" rows="6" class="crm-field-input" placeholder="0:00 Entrada&#10;0:45 Living y cocina&#10;2:10 Dormitorios&#10;3:05 Contacto" style="width:100%;">' + esc(existing) + '</textarea>' +
      '<div id="ytChapErr" style="font-size:11.5px;color:var(--danger);margin-top:6px;min-height:15px;"></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button type="button" id="ytChapCancel" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;">Cancelar</button>' +
        '<button type="button" id="ytChapApply" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;"><i class="fas fa-check"></i> Aplicar</button>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModalIfExists('ytChaptersOverlay'); });
    box.querySelector('#ytChapCancel').addEventListener('click', function () { closeModalIfExists('ytChaptersOverlay'); });
    box.querySelector('#ytChapApply').addEventListener('click', function () {
      const r = parseChapters(box.querySelector('#ytChapText').value);
      if (r.error) { box.querySelector('#ytChapErr').textContent = r.error; return; }
      if (!r.chap || r.chap.length < 3) { box.querySelector('#ytChapErr').textContent = 'Mínimo 3 capítulos — YouTube no los activa con menos.'; return; }
      const base = stripChaptersBlock(descEl.value).replace(/\s*$/, '');
      const block = '\n\nCAPÍTULOS:\n' + r.chap.map(function (c) { return c.stamp + ' ' + c.label; }).join('\n');
      descEl.value = base + block;
      descEl.dispatchEvent(new Event('input', { bubbles: true }));
      closeModalIfExists('ytChaptersOverlay');
      showToast('Capítulos agregados a la descripción (' + r.chap.length + ').', 'success');
    });
    box.querySelector('#ytChapText').focus();
  }

  /* #8: clonado de metadata a otro canal — mínimo por diseño: los textos
     ya están en el form; el clon cambia el canal destino. El archivo no se
     re-sube: se elige de nuevo por canal y se publica a mano. */
  function openCloneModal() {
    const sel = $('#ytAccountSelect');
    const cur = sel && sel.value;
    const others = _accounts.filter(function (a) { return a.platform === 'youtube' && a.status === 'active' && a.id !== cur; });
    if (!others.length) { showToast('No hay otro canal conectado.', 'warning'); return; }
    closeModalIfExists('ytCloneOverlay');
    const ov = document.createElement('div');
    ov.id = 'ytCloneOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
    const box = document.createElement('div');
    box.className = 'glass-panel';
    box.style.cssText = 'max-width:440px;width:100%;padding:24px;';
    box.innerHTML =
      '<h3 style="margin:0 0 6px;font-size:16px;"><i class="fas fa-copy"></i> Clonar metadata a otro canal</h3>' +
      '<p style="margin:0 0 14px;font-size:12px;color:var(--text-dim);line-height:1.5;">Título, descripción, tags, visibilidad y programación quedan cargados para el canal que elijas. El archivo de video NO se repite: elegilo de nuevo al publicar en cada canal.</p>' +
      '<select id="ytCloneSel" class="crm-field-input crm-field-input--select" style="width:100%;margin-bottom:14px;">' +
        others.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.display_name) + '</option>'; }).join('') +
      '</select>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button type="button" id="ytCloneCancel" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;">Cancelar</button>' +
        '<button type="button" id="ytCloneApply" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;"><i class="fas fa-check"></i> Usar en ese canal</button>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModalIfExists('ytCloneOverlay'); });
    box.querySelector('#ytCloneCancel').addEventListener('click', function () { closeModalIfExists('ytCloneOverlay'); });
    box.querySelector('#ytCloneApply').addEventListener('click', function () {
      const target = box.querySelector('#ytCloneSel');
      if (target && target.value && sel) sel.value = target.value;
      closeModalIfExists('ytCloneOverlay');
      showToast('Metadata lista para el otro canal — revisá y publicá.', 'success');
    });
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

  function ytPutChunk(sessionUrl, blob, contentRange, onChunkProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUrl);
      xhr.setRequestHeader('Content-Range', contentRange);
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      xhr.timeout = YT_CHUNK_TIMEOUT;
      /* MEJORA: progreso suave DENTRO del chunk (la barra saltaba cada 8 MB
       y en una subida lenta parecía colgada). */
      if (onChunkProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onChunkProgress(e.loaded, e.total);
        };
      }
      /* MEJORA: permite cancelar la subida (abort del XHR en vuelo). */
      _activeXhr = xhr;
      const settle = function (fn, arg) {
        if (_activeXhr === xhr) _activeXhr = null;
        fn(arg);
      };
      xhr.addEventListener('load', () => settle(resolve, xhr));
      xhr.addEventListener('error', () => settle(reject, new Error('network')));
      xhr.addEventListener('timeout', () => settle(reject, new Error('network')));
      xhr.addEventListener('abort', () => settle(reject, new Error('abort')));
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
    /* #9: muestreo de velocidad (EMA) para el ETA del panel flotante */
    let lastBytes = 0;
    let lastTs = Date.now();
    let bps = 0;
    const tick = function (bytesNow) {
      const now = Date.now();
      const dt = (now - lastTs) / 1000;
      if (dt > 0.25) {
        const inst = (bytesNow - lastBytes) / dt;
        if (inst > 0) bps = bps ? bps * 0.7 + inst * 0.3 : inst;
        lastBytes = bytesNow;
        lastTs = now;
      }
      const remaining = total - bytesNow;
      return { bps: bps, etaSec: bps > 0 ? remaining / bps : 0 };
    };
    const advance = (to) => { offset = to; stalls = 0; };
    while (offset < total) {
      if (_uploadCancelled) throw new Error('Subida cancelada — no se publicó nada.');
      const end = Math.min(offset + YT_CHUNK_SIZE, total) - 1;
      try {
        const xhr = await ytPutChunk(
          sessionUrl,
          file.slice(offset, end + 1),
          'bytes ' + offset + '-' + end + '/' + total,
          /* progreso suave: bytes del chunk ya enviados + offset global */
          function (loadedInChunk) {
            if (!onProgress) return;
            const smooth = Math.min(offset + loadedInChunk, total);
            onProgress(smooth, total, tick(smooth));
          },
        );
        if (xhr.status >= 200 && xhr.status < 300) {
          /* Último chunk aceptado: Google responde con el recurso del video. */
          advance(total);
          if (onProgress) onProgress(total, total, { bps: bps, etaSec: 0 });
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
          if (st.complete) { advance(total); if (onProgress) onProgress(total, total, { bps: 0, etaSec: 0 }); return st.resource; }
          if (st.received > offset) advance(st.received); else stalls++;
        }
      } catch (e) {
        if (e.message === 'abort') {
          if (_uploadCancelled) throw new Error('Subida cancelada — no se publicó nada.');
          throw new Error('La subida se interrumpió porque la página se cerró o recargó. Volvé a intentarlo.');
        }
        const st = await ytQueryUploadStatus(sessionUrl, total);
        if (st.complete) { advance(total); if (onProgress) onProgress(total, total, { bps: 0, etaSec: 0 }); return st.resource; }
        if (st.received > offset) advance(st.received); else stalls++;
      }
      if (onProgress) onProgress(offset, total, tick(offset));
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

    /* MEJORAS #11 / #6 / #18: (1) el auto-CTA completa la descripción con el
       bloque de ficha+WhatsApp+hashtags si no trae link ni hashtags; (2) el
       bloqueo de seguridad avisa si el score EN PANTALLA quedó bajo (<50);
       (3) el score que viaja al init es el del texto REAL que se sube. */
    let descOut = description;
    const ctaAuto = document.getElementById('ytCtaAuto');
    if (!ctaAuto || ctaAuto.checked) {
      const prop = _createProps.find(function (x) { return x.id === (($('#ytProperty') || {}).value || ''); });
      if (descOut && !/https?:\/\//i.test(descOut) && !/#[A-Za-zÀ-ÿ]/.test(descOut)) {
        descOut = descOut.replace(/\s*$/, '') + buildCtaBlock(prop);
      } else if (!descOut) {
        descOut = descOut.replace(/^\s*$/, '') + buildCtaBlock(prop).trim();
      }
    }

    let seoScore = null;
    if (window.BH_YT_SEO && typeof window.BH_YT_SEO.calc === 'function') {
      try {
        const gateR = window.BH_YT_SEO.calc({
          title: title, description: description, tags: tags,
          keyword: (($('#ytKeyword') || {}).value || ''),
        });
        if (!gateR.empty && gateR.score < 50) {
          if (!window.confirm('El Score SEO de este video es bajo (' + gateR.score + '/100 — ' + gateR.label + ').\n\nCompletar las sugerencias del panel a la derecha le da más chances de aparecer en búsquedas. ¿Publicar igual?')) return;
        }
        const shipR = window.BH_YT_SEO.calc({
          title: title, description: descOut, tags: tags,
          keyword: (($('#ytKeyword') || {}).value || ''),
        });
        if (!shipR.empty) seoScore = shipR.score;
      } catch (_) { /* el gate nunca bloquea la publicación por un bug interno */ }
    }

    _publishing = true;
    _uploadCancelled = false;
    let postId = null;      // registro en social_posts (fail + heartbeat)
    let hbTimer = null;     // heartbeat de updated_at durante la subida
    const btn = $('#ytPublishBtn');
    const btnHtml = btn ? btn.innerHTML : '';
    /* Bloquear todo el form durante la subida */
    LOCK_IDS.forEach(id => {
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
          description: descOut, // #11: con el auto-CTA si correspondía
          tags,
          privacy,
          file_size: file.size,
          file_type: file.type || 'video/mp4',
          publish_at: publishAt || undefined,
          property_id: (($('#ytProperty') || {}).value || undefined), // #1
          seo_score: (typeof seoScore === 'number' && seoScore > 0 ? seoScore : undefined), // #18
          keyword: (($('#ytKeyword') || {}).value || undefined), // se guarda en content (reintentar lo conserva)
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
      setUploadProgress(2, 'Subiendo a YouTube…', { bps: 0, etaSec: 0 });
      const uploaded = await xhrUploadToGoogle(init.session_url, file, (loaded, t, extra) => {
        const pct = Math.min(95, Math.round((loaded / t) * 95));
        setUploadProgress(pct, Math.round((loaded / t) * 100) + '% subido...', extra || null);
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
      trackQuota(1600); // #44: costo real de una subida resumable
      showToast(publishAt ? 'Video programado para ' + new Date(publishAt).toLocaleString('es-AR') + '.' : 'Video publicado en YouTube.', 'success');
      if (done.url && !publishAt) window.open(done.url, '_blank', 'noopener');
      setFieldValue('ytTitle', '');
      setFieldValue('ytDesc', '');
      setFieldValue('ytTags', '');
      if ($('#ytPublishAt')) $('#ytPublishAt').value = '';
      if ($('#ytProperty')) $('#ytProperty').value = '';
      if ($('#ytKeyword')) $('#ytKeyword').value = '';
      if (fileInput) fileInput.value = '';
      if ($('#ytFileInfo')) $('#ytFileInfo').style.display = 'none';
      studioInvalidate(); // #30: un studio abierto seguiría mostrando el cache
      recomputeSeoPanel(); // el form quedó vacío — el score vuelve a arrancar
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
      _activeXhr = null;
      _uploadCancelled = false;
      LOCK_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });
      hideUploadFloat();
      if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
      const cancelBtn = $('#ytCancelUpload');
      if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.innerHTML = '<i class="fas fa-circle-xmark"></i> Cancelar subida'; }
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
      .select('id, platform, status, post_type, content, published_at, created_at, external_url, error, property_id, social_accounts(display_name)')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) { logError('Contenido: loadHistory', error); return; }
    _lastHistory = data || []; // #3/#42: fuente del copiar/reintentar
    renderChannelTags(); // MEJORA: los tags del historial alimentan los chips
    if (!data || !data.length) {
      wrap.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:12px 0;">Todavía no hay publicaciones.</p>';
      return;
    }
    /* #48: backup JSON de social_posts (solo lectura, descarga local) */
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">' +
        '<span style="font-size:12px;color:var(--text-dim);">' + data.length + ' publicaciones recientes</span>' +
        '<div style="flex:1;"></div>' +
        '<button type="button" id="ytBackupJson" class="btn-luxury-action" title="Descarga JSON completo del historial (500 posts)" style="padding:8px 12px;font-size:11px;"><i class="fas fa-file-export"></i> Backup JSON</button>' +
      '</div>' +
      data.map(p => {
      const c = p.content || {};
      const st = STATUS_META[p.status] || { label: p.status, color: 'var(--text-dim)' };
      const fecha = window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(p.published_at || p.created_at) : (p.published_at || p.created_at || '');
      const accName = p.social_accounts && p.social_accounts.display_name ? p.social_accounts.display_name : '';
      const removable = p.status === 'failed' || p.status === 'draft';
      const seoChip = typeof c.seo_score === 'number'
        ? '<span title="Score SEO guardado al publicar" style="font-size:10.5px;color:var(--accent);border:1px solid rgba(45,212,191,0.35);border-radius:8px;padding:2px 8px;flex-shrink:0;">SEO ' + c.seo_score + '</span>'
        : '';
      return '<div class="glass-panel" style="display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:8px;">' +
        '<i class="' + esc((PLATFORM_META[p.platform] || {}).icon || 'fas fa-share') + '" style="font-size:18px;"></i>' +
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.title || '(sin título)') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim);">' + esc(accName) + ' · ' + esc(fecha) + (p.status === 'failed' && p.error ? ' · <span style="color:var(--danger);">' + esc(String(p.error).substring(0, 80)) + '</span>' : '') + '</div>' +
        '</div>' +
        (p.external_url ? '<a href="' + esc(p.external_url) + '" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);text-decoration:none;flex-shrink:0;">Ver <i class="fas fa-arrow-up-right-from-square"></i></a>' : '') +
        seoChip +
        (p.status !== 'publishing' ? '<button type="button" data-contenido-copy="' + esc(p.id) + '" title="Copiar esta metadata al formulario" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:4px;flex-shrink:0;"><i class="fas fa-copy" style="font-size:12px;"></i></button>' : '') +
        (p.status === 'failed' ? '<button type="button" data-contenido-retry="' + esc(p.id) + '" title="Reintentar: carga la metadata en el formulario" style="background:none;border:none;color:var(--accent);cursor:pointer;padding:4px;flex-shrink:0;"><i class="fas fa-rotate-right" style="font-size:12px;"></i></button>' : '') +
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

  /* #48: backup JSON de social_posts — descarga local, panel queda igual */
  async function backupSocialPostsJson() {
    const client = await getAuthedClient();
    if (!client) return;
    try {
      const { data, error } = await client
        .from('social_posts')
        .select('id, platform, status, post_type, content, published_at, created_at, external_post_id, external_url, property_id, error')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const payload = {
        exported_at: new Date().toISOString(),
        count: (data || []).length,
        posts: data || [],
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'contenido-social-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      showToast('Backup descargado (' + payload.count + ' posts).', 'success');
    } catch (err) {
      logError('Contenido: backup', err);
      showToast('No se pudo exportar: ' + err.message, 'error');
    }
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
    if (sub === 'create') {
      /* MEJORA 2026-10-30: al entrar al tab Crear — picker de propiedades
         (#1, lazy, sin await), HUD de cuota (#44) y score SEO en vivo. */
      loadPropertiesForPicker();
      renderQuotaHud();
      recomputeSeoPanel();
      /* MEJORA: chips con los tags reales del canal (inventario cacheado +
         historial) para no escribirlos a mano en cada video. */
      restoreStudioCacheForTags();
      renderChannelTags();
    }
    /* REPARACIÓN: entrar al Studio sin ningún canal conectado mostraba un
       panel vacío sin explicación → estado vacío con acción. */
    if (sub === 'studio' && !hasYoutubeChannel()) renderStudioEmpty();
  }

  function hasYoutubeChannel() {
    return _accounts.some(function (a) { return a.platform === 'youtube' && a.status === 'active'; });
  }

  function renderStudioEmpty() {
    const wrap = $('#contenidoStudio');
    if (!wrap) return;
    wrap.innerHTML =
      '<div class="glass-panel" style="padding:28px 24px;text-align:center;max-width:520px;margin:24px auto;">' +
        '<i class="fab fa-youtube" style="font-size:38px;color:#FF0000;"></i>' +
        '<div style="font-size:15px;font-weight:600;margin:10px 0 4px;">Todavía no hay un canal conectado</div>' +
        '<p style="font-size:12.5px;color:var(--text-dim);margin:0 auto 16px;max-width:380px;line-height:1.6;">El Studio administra el contenido del canal: inventario completo, métricas, playlists, edición, miniaturas y programación.</p>' +
        '<button type="button" id="studioGoAccounts" class="btn-luxury-action" style="padding:10px 18px;font-size:12px;"><i class="fas fa-plug"></i> Conectar un canal</button>' +
      '</div>';
    const btn = $('#studioGoAccounts');
    if (btn) btn.addEventListener('click', function () { switchSubTab('accounts'); });
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
        /* REPARACIÓN: el Studio no tenía botón — al abrirlo la barra quedaba
           sin pestaña activa y el único regreso era el botón del header. */
        '<button type="button" data-sub="studio" class="btn-luxury-action" style="padding:9px 16px;font-size:12px;"><i class="fas fa-sliders"></i> Studio</button>' +
      '</div>' +
      '<div id="contenidoAccounts" style="display:flex;flex-wrap:wrap;gap:12px;"></div>' +
      '<div id="contenidoStudio" style="display:none;"></div>' +
      '<div id="contenidoCreate" style="display:none;">' +
        /* MEJORA 2026-10-30: layout en 2 columnas — form a la izquierda + Score SEO (vidIQ) pegado a la derecha */
        '<div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;">' +
        '<div style="flex:3;min-width:min(340px,100%);">' +
        '<div class="glass-panel" style="padding:24px;">' +
          '<h3 style="margin:0 0 4px;font-size:16px;"><i class="fab fa-youtube" style="color:#FF0000;"></i> Publicar video en YouTube</h3>' +
          '<p style="margin:0 0 20px;font-size:12px;color:var(--text-dim);">El video sube directo de tu navegador a Google — sin pasar por el servidor. El panel de la derecha puntúa tu SEO mientras escribís.</p>' +
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Canal</span>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<select id="ytAccountSelect" class="crm-field-input crm-field-input--select" style="flex:1;min-width:0;"></select>' +
            /* #8: con varios canales, la metadata viaja al otro canal */
            '<button type="button" id="ytCloneMeta" class="btn-luxury-action" title="Publicar el mismo contenido en otro canal (metadata, no archivo)" style="padding:9px 10px;font-size:11px;flex-shrink:0;"><i class="fas fa-copy"></i></button>' +
          '</div></div>' +
          /* #1: vínculo con la propiedad (llena campos + registra social_posts.property_id) */
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Propiedad vinculada <span style="font-size:10.5px;">(opcional — llena los campos vacíos)</span></span>' +
          /* MEJORA: buscador (el select trae hasta 300 propiedades) */
          '<input id="ytPropertySearch" type="text" class="crm-field-input" placeholder="Buscar por código, título o zona…" style="margin-bottom:6px;">' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<select id="ytProperty" class="crm-field-input crm-field-input--select" style="flex:1;min-width:0;"><option value="">— Sin propiedad vinculada —</option></select>' +
            '<button type="button" id="ytPropertyFill" class="btn-luxury-action" title="Cargar título/descripción/tags desde la ficha (solo vacíos)" style="padding:9px 10px;font-size:11px;flex-shrink:0;"><i class="fas fa-house-circle-check"></i></button>' +
          '</div>' +
          '<div id="ytPropertyCount" style="font-size:10.5px;color:var(--text-dim);margin-top:4px;"></div>' +
          '</div>' +
          /* #2: plantillas locales */
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Plantillas locales <span style="font-size:10.5px;">(title/desc/tags/visibilidad)</span></span>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<select id="ytTemplateSel" class="crm-field-input crm-field-input--select" style="flex:1;min-width:0;"></select>' +
            '<button type="button" id="ytTemplateSave" class="btn-luxury-action" title="Guardar el formulario actual como plantilla" style="padding:9px 10px;font-size:11px;flex-shrink:0;"><i class="fas fa-floppy-disk"></i></button>' +
            '<button type="button" id="ytTemplateDel" class="btn-luxury-action" title="Borrar la plantilla seleccionada" style="padding:9px 10px;font-size:11px;flex-shrink:0;"><i class="fas fa-trash-can"></i></button>' +
          '</div></div>' +
          '<div style="margin-bottom:10px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Título * <span id="ytTitleCounter" style="color:var(--text-dim);font-size:11px;float:right;"></span></span>' +
          '<input id="ytTitle" type="text" class="crm-field-input" maxlength="100" placeholder="Ej: Departamento 2 ambientes Nueva Córdoba — TOUR COMPLETO" style="width:100%;"></div>' +
          /* #16: banco de frases probadas */
          '<div style="margin-bottom:14px;"><select id="ytTitleBank" class="crm-field-input crm-field-input--select" style="width:auto;padding:6px 10px;font-size:11.5px;"></select></div>' +
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Descripción (con hashtags para SEO) <span id="ytDescCounter" style="color:var(--text-dim);font-size:11px;float:right;"></span></span>' +
          '<textarea id="ytDesc" rows="5" class="crm-field-input" maxlength="5000" placeholder="Descripción del video + #hashtags…" style="width:100%;"></textarea>' +
          '<div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap;">' +
            /* #12: capítulos — modal con validación nativa */
            '<button type="button" id="ytChaptersBtn" class="btn-luxury-action" title="Agregar bloque de capítulos al final de la descripción" style="padding:7px 12px;font-size:11px;"><i class="fas fa-list-check"></i> Capítulos</button>' +
            /* #11: CTA + hashtags */
            '<button type="button" id="ytCtaInsert" class="btn-luxury-action" title="Insertar bloque de contacto + hashtags institucionales" style="padding:7px 12px;font-size:11px;"><i class="fas fa-bullhorn"></i> Insertar CTA</button>' +
            '<label style="font-size:11px;color:var(--text-dim);display:inline-flex;align-items:center;gap:6px;cursor:pointer;">' +
              '<input id="ytCtaAuto" type="checkbox" style="cursor:pointer;"> Agregar CTA automático si falta' +
            '</label>' +
          '</div></div>' +
          '<div style="margin-bottom:14px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Tags SEO (separados por coma)</span>' +
          '<input id="ytTags" type="text" class="crm-field-input" placeholder="inmobiliaria córdoba, departamentos, nueva córdoba" style="width:100%;">' +
          /* MEJORA: chips con los tags que ya rindieron en el canal */
          '<div id="ytChannelTags" style="margin-top:8px;"></div>' +
          '</div>' +
          '<div style="display:flex;gap:14px;margin-bottom:16px;flex-wrap:wrap;">' +
            '<div style="flex:2;min-width:250px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Video (máx. 2 GB)</span>' +
            /* MEJORA: se puede arrastrar el archivo a la zona */
            '<div id="ytFileDrop" style="border:1px dashed rgba(255,255,255,0.18);border-radius:12px;padding:10px;transition:border-color .2s,background .2s;">' +
              '<input id="ytFile" type="file" accept="video/*" class="crm-field-input" style="width:100%;padding:8px;">' +
              '<div id="ytFileInfo" style="font-size:11px;color:var(--accent);margin-top:4px;display:none;"></div>' +
              '<div id="ytFileDropHint" style="font-size:10.5px;color:var(--text-dim);margin-top:5px;text-align:center;">o arrastrá el video acá</div>' +
            '</div></div>' +
            '<div style="flex:1;min-width:140px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Visibilidad</span>' +
            '<select id="ytPrivacy" class="crm-field-input crm-field-input--select">' +
              '<option value="public">Público</option>' +
              '<option value="unlisted">Oculto (link)</option>' +
              '<option value="private">Privado</option>' +
            '</select></div>' +
            '<div style="flex:1;min-width:180px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Programar (opcional)</span>' +
            '<input id="ytPublishAt" type="datetime-local" class="crm-field-input" style="width:100%;">' +
            /* #10: schedules rápidos */
            '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">' +
              '<button type="button" data-quick-sched="hoy18" class="btn-luxury-action" style="padding:5px 9px;font-size:10.5px;">Hoy 18:00</button>' +
              '<button type="button" data-quick-sched="manana12" class="btn-luxury-action" style="padding:5px 9px;font-size:10.5px;">Mañana 12:00</button>' +
              '<button type="button" data-quick-sched="jueves18" class="btn-luxury-action" style="padding:5px 9px;font-size:10.5px;">Jueves 18:00</button>' +
            '</div></div>' +
          '</div>' +
          '<div id="ytProgress" style="display:none;margin-bottom:16px;">' +
            '<div style="height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;">' +
              '<div id="ytUploadBar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),#2DE2DA);border-radius:4px;transition:width .3s;"></div>' +
            '</div>' +
            '<div id="ytUploadPct" style="font-size:12px;color:var(--text-dim);margin-top:6px;display:flex;justify-content:space-between;"></div>' +
            '<div id="ytUploadEta" style="font-size:11px;color:var(--accent);margin-top:3px;"></div>' +
            /* MEJORA: cancelar la subida (antes solo se podía cerrar la pestaña) */
            '<button type="button" id="ytCancelUpload" class="btn-luxury-action" style="margin-top:10px;padding:7px 12px;font-size:11px;color:var(--danger);"><i class="fas fa-circle-xmark"></i> Cancelar subida</button>' +
          '</div>' +
          '<button type="button" id="ytPublishBtn" class="btn-luxury-action" style="padding:12px 28px;font-size:14px;"><i class="fas fa-paper-plane"></i> Publicar en YouTube</button>' +
          /* #44: HUD de cuota API estimada */
          '<div id="ytQuotaHud" style="margin-top:14px;"></div>' +
        '</div>' +
        '</div>' +
        /* Columna derecha: Score SEO — el motor vive en assets/js/yt-seo-score.js (BH_YT_SEO) */
        '<div style="flex:2;min-width:min(300px,100%);max-width:430px;position:sticky;top:74px;">' +
          '<div class="glass-panel" style="padding:20px 18px 16px;">' +
            '<h3 style="margin:0 0 4px;font-size:15px;"><i class="fas fa-bullseye" style="color:var(--accent);"></i> Score SEO del video</h3>' +
            '<p style="margin:0 0 12px;font-size:11.5px;color:var(--text-dim);">Optimización medida en vivo (estilo vidIQ Vision).</p>' +
            '<div style="margin-bottom:6px;"><span style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:5px;">Palabra clave objetivo <span style="font-size:10.5px;">(vacío = la deduzco del título)</span></span>' +
            '<input id="ytKeyword" type="text" class="crm-field-input" placeholder="Ej: inmobiliaria córdoba" style="width:100%;"></div>' +
            '<div id="ytSeoBody"></div>' +
            /* #7: completar tags con los presets sugeridos */
            '<button type="button" id="ytQuickFixTags" class="btn-luxury-action" title="Agrega los tags sugeridos hasta 15 (respeta el límite de 480 chars)" style="width:100%;margin-top:10px;padding:8px 12px;font-size:11px;"><i class="fas fa-wand-magic-sparkles"></i> Completar tags sugeridos</button>' +
          '</div>' +
        '</div>' +
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
      if (sub) {
        const which = sub.dataset.sub;
        /* REPARACIÓN: el botón "Studio" abre el canal conectado (si hay
           más de uno, el primero activo) en vez de mostrar un panel vacío. */
        if (which === 'studio') {
          const acc = _accounts.find(function (a) { return a.platform === 'youtube' && a.status === 'active'; });
          if (acc) { openStudio(acc); return; }
        }
        switchSubTab(which);
        return;
      }
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
      /* MEJORA: copiar link desde la card */
      const copyVidBtn = e.target.closest('[data-studio-copy]');
      if (copyVidBtn) {
        const url = 'https://www.youtube.com/watch?v=' + copyVidBtn.dataset.studioCopy;
        copyText(url).then(function (ok) {
          showToast(ok ? 'Link copiado.' : 'No se pudo copiar el link.', ok ? 'success' : 'error');
        });
        return;
      }
      const delVid = e.target.closest('[data-studio-delete]');
      if (delVid) { studioDeleteVideo(delVid.dataset.studioDelete, delVid.dataset.studioTitle || ''); return; }
      /* STUDIO: tarjeta/detalle de video (#26) */
      const detail = e.target.closest('[data-studio-detail]');
      if (detail) {
        const v = findStudioVideo(detail.dataset.studioDetail);
        if (v) openStudioVideoDetail(v);
        return;
      }
      /* MEJORAS 2026-10-30: form Crear */
      if (e.target.closest('#ytPropertyFill')) { fillFromProperty(); return; }
      /* MEJORA: chip de tag del canal → lo agrega al campo de tags */
      const tagChip = e.target.closest('[data-yt-tag]');
      if (tagChip) {
        const tag = tagChip.dataset.ytTag || '';
        const input = $('#ytTags');
        if (input && tag) {
          const current = String(input.value || '').split(',').map(function (t) { return bhNorm(t.trim()); }).filter(Boolean);
          if (current.indexOf(bhNorm(tag)) < 0) {
            input.value = input.value ? (input.value.replace(/\s*,\s*$/, '') + ', ' + tag) : tag;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            showToast('Tag agregado: ' + tag, 'success');
          }
        }
        return;
      }
      const quickSched = e.target.closest('[data-quick-sched]');
      if (quickSched) { applyQuickSchedule(quickSched.dataset.quickSched || ''); return; }
      if (e.target.closest('#ytCtaInsert')) { insertCtaBlock(); return; }
      if (e.target.closest('#ytChaptersBtn')) { openChaptersModal(); return; }
      if (e.target.closest('#ytTemplateSave')) { saveTemplateFromForm(); return; }
      if (e.target.closest('#ytTemplateDel')) { deleteCurrentTemplate(); return; }
      if (e.target.closest('#ytQuickFixTags')) { quickFixTags(); return; }
      if (e.target.closest('#ytCloneMeta')) { openCloneModal(); return; }
      /* #3/#42: historial → copiar o reintentar (metadata al form) */
      const copyBtn = e.target.closest('[data-contenido-copy]');
      if (copyBtn) {
        const p = _lastHistory.find(function (x) { return x.id === copyBtn.dataset.contenidoCopy; });
        if (p) { prefillFromPost(p, false); showToast('Metadata copiada al formulario.', 'info'); }
        return;
      }
      const retryBtn = e.target.closest('[data-contenido-retry]');
      if (retryBtn) {
        const p = _lastHistory.find(function (x) { return x.id === retryBtn.dataset.contenidoRetry; });
        if (p) { prefillFromPost(p, true); showToast('Metadata cargada — elegí el archivo y volvé a publicar.', 'info'); }
        return;
      }
      /* #48: backup JSON del historial */
      if (e.target.closest('#ytBackupJson')) { backupSocialPostsJson(); return; }
    });
  }

  async function loadContenido() {
    if (!window.supabaseClient) return;
    renderShell();
    bindOnce();
    setupCreateFormUX(); // contadores de chars + feedback de archivo
    switchSubTab(_subTab);
    loadPropertiesForPicker(); // #1: async sin await — el picker llena cuando llegue
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
