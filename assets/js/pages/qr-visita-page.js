/* ============================================================
   BIENENHAUS - QR de llegada (qr-visita.html)
   Script externo: la CSP de la página (script-src 'self') no permite
   ni scripts inline ni onclick inline — antes toda la página quedaba
   en "Cargando…" y el botón Imprimir no hacía nada (fix 2026-10-15).
   ============================================================ */
(function () {
  'use strict';

  /* Botón imprimir: data-action + listener (cero onclick inline). */
  var printBtn = document.getElementById('printBtn');
  if (printBtn) {
    printBtn.addEventListener('click', function () {
      window.print();
    });
  }

  (async function () {
    var params = new URLSearchParams(location.search);
    var token = params.get('token');
    var img = document.getElementById('qrImg');
    var titleEl = document.getElementById('propTitle');
    var dirEl = document.getElementById('propDir');

    if (!token) {
      if (titleEl) titleEl.textContent = 'Enlace inválido';
      if (img) img.style.display = 'none';
      return;
    }

    var target = location.origin + '/confirmar-visita.html?token=' + encodeURIComponent(token) + '&mode=checkin';
    if (img) {
      img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=8&data=' + encodeURIComponent(target);
    }

    try {
      var sb = window.supabase.createClient(window.BH_CONFIG.SUPABASE_URL, window.BH_CONFIG.SUPABASE_ANON_KEY);
      var res = await sb.rpc('get_visit_by_token', { p_token: token });
      if (res.data) {
        if (titleEl) titleEl.textContent = (res.data.property && res.data.property.title) || 'Visita programada';
        if (dirEl) dirEl.textContent = (res.data.property && res.data.property.address) || '';
      } else if (titleEl) {
        /* Token inexistente o visita vieja: el cartel igual muestra el QR,
           sin dejar el título clavado en "Cargando…". */
        titleEl.textContent = 'Visita programada';
      }
    } catch (_) { /* fail-soft: el QR ya se muestra */ }
  })();
})();
