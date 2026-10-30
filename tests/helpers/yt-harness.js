// ============================================================
// Harness compartido de los tests del MÓDULO CONTENIDO (YouTube)
// ------------------------------------------------------------
// Monta un HTML mínimo con los stubs que el módulo necesita
// (window.__BH, supabaseClient, fetch a las Edge Functions) y
// levanta el módulo REAL en el navegador.
//
// Vive aparte de los specs porque hay varios (contenido-ui,
// yt-modulos) y duplicar 200 líneas de harness hacía que los
// stubs se desincronizaran entre specs (la clase de bug más
// cara del repo: el test pasa y la feature no).
//
// Uso:
//   const { boot, VIDEO } = require('./helpers/yt-harness');
//   await boot(page, { accounts: [...] });
// ============================================================

const HARNESS = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Harness Contenido</title>
<link rel="stylesheet" href="/assets/css/admin.css">
<link rel="stylesheet" href="/assets/css/admin-contenido.css">
</head>
<body style="background:#020305;color:#fff;font-family:system-ui">
  <div id="contenidoRoot"></div>
  <script>
    (function () {
      function esc(s) {
        var v = String(s == null ? '' : s);
        var AMP = String.fromCharCode(38);
        var LT = String.fromCharCode(60);
        var GT = String.fromCharCode(62);
        var QT = String.fromCharCode(34);
        var AP = String.fromCharCode(39);
        return v.split(AMP).join(AMP + 'amp;')
                .split(LT).join(LT + 'lt;')
                .split(GT).join(GT + 'gt;')
                .split(QT).join(QT + 'quot;')
                .split(AP).join(AP + '#39;');
      }
      window.__TOASTS = [];
      window.__CONFIRM_CALLS = [];
      window.__PROMPT_CALLS = [];
      window.__NATIVE_CALLS = [];
      window.__BH = {
        $: function (s) { return document.querySelector(s); },
        $$: function (s) { return Array.from(document.querySelectorAll(s)); },
        esc: esc,
        showToast: function (m, t) { window.__TOASTS.push((t || 'info') + ':' + m); },
        logError: function () {},
        formatDateTimeWithTZ: function (s) { return s || ''; },
        getAuthedClient: async function () { return window.__FAKE_CLIENT; },
      };
      window.BH_CONFIG = { SUPABASE_URL: 'https://rnldqiwwzhjnurkguihu.supabase.co' };
      window.supabaseClient = {
        auth: { getSession: async function () { return { data: { session: { access_token: 'test-token' } } }; } },
      };
      window.confirm = function (m) { window.__NATIVE_CALLS.push('confirm:' + String(m)); return window.__CONFIRM !== false; };
      window.prompt = function (m, d) { window.__NATIVE_CALLS.push('prompt:' + String(m)); return window.__PROMPT_VALUE; };

      /* Diálogos DEL PANEL (showConfirmDialog/showInputPrompt de admin-app.js).
         El módulo debe usarlos en vez del confirm()/prompt() nativo. */
      window.__BH.showConfirmDialog = function (o) {
        window.__CONFIRM_CALLS.push(String(o && o.title) + '|' + String(o && o.message));
        return Promise.resolve(window.__CONFIRM !== false);
      };
      window.__BH.showInputPrompt = function (o) {
        window.__PROMPT_CALLS.push(String(o && o.title) + '|' + String(o && o.message));
        return Promise.resolve(window.__PROMPT_VALUE);
      };

      /* Modo "abort rápido": el AbortController corta a los 250 ms — permite
         testear el timeout de la Edge Function sin esperar 30 s. */
      if (location.search.indexOf('fastAbort') >= 0) {
        var RealAC = window.AbortController;
        window.AbortController = function () {
          var c = new RealAC();
          setTimeout(function () { try { c.abort(); } catch (_) {} }, 250);
          return c;
        };
      }

      /* Cliente Supabase fake (chainable) */
      window.__ROWS = {
        social_accounts: [{ id: 'acc-1', platform: 'youtube', display_name: 'Bienenhaus Propiedades', avatar_url: '', status: 'active', last_publish_at: null, scope: 'https://www.googleapis.com/auth/youtube.force-ssl' }],
        social_posts: [],
        audit_log: [],
        properties: [{ id: 'prop-1', property_code: 'ML-0001', title: 'Casa en Nueva Córdoba', property_type: 'casa', status: 'venta', zone: 'Nueva Córdoba', address: 'Av. Siempreviva 123', surface_total: 120, rooms: 3, bedrooms: 2, bathrooms: 1, is_published: true }],
        app_settings: { value: [] },
      };
      window.__FAKE_CLIENT = {
        from: function (table) {
          var obj = {
            select: function () { return obj; },
            order: function () { return obj; },
            limit: function () { return obj; },
            eq: function () { return obj; },
            not: function () { return obj; },
            lt: function () { return obj; },
            is: function () { return obj; },
            update: function () { return obj; },
            insert: function () { return obj; },
            upsert: function () { return obj; },
            delete: function () { return obj; },
            maybeSingle: function () { return Promise.resolve({ data: window.__ROWS[table], error: null }); },
            single: function () { return Promise.resolve({ data: window.__ROWS[table], error: null }); },
            then: function (resolve) { return resolve({ data: window.__ROWS[table], error: null }); },
          };
          return obj;
        },
      };
    })();
  </script>
</body></html>`;

/* Video de ejemplo del canal (inventario del Studio). */
const VIDEO = {
  id: 'vid-1',
  title: 'Tour de la casa',
  description: 'desc',
  published_at: '2026-10-20T10:00:00Z',
  publish_at: '2026-10-31T18:00:00Z',
  thumbnail: 'https://i.ytimg.com/vi/vid-1/mqdefault.jpg',
  category_id: '22',
  tags: ['bienenhaus', 'casa'],
  views: 120,
  likes: 8,
  comments: 2,
  privacy: 'private',
  upload_status: 'processed',
  duration: 'PT2M30S',
};

/* Categorías de YouTube que devuelve el server (videoCategories.list). */
const CATEGORIES = [
  { id: '22', name: 'People & Blogs' },
  { id: '10', name: 'Music' },
  { id: '27', name: 'Education' },
];

/**
 * Levanta el módulo en el navegador.
 * opts:
 *   accounts / posts / properties → filas del cliente fake
 *   videos / total / truncated     → inventario del canal
 *   canManage                      → scope youtube.force-ssl
 *   hangAction                     → action del Studio que no responde
 *   fastAbort                      → AbortController corta a los 250 ms
 *   categories                    → categorías que devuelve el server
 *   dryRunIssues                   → issues del dry-run del server
 *   uploadStatus                   → 200 | 308 | 500 (protocolo resumable)
 */
async function boot(page, opts = {}) {
  /* Gate para simular una Edge Function que NO responde. */
  let release = null;
  const gate = new Promise((r) => { release = r; });
  /* Contadores de llamadas a la Edge Function (para assertar refrescos). */
  const calls = { channel: 0, videos: 0, analytics: 0, init: 0, complete: 0, fail: 0, dry_run: 0, video_categories: 0, audit_log: 0,
    comments_list: 0, comments_inbox: 0, comment_reply: 0, comment_heart: 0, comment_moderate: 0, comment_lead: 0,
    analytics_report: 0, settings_get: 0, settings_set: 0, videos_sync_public: 0 };
  /* Copia de app_settings en el server fake (settings_set escribe acá). */
  const settingsStore = Object.assign({}, opts.settings || {});
  /* Peticiones capturadas (para assertar el body que viaja al server). */
  const requests = [];

  await page.route(/\/harness-contenido\.html/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HARNESS }));
  await page.route('**/functions/v1/social-youtube-studio', async (route) => {
    const body = route.request().postDataJSON() || {};
    const action = body.action;
    requests.push({ fn: 'studio', body: body });
    if (calls[action] !== undefined) calls[action]++;
    if (opts.hangAction && action === opts.hangAction) {
      await gate;
      return route.abort('aborted');
    }
    let payload = {};
    if (action === 'channel') {
      payload = {
        channel: { id: 'ch-1', title: 'Bienenhaus Propiedades', handle: '@bienenhaus', avatar: null, subscribers: 1200, total_views: 34000, video_count: opts.channelVideos || 29 },
        can_manage: opts.canManage !== false,
      };
    } else if (action === 'videos') {
      payload = {
        videos: opts.videos || [VIDEO],
        can_manage: opts.canManage !== false,
        total: opts.total != null ? opts.total : (opts.videos || [VIDEO]).length,
        truncated: !!opts.truncated,
      };
    } else if (action === 'platforms_config') {
      payload = { platforms: [{ platform: 'youtube', configured: true }, { platform: 'instagram', configured: false }] };
    } else if (action === 'playlists') {
      payload = { playlists: [] };
    } else if (action === 'analytics') {
      payload = { totals: { views: 10, watch_minutes: 20, avg_view_seconds: 65, subscribers_gained: 1 }, range: { start: '2026-10-01', end: '2026-10-28' } };
    } else if (action === 'analytics_report') {
      /* La conexión vieja no tiene el scope de analítica: el server real
         responde 403 needs_reconnect. */
      if (opts.analyticsNeedsReconnect) {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'needs_reconnect' }) });
      }
      const report = body.report || 'summary';
      const rep = opts.reports && opts.reports[report];
      if (rep) {
        payload = rep;
      } else {
        payload = {
          report: report,
          label: 'Reporte',
          range: { start: '2026-10-01', end: '2026-10-28', days: Number(body.days) || 28 },
          headers: [],
          rows: [],
          titles: {},
        };
      }
    } else if (action === 'videos_sync_public') {
      payload = Object.assign(
        { importados: 0, actualizados: 0, reconciliados: 0, total: 0, completo: true },
        opts.syncResult || {},
      );
    } else if (action === 'video_categories') {
      /* Demora opcional: sirve para probar que una categoría pedida
         ANTES de la respuesta queda pendiente y se aplica después. */
      if (opts.categoriesDelayMs) {
        await new Promise((r) => setTimeout(r, opts.categoriesDelayMs));
      }
      payload = { categories: opts.categories || CATEGORIES, cached: !!opts.categoriesCached };
    } else if (action === 'settings_get') {
      const key = body.key;
      const value = (key in settingsStore)
        ? settingsStore[key]
        : (opts.settingsValue !== undefined ? opts.settingsValue : null);
      payload = { key: key, value: value };
    } else if (action === 'settings_set') {
      settingsStore[body.key] = body.value;
      payload = { ok: true };
    } else if (action === 'audit_log') {
      payload = { ok: true };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  /* Endpoint de publicación (init/complete/fail/dry_run) + destino de la subida. */
  await page.route('**/functions/v1/social-publish-youtube', async (route) => {
    const body = route.request().postDataJSON() || {};
    requests.push({ fn: 'publish', body: body });
    if (calls[body.action] !== undefined) calls[body.action]++;
    if (body.action === 'init') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ post_id: 'post-99', session_url: 'http://localhost:8788/fake-upload-session' }),
      });
    }
    if (body.action === 'dry_run') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: !(opts.dryRunIssues || []).some((i) => i.level === 'error'),
          issues: opts.dryRunIssues || [],
          estimate: { quota_units: 1600, title_length: (body.title || '').length, description_length: (body.description || '').length, tags_count: String(body.tags || '').split(',').filter(Boolean).length, tags_chars: String(body.tags || '').length, category_id: body.category_id || '22' },
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'https://youtube.com/watch?v=x' }) });
  });

  /* Endpoint de comentarios (listar/responder/moderar/lead). */
  await page.route('**/functions/v1/social-youtube-comments', async (route) => {
    const body = route.request().postDataJSON() || {};
    requests.push({ fn: 'comments', body: body });
    if (calls[body.action] !== undefined) calls[body.action]++;
    if (opts.hangAction && body.action === opts.hangAction) {
      await gate;
      return route.abort('aborted');
    }
    const threads = opts.comments || [
      {
        id: 'cm-1',
        videoId: 'vid-1',
        text: 'Hola, ¿la casa tiene pileta? Mi teléfono es 3514445555',
        author: 'Marta Gomez',
        likes: 3,
        replyCount: 1,
        publishedAt: new Date(Date.now() - 3600000).toISOString(),
        replies: [
          { id: 'cm-1-r1', text: 'Sí, tiene pileta', author: 'Bienenhaus', likes: 1, publishedAt: new Date(Date.now() - 1800000).toISOString() },
        ],
      },
    ];
    if (body.action === 'comments_list' || body.action === 'comments_inbox') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ threads: threads, total: threads.length, videoId: body.video_id }),
      });
    }
    if (body.action === 'comment_lead') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, lead_id: 'lead-1', duplicate: !!opts.commentLeadDuplicate }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  /* Destino de la subida resumable. Por defecto queda colgado (para poder
     probar la cancelación). Con uploadStatus: 200 responde un video válido. */
  await page.route('**/fake-upload-session', async (route) => {
    if (opts.uploadStatus === 200) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'vid-uploaded-1' }),
      });
    }
    await gate;                       // la subida queda colgada hasta que se cancele
    return route.abort('aborted');
  });

  await page.goto('/harness-contenido.html' + (opts.fastAbort ? '?fastAbort=1' : ''));
  /* ORDEN IMPORTANTE: los módulos compartidos se cargan ANTES del
     orquestador (admin-contenido.js captura window.BH_YT al parsear). */
  await page.addScriptTag({ url: '/assets/js/yt-core.js' });
  await page.addScriptTag({ url: '/assets/js/yt-seo-tools.js' });
  await page.addScriptTag({ url: '/assets/js/yt-publish.js' });
  await page.addScriptTag({ url: '/assets/js/yt-comments.js' });
  await page.addScriptTag({ url: '/assets/js/yt-analytics.js' });
  await page.addScriptTag({ url: '/assets/js/yt-ops.js' });
  await page.addScriptTag({ url: '/assets/js/yt-integrations.js' });
  await page.addScriptTag({ url: '/assets/js/yt-seo-score.js' });
  await page.addScriptTag({ url: '/assets/js/admin-contenido.js' });

  if (opts.accounts) {
    await page.evaluate((rows) => { window.__ROWS.social_accounts = rows; }, opts.accounts);
  }
  if (opts.posts) {
    await page.evaluate((rows) => { window.__ROWS.social_posts = rows; }, opts.posts);
  }
  if (opts.properties) {
    await page.evaluate((rows) => { window.__ROWS.properties = rows; }, opts.properties);
  }
  /* Posts fallidos (los lee el semáforo de salud desde social_posts). */
  if (opts.failedPosts) {
    await page.evaluate((rows) => { window.__ROWS.social_posts = rows; }, opts.failedPosts);
  }
  /* Trazas del módulo (historial de acciones). */
  if (opts.auditRows) {
    await page.evaluate((rows) => { window.__ROWS.audit_log = rows; }, opts.auditRows);
  }
  /* Scope/conectividad de la cuenta (semáforo de salud). */
  if (opts.accountPatch) {
    await page.evaluate((patch) => {
      const acc = window.__ROWS.social_accounts[0];
      if (acc) Object.assign(acc, patch);
    }, opts.accountPatch);
  }
  await page.evaluate(() => window.__BH.loadContenido());
  await page.waitForTimeout(200);
  return { release: () => release(), calls, requests, settings: settingsStore };
}

module.exports = { HARNESS, VIDEO, CATEGORIES, boot };
