// Medición first-party + handoff de WhatsApp — guard de la Fase 2 (2026-11-18).
//
// POR QUÉ ESTE GUARD: el sitio estaba sin medición y sin captura.
//   • GA4/Clarity solo cargan con consentimiento 'all' → casi ninguna visita
//     se veía; `bhTrack` era un no-op sin cookies.
//   • Las 27 fichas tenían 1 link a wa.me, 0 teléfono y 0 formulario → TODO
//     el contacto se perdía en el chat (1 lead del formulario en 12 semanas).
//
// QUÉ PROTEGE (todo estático: lee el repo, NO toca la BD ni la red):
//   1. La tabla page_events: RLS ON, sin policies, service_role escribe.
//   2. La RPC bh_web_metrics: SECDEF, search_path fijo, anon NO puede.
//   3. El clamp de días (bug real: la ventana era siempre 90 → no vuelve).
//   4. La edge function track-event: whitelist de eventos, rate limit, sin PII.
//   5. El cliente tracking.js: sin cookies, con opt-out, sin datos personales.
//   6. El handoff de WhatsApp: 1 campo, consentimiento, origen 'whatsapp',
//      y NUNCA frena la conversión (se puede saltear).
//   7. contact-submit: el handoff no exige email (el teléfono alcanza) y el
//      flujo normal sigue exigiéndolo.
//   8. Las fichas: CSP con connect-src de Supabase + los scripts nuevos.
//   9. Aviso de privacidad + botón "No medirme" en el pie del sitio.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const mig = read('supabase', 'migrations', '20261118000005_page_events.sql');
const fix = read('supabase', 'migrations', '20261118000006_web_metrics_days_fix.sql');
const trackFn = read('supabase', 'functions', 'track-event', 'index.ts');
const trackingJs = read('assets', 'js', 'tracking.js');
const handoffJs = read('assets', 'js', 'wa-handoff.js');
const contactSubmit = read('supabase', 'functions', 'contact-submit', 'index.ts');
const generateFicha = read('scripts', 'generate-ficha.mjs');
const indexHtml = read('index.html');
const privacyHtml = read('politica-de-privacidad.html');
const deployYml = read('.github', 'workflows', 'deploy.yml');
const deploySpec = read('tests', 'functions-deploy.spec.js');
const portales = read('assets', 'js', 'admin-portales.js');
const adminHtml = read('admin.html');

test.describe('medición first-party (Fase 2)', () => {
  test('la tabla page_events existe con RLS sin policies (solo service_role)', () => {
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS public.page_events');
    expect(mig).toContain('ALTER TABLE public.page_events ENABLE ROW LEVEL SECURITY');
    expect(mig).toMatch(/REVOKE ALL ON public\.page_events FROM anon, authenticated/);
    expect(mig).toMatch(/GRANT ALL ON public\.page_events TO service_role/);
    // NO debe haber policies (la lectura va por la RPC).
    expect(mig).not.toMatch(/CREATE POLICY[^;]*page_events/i);
  });

  test('page_events NO tiene columnas de PII (ni IP, ni user agent, ni email)', () => {
    const bloque = mig.slice(mig.indexOf('CREATE TABLE IF NOT EXISTS public.page_events'));
    const tabla = bloque.slice(0, bloque.indexOf(');'));
    expect(tabla).not.toMatch(/\bip\b|user_agent|email|phone|full_name/i);
    // Los campos permitidos (session_id es un UUID de sesión, no una persona).
    for (const c of ['event', 'path', 'page', 'property_code', 'origin', 'referrer', 'utm_source', 'utm_campaign', 'session_id']) {
      expect(tabla).toContain(c);
    }
  });

  test('bh_web_metrics es SECDEF con search_path fijo y anon NO la puede ejecutar', () => {
    expect(mig).toMatch(/bh_web_metrics\(p_dias integer DEFAULT 7\)[\s\S]*?SECURITY DEFINER\s+SET search_path = ''/);
    expect(mig).toContain('REVOKE ALL ON FUNCTION public.bh_web_metrics(integer) FROM PUBLIC, anon');
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.bh_web_metrics(integer) TO authenticated, service_role');
  });

  test('el clamp de días está bien en la migración vigente (bug real: ventana siempre 90)', () => {
    // La 005 (YA APLICADA en producción) tenía el clamp al revés:
    //   GREATEST(LEAST(x, 1), 90) → siempre 90 días, ignoraba el parámetro.
    // La 006 lo corrige. El guard mira la ÚLTIMA definición de la función
    // en el repo (la que manda en una base nueva) → no se edita la 005.
    expect(mig).toContain('GREATEST(LEAST(COALESCE(p_dias, 7), 1), 90)');
    expect(fix).toContain('GREATEST(LEAST(COALESCE(p_dias, 7), 90), 1)');

    const dir = path.join(ROOT, 'supabase', 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    let vigente = null;
    for (const f of files) {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/CREATE OR REPLACE FUNCTION public\.bh_web_metrics/.test(txt)) vigente = { f, txt };
    }
    expect(vigente, 'bh_web_metrics debe existir en las migraciones').toBeTruthy();
    // Sin comentarios: la 006 MENCIONA la forma vieja para documentar el bug.
    const codigo = vigente.txt.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(codigo).toContain('GREATEST(LEAST(COALESCE(p_dias, 7), 90), 1)');
    expect(codigo).not.toContain('GREATEST(LEAST(COALESCE(p_dias, 7), 1), 90)');
  });

  test('la RPC devuelve vistas, clics de WhatsApp, formularios y páginas más vistas', () => {
    for (const k of ['vistas_7d', 'vistas_30d', 'wa_clicks_7d', 'wa_clicks_30d', 'form_starts_7d', 'form_submits_7d', 'leads_web_7d', 'tasa_form_7d', 'top_paginas', 'por_evento']) {
      expect(mig).toContain(k);
    }
  });

  test('track-event tiene whitelist de eventos (el cliente no puede inventar)', () => {
    expect(trackFn).toContain('const EVENTS = new Set([');
    expect(trackFn).toContain("'page_view'");
    expect(trackFn).toContain("'wa_click'");
    expect(trackFn).toContain("'form_submit'");
    // Y NO acepta un evento arbitrario.
    expect(trackFn).not.toMatch(/EVENTS\.add\(/);
  });

  test('track-event tiene rate limit y NO escribe la IP en la base', () => {
    expect(trackFn).toContain("checkRateLimit('track-event'");
    const insert = trackFn.slice(trackFn.indexOf('const row = {'));
    expect(insert).not.toMatch(/\bip\b|x-forwarded-for|user_agent/i);
  });

  test('track-event es pública: está en NO_VERIFY y en CALLED_WITHOUT_JWT', () => {
    expect(deployYml).toMatch(/NO_VERIFY=\([\s\S]*?"track-event"/);
    expect(deploySpec).toContain("fn: 'track-event'");
  });

  test('tracking.js NO usa cookies y tiene opt-out', () => {
    expect(trackingJs).not.toContain('document.cookie');
    expect(trackingJs).toContain("bh_track_optout");
    expect(trackingJs).toContain('sessionStorage');
    expect(trackingJs).not.toContain('localStorage.setItem(\'sid\'');
  });

  test('tracking.js NO manda datos personales', () => {
    const payload = trackingJs.slice(trackingJs.indexOf('function buildPayload'));
    const bloque = payload.slice(0, payload.indexOf('function send'));
    expect(bloque).not.toMatch(/email|phone|nombre|full_name/i);
  });

  test('el panel de métricas existe en el admin y llama a bh_web_metrics', () => {
    expect(adminHtml).toContain('id="webMetricsPanel"');
    expect(adminHtml).toContain('id="webMetricsPanelBody"');
    expect(portales).toContain("rpc('bh_web_metrics'");
    expect(portales).toContain('loadWebMetricsPanel()');
  });
});

test.describe('handoff de WhatsApp (1 campo → lead → chat)', () => {
  test('el cliente pide SOLO el teléfono y un checkbox de consentimiento', () => {
    expect(handoffJs).toContain('id="bhWaPhone"');
    expect(handoffJs).toContain('id="bhWaConsent"');
    expect(handoffJs).toContain('type="checkbox"');
    // No pide email ni nombre en el modal.
    const modal = handoffJs.slice(handoffJs.indexOf('function buildModal'));
    const bloque = modal.slice(0, modal.indexOf('function closeModal'));
    expect(bloque).not.toMatch(/type="email"|name="email"|nombre completo/i);
  });

  test('el handoff NUNCA frena la conversión (se puede saltear y seguir al chat)', () => {
    expect(handoffJs).toContain('bhWaSkip');
    expect(handoffJs).toContain('Prefiero no dejar mis datos');
    expect(handoffJs).toContain('openWhatsApp()');
  });

  test('el handoff manda el lead a contact-submit con consent=true', () => {
    expect(handoffJs).toContain('/functions/v1/contact-submit');
    expect(handoffJs).toContain("kind: 'whatsapp'");
    expect(handoffJs).toContain('consent: true');
    expect(handoffJs).toContain('property_code');
  });

  test('contact-submit: el handoff no exige email y usa el origen "whatsapp"', () => {
    expect(contactSubmit).toContain("const isHandoff = payload.kind === 'whatsapp'");
    expect(contactSubmit).toContain("payload.consent !== true");
    expect(contactSubmit).toContain("source: isHandoff ? 'whatsapp' : 'landing_page'");
    // El flujo normal (formulario) sigue exigiendo email + nombre + mensaje.
    expect(contactSubmit).toContain("if (!email || !EMAIL_RE.test(email)) return jsonResponse(400, { error: 'Email inválido' }, req);");
    expect(contactSubmit).toContain("if (!name) return jsonResponse(400, { error: 'Falta el nombre' }, req);");
    expect(contactSubmit).toContain("if (!message) return jsonResponse(400, { error: 'Falta el mensaje' }, req);");
  });

  test('contact-submit: el handoff resuelve el código de propiedad (DA-P0002 → UUID)', () => {
    expect(contactSubmit).toContain('property_code');
    expect(contactSubmit).toContain("/^[A-Z]{2}-P[0-9]{4}$/");
    expect(contactSubmit).toContain(".eq('property_code', propertyCode)");
    expect(contactSubmit).toContain('property_id: linkedPropertyId');
  });

  test('el handoff se carga en la landing y en las fichas', () => {
    expect(indexHtml).toContain('assets/js/wa-handoff.js');
    expect(indexHtml).toContain('assets/js/tracking.js');
    expect(generateFicha).toContain('../assets/js/wa-handoff.js');
    expect(generateFicha).toContain('../assets/js/tracking.js');
  });

  test('las fichas tienen connect-src de Supabase (sin eso el tracking y el handoff mueren)', () => {
    const csp = generateFicha.slice(generateFicha.indexOf('Content-Security-Policy'));
    const linea = csp.slice(0, csp.indexOf('">'));
    expect(linea).toContain('connect-src');
    expect(linea).toContain('https://*.supabase.co');
  });

  test('el "wa_click" no se trackea dos veces (handoff + landing/ficha)', () => {
    expect(handoffJs).toContain('data-bh-wa-tracked');
    expect(generateFicha).toContain('data-bh-wa-tracked');
    expect(read('assets', 'js', 'landing-app.js')).toContain('data-bh-wa-tracked');
  });
});

test.describe('aviso de privacidad y opt-out', () => {
  test('la política de privacidad explica la medición sin cookies y el handoff', () => {
    expect(privacyHtml).toContain('Medición propia');
    expect(privacyHtml).toContain('No usamos cookies');
    expect(privacyHtml).toContain('WhatsApp');
    expect(privacyHtml).toContain('data-bh-track-optout');
  });

  test('la política de privacidad tiene connect-src para la medición propia', () => {
    const csp = privacyHtml.slice(privacyHtml.indexOf('Content-Security-Policy'));
    expect(csp.slice(0, 400)).toContain('https://*.supabase.co');
  });

  test('el sitio tiene el botón "No medirme" en el pie', () => {
    expect(indexHtml).toContain('data-bh-track-optout');
    expect(trackingJs).toContain('setupOptOutButtons');
  });
});
