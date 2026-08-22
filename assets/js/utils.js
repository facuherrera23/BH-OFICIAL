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

  global.BHUtils = {
    esc: esc,
    escAttr: escAttr,
    safeUrl: safeUrl,
    safeImageUrl: safeImageUrl,
    safeCssUrl: safeCssUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.BHUtils;
  }
})(typeof window !== 'undefined' ? window : globalThis);
