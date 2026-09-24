// Analytics de terceros: Google Analytics 4 y Microsoft Clarity.
//
// ACTIVACION: completar los IDs entre las comillas y pushear.
// Con los IDs vacios este archivo no hace absolutamente nada (no carga nada externo).
//
//   GA4:     analytics.google.com -> Measurement ID (formato G-XXXXXXXXXX)
//   Clarity: clarity.microsoft.com -> Project ID   (formato abcd1234ef)
//
// Nota: la CSP de index.html ya permite los dominios necesarios, no hay que tocarla.
(function () {
  'use strict';

  var GA_MEASUREMENT_ID = '';   // Ej: 'G-1A2B3C4D5E'
  var CLARITY_PROJECT_ID = '';  // Ej: 'abcd1234ef'

  if (GA_MEASUREMENT_ID) {
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    var ga = document.createElement('script');
    ga.async = true;
    ga.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(ga);
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID);
  }

  if (CLARITY_PROJECT_ID) {
    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    var cl = document.createElement('script');
    cl.async = true;
    cl.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(CLARITY_PROJECT_ID);
    document.head.appendChild(cl);
    window.clarity('set', 'clarity_id', CLARITY_PROJECT_ID);
  }
})();
