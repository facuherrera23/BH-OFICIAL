// Analytics de terceros: Google Analytics 4 y Microsoft Clarity.
//
// CUMPLIMIENTO LEGAL (Ley 25.326 + AAIP): GA y Clarity solo se cargan
// si el usuario aceptó las cookies (banner). El consentimiento se
// persiste en localStorage('bh_cookie_consent') por cookie-banner.js.
// Cloudflare Insights es anónimo (sin cookies) y se mantiene en el HTML.
(function () {
  'use strict';

  var GA_MEASUREMENT_ID = 'G-5HHCPBXXMD';
  var CLARITY_PROJECT_ID = 'yn3lt5joju';

  /* FIX LEGAL 2026-10-23: gatear la carga tras el consentimiento.
     Sin consentimiento explícito ('all'), NO se carga ningún script
     de tracking. La AAIP exige consentimiento previo. */
  function hasConsent() {
    try { return localStorage.getItem('bh_cookie_consent') === 'all'; } catch (_) { return false; }
  }

  function loadGtag() {
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    var ga = document.createElement('script');
    ga.async = true;
    ga.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(ga);
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
  }

  function loadClarity() {
    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    var cl = document.createElement('script');
    cl.async = true;
    cl.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(CLARITY_PROJECT_ID);
    document.head.appendChild(cl);
    window.clarity('set', 'clarity_id', CLARITY_PROJECT_ID);
  }

  function activate() {
    if (!hasConsent()) return;
    if (GA_MEASUREMENT_ID) loadGtag();
    if (CLARITY_PROJECT_ID) loadClarity();
  }

  /* Activar si ya hay consentimiento (visita repetida) */
  activate();

  /* Escuchar cambios de consentimiento (primera visita, banner aceptado) */
  window.addEventListener('storage', function (e) {
    if (e.key === 'bh_cookie_consent') activate();
  });

  /* cookie-banner.js dispara este evento custom al aceptar */
  window.addEventListener('bh-cookie-consent', activate);
})();
