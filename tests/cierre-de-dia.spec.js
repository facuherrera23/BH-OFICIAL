// CIERRE DE DÍA + PLANTILLA DE PRIMER CONTACTO (28/11/2026).
//
// Dos mejoras del diagnóstico con datos reales:
//   1) las 4 colas (tareas vencidas, leads sin contacto >48 h, encuestas
//      pendientes y leads sin agente) estaban repartidas en 4 pantallas;
//   2) la plantilla de WhatsApp no incluía precio ni link, y abrir el chat
//      después de un `await` exponía el popup al bloqueador del navegador.
//
// La RPC es SÓLO LECTURA y el front reutiliza los flujos existentes: el mismo
// delegado `bindMiDiaActions`, `openVisitModal`, `sendSurveyForProperty`,
// `showLostReasonModal` y `markLeadContacted`.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const crm = read('assets/js/admin-crm.js');
const app = read('assets/js/admin-app.js');
const html = read('admin.html');
const sql = read('supabase/migrations/20261128000013_cierre_de_dia.sql');

const slice = (from, to) => {
  const a = crm.indexOf(from);
  const b = crm.indexOf(to, a);
  expect(a, 'inicio no encontrado: ' + from).toBeGreaterThan(-1);
  expect(b, 'fin no encontrado: ' + to).toBeGreaterThan(a);
  return crm.slice(a, b);
};

test.describe('Cierre de día — RPC de sola lectura', () => {
  test('las 4 colas y los conteos salen de una sola RPC', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.cierre_de_dia(');
    expect(sql).toContain("'tareas', (");
    expect(sql).toContain("'sin_contacto', (");
    expect(sql).toContain("'encuestas', (");
    expect(sql).toContain("'sin_agente', (");
    expect(sql).toContain("'conteos', jsonb_build_object(");
    // Contexto de propiedad para la plantilla (sin query extra en el front).
    expect(sql).toContain("'precio_usd', x.price_usd, 'precio_currency', x.price_currency, 'link', x.link");
  });

  test('es SECURITY DEFINER con search_path vacío y sin anon', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path = ''");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.cierre_de_dia(uuid, boolean) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.cierre_de_dia(uuid, boolean) TO authenticated, service_role;');
    const ejecutable = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    // Ninguna escritura: el agente decide por fila con los flujos del CRM.
    expect(ejecutable).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    // El enum es real (incluye 'en_espera', verificado con enum_range).
    expect(ejecutable).toContain("'cerrado_ganado', 'cerrado_perdido', 'en_espera'");
  });

  test('alcance por rol y límites de cola', () => {
    expect(sql).toContain("v_role IN ('super_admin', 'broker')");
    expect(sql).toContain("COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono");
    expect(sql.match(/LIMIT 20/g).length).toBe(4);
    expect(sql).toContain('America/Argentina/Buenos_Aires');
  });
});

test.describe('Cierre de día — front', () => {
  test('botón, overlay y panel del Dashboard', () => {
    expect(html).toContain('id="crmCierreDiaBtn"');
    expect(html).toContain('id="dashCierreDiaPanel"');
    expect(html).toContain('id="dashCierreDiaBody"');
    expect(html).toContain('id="dashCierreDiaSub"');
    expect(html).toContain('data-action="openCierreDiaPanel"');
    expect(crm).toContain('cierreBtn.addEventListener(\'click\', openCierreDia);');
    expect(crm).toContain("if (cierreBtn) cierreBtn.style.display = ownersMode ? 'none' : '';");
    expect(crm).toContain('openCierreDia: openCierreDia, mountCierreDiaPanel: mountCierreDiaPanel');
    expect(app).toContain('window.adminApp.openCierreDiaPanel = function () {');
    expect(app).toContain("window.BH_CRM.openCierreDia === 'function'");
    expect(app).toContain("window.BH_CRM.mountCierreDiaPanel(body, $('#dashCierreDiaSub'))");
    expect(app).toContain('renderDashCierreDia();');
    const load = app.slice(app.indexOf('async function loadDashboard()'), app.indexOf('async function loadDashboard()') + 1600);
    expect(load.indexOf('renderDashCierreDia();')).toBeLessThan(load.indexOf('try {'));
  });

  test('no duplica delegado: el mismo bindMiDiaActions atiende ambas vistas', () => {
    expect(crm).toContain('function bindMiDiaActions(body, ctx) {');
    expect(crm).toContain('var render = ctx.render || miDiaRender;');
    expect(crm).toContain('bindMiDiaActions(body, { body: body, sub: sub, soloPropio: false, cerrar: cerrar, render: cierreDiaRender })');
    expect(crm).toContain('bindMiDiaActions(body, { body: body, sub: sub, soloPropio: true, cerrar: null, render: cierreDiaRender })');
    expect(crm).toContain("db().rpc('cierre_de_dia', { p_solo_propio: !!soloPropio })");
    // Acciones existentes, no flujos nuevos.
    expect(crm).toContain('window.adminApp.openVisitModal({ lead_id: leadId, client_name: nombre, client_phone: tel, property_id: propId })');
    expect(crm).toContain('await sendSurveyForProperty({ id: leadId, full_name: nombre, whatsapp: tel, phone: tel }, propId, prop, null, true)');
    expect(crm).toContain('var lost = await showLostReasonModal(detalle);');
    expect(crm).toContain("await markLeadContacted(leadId, { stage: 'cerrado_perdido', lost_reason: lost.reason })");
  });

  test('todas las filas pasan por esc() y las acciones llevan lead_id', () => {
    const fn = slice('function cierreDiaItemHtml(it) {', 'async function cierreDiaRender(');
    expect(fn).toContain('data-cierre-agendar=');
    expect(fn).toContain('data-cierre-cerrar=');
    expect(fn).toContain('data-cierre-encuesta=');
    expect(fn).toContain('data-midia-abrir=');
    expect(fn).toContain("esc(it.nombre || 'Sin nombre')");
    expect(fn).toContain('target="_blank" rel="noopener"');
    expect(fn).toContain('window.BHUtils.safeUrl(it.link)');
    expect(fn).not.toMatch(/onclick=/);
  });

  test('behavioral: el ítem arma Llamar / Agendar / Cerrar con el lead correcto', () => {
    const sandbox = { window: { BHUtils: { safeUrl: (u) => /^https?:\/\//.test(u) ? u : '' } }, console };
    vm.createContext(sandbox);
    vm.runInContext(slice('function esc(s) {', 'function safeCssUrl(u) {'), sandbox);
    vm.runInContext(slice('var AR_MOBILE_AREAS = {', 'function contactSectionHtml('), sandbox);
    vm.runInContext(slice('function propPriceText(p) {', 'var WA_TEMPLATES = ['), sandbox);
    vm.runInContext(slice('function cierreDiaItemHtml(it) {', 'async function cierreDiaRender('), sandbox);

    const html = sandbox.cierreDiaItemHtml({
      tipo: 'sin_contacto', lead_id: 'lead-1', nombre: 'Ana Pérez',
      telefono: '+54 351 555-1234', stage: 'nuevo', titulo: 'Sin contactar',
      detalle: 'Entró el 20/11/2026', prop: 'Casa en Urca', price_usd: 110000,
      price_currency: 'USD', link: 'https://bienenhaus.com.ar/fichas/HS-P0004.html'
    });
    expect(html).toContain('href="tel:+543515551234"');
    expect(html).toContain('data-cierre-agendar="lead-1"');
    expect(html).toContain('data-cierre-cerrar="lead-1"');
    expect(html).toContain('data-midia-contactado="lead-1"');
    expect(html).toContain('data-midia-abrir="lead-1"');
    expect(html).toContain('US$ 110.000');
    expect(html).toContain('Ver ficha');

    const enc = sandbox.cierreDiaItemHtml({
      tipo: 'encuesta', lead_id: 'lead-2', nombre: 'Beto', telefono: '',
      property_id: 'prop-2', prop: 'Depto Centro', titulo: 'Depto Centro',
      detalle: 'Pendiente desde el 10/10/2026'
    });
    expect(enc).toContain('data-cierre-encuesta="lead-2"');
    expect(enc).toContain('data-prop-id="prop-2"');
    expect(enc).toContain('is-disabled'); // sin teléfono no hay botón de llamar

    const xss = sandbox.cierreDiaItemHtml({ tipo: 'sin_agente', lead_id: 'x', nombre: '<img src=x onerror=alert(1)>' });
    expect(xss).not.toContain('<img');
    expect(xss).toContain('&lt;img');
  });
});

test.describe('Plantilla de primer contacto', () => {
  test('incluye nombre, propiedad, precio y ficha', () => {
    expect(crm).toContain("id: 'primer_contacto'");
    expect(crm).toContain("c.precio ? ' (' + c.precio + ')' : ''");
    expect(crm).toContain("(c.link ? '\\nFicha: ' + c.link : '')");
    expect(crm).toContain('propPriceText(firstProp)');
    expect(crm).toContain('precio: propPrecio');
  });

  test('anti popup-blocker: apertura sin await + traza fire-and-forget', () => {
    const fn = slice('var useBtn = panel.querySelector(\'#crmTemplateUse\');', 'var assignBtn = panel.querySelector(\'#crmAssignMe\');');
    expect(fn).not.toMatch(/async function/);
    expect(fn.indexOf("window.open('about:blank', '_blank')")).toBeLessThan(fn.indexOf('popup.location.replace(url)'));
    expect(fn).toContain("markLeadContacted(lead.id, lead.stage === 'nuevo' ? { stage: 'contactado' } : null).catch");
    // El log NO puede bloquear la apertura del chat.
    expect(fn.indexOf('.insert([')).toBeGreaterThan(fn.indexOf('popup.location.replace(url)'));
    expect(fn).not.toMatch(/await db\(\)\.from\('lead_activities'\)/);
  });

  test('behavioral: el precio respeta price_currency (ARS = $, USD = US$)', () => {
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(slice('function propPriceText(p) {', 'var WA_TEMPLATES = ['), sandbox);
    vm.runInContext(slice('var WA_TEMPLATES = [', '// Normalización AR'), sandbox);
    expect(sandbox.propPriceText({ price_usd: 110000, price_currency: 'USD' })).toBe('US$ 110.000');
    expect(sandbox.propPriceText({ price_usd: 650000, price_currency: 'ARS' })).toBe('$ 650.000');
    expect(sandbox.propPriceText(null)).toBe('');
    const tpl = sandbox.WA_TEMPLATES.filter((t) => t.id === 'primer_contacto')[0];
    const text = tpl.text({ nombre: 'Ana', prop: 'Casa en Urca', precio: 'US$ 110.000', link: 'https://bienenhaus.com.ar/fichas/HS-P0004.html' });
    expect(text).toContain('Ana');
    expect(text).toContain('Casa en Urca');
    expect(text).toContain('US$ 110.000');
    expect(text).toContain('https://bienenhaus.com.ar/fichas/HS-P0004.html');
  });
});
