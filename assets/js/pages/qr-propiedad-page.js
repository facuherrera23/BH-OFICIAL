/* ============================================================
   BIENENHAUS - Cartel imprimible de la propiedad (qr-propiedad.html)
   Segundo artefacto del sistema de carteles (lote captación 2026-11-03):
   el cartel de TASACIÓN captura dueños; este captura COMPRADORES — se
   cuelga en la propiedad en venta y lleva al interesado a la ficha
   pública (/fichas/CODE.html) con:
     · utm_source=cartel + utm_campaign=CODE  → canal offline atribuido
     · ?de=&tel= del agente logueado          → el mismo patrón que
       sharePropertyWhatsApp: la ficha muestra ESE contacto (no el
       broker asignado) y el CTA de WhatsApp apunta a su número.

   Igual que qr-visita/qr-tasacion: script externo por CSP (ni scripts
   inline ni onclick). Sin supabase: no lee la DB.
   ============================================================ */
(function () {
  'use strict';

  /* Botón imprimir: listener (cero handler inline). */
  var printBtn = document.getElementById('printBtn');
  if (printBtn) {
    printBtn.addEventListener('click', function () {
      window.print();
    });
  }

  var params = new URLSearchParams(location.search);
  var code = (params.get('code') || '').trim().slice(0, 60);
  var de = (params.get('de') || '').trim().slice(0, 120);
  var tel = (params.get('tel') || '').trim().slice(0, 30);
  var img = document.getElementById('qrImg');
  var refEl = document.getElementById('refCode');
  var ctaEl = document.getElementById('ctaEl');

  /* Sin código no hay carta a: la ficha es por código (id de página pública). */
  if (!code) {
    var askEl = document.getElementById('askEl');
    if (askEl) askEl.textContent = 'Enlace inválido';
    if (img) img.style.display = 'none';
    if (ctaEl) ctaEl.style.display = 'none';
    return;
  }

  var target = location.origin + '/fichas/' + encodeURIComponent(code) + '.html'
    + '?utm_source=cartel'
    + '&utm_medium=qr'
    + '&utm_campaign=' + encodeURIComponent(code);
  if (de) target += '&de=' + encodeURIComponent(de);
  if (tel) target += '&tel=' + encodeURIComponent(tel);

  if (img) {
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=8&data=' + encodeURIComponent(target);
  }

  /* Referencia impresa para identificar el cartel físico (oculta al imprimir). */
  if (refEl) {
    refEl.textContent = 'Código: ' + code;
    refEl.style.display = '';
  }
})();
