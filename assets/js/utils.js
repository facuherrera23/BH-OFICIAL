/* ============================================================
   BIENENHAUS - Shared Security Utilities
   ============================================================
   Arquitectura: classic scripts (sin build step). Se carga como
   <script> ANTES de landing-app.js / admin-app.js y del JS inline
   de tasacion.html, exponiendo window.BHUtils.
   Export CommonJS condicional para tests unitarios (Node/Vitest).

   Contextos cubiertos:
   - esc(): texto no confiable -> contenido de elemento o atributo
     entre comillas dobles.
   - safeUrl(): valida esquema para href/src. Solo http:, https:,
     mailto:, tel: y rutas relativas. Rechaza javascript:, vbscript:,
     data:, blob:, etc.
   - safeImageUrl(): igual pero solo http/https/relativo.
   - safeCssUrl(): safeImageUrl + neutraliza " ' \ ( ) para
     contexto CSS url("...").
   PROHIBIDO construir JS dentro de atributos onclick: usar
   data-* + addEventListener (delegacion).
   ============================================================ */
(function (global) {
  'use strict';

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var escAttr = esc;

  var SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

  function defaultBase() {
    return (typeof location !== 'undefined' && location && location.href)
      ? location.href
      : 'https://bienenhaus.com.ar/';
  }

  function parseSafe(u, base, protocols) {
    if (u === null || u === undefined) return '';
    var raw = String(u);
    if (raw.trim() === '') return '';
    try {
      var parsed = new URL(raw, base || defaultBase());
      if (protocols.indexOf(parsed.protocol) === -1) return '';
      return raw;
    } catch (err) {
      return '';
    }
  }

  function safeUrl(u, base) {
    return parseSafe(u, base, SAFE_PROTOCOLS);
  }

  var IMG_PROTOCOLS = ['http:', 'https:'];

  function safeImageUrl(u, base) {
    return parseSafe(u, base, IMG_PROTOCOLS);
  }

  function safeCssUrl(u, base) {
    var ok = safeImageUrl(u, base);
    if (!ok) return '';
    return ok
      .replace(/\\/g, '%5C')
      .replace(/"/g, '%22')
      .replace(/'/g, '%27')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29');
  }

  /* ----------------------------------------------------------
     sanitizeRichText(): contenido CMS -> innerHTML seguro.
     Escapa TODO y re-habilita solo 3 formas exactas, probadas
     contra los datos reales de site_content (2026-09-04):
       <span class="highlight">, </span>, <br>/<br/>
     Al escapar '&' primero, ni entidades trampa ni atributos
     inyectados pueden formar tags reales.
     ---------------------------------------------------------- */
  var RICH_TEXT_ALLOW = [
    [/&lt;span class=&quot;highlight&quot;&gt;/gi, '<span class="highlight">'],
    [/&lt;\/span&gt;/gi, '</span>'],
    [/&lt;br\s*\/?&gt;/gi, '<br>']
  ];

  function sanitizeRichText(input) {
    if (input === null || input === undefined) return '';
    var out = esc(String(input));
    for (var i = 0; i < RICH_TEXT_ALLOW.length; i++) {
      out = out.replace(RICH_TEXT_ALLOW[i][0], RICH_TEXT_ALLOW[i][1]);
    }
    return out;
  }

  global.BHUtils = {
    esc: esc,
    escAttr: escAttr,
    safeUrl: safeUrl,
    safeImageUrl: safeImageUrl,
    safeCssUrl: safeCssUrl,
    sanitizeRichText: sanitizeRichText
  };

  // Activar CSS de fuentes cargadas con media="print" (no-render-blocking sin
  // necesitar handlers inline, que la CSP del sitio no permite)
  if (typeof document !== 'undefined') {
    (function activatePrintMediaStyles() {
      var links = document.querySelectorAll('link[rel="stylesheet"][media="print"]');
      function activate(l) { l.media = 'all'; }
      links.forEach(function(l) {
        if (l.sheet) { activate(l); return; }
        l.addEventListener('load', function() { activate(l); });
      });
    })();

    // Horario comercial 08:00-21:00, saltos de 10 min. Los datetime-local no
    // pueden restringir solo la hora vía HTML, así que se valida acá.
    (function enforceBusinessHours() {
      var MIN_MIN = 8 * 60, MAX_MIN = 21 * 60, STEP = 10;
      function pad(n) { return (n < 10 ? '0' : '') + n; }
      function clampTime(hh, mm) {
        var total = hh * 60 + Math.round(mm / STEP) * STEP;
        if (total < MIN_MIN) total = MIN_MIN;
        if (total > MAX_MIN) total = MAX_MIN;
        return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
      }
      function fixInput(el) {
        if (!el.value) return;
        var m = el.value.match(/T?(\d{1,2}):(\d{2})/);
        if (!m) return;
        var total = (+m[1]) * 60 + (+m[2]);
        if (total < MIN_MIN || total > MAX_MIN || total % STEP !== 0) {
          var fixed = clampTime(+m[1], +m[2]);
          el.value = el.type === 'time' ? fixed
            : el.value.replace(/T\d{1,2}:\d{2}/, 'T' + fixed);
        }
      }
      document.addEventListener('change', function (e) {
        var el = e.target;
        if (el && el.matches && el.matches('input[type="time"], input[type="datetime-local"]')) fixInput(el);
      }, true);
    })();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.BHUtils;
  }
})(typeof window !== 'undefined' ? window : globalThis);
