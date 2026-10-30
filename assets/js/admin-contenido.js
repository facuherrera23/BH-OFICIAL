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

  /* ---------- Módulos compartidos del módulo (cargados antes que este archivo)
     BH_YT.core     → API con timeout/reintentos, estado, bus, storage, auditoría
     BH_YT.seo      → validaciones, variantes de título, bloques, presets
     BH_YT.publish  → pre-flight, subida reanudable, cola, dry-run, borrador
     Si alguno no estuviera cargado (HTML viejo en caché), el módulo sigue
     funcionando con lo que sí está: cada feature nueva chequea antes de
     usarse. NO se reimplementa nada acá: una sola implementación por
     comportamiento (si no, los módulos se pisan entre sí). */
  const CORE = (window.BH_YT && window.BH_YT.core) || null;
  const YTSEO = (window.BH_YT && window.BH_YT.seo) || null;
  const YTPUB = (window.BH_YT && window.BH_YT.publish) || null;

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
  let _uploadCtx = null;    // ctx de la subida en vuelo (permite abortar el XHR)

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
    /* videoCategories.list cuesta 1 unidad (no 5). */
    video_categories: 1,
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
     (Google suma unidades aunque el request falle en su lado).
     Si el núcleo compartido está cargado, la llamada pasa por él: timeout,
     reintentos con backoff y errores en español (un solo lugar donde la
     lógica de red vive). El fallback legacy es para un HTML viejo en caché. */
  async function studioApiCall(body) {
    const units = STUDIO_QUOTA[body.action] || 5;
    if (CORE && CORE.api && typeof CORE.api.studio === 'function') {
      const payload = Object.assign({}, body);
      delete payload.action;
      try {
        return await CORE.api.studio(body.action, payload);
      } finally {
        trackQuota(units); // estimación: el request salió (la unidad se consume)
      }
    }
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
      '<div class="yt-quota-head">' +
        '<span><i class="fas fa-gauge-high"></i> Cuota API estimada hoy (local)</span>' +
        '<span style="color:' + color + ';">' + used + ' / 10.000</span>' +
      '</div>' +
      '<div class="yt-quota-track">' +
        '<div class="yt-quota-bar" style="width:' + pct + '%;background:' + color + ';"></div>' +
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
        '<div class="yt-notice">' +
        '<i class="fas fa-chart-line"></i>' +
        '<span>Tendencia diaria del canal: se llena sola con los snapshots diarios (1 captura por día).</span></div>';
      return;
    }
    const delta = vals[vals.length - 1] - vals[0];
    el.innerHTML =
      '<div class="glass-panel yt-subpanel">' +
        '<div class="yt-subpanel-head">' +
          '<span><i class="fas fa-chart-line"></i> Vistas acumuladas (' + vals.length + ' días de historia)</span>' +
          '<span class="' + (delta >= 0 ? 'yt-delta--up' : 'yt-delta--down') + '">' + (delta >= 0 ? '+' : '') + fmtNum(delta) + ' en el período</span>' +
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
      '<div class="yt-chip-label"><i class="fas fa-tags"></i> Tags que ya rindieron en tu canal (clic para agregar):</div>' +
      '<div class="yt-chip-list">' +
      tags.map(function (t) {
        return '<button type="button" class="yt-chip" data-yt-tag="' + esc(t) + '">' + esc(t) + '</button>';
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

  /* Skeleton de carga del Studio (mismo lenguaje que los loaders del panel):
     en lugar de un texto con spinner, se insinúa la grilla que va a aparecer. */
  function studioSkeletonHtml() {
    const card = '<div class="yt-skeleton-card">' +
      '<div class="yt-skeleton yt-skeleton-thumb"></div>' +
      '<div class="yt-skeleton yt-skeleton-line"></div>' +
      '<div class="yt-skeleton yt-skeleton-line yt-skeleton-line--short"></div>' +
      '</div>';
    return '<div class="yt-studio-head">' +
        '<div class="yt-skeleton" style="width:72px;height:72px;border-radius:50%;flex-shrink:0;"></div>' +
        '<div style="flex:1;min-width:220px;">' +
          '<div class="yt-skeleton" style="height:20px;width:45%;"></div>' +
          '<div class="yt-skeleton" style="height:12px;width:28%;margin-top:10px;"></div>' +
        '</div>' +
      '</div>' +
      '<div class="yt-kpis">' +
        '<div class="yt-kpi"><div class="yt-skeleton" style="height:16px;width:50%;margin:0 auto 10px;"></div><div class="yt-skeleton" style="height:26px;width:35%;margin:0 auto;"></div></div>' +
        '<div class="yt-kpi"><div class="yt-skeleton" style="height:16px;width:50%;margin:0 auto 10px;"></div><div class="yt-skeleton" style="height:26px;width:35%;margin:0 auto;"></div></div>' +
        '<div class="yt-kpi"><div class="yt-skeleton" style="height:16px;width:50%;margin:0 auto 10px;"></div><div class="yt-skeleton" style="height:26px;width:35%;margin:0 auto;"></div></div>' +
      '</div>' +
      '<div class="yt-video-grid">' + card + card + card + card + '</div>';
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

    if (wrap) wrap.innerHTML = studioSkeletonHtml();
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
      if (wrap) wrap.innerHTML = '<div class="yt-notice yt-notice--danger"><i class="fas fa-triangle-exclamation"></i><span>Error: ' + esc(err.message) + '</span></div>';
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
    /* Contador de comentarios nuevos (no abre el panel: solo el badge).
       Si la conexión no puede listarlos, el Studio sigue igual. */
    loadCommentsInbox(false);
  }

  function renderStudio() {
    const wrap = $('#contenidoStudio');
    if (!wrap || !_studioChannel) return;
    const ch = _studioChannel;
    const handleUrl = ch.handle ? 'https://www.youtube.com/@' + ch.handle.replace(/^@/, '') : 'https://www.youtube.com/channel/' + ch.id;

    const kpi = (icono, valor, label) =>
      '<div class="yt-kpi">' +
        '<div class="yt-kpi-icon"><i class="' + icono + '"></i></div>' +
        '<div class="yt-kpi-value">' + esc(fmtNum(valor)) + '</div>' +
        '<div class="yt-kpi-label">' + esc(label) + '</div>' +
      '</div>';

    wrap.innerHTML =
      /* Header del canal — ancho completo */
      '<div class="yt-studio-head">' +
        (ch.avatar
          ? '<img class="yt-studio-avatar" src="' + esc(ch.avatar) + '" alt="">'
          : '<div class="yt-studio-avatar yt-studio-avatar--icon"><i class="fab fa-youtube" style="color:#FF0000;"></i></div>') +
        '<div style="flex:1;min-width:220px;">' +
          '<div class="yt-studio-title">' + esc(ch.title) + '</div>' +
          '<div class="yt-studio-sub">Canal de YouTube · gestionado desde Bienenhaus</div>' +
        '</div>' +
        '<div class="yt-inline">' +
          '<button type="button" id="studioPublishBtn" class="btn-luxury-action yt-btn--md"><i class="fas fa-plus"></i> Publicar</button>' +
          /* MEJORA #31/#46: bandeja de comentarios del canal (con contador
             de "nuevos" desde la última visita). */
          '<button type="button" id="studioCommentsBtn" class="btn-luxury-action yt-btn--md" title="Comentarios recientes del canal"><i class="fas fa-comment-dots"></i> Comentarios<span id="ytCommentsBadge" class="yt-comments-badge" style="display:none;"></span></button>' +
          /* MEJORA: forzar el refresh del inventario (el cache de 5 min
             escondía los videos recién publicados en YouTube Studio). */
          '<button type="button" id="studioRefreshBtn" class="btn-luxury-action" title="Volver a pedir el inventario a YouTube (ignora el caché)" style="padding:10px 18px;font-size:13px;"><i class="fas fa-rotate"></i> Actualizar</button>' +
          '<a href="' + esc(handleUrl) + '" target="_blank" rel="noopener" class="btn-luxury-action yt-btn--md yt-btn--link"><i class="fas fa-arrow-up-right-from-square"></i> Ver canal</a>' +
          '<a href="' + esc(handleUrl + '/community') + '" target="_blank" rel="noopener" title="Los posts de la comunidad no tienen API oficial — se crean desde YouTube" class="btn-luxury-action yt-btn--md yt-btn--link"><i class="fas fa-users"></i> Comunidad</a>' +
          '<button type="button" id="studioBackBtn" class="btn-luxury-action yt-btn--md"><i class="fas fa-arrow-left"></i> Volver</button>' +
        '</div>' +
      '</div>' +
      /* KPIs — ancho completo, 3 en fila */
      '<div class="yt-kpis">' +
        kpi('fas fa-users', ch.subscribers, 'Suscriptores') +
        kpi('fas fa-eye', ch.total_views, 'Vistas totales') +
        kpi('fas fa-video', ch.video_count, 'Videos') +
      '</div>' +
      /* MEJORAS 2026-10-30: métricas #21, tendencia #22 y calendario #46 */
      '<div id="ytAnalyticsPanel" class="yt-block"></div>' +
      '<div id="ytTrend" class="yt-block"></div>' +
      /* Bandeja de comentarios (se abre desde el botón del header). */
      '<div id="ytCommentsInbox" class="yt-block" style="display:none;"></div>' +
      studioMonthGridHtml() +
      (!_studioCanManage
        ? '<div class="yt-notice yt-notice--warning">' +
            '<i class="fas fa-triangle-exclamation"></i>' +
            '<span>Modo solo lectura: reconectá la cuenta de YouTube desde la pestaña Cuentas para habilitar edición, borrado, programación y miniaturas.</span>' +
          '</div>'
        : '') +
      /* #25: barra de búsqueda/orden/filtro y export (#28) */
      (_studioTruncated
        ? '<div class="yt-notice yt-notice--warning">' +
            '<i class="fas fa-triangle-exclamation"></i>' +
            '<span>Mostrando ' + _studioVideos.length + ' de ' + _studioTotal + ' videos del canal (el inventario carga hasta 100 por vez).</span>' +
          '</div>'
        : '') +
      '<div class="yt-toolbar">' +
        '<h3 class="yt-toolbar-title"><i class="fas fa-list"></i> Contenido (<span id="studioCount">' + _studioVideos.length + '</span>)</h3>' +
        '<div class="yt-spacer"></div>' +
        '<input id="studioSearch" type="text" placeholder="Buscar título, tag o descripción…" class="crm-field-input yt-search">' +
        '<select id="studioSort" class="crm-field-input crm-field-input--select">' +
          '<option value="recent">Más recientes</option>' +
          '<option value="old">Más antiguos</option>' +
          '<option value="views">Más vistas</option>' +
          '<option value="likes">Más likes</option>' +
          '<option value="comments">Más comentarios</option>' +
        '</select>' +
        '<select id="studioFilter" class="crm-field-input crm-field-input--select">' +
          '<option value="all">Todos</option>' +
          '<option value="public">Públicos</option>' +
          '<option value="private">Privados</option>' +
          '<option value="unlisted">Ocultos</option>' +
          '<option value="processing">Procesando</option>' +
          '<option value="dead">Sin vistas +30 días</option>' +
        '</select>' +
        /* MEJORA: filtros por rendimiento y antigüedad (el dueño pregunta
           "¿cuáles rinden?" — con 100 videos no se filtraba a mano). */
        '<select id="studioViews" class="crm-field-input crm-field-input--select" title="Filtrar por cantidad de vistas">' +
          '<option value="all">Vistas: todas</option>' +
          '<option value="0">0 vistas</option>' +
          '<option value="1-999">1 – 999</option>' +
          '<option value="1k-9k">1.000 – 9.999</option>' +
          '<option value="10k+">10.000+</option>' +
        '</select>' +
        '<select id="studioAge" class="crm-field-input crm-field-input--select" title="Filtrar por antigüedad">' +
          '<option value="all">Antigüedad: todas</option>' +
          '<option value="7">Últimos 7 días</option>' +
          '<option value="30">Últimos 30 días</option>' +
          '<option value="90">Últimos 90 días</option>' +
          '<option value="365">Último año</option>' +
        '</select>' +
        '<button type="button" id="studioCsv" class="btn-luxury-action" title="Descargar inventario filtrado en CSV" style="padding:8px 12px;font-size:11px;"><i class="fas fa-file-csv"></i> CSV</button>' +
      '</div>' +
      '<div id="studioVideos" class="yt-video-grid">' + renderStudioVideos() + '</div>';

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

    /* Bandeja de comentarios: abre/cierra el panel y pide los comentarios
       del canal (la primera vez los marca como vistos). */
    const cmBtn = $('#studioCommentsBtn');
    if (cmBtn) cmBtn.addEventListener('click', function () {
      const panel = $('#ytCommentsInbox');
      if (!panel) return;
      const abierto = panel.style.display !== 'none';
      panel.style.display = abierto ? 'none' : '';
      if (!abierto) loadCommentsInbox(true);
    });
  }

  /* Score SEO de un video del canal (badge de la card). El motor es puro y
     barato: con 100 videos son 100 cálculos chicos por re-render. */
  function studioSeoScore(v) {
    if (!window.BH_YT_SEO || typeof window.BH_YT_SEO.calc !== 'function') return null;
    try {
      const r = window.BH_YT_SEO.calc({
        title: (v && v.title) || '',
        description: (v && v.description) || '',
        tags: (v && v.tags) || [],
      });
      return (r && !r.empty) ? r : null;
    } catch (_) { return null; }
  }

  /* #25: filtro/orden de la grilla; #27 "dead" = 0 vistas con más de 30 días */
  function filteredStudioVideos() {
    let list = _studioVideos.slice();
    const q = bhNorm(_studioQ).trim();
    if (q) {
      list = list.filter(function (v) {
        /* Búsqueda full-text: título, tags Y descripción (el dueño
           recuerda una frase de la descripción, no el título). */
        return bhNorm(v.title || '').indexOf(q) >= 0 ||
          bhNorm(v.description || '').indexOf(q) >= 0 ||
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
      /* Estado vacío con el lenguaje del panel (.empty-state) */
      return '<div class="empty-state">' +
        '<i class="fab fa-youtube"></i>' +
        '<div class="empty-state-title">El canal todavía no tiene videos</div>' +
        '<div>Publicá el primero desde la pestaña Crear publicación.</div>' +
        '<button type="button" class="btn-luxury-action" id="studioEmptyPublish"><i class="fas fa-plus"></i> Publicar un video</button>' +
        '</div>';
    }
    if (!list.length) {
      return '<div class="empty-state">' +
        '<i class="fas fa-filter-circle-xmark"></i>' +
        '<div class="empty-state-title">Ningún video coincide con la búsqueda o el filtro</div>' +
        '<div>Probá con otro texto o volvé a "Todos".</div>' +
        '</div>';
    }
    const PRIVACY = { public: ['Público', 'public'], private: ['Privado', 'private'], unlisted: ['Oculto', 'unlisted'] };
    return list.map(function (v) {
      const priv = PRIVACY[v.privacy] || [v.privacy, 'other'];
      const fecha = window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(v.published_at) : (v.published_at || '');
      /* #24: badge de subida en procesamiento (upload_status del server) */
      const processing = v.upload_status && v.upload_status !== 'processed';
      const sparkData = sparkPointsFor(v.id, 14); // #23
      const seo = studioSeoScore(v);
      /* REPARACIÓN: sin youtube.force-ssl (can_manage=false) los botones de
         editar/borrar se mostraban igual → el server respondía 403 y el dueño
         veía un error. Ahora se ocultan y el aviso de "solo lectura" explica
         cómo habilitarlo. */
      const manageActions = _studioCanManage
        ? '<button type="button" class="btn-luxury-action" data-studio-edit="' + esc(v.id) + '" title="Editar título, descripción, tags, visibilidad y programación" style="padding:7px 11px;font-size:11px;"><i class="fas fa-pen"></i></button>' +
          '<button type="button" class="btn-luxury-action" data-studio-delete="' + esc(v.id) + '" data-studio-title="' + esc(v.title) + '" title="Borrar video (permanente)" style="padding:7px 11px;font-size:11px;color:var(--danger);"><i class="fas fa-trash-can"></i></button>'
        : '';
      /* Tarjeta en grid: miniatura grande arriba, info + acciones abajo */
      return '<article class="yt-video-card">' +
        /* Miniatura a ancho completo de la tarjeta */
        (v.thumbnail
          ? '<div class="yt-video-thumb" data-studio-detail="' + esc(v.id) + '">' +
              '<img class="yt-thumb-img" src="' + esc(v.thumbnail) + '" alt="" loading="lazy">' +
              (v.duration ? '<span class="yt-video-duration">' + esc(isoDurationToText(v.duration)) + '</span>' : '') +
              (processing ? '<span class="yt-video-processing"><i class="fas fa-spinner fa-spin"></i> Procesando…</span>' : '') +
            '</div>'
          : '<div class="yt-video-thumb yt-video-thumb--empty" data-studio-detail="' + esc(v.id) + '"><i class="fab fa-youtube" style="color:#FF0000;font-size:32px;"></i></div>') +
        /* Info */
        '<div class="yt-video-body" data-studio-detail="' + esc(v.id) + '">' +
          '<div class="yt-video-title">' + esc(v.title) + '</div>' +
          '<div class="yt-video-metrics">' +
            '<span title="Vistas"><i class="fas fa-eye"></i> ' + fmtNum(v.views) + '</span>' +
            '<span title="Likes"><i class="fas fa-thumbs-up"></i> ' + fmtNum(v.likes) + '</span>' +
            '<span title="Comentarios"><i class="fas fa-comment"></i> ' + fmtNum(v.comments) + '</span>' +
            (seo ? '<span class="yt-video-seo" style="color:' + esc(seo.color) + ';" title="Score SEO del video (' + esc(seo.label) + ')"><i class="fas fa-bullseye"></i> ' + esc(String(seo.score)) + '</span>' : '') +
            (sparkData ? '<span title="Tendencia de las últimas 2 semanas">' + buildSparkSvg(sparkData, 62, 18) + '</span>' : '') +
          '</div>' +
          '<div class="yt-video-date">' + esc(fecha) + '</div>' +
        '</div>' +
        /* Barra de acciones */
        '<div class="yt-video-actions">' +
          '<span class="yt-privacy yt-privacy--' + esc(priv[1]) + '">' + esc(priv[0]) + '</span>' +
          '<button type="button" class="btn-luxury-action" data-studio-detail="' + esc(v.id) + '" title="Detalles, playlists y métricas del video" style="padding:7px 11px;font-size:11px;"><i class="fas fa-circle-info"></i></button>' +
          /* MEJORA: copiar el link desde la card (sin abrir el detalle) */
          '<button type="button" class="btn-luxury-action" data-studio-copy="' + esc(v.id) + '" title="Copiar el link del video" style="padding:7px 11px;font-size:11px;"><i class="fas fa-link"></i></button>' +
          manageActions +
          '<a href="https://www.youtube.com/watch?v=' + esc(v.id) + '" target="_blank" rel="noopener" title="Ver en YouTube" class="btn-luxury-action yt-btn--sm yt-btn--link"><i class="fas fa-arrow-up-right-from-square"></i></a>' +
        '</div>' +
      '</article>';
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
      cells += '<div class="yt-month-cell">' + d +
        (byDay[d] ? '<i class="fas fa-circle yt-month-dot"></i>' : '') +
        '</div>';
    }
    return '<div id="ytMonthGrid" class="glass-panel yt-subpanel">' +
      '<div class="yt-subpanel-head"><span><i class="fas fa-calendar"></i> ' + esc(monthName) + ' · ' + estrenos + ' estreno(s)</span></div>' +
      '<div class="yt-month-grid">' + cells + '</div>' +
      '</div>';
  }

  /* #21: métricas del canal (28 días). Sin scope de analytics → banner de
     reconexión (needs_reconnect, contrato del Edge Function). El panel vacío
     en otros errores: la métrica es un extra, no un bloqueante. */
  async function loadAnalyticsPanel() {
    const el = $('#ytAnalyticsPanel');
    if (!el || !_studioAccount) return;
    el.innerHTML = '<p class="yt-muted"><i class="fas fa-spinner fa-spin"></i> Cargando métricas…</p>';
    try {
      const res = await studioApiCall({ action: 'analytics', account_id: _studioAccount.id });
      const t = res.totals || {};
      const stat = function (val, label) {
        return '<div class="yt-stat">' +
          '<div class="yt-stat-value">' + esc(fmtNum(Number(val) || 0)) + '</div>' +
          '<div class="yt-stat-label">' + esc(label) + '</div>' +
        '</div>';
      };
      const statRaw = function (text, label) {
        return '<div class="yt-stat">' +
          '<div class="yt-stat-value">' + esc(text) + '</div>' +
          '<div class="yt-stat-label">' + esc(label) + '</div>' +
        '</div>';
      };
      const avgNum = Number(t.avg_view_seconds) || 0;
      const avgTxt = Math.floor(avgNum / 60) + ':' + String(Math.round(avgNum % 60)).padStart(2, '0');
      el.innerHTML =
        '<div class="glass-panel yt-subpanel">' +
          '<div class="yt-subpanel-head">' +
            '<span><i class="fas fa-chart-simple"></i> Últimos 28 días' + (res.range ? ' (' + esc(res.range.start) + ' → ' + esc(res.range.end) + ')' : '') + '</span>' +
            '<span>YouTube Analytics</span>' +
          '</div>' +
          '<div class="yt-stats">' +
            stat(t.views, 'Vistas') +
            stat(t.watch_minutes, 'Minutos vistos') +
            statRaw(avgTxt, 'Duración prom. vista') +
            stat(t.subscribers_gained, 'Suscriptores ganados') +
          '</div>' +
        '</div>';
    } catch (err) {
      if (/needs_reconnect/.test(String(err.message))) {
        el.innerHTML =
          '<div class="yt-notice">' +
            '<i class="fas fa-plug-circle-exclamation"></i>' +
            '<span>Las métricas avanzadas piden un permiso nuevo (analítica). Desconectá la cuenta y conectala de nuevo en Cuentas — es una sola vez; el resto del canal sigue funcionando.</span>' +
          '</div>';
      } else {
        el.innerHTML = '';
      }
    }
  }

  function findStudioVideo(videoId) {
    return _studioVideos.find(function (v) { return v.id === videoId; }) || null;
  }

  /* ---------- Comentarios (módulo compartido yt-comments.js) ----------
     Leer/responder/moderar comentarios y crear leads desde ellos.
     La lógica vive en el server (social-youtube-comments); acá solo
     se pinta y se conectan los botones. */

  function commentsModule() {
    return (window.BH_YT && window.BH_YT.comments) || null;
  }

  /* Comentarios cargados, indexados por id (para responder/crear lead
     sin volver a pegarle al server). */
  let _commentsById = {};

  /* --- Bloque de comentarios dentro del modal de detalle del video --- */
  function loadCommentsBlock(box, video) {
    const wrap = box.querySelector('#steComments');
    if (!wrap) return;
    const cm = commentsModule();
    if (!cm) {
      wrap.innerHTML = '<div class="yt-hint">El módulo de comentarios no está cargado (recargá la página).</div>';
      return;
    }
    wrap.innerHTML =
      '<div class="yt-block-head"><i class="fas fa-comment"></i> Comentarios</div>' +
      '<button type="button" id="steCommentsLoad" class="btn-luxury-action yt-btn--sm"><i class="fas fa-download"></i> Cargar comentarios</button>';
    const btn = wrap.querySelector('#steCommentsLoad');
    if (!btn) return;
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cargando…';
      try {
        const res = await cm.list(_studioAccount.id, video.id);
        renderCommentsList(wrap, res.threads || []);
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-download"></i> Cargar comentarios';
        wrap.innerHTML = '<div class="yt-notice yt-notice--danger"><i class="fas fa-triangle-exclamation"></i><span>' +
          esc(err.message) + '</span></div>';
      }
    });
  }

  function renderCommentsList(wrap, threads) {
    const cm = commentsModule();
    _commentsById = {};
    if (!threads.length) {
      wrap.innerHTML = '<div class="yt-block-head"><i class="fas fa-comment"></i> Comentarios</div>' +
        '<div class="yt-hint">Este video todavía no tiene comentarios.</div>';
      return;
    }
    threads.forEach(function (t) { _commentsById[t.id] = t; });
    const html =
      '<div class="yt-block-head"><i class="fas fa-comment"></i> Comentarios (' + threads.length + ')</div>' +
      '<div class="yt-comments">' + threads.map(function (t) {
        return '<div class="yt-comment" data-comment-id="' + esc(t.id) + '">' +
          '<div class="yt-comment-head">' +
            '<span class="yt-comment-avatar">' + esc(cm.initials(t.author)) + '</span>' +
            '<span class="yt-comment-author">' + esc(t.author) + '</span>' +
            '<span class="yt-comment-time">' + esc(cm.timeAgo(t.publishedAt)) + '</span>' +
          '</div>' +
          '<div class="yt-comment-text">' + esc(t.text) + '</div>' +
          '<div class="yt-comment-actions">' +
            '<span class="yt-comment-likes"><i class="fas fa-thumbs-up"></i> ' + esc(String(t.likes)) + '</span>' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-cm-reply="' + esc(t.id) + '"><i class="fas fa-reply"></i> Responder</button>' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-cm-lead="' + esc(t.id) + '" title="Crear un lead del CRM con este comentario"><i class="fas fa-user-plus"></i> Crear lead</button>' +
            (_studioCanManage
              ? '<button type="button" class="btn-luxury-action yt-btn--xs" data-cm-heart="' + esc(t.id) + '" title="Dar like a este comentario"><i class="fas fa-heart"></i></button>' +
                '<button type="button" class="btn-luxury-action yt-btn--xs" data-cm-hold="' + esc(t.id) + '" title="Retener el comentario (no aparece hasta aprobarlo)"><i class="fas fa-eye-slash"></i></button>'
              : '') +
          '</div>' +
          ((t.replies || []).length
            ? '<div class="yt-comment-replies">' + t.replies.map(function (r) {
                return '<div class="yt-comment-reply">' +
                  '<span class="yt-comment-avatar yt-comment-avatar--sm">' + esc(cm.initials(r.author)) + '</span>' +
                  '<div><div class="yt-comment-author">' + esc(r.author) +
                    ' <span class="yt-comment-time">' + esc(cm.timeAgo(r.publishedAt)) + '</span></div>' +
                    '<div class="yt-comment-text">' + esc(r.text) + '</div></div>' +
                '</div>';
              }).join('') + '</div>'
            : '') +
          '<div class="yt-comment-replybox" data-replybox="' + esc(t.id) + '" style="display:none;">' +
            '<textarea class="crm-field-input" rows="2" style="width:100%;" placeholder="Escribí la respuesta…"></textarea>' +
            '<div class="yt-inline" style="margin-top:6px;">' +
              '<button type="button" class="btn-luxury-action yt-btn--xs" data-cm-send="' + esc(t.id) + '"><i class="fas fa-paper-plane"></i> Enviar</button>' +
              '<button type="button" class="btn-luxury-action yt-btn--xs" data-cm-cancel="' + esc(t.id) + '">Cancelar</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    wrap.innerHTML = html;
  }

  /* --- Bandeja de comentarios del canal (con contador de nuevos) --- */
  async function loadCommentsInbox(showPanel) {
    const cm = commentsModule();
    const panel = $('#ytCommentsInbox');
    const badge = $('#ytCommentsBadge');
    if (!cm || !_studioAccount || !_studioChannel || !_studioChannel.id) return;
    try {
      const res = await cm.inbox(_studioAccount.id, _studioChannel.id);
      const threads = res.threads || [];
      _commentsById = {};
      threads.forEach(function (t) { _commentsById[t.id] = t; });
      const unread = cm.unreadCount(threads);
      if (badge) {
        badge.textContent = unread ? String(unread) : '';
        badge.style.display = unread ? 'inline-flex' : 'none';
      }
      if (showPanel && panel) renderCommentsInbox(panel, threads);
      /* Al abrir la bandeja se marcan como vistos. */
      if (showPanel) cm.markSeen(Date.now());
    } catch (err) {
      /* La bandeja es un extra: si la conexión no tiene permiso para
         listar comentarios del canal, el resto del Studio sigue vivo. */
      if (showPanel && panel) {
        panel.innerHTML = '<div class="yt-notice yt-notice--warning"><i class="fas fa-triangle-exclamation"></i><span>' +
          esc(err.message) + '</span></div>';
      }
    }
  }

  function renderCommentsInbox(panel, threads) {
    const cm = commentsModule();
    if (!threads.length) {
      panel.innerHTML = '<div class="yt-block-head"><i class="fas fa-inbox"></i> Bandeja de comentarios</div>' +
        '<div class="yt-hint">Todavía no hay comentarios en el canal.</div>';
      return;
    }
    panel.innerHTML =
      '<div class="yt-block-head"><i class="fas fa-inbox"></i> Bandeja de comentarios (' + threads.length + ')</div>' +
      '<div class="yt-comments">' + threads.map(function (t) {
        return '<div class="yt-comment" data-comment-id="' + esc(t.id) + '">' +
          '<div class="yt-comment-head">' +
            '<span class="yt-comment-avatar">' + esc(cm.initials(t.author)) + '</span>' +
            '<span class="yt-comment-author">' + esc(t.author) + '</span>' +
            '<span class="yt-comment-time">' + esc(cm.timeAgo(t.publishedAt)) + '</span>' +
          '</div>' +
          '<div class="yt-comment-text">' + esc(t.text) + '</div>' +
          '<div class="yt-comment-actions">' +
            '<a class="btn-luxury-action yt-btn--xs yt-btn--link" href="https://www.youtube.com/watch?v=' + esc(t.videoId) + '" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> Ver video</a>' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-cm-lead="' + esc(t.id) + '" title="Crear un lead del CRM con este comentario"><i class="fas fa-user-plus"></i> Crear lead</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
  }

  /* ---------- Acciones sobre comentarios (delegadas) ---------- */

  /* El comentario cargado (para sacar el videoId y el texto). */
  function cmCommentById(id) {
    return _commentsById[id] || null;
  }

  /* Recarga la lista de comentarios de un video (tras responder/moderar). */
  async function reloadComments(wrap, videoId) {
    const cm = commentsModule();
    if (!cm || !wrap || !videoId || !_studioAccount) return;
    try {
      const res = await cm.list(_studioAccount.id, videoId);
      renderCommentsList(wrap, res.threads || []);
    } catch (_) { /* se deja la lista anterior: no se pierde lo que se veía */ }
  }

  /* Botón de moderación: alterna Retener ↔ Aprobar. El estado real NO
     viene en commentThreads.list, así que se recuerda localmente lo que
     se hizo en esta sesión (el server es la fuente de verdad). */
  function cmToggleHeld(btn) {
    const c = cmCommentById(btn.getAttribute('data-cm-hold'));
    const held = c ? !!c._held : false;
    const next = held ? 'approved' : 'held';
    if (c) c._held = !held;
    btn.innerHTML = held
      ? '<i class="fas fa-eye-slash"></i> Retener'
      : '<i class="fas fa-check"></i> Aprobar';
    btn.title = held
      ? 'Retener el comentario (no aparece hasta aprobarlo)'
      : 'Aprobar el comentario (volver a publicarlo)';
    return next;
  }

  /* Handler único de los botones [data-cm-*] (modal + bandeja). */
  async function onCommentAction(e) {
    const cm = commentsModule();
    if (!cm || !_studioAccount) {
      showToast('El módulo de comentarios no está disponible — recargá la página.', 'warning');
      return;
    }

    /* Abrir el box de respuesta */
    const replyBtn = e.target.closest('[data-cm-reply]');
    if (replyBtn) {
      const box = document.querySelector('[data-replybox="' + replyBtn.getAttribute('data-cm-reply') + '"]');
      if (box) {
        box.style.display = '';
        const ta = box.querySelector('textarea');
        if (ta) ta.focus();
      }
      return;
    }

    /* Cerrar el box de respuesta */
    const cancelBtn = e.target.closest('[data-cm-cancel]');
    if (cancelBtn) {
      const box = document.querySelector('[data-replybox="' + cancelBtn.getAttribute('data-cm-cancel') + '"]');
      if (box) {
        box.style.display = 'none';
        const ta = box.querySelector('textarea');
        if (ta) ta.value = '';
      }
      return;
    }

    /* Enviar la respuesta */
    const sendBtn = e.target.closest('[data-cm-send]');
    if (sendBtn) {
      const id = sendBtn.getAttribute('data-cm-send');
      const box = document.querySelector('[data-replybox="' + id + '"]');
      const ta = box && box.querySelector('textarea');
      const text = (ta && ta.value || '').trim();
      if (!text) { showToast('Escribí la respuesta antes de enviar.', 'warning'); return; }
      const c = cmCommentById(id);
      const videoId = (c && c.videoId) || '';
      if (!videoId) { showToast('No se pudo identificar el video del comentario.', 'error'); return; }
      sendBtn.disabled = true;
      const original = sendBtn.innerHTML;
      sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando…';
      try {
        await cm.reply(_studioAccount.id, videoId, id, text);
        showToast('Respuesta publicada.', 'success');
        const wrap = sendBtn.closest('#steComments');
        if (wrap) reloadComments(wrap, videoId);
      } catch (err) {
        showToast(err.message || 'No se pudo publicar la respuesta.', 'error');
      } finally {
        sendBtn.disabled = false;
        sendBtn.innerHTML = original;
      }
      return;
    }

    /* Like al comentario del canal */
    const heartBtn = e.target.closest('[data-cm-heart]');
    if (heartBtn) {
      const id = heartBtn.getAttribute('data-cm-heart');
      const c = cmCommentById(id);
      const liked = c ? !!c._liked : false;
      heartBtn.disabled = true;
      try {
        await cm.heart(_studioAccount.id, id, !liked);
        if (c) c._liked = !liked;
        showToast(liked ? 'Like quitado.' : 'Like dado.', 'success');
      } catch (err) {
        showToast(err.message || 'No se pudo dar like.', 'error');
      } finally {
        heartBtn.disabled = false;
      }
      return;
    }

    /* Retener / aprobar */
    const holdBtn = e.target.closest('[data-cm-hold]');
    if (holdBtn) {
      const id = holdBtn.getAttribute('data-cm-hold');
      const next = cmToggleHeld(holdBtn);
      holdBtn.disabled = true;
      try {
        await cm.moderate(_studioAccount.id, id, next);
        showToast(next === 'held' ? 'Comentario retenido.' : 'Comentario aprobado.', 'success');
      } catch (err) {
        /* Se revierte el estado local si el server no lo aceptó. */
        cmToggleHeld(holdBtn);
        showToast(err.message || 'No se pudo moderar el comentario.', 'error');
      } finally {
        holdBtn.disabled = false;
      }
      return;
    }

    /* Crear lead del CRM desde el comentario (#46) */
    const leadBtn = e.target.closest('[data-cm-lead]');
    if (leadBtn) {
      const id = leadBtn.getAttribute('data-cm-lead');
      const c = cmCommentById(id);
      if (!c) { showToast('No se encontró el comentario — recargá la lista.', 'error'); return; }
      leadBtn.disabled = true;
      const original = leadBtn.innerHTML;
      leadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      try {
        const res = await cm.createLead(_studioAccount.id, c.videoId, c);
        if (res && res.duplicate) {
          showToast('Ese comentario ya tenía un lead — no se duplicó.', 'info');
        } else {
          showToast('Lead creado en el CRM.', 'success');
        }
        leadBtn.innerHTML = '<i class="fas fa-check"></i> Lead';
      } catch (err) {
        showToast(err.message || 'No se pudo crear el lead.', 'error');
        leadBtn.innerHTML = original;
      } finally {
        leadBtn.disabled = false;
      }
      return;
    }
  }

  /* ---------- STUDIO: editar video ---------- */

  function openStudioEditModal(v) {
    const html =
      '<div class="yt-modal-head">' +
        '<h3><i class="fas fa-pen"></i> Editar video</h3>' +
        '<p class="yt-modal-sub">' + esc(String(v.title).substring(0, 80)) + '</p>' +
      '</div>' +
      '<div class="yt-field"><span class="yt-label">Título</span>' +
      '<input id="steTitle" type="text" class="crm-field-input" maxlength="100" value="' + esc(v.title) + '" style="width:100%;"></div>' +
      '<div class="yt-field"><span class="yt-label">Descripción</span>' +
      '<textarea id="steDesc" rows="4" class="crm-field-input" maxlength="5000" style="width:100%;">' + esc(v.description || '') + '</textarea></div>' +
      '<div class="yt-field"><span class="yt-label">Tags SEO (coma)</span>' +
      '<input id="steTags" type="text" class="crm-field-input" value="' + esc((v.tags || []).join(', ')) + '" style="width:100%;"></div>' +
      '<div class="yt-row" style="margin-bottom:16px;gap:12px;">' +
        '<div style="flex:1;min-width:150px;"><span class="yt-label">Visibilidad</span>' +
        '<select id="stePrivacy" class="crm-field-input crm-field-input--select" style="width:100%;">' +
          '<option value="public"' + (v.privacy === 'public' ? ' selected' : '') + '>Público</option>' +
          '<option value="unlisted"' + (v.privacy === 'unlisted' ? ' selected' : '') + '>Oculto (link)</option>' +
          '<option value="private"' + (v.privacy === 'private' ? ' selected' : '') + '>Privado</option>' +
        '</select></div>' +
        '<div style="flex:1;min-width:180px;"><span class="yt-label">Programar publicación (opcional)</span>' +
        '<input id="stePublishAt" type="datetime-local" class="crm-field-input" style="width:100%;">' +
        '<span id="steSchedHint" class="yt-hint"></span></div>' +
      '</div>' +
      '<div class="yt-field"><span class="yt-label">Miniatura (imagen JPG/PNG ≤ 2MB)</span>' +
      '<input id="steThumb" type="file" accept="image/jpeg,image/png" class="crm-field-input" style="width:100%;padding:8px;"></div>' +
      /* MEJORA #13: keyword + competencia del canal + delta de score (#20) */
      '<div id="steKwInfo" style="font-size:11px;color:var(--text-dim);border-top:1px solid rgba(255,255,255,0.06);margin-top:2px;padding-top:8px;"></div>' +
      /* MEJORA 2026-10-30: Score SEO en vivo dentro del modal (motor yt-seo-score.js) */
      '<div id="steSeoBody" style="border-top:1px solid rgba(255,255,255,0.06);margin-top:2px;padding-top:10px;"></div>' +
      '<div class="yt-modal-foot">' +
        '<button type="button" id="steCancel" class="btn-luxury-action yt-btn--md">Cancelar</button>' +
        '<button type="button" id="steSave" class="btn-luxury-action yt-btn--md"><i class="fas fa-floppy-disk"></i> Guardar</button>' +
      '</div>';
    const m = createYtModal('studioEditOverlay', { html: html });
    const box = m.box;
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
          /* Instante absoluto: el server corre en UTC y un "2026-10-31T18:00"
             sin zona lo interpretaría como 18:00 UTC = 21:00 en Argentina. */
          publish_at: publishAt ? new Date(publishAt).toISOString() : undefined,
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
    const ok = await ytConfirm({
      title: 'Borrar el video',
      message: 'Borrar "' + title.substring(0, 60) + '" de YouTube.\n\nPERMANENTE: los links compartidos hacia este video quedan muertos y no hay papelera.',
      icon: 'fas fa-trash-can',
      confirmText: 'Borrar de YouTube',
      danger: true,
    });
    if (!ok) return;
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
    const PRIVACY_TXT = { public: 'Público', private: 'Privado', unlisted: 'Oculto (link)' };
    const priv = PRIVACY_TXT[v.privacy] || String(v.privacy || '');
    const fecha = window.__BH.formatDateTimeWithTZ ? window.__BH.formatDateTimeWithTZ(v.published_at) : (v.published_at || '');
    const sparkFull = sparkPointsFor(v.id, 30);
    const tagsChips = (v.tags || []).map(function (t) {
      return '<span class="yt-chip" style="cursor:default;">' + esc(t) + '</span>';
    }).join('');
    const watchUrl = 'https://www.youtube.com/watch?v=' + v.id;
    const processing = v.upload_status && v.upload_status !== 'processed';

    const html =
      '<div class="yt-modal-head">' +
        '<h3 style="font-size:17px;line-height:1.35;">' + esc(v.title) + '</h3>' +
        '<p class="yt-modal-sub">' + esc(fecha) + ' · ' + esc(priv) +
          (processing ? ' · <span style="color:var(--warning);"><i class="fas fa-spinner fa-spin"></i> procesando</span>' : '') + '</p>' +
      '</div>' +
      '<div class="yt-row" style="margin-bottom:6px;gap:16px;">' +
        '<div style="flex:2;min-width:280px;">' +
          '<a href="' + esc(watchUrl) + '" target="_blank" rel="noopener" title="Ver en YouTube">' +
          (v.thumbnail
            ? '<img class="yt-thumb-img" src="' + esc(v.thumbnail) + '" alt="" style="width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:10px;">'
            : '<div style="width:100%;aspect-ratio:16/9;border-radius:10px;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;"><i class="fab fa-youtube" style="color:#FF0000;font-size:40px;"></i></div>') +
          '</a>' +
          '<div class="yt-video-metrics" style="margin-top:10px;font-size:12px;">' +
            '<span><i class="fas fa-eye"></i> <b>' + esc(fmtNum(v.views)) + '</b> vistas</span>' +
            '<span><i class="fas fa-thumbs-up"></i> <b>' + esc(fmtNum(v.likes)) + '</b> likes</span>' +
            '<span><i class="fas fa-comment"></i> <b>' + esc(fmtNum(v.comments)) + '</b> comentarios</span>' +
            '<span><i class="fas fa-clock"></i> ' + esc(isoDurationToText(v.duration || '')) + '</span>' +
          '</div>' +
        '</div>' +
        '<div style="flex:3;min-width:260px;">' +
          '<div class="yt-label" style="margin-bottom:6px;"><i class="fas fa-tags"></i> TAGS (' + (v.tags || []).length + ')</div>' +
          '<div class="yt-chip-list" style="margin-bottom:12px;">' + (tagsChips || '<span style="font-size:11px;color:var(--text-dim);">sin tags</span>') + '</div>' +
          (sparkFull
            ? '<div style="font-size:10.5px;color:var(--text-dim);margin-bottom:4px;"><i class="fas fa-chart-line"></i> Vistas · ' + sparkFull.length + ' puntos de historia</div>' +
              '<div>' + buildSparkSvgWide(sparkFull, 200, 44) + '</div>'
            : '') +
          '<div class="yt-inline" style="margin-top:12px;">' +
            (_studioCanManage
              ? '<button type="button" id="steDetailOpen" class="btn-luxury-action yt-btn--sm"><i class="fas fa-pen"></i> Editar datos</button>'
              : '') +
            '<a href="https://studio.youtube.com/video/' + esc(v.id) + '/edit" target="_blank" rel="noopener" title="Abrir en YouTube Studio" class="btn-luxury-action yt-btn--sm yt-btn--link"><i class="fas fa-sliders"></i> Studio</a>' +
            '<button type="button" id="steCopyLink" class="btn-luxury-action" title="Copiar link del video" style="padding:8px 14px;font-size:11.5px;"><i class="fas fa-link"></i> Copiar link</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="steDetailAna" style="margin:10px 0 6px;border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;"></div>' +
      '<div id="steComments" style="border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;margin-top:6px;"></div>' +
      '<div id="stePlaylists" style="border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;margin-top:6px;"></div>';

    const m = createYtModal('studioDetailOverlay', { wide: true, html: html });
    const box = m.box;

    /* #26 lazy: métricas del video + playlists a pedido */
    loadVideoAnalytics(box, v);
    loadPlaylistsBlock(box, v);
    /* Comentarios del video (a pedido: no se descargan solos). */
    loadCommentsBlock(box, v);

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
      '<button type="button" id="steAnaBtn" class="btn-luxury-action yt-btn--sm"><i class="fas fa-chart-simple"></i> Métricas de YouTube Analytics (28 días)</button>' +
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
              '<button type="button" id="stePlCreate" class="btn-luxury-action yt-btn--sm"><i class="fas fa-plus"></i> Crear</button>' +
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

  /* ---------- Modales del módulo (mismo lenguaje visual que el panel) ----------
     .yt-modal + .modal-box replican .admin-modal/.modal-box del admin
     (tokens, blur, radios, sombra) y el botón X de cierre (.modal-x-close).
     El panel inyecta su X solo sobre los modales estáticos del HTML, así que
     los modales dinámicos de Contenido llevan el suyo. */
  function createYtModal(id, opts) {
    opts = opts || {};
    closeModalIfExists(id);
    const ov = document.createElement('div');
    ov.id = id;
    ov.className = 'yt-modal is-open';
    const box = document.createElement('div');
    box.className = 'modal-box' + (opts.wide ? ' modal-box--wide' : '');
    /* El contenido se inyecta ANTES de la X: si se hiciera después, el
       innerHTML borraría el botón de cierre. */
    if (opts.html) box.innerHTML = opts.html;
    ov.appendChild(box);
    document.body.appendChild(ov);
    /* Clic en el fondo cierra (los modales del panel no lo hacen, pero acá
       el fondo es un overlay propio y el dueño lo espera así). */
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModalIfExists(id); });
    /* X de cierre */
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'modal-x-close';
    x.setAttribute('aria-label', 'Cerrar');
    x.innerHTML = '<i class="fas fa-xmark"></i>';
    x.addEventListener('click', function () { closeModalIfExists(id); });
    box.appendChild(x);
    /* Escape cierra */
    const onKey = function (e) {
      if (e.key !== 'Escape') return;
      if (!document.getElementById(id)) { document.removeEventListener('keydown', onKey, true); return; }
      e.stopPropagation();
      closeModalIfExists(id);
      document.removeEventListener('keydown', onKey, true);
    };
    document.addEventListener('keydown', onKey, true);
    return { overlay: ov, box: box };
  }

  /* Confirmación y prompt con el DIÁLOGO DEL PANEL (mismo look que el resto
     del admin) en vez del confirm()/prompt() nativo del navegador. Fallback
     al nativo si admin-app.js no está cargado. */
  function ytConfirm(opts) {
    const fn = (window.__BH && window.__BH.showConfirmDialog) || window.showConfirmDialog;
    if (typeof fn === 'function') return Promise.resolve(fn(opts));
    return Promise.resolve(window.confirm(opts.message || opts.title || '¿Confirmás?'));
  }

  function ytPrompt(opts) {
    const fn = (window.__BH && window.__BH.showInputPrompt) || window.showInputPrompt;
    if (typeof fn === 'function') return Promise.resolve(fn(opts));
    return Promise.resolve(window.prompt(opts.message || opts.title || '', opts.defaultValue || ''));
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
      card.className = 'yt-account-card is-linked';
      const iconHtml = acc.avatar_url
        ? '<div class="yt-account-icon"><img src="' + esc(acc.avatar_url) + '" alt=""></div>'
        : '<div class="yt-account-icon" style="color:' + meta.color + ';"><i class="' + esc(meta.icon) + '" style="font-size:22px;"></i></div>';
      /* STUDIO: click en la tarjeta del canal abre la administración completa
         del contenido — pedir del dueño 2026-10-27. */
      card.dataset.contenidoStudio = acc.id;
      card.innerHTML =
        '<div style="flex:1;min-width:0;">' +
        '<div class="yt-account-name">' + esc(acc.display_name) + '</div>' +
        '<div class="yt-account-meta">' + esc(meta.name) + ' · conectada' +
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
      card.className = 'yt-account-card';
      card.innerHTML =
        '<div class="yt-account-icon" style="color:' + meta.color + ';"><i class="' + esc(meta.icon) + '" style="font-size:22px;"></i></div>' +
        '<div style="flex:1;min-width:0;">' +
        '<div class="yt-account-name">' + esc(meta.name) + '</div>' +
        '<div class="yt-account-meta">' + (!meta.available ? 'Próximamente' : (configured ? 'Sin conectar' : 'Sin app configurada')) + '</div>' +
        '</div>' +
        (!meta.available
          ? '<span style="font-size:11px;color:var(--text-dim);"><i class="fas fa-clock"></i></span>'
          : (configured
            ? '<button type="button" data-contenido-connect="' + esc(pid) + '" class="btn-luxury-action" style="padding:8px 14px;font-size:11px;"><i class="fas fa-plug"></i> Conectar</button>'
            : '<span class="yt-account-state" title="Faltan las credenciales OAuth de esta red (app_settings social_' + esc(pid) + ')."><i class="fas fa-sliders"></i> Sin configurar</span>'));
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
    const ok = await ytConfirm({
      title: 'Desconectar la cuenta',
      message: '¿Desconectar esta cuenta? Podés volver a conectarla cuando quieras.',
      icon: 'fas fa-plug-circle-xmark',
      confirmText: 'Desconectar',
      danger: true,
    });
    if (!ok) return;
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
        /* Las categorías de YouTube dependen del canal (son por región). */
        loadCategories();
      });
    }
    /* La lista de categorías se pide una vez por canal (queda cacheada 7 días
       en app_settings: el server no la vuelve a bajar). */
    loadCategories();
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
    /* La validación previa se refresca siempre (aunque el motor SEO no esté
       cargado): son dos checks distintos y el dueño no puede publicar sin
       ver los errores de límites de YouTube. */
    refreshValidationPanel();
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
    float.className = 'yt-upload-float';
    float.innerHTML =
      '<i class="fas fa-cloud-arrow-up" style="color:var(--accent);font-size:16px;"></i>' +
      '<div style="min-width:150px;">' +
        '<div id="ytFloatPct" class="yt-upload-float-pct"></div>' +
        '<div class="yt-quota-track" style="margin-top:4px;">' +
          '<div id="ytFloatBar" class="yt-quota-bar" style="background:var(--accent);"></div>' +
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
      const highlight = function (on) { dropZone.classList.toggle('is-over', !!on); };
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
        /* Aborta el XHR en vuelo (si hay): el módulo ve el 'abort' y frena
           sin dejar el video a medio publicar. */
        if (_uploadCtx && _uploadCtx.xhr) { try { _uploadCtx.xhr.abort(); } catch (_) {} }
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

    /* Plantillas por tipo de contenido (lógica en assets/js/yt-seo-tools.js).
       El select se puebla solo con el módulo cargado; si no, queda el
       placeholder y el botón avisa (nunca rompe el form). */
    const presetSel = $('#ytPresetSel');
    if (presetSel && YTSEO && YTSEO.PRESETS && presetSel.dataset.bound !== '1') {
      presetSel.dataset.bound = '1';
      presetSel.innerHTML = '<option value="">＋ Plantilla por tipo…</option>' +
        YTSEO.PRESETS.map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>';
        }).join('');
      presetSel.addEventListener('change', function () {
        const id = this.value || '';
        this.value = '';
        if (id) applyPresetById(id);
      });
    }

    /* Cola de publicación (render inicial + aviso de una subida pendiente) */
    renderQueuePanel();
    if (YTPUB && YTPUB.resume) {
      const pending = YTPUB.resume.load();
      if (pending && pending.postId) {
        const hint = $('#ytFileInfo');
        if (hint) {
          hint.style.display = '';
          hint.style.color = 'var(--warning)';
          hint.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Hay una subida pendiente de "' +
            esc(String(pending.title || pending.fileName || 'video').substring(0, 50)) +
            '" — volvé a elegir el mismo archivo para retomarla.';
        }
      }
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

  /* ============================================================
     HERRAMIENTAS DE PUBLICACIÓN (lote de 50 mejoras)
     ------------------------------------------------------------
     Toda la lógica vive en los módulos compartidos:
       · assets/js/yt-seo-tools.js → validate, titleVariants, BLOCKS, PRESETS, canibalización
       · assets/js/yt-publish.js   → preflight, dryRun, queue
     Acá solo se dibuja la UI y se conecta con el formulario. Si un
     módulo no estuviera cargado, el botón avisa (no falla en silencio).
     ============================================================ */

  function toolsUnavailable(name) {
    showToast('"' + name + '" no está disponible — recargá la página.', 'warning');
  }

  /* Propiedad seleccionada en el form (objeto del picker). */
  function currentProperty() {
    const id = ($('#ytProperty') || {}).value || '';
    if (!id) return null;
    return _createProps.find(function (x) { return x.id === id; }) || null;
  }

  /* Flag de publicación leído del form. El default importa: si el checkbox
     no está (HTML viejo en caché) NO se manda embeddable=false — con false
     YouTube bloquea el embed y las fichas dejan de mostrar el tour. */
  function flagChecked(id, fallback) {
    const el = $('#' + id);
    if (!el) return fallback;
    return !!el.checked;
  }

  /* Metadata del formulario: una sola fuente para la cola, el dry-run
     y el pre-flight (así no se desincronizan entre sí). */
  function collectFormMeta() {    return {
      title: (($('#ytTitle') || {}).value || '').trim(),
      description: (($('#ytDesc') || {}).value || '').trim(),
      tags: (($('#ytTags') || {}).value || '').trim(),
      keyword: (($('#ytKeyword') || {}).value || '').trim(),
      privacy: (($('#ytPrivacy') || {}).value || 'public'),
      propertyId: (($('#ytProperty') || {}).value || ''),
      categoryId: (($('#ytCategory') || {}).value || '22'),
      publishAt: (($('#ytPublishAt') || {}).value || ''),
    };
  }

  /* --- Categorías de YouTube: lista REAL de la API (cacheada 7 días) --- */
  async function loadCategories() {
    const sel = $('#ytCategory');
    if (!sel) return;
    const hint = $('#ytCategoryHint');
    const accountId = ($('#ytAccountSelect') || {}).value || '';
    if (!accountId) {
      if (hint) hint.textContent = 'Elegí un canal para cargar las categorías.';
      return;
    }
    try {
      const res = await studioApiCall({ action: 'video_categories', account_id: accountId });
      const cats = (res && res.categories) || [];
      if (!cats.length) return;
      const current = sel.value || '22';
      sel.innerHTML = cats.map(function (c) {
        return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
      }).join('');
      /* Si la categoría elegida sigue existiendo, se conserva. */
      const stillThere = cats.some(function (c) { return String(c.id) === String(current); });
      sel.value = stillThere ? current : String(cats[0].id);
      if (hint) {
        hint.textContent = res.cached
          ? 'Categorías de YouTube (cacheadas 7 días).'
          : 'Categorías reales de YouTube para Argentina.';
      }
    } catch (_) {
      if (hint) hint.textContent = 'No se pudo consultar la lista de categorías — se usa People & Blogs.';
    }
  }

  /* --- Validación en vivo: límites reales de YouTube + canibalización --- */
  function refreshValidationPanel() {
    const panel = $('#ytValidationPanel');
    if (!panel) return;
    if (!YTSEO || typeof YTSEO.validate !== 'function') { panel.innerHTML = ''; return; }
    const meta = collectFormMeta();
    let res;
    try {
      res = YTSEO.validate(meta);
    } catch (_) { panel.innerHTML = ''; return; }
    const items = [];
    (res.errors || []).forEach(function (i) { items.push({ level: 'error', msg: i.message }); });
    (res.warnings || []).forEach(function (i) { items.push({ level: 'warning', msg: i.message }); });
    (res.infos || []).forEach(function (i) { items.push({ level: 'info', msg: i.message }); });
    /* Canibalización: el video no debe competir con otro del canal. */
    try {
      const comp = YTSEO.canibalization({
        title: meta.title,
        keyword: meta.keyword,
        channelVideos: _studioVideos || [],
      });
      (comp || []).forEach(function (w) {
        items.push({ level: w.level === 'warning' ? 'warning' : 'info', msg: w.message });
      });
    } catch (_) { /* la canibalización es un extra: nunca rompe el panel */ }

    if (!items.length) {
      panel.innerHTML = '<div class="yt-validation-item yt-validation-item--ok">' +
        '<i class="fas fa-circle-check"></i> Todo listo para publicar.</div>';
      return;
    }
    const MAX = 8;
    const shown = items.slice(0, MAX);
    const rest = items.length - shown.length;
    panel.innerHTML = '<div class="yt-validation-title">Validación previa</div>' +
      shown.map(function (i) {
        const icon = i.level === 'error' ? 'fa-circle-xmark' : (i.level === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info');
        return '<div class="yt-validation-item yt-validation-item--' + i.level + '">' +
          '<i class="fas ' + icon + '"></i><span>' + esc(i.msg) + '</span></div>';
      }).join('') +
      (rest > 0 ? '<div class="yt-validation-more">y ' + rest + ' aviso(s) más…</div>' : '');
  }

  /* --- Títulos alternativos: 5 variantes con su score --- */
  function openTitleVariantsModal() {
    if (!YTSEO || typeof YTSEO.titleVariants !== 'function') return toolsUnavailable('Títulos alternativos');
    const meta = collectFormMeta();
    if (!meta.title) { showToast('Escribí un título base para generar las variantes.', 'warning'); return; }
    const variants = YTSEO.titleVariants({
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      keyword: meta.keyword,
      property: currentProperty() || {},
    });
    if (!variants.length) { showToast('No se pudieron generar variantes.', 'info'); return; }
    const html =
      '<div class="yt-modal-head">' +
        '<h3><i class="fas fa-wand-magic-sparkles"></i> Títulos alternativos</h3>' +
        '<p class="yt-modal-sub">Ordenados por score SEO. Hacé click para usar uno.</p>' +
      '</div>' +
      '<div class="yt-variants">' + variants.map(function (v, i) {
        const color = v.score == null ? 'var(--text-dim)'
          : (v.score >= 85 ? '#22c55e' : (v.score >= 70 ? '#a3e635' : (v.score >= 50 ? '#f59e0b' : '#ef4444')));
        return '<button type="button" class="yt-variant" data-yt-variant="' + i + '">' +
          '<div class="yt-variant-title">' + esc(v.title) + '</div>' +
          '<div class="yt-variant-meta">' +
            '<span class="yt-variant-score" style="color:' + color + ';">' + (v.score == null ? '—' : v.score + '/100') + '</span>' +
            '<span class="yt-variant-why">' + esc(v.why) + '</span>' +
          '</div>' +
        '</button>';
      }).join('') + '</div>' +
      '<div class="yt-modal-foot">' +
        '<button type="button" id="ytVariantsClose" class="btn-luxury-action yt-btn--md">Cerrar</button>' +
      '</div>';
    const m = createYtModal('ytVariantsOverlay', { html: html, wide: true });
    const close = m.box.querySelector('#ytVariantsClose');
    if (close) close.addEventListener('click', function () { closeModalIfExists('ytVariantsOverlay'); });
    m.box.querySelectorAll('[data-yt-variant]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const v = variants[parseInt(btn.getAttribute('data-yt-variant'), 10)];
        if (!v) return;
        setFieldValue('ytTitle', v.title);
        closeModalIfExists('ytVariantsOverlay');
        showToast('Título aplicado.', 'success');
      });
    });
  }

  /* --- Bloques de descripción reutilizables --- */
  function openBlocksModal() {
    if (!YTSEO || !YTSEO.BLOCKS) return toolsUnavailable('Bloques de descripción');
    const prop = currentProperty();
    const meta = {
      phone: '',
      email: '',
      url: 'https://bienenhaus.com.ar',
      keyword: collectFormMeta().keyword,
      propertyUrl: prop ? fichaUrlFor(prop.property_code) : '',
      zones: [],
    };
    const html =
      '<div class="yt-modal-head">' +
        '<h3><i class="fas fa-puzzle-piece"></i> Bloques de descripción</h3>' +
        '<p class="yt-modal-sub">Click para insertar el bloque al final de la descripción.</p>' +
      '</div>' +
      '<div class="yt-blocks">' + YTSEO.BLOCKS.map(function (b, i) {
        const preview = String(b.build(meta) || '').trim();
        return '<button type="button" class="yt-block" data-yt-block="' + i + '">' +
          '<div class="yt-block-head"><i class="' + esc(b.icon) + '"></i> ' + esc(b.label) + '</div>' +
          '<div class="yt-block-preview">' + esc(preview.substring(0, 180)) + '</div>' +
        '</button>';
      }).join('') + '</div>' +
      '<div class="yt-modal-foot">' +
        '<button type="button" id="ytBlocksClose" class="btn-luxury-action yt-btn--md">Cerrar</button>' +
      '</div>';
    const m = createYtModal('ytBlocksOverlay', { html: html, wide: true });
    const close = m.box.querySelector('#ytBlocksClose');
    if (close) close.addEventListener('click', function () { closeModalIfExists('ytBlocksOverlay'); });
    m.box.querySelectorAll('[data-yt-block]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const b = YTSEO.BLOCKS[parseInt(btn.getAttribute('data-yt-block'), 10)];
        if (!b) return;
        const text = String(b.build(meta) || '').trim();
        if (!text) { showToast('Ese bloque no aplica (falta la ficha de la propiedad).', 'info'); return; }
        const descEl = $('#ytDesc');
        if (!descEl) return;
        descEl.value = descEl.value.replace(/\s*$/, '') + '\n' + text;
        descEl.dispatchEvent(new Event('input', { bubbles: true }));
        closeModalIfExists('ytBlocksOverlay');
        showToast('Bloque insertado: ' + b.label, 'success');
      });
    });
  }

  /* --- Plantillas por tipo de contenido --- */
  function applyPresetById(id) {
    if (!YTSEO || typeof YTSEO.presetById !== 'function') return toolsUnavailable('Plantillas por tipo');
    const preset = YTSEO.presetById(id);
    if (!preset) return;
    const meta = collectFormMeta();
    const prop = currentProperty() || {};
    const out = preset.apply({ property: prop, keyword: meta.keyword, title: meta.title }) || {};
    if (out.title) setFieldValue('ytTitle', String(out.title).substring(0, 100));
    if (out.description) setFieldValue('ytDesc', String(out.description).substring(0, 5000));
    if (out.tags) {
      const tags = Array.isArray(out.tags) ? out.tags.join(', ') : String(out.tags);
      setFieldValue('ytTags', tags.substring(0, 480));
    }
    if (out.privacy && $('#ytPrivacy')) $('#ytPrivacy').value = out.privacy;
    recomputeSeoPanel();
    showToast('Plantilla "' + preset.label + '" aplicada.', 'success');
  }

  /* --- Pre-flight: archivo + metadata antes de gastar cuota --- */
  function openPreflightModal() {
    if (!YTPUB || typeof YTPUB.preflight !== 'function') return toolsUnavailable('Pre-flight');
    const fileInput = $('#ytFile');
    const file = fileInput && fileInput.files && fileInput.files[0];
    const res = YTPUB.preflight(file, collectFormMeta());
    const html =
      '<div class="yt-modal-head">' +
        '<h3><i class="fas fa-clipboard-check"></i> Pre-flight</h3>' +
        '<p class="yt-modal-sub">Chequeos que se hacen ANTES de subir el video (no gastan cuota).</p>' +
      '</div>' +
      '<div class="yt-preflight">' + (res.checks || []).map(function (c) {
        const icon = c.ok ? 'fa-circle-check' : 'fa-circle-xmark';
        const color = c.ok ? '#22c55e' : '#ef4444';
        return '<div class="yt-preflight-item">' +
          '<i class="fas ' + icon + '" style="color:' + color + ';"></i>' +
          '<div><div class="yt-preflight-label">' + esc(c.label) + '</div>' +
          '<div class="yt-preflight-detail">' + esc(c.detail) + '</div></div>' +
        '</div>';
      }).join('') + '</div>' +
      '<div class="yt-modal-foot">' +
        '<span class="yt-preflight-summary">' + (res.ok ? 'Todo OK: se puede publicar.' : 'Hay ' + (res.errors || []).length + ' problema(s) por corregir.') + '</span>' +
        '<button type="button" id="ytPreflightClose" class="btn-luxury-action yt-btn--md">Cerrar</button>' +
      '</div>';
    const m = createYtModal('ytPreflightOverlay', { html: html });
    const close = m.box.querySelector('#ytPreflightClose');
    if (close) close.addEventListener('click', function () { closeModalIfExists('ytPreflightOverlay'); });
  }

  /* --- Simulación en el servidor (dry-run: no consume cuota de Google) --- */
  async function runDryRun() {
    if (!YTPUB || typeof YTPUB.dryRun !== 'function') return toolsUnavailable('Simulación');
    const fileInput = $('#ytFile');
    const file = fileInput && fileInput.files && fileInput.files[0];
    const meta = collectFormMeta();
    const btn = $('#ytDryRunBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Simulando…'; }
    try {
      const res = await YTPUB.dryRun({
        account_id: ($('#ytAccountSelect') || {}).value || '',
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        privacy: meta.privacy,
        category_id: meta.categoryId,
        file_size: file ? file.size : 0,
        file_type: file ? (file.type || 'video/mp4') : 'video/mp4',
        publish_at: meta.publishAt ? new Date(meta.publishAt).toISOString() : undefined,
        embeddable: flagChecked('ytEmbeddable', true),
        notify_subscribers: flagChecked('ytNotifySubs', true),
        made_for_kids: flagChecked('ytMadeForKids', false),
        license: (($('#ytLicense') || {}).value || 'youtube'),
      });
      const issues = (res && res.issues) || [];
      const est = (res && res.estimate) || {};
      const html =
        '<div class="yt-modal-head">' +
          '<h3><i class="fas fa-flask"></i> Simulación de publicación</h3>' +
          '<p class="yt-modal-sub">El servidor validó el paquete SIN llamar a YouTube (0 unidades de cuota).</p>' +
        '</div>' +
        '<div class="yt-dryrun">' + (issues.length
          ? issues.map(function (i) {
              const color = i.level === 'error' ? '#ef4444' : (i.level === 'warning' ? '#f59e0b' : 'var(--text-dim)');
              return '<div class="yt-dryrun-item" style="color:' + color + ';"><i class="fas fa-circle-dot"></i> ' + esc(i.message) + '</div>';
            }).join('')
          : '<div class="yt-dryrun-item" style="color:#22c55e;"><i class="fas fa-circle-check"></i> Sin observaciones: el paquete es válido.</div>') + '</div>' +
        '<div class="yt-dryrun-est"><span>Título: ' + esc(String(est.title_length || 0)) + '/100</span>' +
          '<span>Descripción: ' + esc(String(est.description_length || 0)) + '/5000</span>' +
          '<span>Tags: ' + esc(String(est.tags_count || 0)) + ' (' + esc(String(est.tags_chars || 0)) + '/480)</span>' +
          '<span>Cuota al publicar: ' + esc(String(est.quota_units || 1600)) + ' unidades</span></div>' +
        '<div class="yt-modal-foot">' +
          '<button type="button" id="ytDryRunClose" class="btn-luxury-action yt-btn--md">Cerrar</button>' +
        '</div>';
      const m = createYtModal('ytDryRunOverlay', { html: html });
      const close = m.box.querySelector('#ytDryRunClose');
      if (close) close.addEventListener('click', function () { closeModalIfExists('ytDryRunOverlay'); });
    } catch (err) {
      logError('Contenido: dry-run', err);
      showToast(err.message || 'No se pudo simular la publicación.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-flask"></i> Simular'; }
    }
  }

  /* --- Cola local de publicación (la metadata viaja; el archivo no) --- */
  function enqueueCurrent(silent) {
    if (!YTPUB || !YTPUB.queue) return toolsUnavailable('Cola de publicación');
    const meta = collectFormMeta();
    if (!meta.title) { showToast('Poné un título antes de encolar.', 'warning'); return; }
    YTPUB.queue.add({
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      keyword: meta.keyword,
      privacy: meta.privacy,
      propertyId: meta.propertyId,
      categoryId: meta.categoryId,
      publishAt: meta.publishAt,
    });
    renderQueuePanel();
    if (!silent) showToast('Metadata guardada en la cola.', 'success');
  }

  function applyQueueItem(id) {
    if (!YTPUB || !YTPUB.queue) return;
    const it = YTPUB.queue.get(id);
    if (!it) return;
    setFieldValue('ytTitle', it.title || '');
    setFieldValue('ytDesc', it.description || '');
    setFieldValue('ytTags', it.tags || '');
    setFieldValue('ytKeyword', it.keyword || '');
    if ($('#ytPrivacy')) $('#ytPrivacy').value = it.privacy || 'public';
    if ($('#ytPublishAt')) $('#ytPublishAt').value = it.publishAt || '';
    if ($('#ytCategory') && it.categoryId) $('#ytCategory').value = it.categoryId;
    if ($('#ytProperty') && it.propertyId) $('#ytProperty').value = it.propertyId;
    recomputeSeoPanel();
    showToast('Metadata cargada — elegí el archivo y publicá.', 'info');
  }

  function removeQueueItem(id) {
    if (!YTPUB || !YTPUB.queue) return;
    YTPUB.queue.remove(id);
    renderQueuePanel();
  }

  function renderQueuePanel() {
    const panel = $('#ytQueuePanel');
    if (!panel) return;
    if (!YTPUB || !YTPUB.queue) { panel.innerHTML = ''; return; }
    const items = YTPUB.queue.list();
    if (!items.length) { panel.innerHTML = ''; return; }
    panel.innerHTML =
      '<div class="yt-queue">' +
        '<div class="yt-queue-head"><i class="fas fa-list-check"></i> Cola de publicación (' + items.length + ')</div>' +
        items.map(function (it) {
          const when = it.publishAt ? new Date(it.publishAt).toLocaleString('es-AR') : 'sin fecha';
          return '<div class="yt-queue-item">' +
            '<div class="yt-queue-title">' + esc(it.label || it.title || 'Sin título') + '</div>' +
            '<div class="yt-queue-meta">' + esc(when) + '</div>' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-yt-queue-load="' + esc(it.id) + '" title="Cargar la metadata en el formulario">Cargar</button>' +
            '<button type="button" class="btn-luxury-action yt-btn--xs" data-yt-queue-del="' + esc(it.id) + '" title="Sacar de la cola" style="color:var(--danger);">Quitar</button>' +
          '</div>';
        }).join('') +
      '</div>';
  }

  /* --- Serie: N copias con fechas escalonadas (quedan en la cola) --- */
  function openSeriesModal() {
    if (!YTPUB || !YTPUB.queue) return toolsUnavailable('Serie de videos');
    const meta = collectFormMeta();
    if (!meta.title) { showToast('Poné un título base antes de crear la serie.', 'warning'); return; }
    const html =
      '<div class="yt-modal-head">' +
        '<h3><i class="fas fa-layer-group"></i> Serie de videos</h3>' +
        '<p class="yt-modal-sub">Crea N copias de esta metadata con fechas escalonadas. Quedan en la cola: el archivo se elige al publicar cada una.</p>' +
      '</div>' +
      '<div class="yt-field"><span class="yt-label">Cantidad de videos</span>' +
        '<input id="ytSeriesCount" type="number" min="2" max="10" value="3" class="crm-field-input" style="width:100%;"></div>' +
      '<div class="yt-field"><span class="yt-label">Días entre cada video</span>' +
        '<input id="ytSeriesDays" type="number" min="1" max="30" value="2" class="crm-field-input" style="width:100%;"></div>' +
      '<div class="yt-field"><span class="yt-label">Fecha del primero</span>' +
        '<input id="ytSeriesStart" type="datetime-local" class="crm-field-input" style="width:100%;"></div>' +
      '<div class="yt-modal-foot">' +
        '<button type="button" id="ytSeriesCancel" class="btn-luxury-action yt-btn--md">Cancelar</button>' +
        '<button type="button" id="ytSeriesApply" class="btn-luxury-action yt-btn--md"><i class="fas fa-layer-group"></i> Crear serie</button>' +
      '</div>';
    const m = createYtModal('ytSeriesOverlay', { html: html });
    const box = m.box;
    const start = box.querySelector('#ytSeriesStart');
    if (start) {
      const d = new Date(Date.now() + 86400000);
      d.setHours(18, 0, 0, 0);
      start.value = toLocalInput(d.toISOString());
    }
    const cancel = box.querySelector('#ytSeriesCancel');
    if (cancel) cancel.addEventListener('click', function () { closeModalIfExists('ytSeriesOverlay'); });
    const apply = box.querySelector('#ytSeriesApply');
    if (!apply) return;
    apply.addEventListener('click', function () {
      const count = Math.max(2, Math.min(10, parseInt(box.querySelector('#ytSeriesCount').value, 10) || 3));
      const days = Math.max(1, Math.min(30, parseInt(box.querySelector('#ytSeriesDays').value, 10) || 2));
      const startVal = box.querySelector('#ytSeriesStart').value || '';
      const startTs = startVal ? new Date(startVal).getTime() : (Date.now() + 86400000);
      const dates = [];
      for (let i = 0; i < count; i++) {
        const when = new Date(startTs + i * days * 86400000);
        dates.push({ publishAt: toLocalInput(when.toISOString()), label: meta.title + ' #' + (i + 1) });
      }
      YTPUB.queue.series({
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        keyword: meta.keyword,
        privacy: meta.privacy,
        propertyId: meta.propertyId,
        categoryId: meta.categoryId,
      }, dates);
      renderQueuePanel();
      closeModalIfExists('ytSeriesOverlay');
      showToast(count + ' videos agregados a la cola.', 'success');
    });
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
  async function saveTemplateFromForm() {
    const title = (($('#ytTitle') || {}).value || '').trim();
    const desc = (($('#ytDesc') || {}).value || '').trim();
    const tags = (($('#ytTags') || {}).value || '').trim();
    if (!title && !desc && !tags) { showToast('El formulario está vacío — nada para guardar.', 'warning'); return; }
    /* Nombre de la plantilla: diálogo del panel (no el prompt nativo). */
    const name = await ytPrompt({
      title: 'Guardar plantilla',
      message: 'Leé un nombre para reconocerla después.',
      icon: 'fas fa-floppy-disk',
      placeholder: 'Plantilla ' + new Date().toLocaleDateString('es-AR'),
      confirmText: 'Guardar',
    });
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
  async function deleteCurrentTemplate() {
    const sel = $('#ytTemplateSel');
    const id = sel && sel.value;
    if (!id || String(id).indexOf('tpl_') !== 0) { showToast('Elegí una plantilla de la lista para borrarla.', 'warning'); return; }
    const ok = await ytConfirm({
      title: 'Borrar la plantilla',
      message: '¿Borrar esta plantilla? (no toca el formulario)',
      icon: 'fas fa-trash-can',
      confirmText: 'Borrar',
      danger: true,
    });
    if (!ok) return;
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
    const descEl = $('#ytDesc');
    if (!descEl) return;
    const cur = descEl.value || '';
    const idx = cur.indexOf('\nCAPÍTULOS:');
    const existing = idx === -1 ? '' : cur.slice(idx + '\nCAPÍTULOS:\n'.length);
    const html =
      '<div class="yt-modal-head">' +
        '<h3 style="font-size:17px;"><i class="fas fa-list-check"></i> Capítulos del video</h3>' +
        '<p class="yt-modal-sub" style="line-height:1.5;">Una línea por capítulo con el tiempo y su nombre. YouTube los exige: arrancar en 0:00, en orden ascendente y mínimo 3. El bloque va al final de la descripción.</p>' +
      '</div>' +
      '<textarea id="ytChapText" rows="6" class="crm-field-input" placeholder="0:00 Entrada&#10;0:45 Living y cocina&#10;2:10 Dormitorios&#10;3:05 Contacto" style="width:100%;">' + esc(existing) + '</textarea>' +
      '<div id="ytChapErr" style="font-size:11.5px;color:var(--danger);margin-top:6px;min-height:15px;"></div>' +
      '<div class="yt-modal-foot">' +
        '<button type="button" id="ytChapCancel" class="btn-luxury-action yt-btn--md">Cancelar</button>' +
        '<button type="button" id="ytChapApply" class="btn-luxury-action yt-btn--md"><i class="fas fa-check"></i> Aplicar</button>' +
      '</div>';
    const m = createYtModal('ytChaptersOverlay', { html: html });
    const box = m.box;
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
    const html =
      '<div class="yt-modal-head">' +
        '<h3 style="font-size:17px;"><i class="fas fa-copy"></i> Clonar metadata a otro canal</h3>' +
        '<p class="yt-modal-sub" style="line-height:1.5;">Título, descripción, tags, visibilidad y programación quedan cargados para el canal que elijas. El archivo de video NO se repite: elegilo de nuevo al publicar en cada canal.</p>' +
      '</div>' +
      '<select id="ytCloneSel" class="crm-field-input crm-field-input--select" style="width:100%;margin-bottom:16px;">' +
        others.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.display_name) + '</option>'; }).join('') +
      '</select>' +
      '<div class="yt-modal-foot">' +
        '<button type="button" id="ytCloneCancel" class="btn-luxury-action yt-btn--md">Cancelar</button>' +
        '<button type="button" id="ytCloneApply" class="btn-luxury-action yt-btn--md"><i class="fas fa-check"></i> Usar en ese canal</button>' +
      '</div>';
    const m = createYtModal('ytCloneOverlay', { html: html });
    const box = m.box;
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
     Los bytes ya subidos jamás se re-envían.

     La implementación vive ÚNICA en assets/js/yt-publish.js (módulo
     compartido): ahí están los chunks, el backoff por stalls, la
     cancelación y la sesión PERSISTENTE (si se recarga la pestaña, la
     subida se puede retomar desde el último byte). Acá solo se conecta
     la UI (progreso + botón cancelar) con ese módulo — dos copias de
     este algoritmo se desincronizan yersen y el resultado es un video
     "a medio subir" sin que nadie sepa por qué. */

  async function xhrUploadToGoogle(sessionUrl, file, onProgress) {
    if (!YTPUB || typeof YTPUB.upload !== 'function') {
      throw new Error('Falta el módulo de publicación (yt-publish.js). Recargá la página e intentá de nuevo.');
    }
    /* ctx: es el puente con la UI. El módulo expone el XHR en vuelo para
       que el botón "Cancelar subida" pueda abortarlo. */
    const ctx = {
      sessionUrl: sessionUrl,
      cancelled: function () { return _uploadCancelled; },
      onProgress: function (pct, loaded, total, extra) {
        if (onProgress) onProgress(loaded, total, extra);
      },
      onOffset: function (offset) {
        /* La posición se persiste: si la página se recarga, el módulo puede
           decir cuánto se había subido y desde dónde retomar. */
        if (YTPUB.resume) YTPUB.resume.updateOffset(offset);
      },
    };
    _uploadCtx = ctx;
    return YTPUB.upload(sessionUrl, file, ctx);
  }

  /* Llamada directa al backend de publicación. Solo se usa si el núcleo
     compartido (yt-core.js) no está cargado — HTML viejo en caché. Con el
     núcleo cargado, todo pasa por core.api.publish (timeout + reintentos). */
  async function legacyPublishCall(action, payload) {
    const res = await fetch(FN_BASE + '/social-publish-youtube', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });
    const json = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
  }

  /* ---------- Publicación (normal o borrador) ----------
     mode: 'publish' (default) | 'draft'
     El borrador sube el video en PRIVADO y deja el post en estado 'draft'
     (después se promueve desde el Studio con video_promote). */
  async function publishToYoutube(mode) {
    if (_publishing) return;
    const isDraft = mode === 'draft';
    const accountId = ($('#ytAccountSelect') || {}).value || '';
    const title = (($('#ytTitle') || {}).value || '').trim();
    const description = (($('#ytDesc') || {}).value || '').trim();
    const tags = (($('#ytTags') || {}).value || '').trim();
    const privacy = isDraft ? 'private' : (($('#ytPrivacy') || {}).value || 'public');
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
    /* Pre-flight: formato, peso y límites de metadata ANTES de gastar los
       1600 puntos de cuota de la subida. */
    if (YTPUB && typeof YTPUB.preflight === 'function') {
      const pre = YTPUB.preflight(file, { title: title, description: description, tags: tags });
      if (!pre.ok) {
        const lines = pre.errors.map(function (c) { return '• ' + c.label + ': ' + c.detail; }).join('\n');
        showToast('No se puede publicar todavía:\n' + lines, 'error');
        return;
      }
    }
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
          const go = await ytConfirm({
            title: 'El Score SEO está bajo',
            message: 'El Score SEO de este video es bajo (' + gateR.score + '/100 — ' + gateR.label + ').\n\nCompletar las sugerencias del panel a la derecha le da más chances de aparecer en búsquedas. ¿Publicar igual?',
            icon: 'fas fa-bullseye',
            confirmText: 'Publicar igual',
          });
          if (!go) return;
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
    if (progressWrap) progressWrap.classList.add('is-visible');

    try {
      /* 1. init: sesión de subida en Google + registro del post */
      const initPayload = {
        account_id: accountId,
        title,
        description: descOut, // #11: con el auto-CTA si correspondía
        tags,
        privacy,
        file_size: file.size,
        file_type: file.type || 'video/mp4',
        publish_at: publishAt ? new Date(publishAt).toISOString() : undefined,
        property_id: (($('#ytProperty') || {}).value || undefined), // #1
        seo_score: (typeof seoScore === 'number' && seoScore > 0 ? seoScore : undefined), // #18
        keyword: (($('#ytKeyword') || {}).value || undefined), // se guarda en content (reintentar lo conserva)
        /* Flags de publicación: categoría real de YouTube, incrustación
           (si es false las fichas NO pueden embeber el tour), aviso a
           suscriptores, contenido para niños y licencia. */
        category_id: (($('#ytCategory') || {}).value || undefined),
        embeddable: flagChecked('ytEmbeddable', true),
        notify_subscribers: flagChecked('ytNotifySubs', true),
        made_for_kids: flagChecked('ytMadeForKids', false),
        license: (($('#ytLicense') || {}).value || 'youtube'),
        draft: isDraft,
      };
      const init = CORE && CORE.api
        ? await CORE.api.publish('init', initPayload)
        : await legacyPublishCall('init', initPayload);
      if (!init || !init.session_url || !init.post_id) throw new Error('La función no devolvió la sesión de subida');
      postId = init.post_id;

      /* Sesión persistente: si el navegador se recarga durante la subida,
         queda registrado en qué byte iba (y qué post era) para poder
         retomar la subida en vez de perderla. */
      if (YTPUB && YTPUB.resume) {
        YTPUB.resume.save({
          sessionUrl: init.session_url,
          postId: init.post_id,
          fileName: file.name || '',
          fileSize: file.size,
          title: title,
          offset: 0,
        });
      }

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
      const done = CORE && CORE.api
        ? await CORE.api.publish('complete', { post_id: init.post_id, video_id: videoId })
        : await legacyPublishCall('complete', { post_id: init.post_id, video_id: videoId });

      setUploadProgress(100, isDraft ? '¡Borrador guardado!' : '¡Publicado!');
      trackQuota(1600); // #44: costo real de una subida resumable
      /* La sesión de reanudación ya no sirve (el video está en YouTube). */
      if (YTPUB && YTPUB.resume) YTPUB.resume.clear();
      if (CORE && CORE.audit) {
        CORE.audit(isDraft ? 'yt_draft' : 'yt_publish', {
          recordId: postId,
          metadata: { title: title, video_id: videoId, draft: isDraft },
        });
      }
      showToast(
        isDraft
          ? 'Borrador guardado en YouTube (privado). Promovélo desde el Studio cuando quieras.'
          : (publishAt ? 'Video programado para ' + new Date(publishAt).toLocaleString('es-AR') + '.' : 'Video publicado en YouTube.'),
        'success'
      );
      if (done.url && !publishAt && !isDraft) window.open(done.url, '_blank', 'noopener');
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
          const failPayload = { post_id: postId, upload_error: err.message };
          if (CORE && CORE.api) await CORE.api.publish('fail', failPayload);
          else await legacyPublishCall('fail', failPayload);
        } catch (_) { /* best-effort — el sweep lo cubre */ }
      }
      /* Traza del fallo en audit_log (la escribe el server: el cliente no
         puede insertar en audit_log por RLS). */
      if (CORE && CORE.audit) {
        CORE.audit('yt_publish_fail', {
          recordId: postId,
          status: 'error',
          errorCode: 'YT_UPLOAD_FAIL',
          metadata: { message: err.message, draft: isDraft },
        });
      }
      showToast(err.message, 'error');
      setUploadProgress(0, '');
      if (progressWrap) progressWrap.classList.remove('is-visible');
    } finally {
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      _publishing = false;
      _uploadCtx = null;
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
      wrap.innerHTML =
        '<div class="empty-state">' +
          '<i class="fas fa-clock-rotate-left"></i>' +
          '<div class="empty-state-title">Todavía no hay publicaciones</div>' +
          '<div>Cuando publiques un video, acá vas a ver el historial con sus métricas.</div>' +
          '<button type="button" class="btn-luxury-action" id="ytHistoryGoCreate"><i class="fas fa-plus"></i> Publicar un video</button>' +
        '</div>';
      const go = $('#ytHistoryGoCreate');
      if (go) go.addEventListener('click', function () { switchSubTab('create'); });
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
      return '<div class="yt-history-row">' +
        '<i class="' + esc((PLATFORM_META[p.platform] || {}).icon || 'fas fa-share') + '" style="font-size:18px;"></i>' +
        '<div style="flex:1;min-width:0;">' +
        '<div class="yt-history-title">' + esc(c.title || '(sin título)') + '</div>' +
        '<div class="yt-history-meta">' + esc(accName) + ' · ' + esc(fecha) + (p.status === 'failed' && p.error ? ' · <span style="color:var(--danger);">' + esc(String(p.error).substring(0, 80)) + '</span>' : '') + '</div>' +
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
    const ok = await ytConfirm({
      title: 'Borrar el registro',
      message: '¿Borrar este registro del historial? (si el video llegó a publicarse en YouTube, no se borra de YouTube)',
      icon: 'fas fa-trash-can',
      confirmText: 'Borrar',
      danger: true,
    });
    if (!ok) return;
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
      '<div class="empty-state" style="max-width:520px;margin:24px auto;">' +
        '<i class="fab fa-youtube" style="color:#FF0000;"></i>' +
        '<div class="empty-state-title">Todavía no hay un canal conectado</div>' +
        '<div style="max-width:380px;line-height:1.6;">El Studio administra el contenido del canal: inventario completo, métricas, playlists, edición, miniaturas y programación.</div>' +
        '<button type="button" id="studioGoAccounts" class="btn-luxury-action yt-btn--md"><i class="fas fa-plug"></i> Conectar un canal</button>' +
      '</div>';
    const btn = $('#studioGoAccounts');
    if (btn) btn.addEventListener('click', function () { switchSubTab('accounts'); });
  }

  function renderShell() {
    const root = $('#contenidoRoot');
    if (!root || root.dataset.rendered === '1') return;
    root.dataset.rendered = '1';
    root.innerHTML =
      '<div id="contenidoSubTabs" class="yt-tabs">' +
        '<button type="button" data-sub="accounts" class="yt-tab is-active"><i class="fas fa-link"></i> Cuentas</button>' +
        '<button type="button" data-sub="create" class="yt-tab"><i class="fas fa-plus"></i> Crear publicación</button>' +
        '<button type="button" data-sub="history" class="yt-tab"><i class="fas fa-clock-rotate-left"></i> Historial</button>' +
        /* REPARACIÓN: el Studio no tenía botón — al abrirlo la barra quedaba
           sin pestaña activa y el único regreso era el botón del header. */
        '<button type="button" data-sub="studio" class="yt-tab"><i class="fas fa-sliders"></i> Studio</button>' +
      '</div>' +
      '<div id="contenidoAccounts" class="yt-account-grid"></div>' +
      '<div id="contenidoStudio" style="display:none;"></div>' +
      '<div id="contenidoCreate" style="display:none;">' +
        /* MEJORA 2026-10-30: layout en 2 columnas — form a la izquierda + Score SEO (vidIQ) pegado a la derecha */
        '<div class="yt-row">' +
        '<div class="yt-col-form">' +
        '<div class="glass-panel" style="padding:24px;">' +
          '<h3 class="yt-section-title" style="font-size:17px;"><i class="fab fa-youtube" style="color:#FF0000;"></i> Publicar video en YouTube</h3>' +
          '<p class="yt-muted" style="margin:0 0 20px;">El video sube directo de tu navegador a Google — sin pasar por el servidor. El panel de la derecha puntúa tu SEO mientras escribís.</p>' +
          '<div class="yt-field"><span class="yt-label">Canal</span>' +
          '<div class="yt-inline">' +
            '<select id="ytAccountSelect" class="crm-field-input crm-field-input--select" style="flex:1;min-width:0;"></select>' +
            /* #8: con varios canales, la metadata viaja al otro canal */
            '<button type="button" id="ytCloneMeta" class="btn-luxury-action" title="Publicar el mismo contenido en otro canal (metadata, no archivo)" style="padding:9px 10px;font-size:11px;flex-shrink:0;"><i class="fas fa-copy"></i></button>' +
          '</div></div>' +
          /* #1: vínculo con la propiedad (llena campos + registra social_posts.property_id) */
          '<div class="yt-field"><span class="yt-label">Propiedad vinculada <span style="font-size:10.5px;text-transform:none;letter-spacing:0;">(opcional — llena los campos vacíos)</span></span>' +
          /* MEJORA: buscador (el select trae hasta 300 propiedades) */
          '<input id="ytPropertySearch" type="text" class="crm-field-input" placeholder="Buscar por código, título o zona…" style="margin-bottom:6px;">' +
          '<div class="yt-inline">' +
            '<select id="ytProperty" class="crm-field-input crm-field-input--select" style="flex:1;min-width:0;"><option value="">— Sin propiedad vinculada —</option></select>' +
            '<button type="button" id="ytPropertyFill" class="btn-luxury-action" title="Cargar título/descripción/tags desde la ficha (solo vacíos)" style="padding:9px 10px;font-size:11px;flex-shrink:0;"><i class="fas fa-house-circle-check"></i></button>' +
          '</div>' +
          '<span id="ytPropertyCount" class="yt-hint"></span>' +
          '</div>' +
          /* #2: plantillas locales */
          '<div class="yt-field"><span class="yt-label">Plantillas locales <span style="font-size:10.5px;text-transform:none;letter-spacing:0;">(title/desc/tags/visibilidad)</span></span>' +
          '<div class="yt-inline">' +
            '<select id="ytTemplateSel" class="crm-field-input crm-field-input--select" style="flex:1;min-width:0;"></select>' +
            '<button type="button" id="ytTemplateSave" class="btn-luxury-action" title="Guardar el formulario actual como plantilla" style="padding:9px 10px;font-size:11px;flex-shrink:0;"><i class="fas fa-floppy-disk"></i></button>' +
            '<button type="button" id="ytTemplateDel" class="btn-luxury-action" title="Borrar la plantilla seleccionada" style="padding:9px 10px;font-size:11px;flex-shrink:0;"><i class="fas fa-trash-can"></i></button>' +
          '</div></div>' +
          '<div class="yt-field"><span class="yt-label">Título * <span id="ytTitleCounter" class="yt-counter"></span></span>' +
          '<input id="ytTitle" type="text" class="crm-field-input" maxlength="100" placeholder="Ej: Departamento 2 ambientes Nueva Córdoba — TOUR COMPLETO" style="width:100%;"></div>' +
          /* #16: banco de frases probadas */
          '<div class="yt-field"><select id="ytTitleBank" class="crm-field-input crm-field-input--select" style="width:auto;padding:6px 10px;font-size:11.5px;"></select></div>' +
          '<div class="yt-field"><span class="yt-label">Descripción (con hashtags para SEO) <span id="ytDescCounter" class="yt-counter"></span></span>' +
          '<textarea id="ytDesc" rows="5" class="crm-field-input" maxlength="5000" placeholder="Descripción del video + #hashtags…" style="width:100%;"></textarea>' +
          '<div class="yt-inline" style="margin-top:8px;">' +
            /* #12: capítulos — modal con validación nativa */
            '<button type="button" id="ytChaptersBtn" class="btn-luxury-action" title="Agregar bloque de capítulos al final de la descripción" style="padding:7px 12px;font-size:11px;"><i class="fas fa-list-check"></i> Capítulos</button>' +
            /* #11: CTA + hashtags */
            '<button type="button" id="ytCtaInsert" class="btn-luxury-action" title="Insertar bloque de contacto + hashtags institucionales" style="padding:7px 12px;font-size:11px;"><i class="fas fa-bullhorn"></i> Insertar CTA</button>' +
            '<label style="font-size:11px;color:var(--text-dim);display:inline-flex;align-items:center;gap:6px;cursor:pointer;">' +
              '<input id="ytCtaAuto" type="checkbox" style="cursor:pointer;"> Agregar CTA automático si falta' +
            '</label>' +
          '</div></div>' +
          '<div class="yt-field"><span class="yt-label">Tags SEO (separados por coma)</span>' +
          '<input id="ytTags" type="text" class="crm-field-input" placeholder="inmobiliaria córdoba, departamentos, nueva córdoba" style="width:100%;">' +
          /* MEJORA: chips con los tags que ya rindieron en el canal */
          '<div id="ytChannelTags" style="margin-top:8px;"></div>' +
          '</div>' +
          /* Herramientas de publicación (lógica en assets/js/yt-seo-tools.js
             y assets/js/yt-publish.js — acá solo el botón y el resultado). */
          '<div class="yt-field"><span class="yt-label">Herramientas</span>' +
          '<div class="yt-inline" style="flex-wrap:wrap;gap:6px;">' +
            '<button type="button" id="ytTitleVariantsBtn" class="btn-luxury-action yt-btn--xs" title="Generar 5 títulos alternativos con su score"><i class="fas fa-wand-magic-sparkles"></i> Títulos alternativos</button>' +
            '<button type="button" id="ytBlocksBtn" class="btn-luxury-action yt-btn--xs" title="Insertar bloques de descripción (contacto, aviso legal, zonas, hashtags, ficha)"><i class="fas fa-puzzle-piece"></i> Bloques</button>' +
            '<select id="ytPresetSel" class="crm-field-input crm-field-input--select" title="Plantilla según el tipo de contenido" style="width:auto;padding:6px 10px;font-size:11.5px;"><option value="">＋ Plantilla por tipo…</option></select>' +
            '<button type="button" id="ytPreflightBtn" class="btn-luxury-action yt-btn--xs" title="Revisar archivo y metadata antes de subir (no consume cuota)"><i class="fas fa-clipboard-check"></i> Pre-flight</button>' +
            '<button type="button" id="ytDryRunBtn" class="btn-luxury-action yt-btn--xs" title="Simular la publicación en el servidor (no consume cuota de YouTube)"><i class="fas fa-flask"></i> Simular</button>' +
          '</div></div>' +
          '<div class="yt-row" style="margin-bottom:18px;gap:14px;">' +
            '<div style="flex:2;min-width:250px;"><span class="yt-label">Video (máx. 2 GB)</span>' +
            /* MEJORA: se puede arrastrar el archivo a la zona */
            '<div id="ytFileDrop" class="yt-dropzone">' +
              '<input id="ytFile" type="file" accept="video/*" class="crm-field-input" style="width:100%;padding:8px;">' +
              '<div id="ytFileInfo" style="font-size:11px;color:var(--accent);margin-top:4px;display:none;"></div>' +
              '<div id="ytFileDropHint" class="yt-dropzone-hint">o arrastrá el video acá</div>' +
            '</div></div>' +
            '<div style="flex:1;min-width:140px;"><span class="yt-label">Visibilidad</span>' +
            '<select id="ytPrivacy" class="crm-field-input crm-field-input--select">' +
              '<option value="public">Público</option>' +
              '<option value="unlisted">Oculto (link)</option>' +
              '<option value="private">Privado</option>' +
            '</select></div>' +
            '<div style="flex:1;min-width:180px;"><span class="yt-label">Programar (opcional)</span>' +
            '<input id="ytPublishAt" type="datetime-local" class="crm-field-input" style="width:100%;">' +
            /* #10: schedules rápidos */
            '<div class="yt-inline" style="margin-top:6px;gap:6px;">' +
              '<button type="button" data-quick-sched="hoy18" class="btn-luxury-action yt-btn--xs">Hoy 18:00</button>' +
              '<button type="button" data-quick-sched="manana12" class="btn-luxury-action yt-btn--xs">Mañana 12:00</button>' +
              '<button type="button" data-quick-sched="jueves18" class="btn-luxury-action yt-btn--xs">Jueves 18:00</button>' +
            '</div></div>' +
          '</div>' +
          /* Categoría real de YouTube + flags de publicación.
             - embeddable=false → las fichas NO pueden embeber el tour.
             - made_for_kids / license / notify_subscribers viajan a la API. */
          '<div class="yt-row" style="margin-bottom:18px;gap:14px;">' +
            '<div style="flex:1;min-width:220px;"><span class="yt-label">Categoría de YouTube</span>' +
            '<select id="ytCategory" class="crm-field-input crm-field-input--select"><option value="22">People & Blogs</option></select>' +
            '<span id="ytCategoryHint" class="yt-hint"></span></div>' +
            '<div style="flex:1;min-width:250px;"><span class="yt-label">Opciones de publicación</span>' +
            '<div class="yt-inline" style="flex-wrap:wrap;gap:10px;font-size:11.5px;color:var(--text-dim);">' +
              '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;"><input id="ytEmbeddable" type="checkbox" checked> Permitir incrustar</label>' +
              '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;"><input id="ytNotifySubs" type="checkbox" checked> Avisar a suscriptores</label>' +
              '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;"><input id="ytMadeForKids" type="checkbox"> Para niños</label>' +
              '<select id="ytLicense" class="crm-field-input crm-field-input--select" title="Licencia del video" style="width:auto;padding:5px 8px;font-size:11px;"><option value="youtube">Licencia YouTube</option><option value="creativeCommon">Creative Commons</option></select>' +
            '</div></div>' +
          '</div>' +
          '<div id="ytProgress" class="yt-progress">' +
            '<div class="yt-progress-track">' +
              '<div id="ytUploadBar" class="yt-progress-bar"></div>' +
            '</div>' +
            '<div id="ytUploadPct" class="yt-progress-label"></div>' +
            '<div id="ytUploadEta" class="yt-progress-eta"></div>' +
            /* MEJORA: cancelar la subida (antes solo se podía cerrar la pestaña) */
            '<button type="button" id="ytCancelUpload" class="btn-luxury-action" style="margin-top:10px;padding:7px 12px;font-size:11px;color:var(--danger);"><i class="fas fa-circle-xmark"></i> Cancelar subida</button>' +
          '</div>' +
          '<div class="yt-actions yt-actions--left">' +
            '<button type="button" id="ytPublishBtn" class="btn-luxury-action yt-btn--lg"><i class="fas fa-paper-plane"></i> Publicar en YouTube</button>' +
            /* Borrador: el video sube en privado y el post queda 'draft'. */
            '<button type="button" id="ytDraftBtn" class="btn-luxury-action" title="Subir el video en privado y dejarlo como borrador (se promueve desde el Studio)"><i class="fas fa-file-circle-exclamation"></i> Guardar borrador</button>' +
            /* Cola local: guarda la metadata (el archivo se elige al publicar). */
            '<button type="button" id="ytQueueBtn" class="btn-luxury-action" title="Guardar la metadata en la cola local (el archivo lo elegís al publicar)"><i class="fas fa-list-check"></i> Encolar</button>' +
            '<button type="button" id="ytSeriesBtn" class="btn-luxury-action" title="Programar una serie de videos con fechas escalonadas"><i class="fas fa-layer-group"></i> Serie</button>' +
          '</div>' +
          /* Cola de publicación (render en vivo) */
          '<div id="ytQueuePanel"></div>' +
          /* #44: HUD de cuota API estimada */
          '<div id="ytQuotaHud" style="margin-top:14px;"></div>' +
        '</div>' +
        '</div>' +
        /* Columna derecha: Score SEO — el motor vive en assets/js/yt-seo-score.js (BH_YT_SEO) */
        '<div class="yt-col-side">' +
          '<div class="glass-panel" style="padding:20px 18px 16px;">' +
            '<h3 class="yt-section-title" style="font-size:16px;"><i class="fas fa-bullseye" style="color:var(--accent);"></i> Score SEO del video</h3>' +
            '<p class="yt-muted" style="margin:0 0 12px;">Optimización medida en vivo (estilo vidIQ Vision).</p>' +
            '<div class="yt-field"><span class="yt-label">Palabra clave objetivo <span style="font-size:10.5px;text-transform:none;letter-spacing:0;">(vacío = la deduzco del título)</span></span>' +
            '<input id="ytKeyword" type="text" class="crm-field-input" placeholder="Ej: inmobiliaria córdoba" style="width:100%;"></div>' +
            '<div id="ytSeoBody"></div>' +
            /* Validación en vivo (límites reales de YouTube + canibalización).
               Vive en assets/js/yt-seo-tools.js: la UI solo la dibuja. */
            '<div id="ytValidationPanel" class="yt-validation"></div>' +
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
    /* Miniatura rota (YouTube cambia las URLs de las thumbs): en vez de dejar
       el ícono de imagen rota del navegador, se muestra el logo del canal.
       El evento "error" no burbujea → se escucha en fase capture. */
    document.addEventListener('error', function (e) {
      const t = e.target;
      if (!t || t.tagName !== 'IMG' || !t.classList.contains('yt-thumb-img')) return;
      const holder = t.closest('.yt-video-thumb');
      if (holder) {
        holder.classList.add('yt-video-thumb--empty');
        holder.innerHTML = '<i class="fab fa-youtube" style="color:#FF0000;font-size:32px;"></i>';
      }
    }, true);
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
      if (e.target.closest('#ytPublishBtn')) { publishToYoutube(); return; }
      /* Herramientas de publicación (lote 50 mejoras) */
      if (e.target.closest('#ytTitleVariantsBtn')) { openTitleVariantsModal(); return; }
      if (e.target.closest('#ytBlocksBtn')) { openBlocksModal(); return; }
      if (e.target.closest('#ytPreflightBtn')) { openPreflightModal(); return; }
      if (e.target.closest('#ytDryRunBtn')) { runDryRun(); return; }
      if (e.target.closest('#ytDraftBtn')) { publishToYoutube('draft'); return; }
      if (e.target.closest('#ytQueueBtn')) { enqueueCurrent(false); return; }
      if (e.target.closest('#ytSeriesBtn')) { openSeriesModal(); return; }
      /* Cola de publicación */
      const qLoad = e.target.closest('[data-yt-queue-load]');
      if (qLoad) { applyQueueItem(qLoad.getAttribute('data-yt-queue-load')); return; }
      const qDel = e.target.closest('[data-yt-queue-del]');
      if (qDel) { removeQueueItem(qDel.getAttribute('data-yt-queue-del')); return; }
      /* Comentarios: responder / like / moderar / lead (modal + bandeja) */
      if (e.target.closest('[data-cm-reply],[data-cm-cancel],[data-cm-send],[data-cm-heart],[data-cm-hold],[data-cm-lead]')) {
        onCommentAction(e);
        return;
      }
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
      /* Estado vacío del Studio → lleva al formulario de publicación */
      if (e.target.closest('#studioEmptyPublish')) { switchSubTab('create'); return; }
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
