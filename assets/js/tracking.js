/* ============================================================
   BIENENHAUS — Tracking first-party del sitio (SIN cookies)
   ============================================================
   POR QUÉ (auditoría 18/11/2026): el sitio no tenía medición de tráfico.
   GA4 + Clarity solo cargan con consentimiento 'all' → casi ninguna visita
   se registraba, y `bhTrack` (form_start/form_submit/wa_click) era un no-op
   sin cookies: ni las conversiones se veían. Con 1 lead del formulario en 12
   semanas y cero datos de tráfico, cualquier cambio en la landing era a ciegas.

   QUÉ HACE ESTE ARCHIVO:
     • Envía los eventos del sitio a NUESTRA edge function (track-event),
       que los guarda en `page_events` (agregados, sin PII).
     • Dispara `page_view` automáticamente en cada página.
     • Expone `bhTrackFirst(event, params)` (lo consume analytics.js).
     • Respeta el opt-out: localStorage 'bh_track_optout' = '1'.

   PRIVACIDAD (AAIP / Ley 25.326):
     • NO se guardan cookies. NO se manda IP. NO hay email/nombre/teléfono.
     • session_id = UUID aleatorio en sessionStorage (se borra al cerrar la
       pestaña): sirve para contar sesiones, NO para identificar personas.
     • El referrer se recorta a origen+ruta (sin query) y se descarta si es
       del mismo sitio (navegación interna).
     • Tracking nunca rompe la página: todo va en try/catch.
   ============================================================ */
(function () {
  'use strict';

  var SUPABASE_FALLBACK = 'https://rnldqiwwzhjnurkguihu.supabase.co';
  var ENDPOINT = ((window.BH_CONFIG && window.BH_CONFIG.SUPABASE_URL) || SUPABASE_FALLBACK)
    + '/functions/v1/track-event';
  var OPT_OUT_KEY = 'bh_track_optout';
  var SID_KEY = 'bh_sid';

  function optedOut() {
    try { return localStorage.getItem(OPT_OUT_KEY) === '1'; } catch (_) { return false; }
  }

  function sessionId() {
    try {
      var sid = sessionStorage.getItem(SID_KEY);
      if (!sid) {
        sid = (window.crypto && typeof crypto.randomUUID === 'function')
          ? crypto.randomUUID()
          : ('11111111-1111-4111-8111-' + Math.random().toString(16).slice(2, 14));
        sessionStorage.setItem(SID_KEY, sid);
      }
      return sid;
    } catch (_) { return null; }
  }

  function inferPage(path) {
    if (/^\/fichas\//.test(path)) return 'ficha';
    if (path === '/' || path === '/index.html') return 'landing';
    if (/tasacion/.test(path)) return 'tasacion';
    if (/canal/.test(path)) return 'canal';
    return 'otro';
  }

  function codeFromPath(path) {
    var m = path.match(/\/fichas\/([A-Za-z]{2}-P[0-9]{4})\.html/);
    return m ? m[1].toUpperCase() : null;
  }

  function cleanReferrer() {
    try {
      if (!document.referrer) return null;
      var u = new URL(document.referrer);
      if (u.hostname === location.hostname) return null; // navegación interna: no aporta
      return (u.origin + u.pathname).slice(0, 300);
    } catch (_) { return null; }
  }

  function utm() {
    try {
      var u = (typeof window.bhGetUtm === 'function') ? window.bhGetUtm() : null;
      if (!u) return {};
      return { utm_source: u.utm_source || null, utm_campaign: u.utm_campaign || null };
    } catch (_) { return {}; }
  }

  function buildPayload(event, params) {
    params = params || {};
    var path = location.pathname || '/';
    var code = params.property_code || codeFromPath(path);
    var u = utm();
    return {
      event: String(event).slice(0, 40),
      path: path.slice(0, 200),
      page: params.page || inferPage(path),
      property_code: code ? String(code).toUpperCase().slice(0, 20) : null,
      origin: params.origin ? String(params.origin).slice(0, 40) : 'web',
      referrer: cleanReferrer(),
      utm_source: params.utm_source || u.utm_source || null,
      utm_campaign: params.utm_campaign || u.utm_campaign || null,
      session_id: sessionId(),
    };
  }

  function send(event, params) {
    if (optedOut()) return;
    try {
      var body = JSON.stringify(buildPayload(event, params));
      /* sendBeacon (fire-and-forget) es el mecanismo estándar para
         analítica: NO expone la respuesta, así que un 404/5xx de la
         función no aparece como error en la consola del visitante (un
         fetch sí lo loguea). Además no depende de que la página siga
         viva al cerrar (importante en 'page_view' al navegar).

         El body va como 'text/plain' a propósito: 'application/json' NO
         es un content-type "simple" → el navegador dispara un preflight
         OPTIONS y, mientras la función no exista (404 del gateway con
         ACAO:*), el preflight rompe la CORS en la consola. Con
         'text/plain' no hay preflight y la función igual parsea el body
         con req.json() (no mira el content-type). */
      if (navigator.sendBeacon) {
        try {
          var blob = new Blob([body], { type: 'text/plain' });
          if (navigator.sendBeacon(ENDPOINT, blob)) return;
        } catch (_) { /* cae al fetch */ }
      }
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        mode: 'cors',
        credentials: 'omit',
      }).catch(function () { /* silencioso a propósito */ });
    } catch (_) { /* tracking nunca rompe la página */ }
  }

  /* API pública (la usa analytics.js para no duplicar la lógica). */
  window.bhTrackFirst = function (event, params) {
    if (!event) return;
    send(event, params);
  };

  /* Opt-out / opt-in (botón "No medirme" del pie del sitio). */
  window.bhTrackOptOut = function () {
    try {
      localStorage.setItem(OPT_OUT_KEY, '1');
      sessionStorage.removeItem(SID_KEY);
    } catch (_) { /* modo privado */ }
    try { window.dispatchEvent(new CustomEvent('bh-track-optout')); } catch (_) {}
  };
  window.bhTrackOptIn = function () {
    try { localStorage.removeItem(OPT_OUT_KEY); } catch (_) { /* modo privado */ }
    try { window.dispatchEvent(new CustomEvent('bh-track-optin')); } catch (_) {}
  };
  window.bhTrackIsOptedOut = optedOut;

  /* Botón "No medirme" (pie del sitio + política de privacidad):
     alterna entre desactivar y volver a activar la medición. */
  function setupOptOutButtons() {
    var nodes = document.querySelectorAll('[data-bh-track-optout]');
    Array.prototype.forEach.call(nodes, function (el) {
      function sync() {
        var off = optedOut();
        el.textContent = off ? 'Medir de nuevo' : 'No medirme';
        el.setAttribute('aria-pressed', off ? 'true' : 'false');
        el.title = off
          ? 'Tu medición está desactivada. Hacé clic para volver a activarla.'
          : 'No registramos tu visita en nuestro sistema de medición (sin cookies).';
      }
      el.addEventListener('click', function (e) {
        e.preventDefault();
        if (optedOut()) window.bhTrackOptIn(); else window.bhTrackOptOut();
        sync();
      });
      sync();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupOptOutButtons);
  } else {
    setupOptOutButtons();
  }

  /* page_view: una vez por carga de página. */
  function trackPageView() {
    if (optedOut()) return;
    send('page_view', { page: inferPage(location.pathname || '/') });
  }

  if (document.readyState === 'complete') {
    trackPageView();
  } else {
    window.addEventListener('load', trackPageView);
  }
})();
