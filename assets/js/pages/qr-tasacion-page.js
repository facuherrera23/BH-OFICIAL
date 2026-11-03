/* ============================================================
   BIENENHAUS - Cartel imprimible "Pedí tu tasación" (qr-tasacion.html)
   Botón del panel de propiedades (ícono cartel) → esta página con
   ?code=<property_code>. El QR apunta a tasacion.html con UTMs:
   la SOLICITUD de tasación llega al CRM con utm_source=cartel y
   utm_campaign=<código de la propiedad donde está colgado el cartel>
   — atribución del canal offline que antes no existía.

   Igual que qr-visita-page.js: script externo porque la CSP de la
   página no permite ni scripts inline ni onclick inline. No usa
   supabase: no necesita leer la DB, el código viaja por la URL.
   ============================================================ */
(function () {
  'use strict';

  /* Botón imprimir: listener (cero onclick inline). */
  var printBtn = document.getElementById('printBtn');
  if (printBtn) {
    printBtn.addEventListener('click', function () {
      window.print();
    });
  }

  var params = new URLSearchParams(location.search);
  var code = (params.get('code') || '').trim().slice(0, 60);
  var img = document.getElementById('qrImg');
  var refEl = document.getElementById('refCode');

  /* Sin código igual funciona: la campaña queda 'cartel' genérica. */
  var campaign = code || 'cartel';

  var target = location.origin + '/tasacion.html'
    + '?utm_source=cartel'
    + '&utm_medium=qr'
    + '&utm_campaign=' + encodeURIComponent(campaign);

  if (img) {
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=8&data=' + encodeURIComponent(target);
  }

  /* El código de referencia va impreso en el cartel (chic, no estorba y
     permite identificar el cartel físico). En pantalla se muestra; al
     imprimir se oculta (@media print no lleva la clase .ref). */
  if (refEl) {
    if (code) {
      refEl.textContent = 'Código de referencia: ' + code;
      refEl.style.display = '';
    } else {
      refEl.style.display = 'none';
    }
  }
})();
