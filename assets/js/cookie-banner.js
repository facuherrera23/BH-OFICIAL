/* ============================================================
   COOKIE BANNER — Ley 25.326 (Argentina) + AAIP
   Cumplimiento: consentimiento previo para cookies no esenciales.
   GA y Clarity solo se cargan si el usuario ACEPTA.
   Cloudflare Insights es anónimo y se mantiene siempre.
   ============================================================ */
(function () {
  'use strict';

  const KEY = 'bh_cookie_consent';
  const GA_ID = null; /* se setea dinámicamente desde el landing */
  /* Los scripts de GA y Clarity están con type="text/plain" en el HTML.
     Al aceptar, se habilitan cambiando el type a text/javascript. */

  function getConsent() {
    try { return localStorage.getItem(KEY); } catch (_) { return null; }
  }

  function setConsent(value) {
    try { localStorage.setItem(KEY, value); } catch (_) {}
  }

  function enableTracking() {
    /* Habilitar los scripts de GA y Clarity que están diferidos */
    document.querySelectorAll('script[data-bh-tracking][type="text/plain"]').forEach(function (s) {
      s.type = 'text/javascript';
      /* recrear el script para que el browser lo ejecute */
      const active = document.createElement('script');
      active.src = s.src;
      if (s.async) active.async = true;
      document.head.appendChild(active);
      s.remove();
    });
  }

  function disableTracking() {
    /* Los scripts nunca se activaron — nada que hacer */
  }

  function hideBanner() {
    const banner = document.getElementById('bhCookieBanner');
    if (banner) { banner.style.opacity = '0'; setTimeout(function () { banner.remove(); }, 300); }
  }

  function showBanner() {
    /* No mostrar si ya existe o si ya hay consentimiento */
    if (getConsent()) return;
    if (document.getElementById('bhCookieBanner')) return;

    const banner = document.createElement('div');
    banner.id = 'bhCookieBanner';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:1000002;background:rgba(5,7,10,.97);border-top:1px solid rgba(31,200,195,.25);backdrop-filter:blur(12px);padding:16px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;color:#CBD5E1;transition:opacity .3s ease;';

    banner.innerHTML =
      '<div style="flex:1;min-width:220px;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
          '<i class="fas fa-cookie-bite" style="color:var(--accent,#1FC8C3);font-size:16px;"></i>' +
          '<strong style="color:#fff;font-size:13px;">Cookies</strong>' +
        '</div>' +
        '<span style="line-height:1.5;">Usamos cookies para medir el tráfico y mejorar tu experiencia. ' +
        '<a href="/politica-de-privacidad.html" style="color:var(--accent,#1FC8C3);text-decoration:underline;" rel="noopener">Más información</a></span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-shrink:0;">' +
        '<button type="button" id="bhCookieReject" style="padding:8px 18px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:transparent;color:#CBD5E1;font-size:12.5px;cursor:pointer;font-weight:600;">Solo esenciales</button>' +
        '<button type="button" id="bhCookieAccept" style="padding:8px 18px;border-radius:8px;border:none;background:var(--accent,#1FC8C3);color:#05070A;font-size:12.5px;cursor:pointer;font-weight:700;">Aceptar todas</button>' +
      '</div>';

    document.body.appendChild(banner);

    banner.querySelector('#bhCookieAccept').addEventListener('click', function () {
      setConsent('all');
      enableTracking();
      window.dispatchEvent(new CustomEvent('bh-cookie-consent'));
      hideBanner();
    });

    banner.querySelector('#bhCookieReject').addEventListener('click', function () {
      setConsent('essential');
      disableTracking();
      hideBanner();
    });
  }

  /* Al cargar: si ya aceptó, activar tracking inmediatamente; si no, mostrar banner */
  const existing = getConsent();
  if (existing === 'all') {
    enableTracking();
  } else if (!existing) {
    /* mostrar banner cuando el DOM esté listo */
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showBanner);
    } else {
      showBanner();
    }
  }
  /* 'essential': no activar tracking, no mostrar banner */
})();
