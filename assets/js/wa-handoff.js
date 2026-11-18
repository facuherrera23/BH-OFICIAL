/* ============================================================
   BIENENHAUS — Handoff de WhatsApp (1 campo → lead → chat)
   ============================================================
   POR QUÉ (auditoría 18/11/2026): TODO el contacto de la web se perdía
   en el chat. Las 27 fichas tenían 1 link a wa.me, 0 teléfono y 0
   formulario; la landing tenía 3 links a WhatsApp. Ni una sola de esas
   visitas llegaba al CRM → 1 lead del formulario en 12 semanas.

   QUÉ HACE ESTE ARCHIVO:
     · Al hacer click en cualquier link a WhatsApp, abre un modal con UN
       solo campo (el teléfono) + el checkbox de privacidad.
     · Al confirmar: crea el lead en el CRM (origen 'whatsapp', propiedad
       y página de origen) y ABRE el chat precargado.
     · El visitante que no quiere dejar datos puede saltear el modal y
       seguir al chat igual (la conversión nunca se frena).

   REGLAS:
     · El chat se abre ANTES del POST (si no, el popup blocker lo mata).
     · Si el POST falla, el chat sigue abierto: perder el lead es mejor
       que perder la consulta.
     · El 'wa_click' se trackea UNA sola vez (marca data-bh-wa-tracked) para
       no duplicar el evento con los listeners de la landing y las fichas.
     · Funciona en la landing (/assets/js/) y en las fichas (../assets/js/).
   ============================================================ */
(function () {
  'use strict';

  var SUPABASE_FALLBACK = 'https://rnldqiwwzhjnurkguihu.supabase.co';
  var ENDPOINT = (((window.BH_CONFIG && window.BH_CONFIG.SUPABASE_URL) || SUPABASE_FALLBACK)
    .replace(/\/+$/, '')) + '/functions/v1/contact-submit';
  var PRIVACY_URL = '/politica-de-privacidad.html';

  var dlg = null;
  var current = null;      // { href, propertyCode, page }

  /* ------------------------------------------------------------
     Utilidades
     ------------------------------------------------------------ */
  function track(name, params) {
    try {
      if (typeof window.bhTrack === 'function') window.bhTrack(name, params || {});
    } catch (_) { /* el tracking nunca rompe la navegación */ }
  }

  function propertyCodeFrom(href) {
    var m = String(href || '').match(/\/fichas\/([A-Za-z]{2}-P[0-9]{4})\.html/);
    return m ? m[1].toUpperCase() : null;
  }

  function currentPage() {
    var p = location.pathname || '/';
    if (/^\/fichas\//.test(p)) return 'ficha';
    if (/tasacion/.test(p)) return 'tasacion';
    if (/canal/.test(p)) return 'canal';
    if (p === '/' || p === '/index.html') return 'landing';
    return 'otro';
  }

  function utm() {
    try {
      var u = (typeof window.bhGetUtm === 'function') ? window.bhGetUtm() : null;
      if (!u) return {};
      return { utm_source: u.utm_source || null, utm_campaign: u.utm_campaign || null };
    } catch (_) { return {}; }
  }

  /** Normaliza el teléfono a formato internacional (549...).
      Casos (Argentina):
        '351 612 345 678' → 549351612345678 (móvil con área: 54 + 9 + 351 + 8)
        '351 15 612 3456' → 549351156123456 (móvil con área y 15 explícito)
        '3516123456'      → 543516123456    (fijo con área: 54 + 351 + 7)
        '612345678'       → 549612345678     (móvil local sin área)
        '+54 9 351 ...'   → 549351...        (ya internacional)
        '0 351 612...'    → 54351612...      (0 inicial) */
  function normalizePhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.indexOf('54') === 0 && d.length >= 12) return d;      // ya internacional
    if (d.charAt(0) === '0' && d.length >= 10) return '54' + d.slice(1);
    if (d.length === 10) return '54' + d;                        // fijo con área
    if (d.length >= 11 && d.length <= 13) return '549' + d;      // móvil con área
    if (d.length === 8 || d.length === 9) return '549' + d;       // móvil local
    return d;
  }

  /* ------------------------------------------------------------
     Modal
     ------------------------------------------------------------ */
  function buildModal() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'bhWaHandoff';
    dlg.setAttribute('aria-label', 'Dejanos tu teléfono para escribirte');
    dlg.style.cssText = [
      'border:0', 'padding:0', 'background:transparent', 'max-width:min(430px,92vw)',
      'width:100%', 'color:#E8EEF6', 'font-family:inherit', 'box-shadow:0 24px 60px rgba(0,0,0,.45)'
    ].join(';');
    dlg.innerHTML = [
      '<div style="background:#0B1220;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:22px 20px 18px;">',
      '  <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">',
      '    <span style="display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:12px;background:rgba(37,211,102,.14);color:#25D366;font-size:19px;">&#128172;</span>',
      '    <div style="flex:1;min-width:0;">',
      '      <strong style="display:block;font-size:16px;color:#fff;line-height:1.3;">&#191;Que te escribamos por WhatsApp?</strong>',
      '      <span style="display:block;font-size:12.5px;color:#9FB0C4;margin-top:3px;line-height:1.45;">Dejanos tu tel&eacute;fono y te contestamos por esta consulta. Despu&eacute;s seguimos al chat.</span>',
      '    </div>',
      '  </div>',
      '  <form id="bhWaForm" novalidate>',
      '    <label for="bhWaPhone" style="display:block;font-size:11.5px;color:#9FB0C4;margin-bottom:5px;letter-spacing:.03em;text-transform:uppercase;">Tel&eacute;fono / WhatsApp</label>',
      '    <input id="bhWaPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel"',
      '      placeholder="351 6 00 0000"',
      '      style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#fff;font-size:15px;">',
      '    <p id="bhWaError" style="display:none;margin:8px 0 0;font-size:12px;color:#FF7A7A;line-height:1.4;"></p>',
      '    <label style="display:flex;gap:9px;align-items:flex-start;margin:13px 0 0;font-size:12px;color:#C4D0DE;line-height:1.5;cursor:pointer;">',
      '      <input id="bhWaConsent" type="checkbox" style="margin:2px 0 0;accent-color:#25D366;flex:none;">',
      '      <span>Acepto que Bienenhaus me contacte y guarde mi tel&eacute;fono para esta consulta. Pod&eacute;s pedir la baja escribi&eacute;ndonos. <a href="' + PRIVACY_URL + '" style="color:#25D366;">Pol&iacute;tica de privacidad</a></span>',
      '    </label>',
      '    <button type="submit" id="bhWaSubmit"',
      '      style="width:100%;margin-top:16px;padding:13px 16px;border-radius:12px;border:0;background:#25D366;color:#08210f;font-weight:700;font-size:14.5px;cursor:pointer;">',
      '      Continuar al WhatsApp',
      '    </button>',
      '    <button type="button" id="bhWaSkip"',
      '      style="width:100%;margin-top:9px;padding:10px 16px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#C4D0DE;font-size:13px;cursor:pointer;">',
      '      Prefiero no dejar mis datos',
      '    </button>',
      '  </form>',
      '</div>'
    ].join('');
    document.body.appendChild(dlg);

    var form = dlg.querySelector('#bhWaForm');
    form.addEventListener('submit', onSubmit);
    dlg.querySelector('#bhWaSkip').addEventListener('click', onSkip);
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); closeModal(); });
    return dlg;
  }

  function closeModal() {
    try { if (dlg && dlg.open) dlg.close(); } catch (_) { /* no-op */ }
  }

  function showError(msg) {
    var el = dlg.querySelector('#bhWaError');
    if (!el) return;
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = msg;
    el.style.display = 'block';
  }

  function openModal(anchor) {
    var href = anchor.getAttribute('href') || '';
    if (!href) return false;
    current = {
      href: href,
      /* El código puede venir en el link (catálogo de la landing) o
         estar en la URL de la ficha → lo sacamos de los dos lados. */
      propertyCode: anchor.getAttribute('data-property-code')
        || propertyCodeFrom(href)
        || propertyCodeFrom(location.pathname),
      page: currentPage(),
    };
    buildModal();
    var phone = dlg.querySelector('#bhWaPhone');
    var consent = dlg.querySelector('#bhWaConsent');
    if (phone) { phone.value = ''; }
    if (consent) { consent.checked = false; }
    showError('');
    try {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    } catch (_) { /* no-op */ }
    setTimeout(function () { try { phone && phone.focus(); } catch (_) {} }, 60);
    track('wa_handoff_start', { origin: 'web', property_code: current.propertyCode || undefined });
    return true;
  }

  /** Abre el chat con el texto precargado que ya traía el link. */
  function openWhatsApp() {
    if (!current) return;
    var url = current.href;
    try {
      var w = window.open(url, '_blank', 'noopener');
      if (!w) { window.location.href = url; }
    } catch (_) {
      try { window.location.href = url; } catch (_) { /* no-op */ }
    }
  }

  function onSkip() {
    track('wa_handoff_skip', { origin: 'web', property_code: current && current.propertyCode ? current.propertyCode : undefined });
    closeModal();
    openWhatsApp();
  }

  function onSubmit(e) {
    e.preventDefault();
    if (!current) return;
    var input = dlg.querySelector('#bhWaPhone');
    var consent = dlg.querySelector('#bhWaConsent');
    var btn = dlg.querySelector('#bhWaSubmit');
    var raw = input ? input.value : '';
    var tel = normalizePhone(raw);

    if (tel.length < 8) {
      showError('Escribí un teléfono válido (mínimo 8 dígitos).');
      return;
    }
    if (!consent || !consent.checked) {
      showError('Necesitamos tu consentimiento para guardarte el teléfono.');
      return;
    }
    showError('');
    if (btn) { btn.disabled = true; btn.textContent = 'Abriendo WhatsApp…'; }

    /* El chat se abre PRIMERO: si el registro falla, el visitante igual
       llega a la conversación (preferimos perder el lead a perder el chat). */
    openWhatsApp();
    closeModal();

    var u = utm();
    var payload = {
      kind: 'whatsapp',
      phone: tel,
      whatsapp: tel,
      consent: true,
      page: current.page,
      path: (location.pathname || '/').slice(0, 200),
      property_code: current.propertyCode || null,
      utm_source: u.utm_source || null,
      utm_campaign: u.utm_campaign || null,
    };

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
    }).then(function (r) {
      track(r && r.ok ? 'wa_handoff_submit' : 'wa_handoff_error', {
        origin: 'web',
        property_code: current && current.propertyCode ? current.propertyCode : undefined,
      });
    }).catch(function () {
      track('wa_handoff_error', { origin: 'web' });
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Continuar al WhatsApp'; }
    });
  }

  /* ------------------------------------------------------------
     Intercepción de los links a WhatsApp
     ------------------------------------------------------------ */
  function onClick(e) {
    if (!e.target || !e.target.closest) return;
    var a = e.target.closest('a[href*="wa.me"]');
    if (!a) return;
    if (a.getAttribute('data-bh-wa') === 'off') return;   // escape hatch
    /* Trackeamos el click UNA vez (los listeners de la landing y de las
       fichas consultan esta marca para no duplicar el evento). */
    if (!a.hasAttribute('data-bh-wa-tracked')) {
      a.setAttribute('data-bh-wa-tracked', '1');
      track('wa_click', {
        origin: a.id === 'propertyWhatsAppCta'
          ? 'modal_propiedad'
          : (a.classList.contains('whatsapp-float') ? 'boton_flotante' : 'sitio'),
        property_code: a.getAttribute('data-property-code')
          || propertyCodeFrom(a.getAttribute('href'))
          || propertyCodeFrom(location.pathname)
          || undefined,
      });
    }
    /* No bloqueamos la conversión: el modal se puede saltear. */
    e.preventDefault();
    openModal(a);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      document.addEventListener('click', onClick, true);
    });
  } else {
    document.addEventListener('click', onClick, true);
  }
})();
