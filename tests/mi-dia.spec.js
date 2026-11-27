// "MI DÍA" (P1-8 — 2026-11-27): las 3 acciones más urgentes del agente.
//
// Problema: "Mi bandeja" trae TODO lo pendiente (5 secciones, decenas de
// filas). Para el dueño es un inventario; para el agente es demasiado: abre
// la bandeja y no sabe por dónde empezar. Faltaba la respuesta a "¿qué hago
// ahora?".
//
// Lo que hay: RPC `mi_dia` (5 categorías ordenadas por urgencia, cortadas en
// 3) + overlay en el CRM con una acción de 1 clic por ítem + los conteos
// aparte (el top 3 no puede tapar el volumen).
//
// Guards estáticos + behavioral del render de un ítem (vm, sin DB).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const m1 = read('supabase/migrations/20261127000009_mi_dia_rpc.sql');
const m2 = read('supabase/migrations/20261127000010_mi_dia_rpc_fix.sql');
const crmSrc = read('assets/js/admin-crm.js');
const appSrc = read('assets/js/admin-app.js');
const htmlSrc = read('admin.html');
const cssSrc = read('assets/css/admin.css');

test.describe('P1-8 — "Mi día" (las 3 acciones más urgentes)', () => {
  test('M1: la RPC existe con el aislamiento de siempre', () => {
    expect(m1).toContain('CREATE OR REPLACE FUNCTION public.mi_dia(p_user_id uuid DEFAULT NULL)');
    expect(m1).toContain('SECURITY DEFINER');
    expect(m1).toContain("SET search_path = ''");
    expect(m1).toContain('REVOKE ALL ON FUNCTION public.mi_dia(uuid) FROM PUBLIC, anon;');
    expect(m1).toContain('GRANT EXECUTE ON FUNCTION public.mi_dia(uuid) TO authenticated, service_role;');
    // Sin sesión → error controlado (no crash).
    expect(m1).toContain("jsonb_build_object('error', 'sin sesion')");
    // Objetos calificados (search_path vacío).
    expect(m1).toContain('FROM public.leads l');
    expect(m1).toContain('FROM public.lead_tasks t');
    expect(m1).toContain('FROM public.visits v');
  });

  test('M1: las 5 categorías están en orden de urgencia y se cortan en 3', () => {
    // El orden es el del diseño: visita → espera → seguimiento → tarea → contacto.
    const iVisita = m1.indexOf("'tipo', 'visita'");
    const iEspera = m1.indexOf("'tipo', 'espera'");
    const iSeg = m1.indexOf("'tipo', 'seguimiento'");
    const iTar = m1.indexOf("'tipo', 'tarea'");
    const iCon = m1.indexOf("'tipo', 'contacto'");
    expect(iVisita).toBeGreaterThan(-1);
    expect(iEspera).toBeGreaterThan(iVisita);
    expect(iSeg).toBeGreaterThan(iEspera);
    expect(iTar).toBeGreaterThan(iSeg);
    expect(iCon).toBeGreaterThan(iTar);
    // El corte a 3.
    expect(m1).toContain('jsonb_array_length(v_items) < 3');
    // Un lead no se repite entre categorías.
    expect(m1).toContain('v_picked := array_append(v_picked, v_lead);');
    expect(m1).toContain('AND NOT (l.id = ANY(v_picked))');
  });

  test('M1: los conteos usan el MISMO alcance que los ítems', () => {
    // Los leads en espera NO son un seguimiento vencido común.
    expect(m1).toContain("l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
    // Las tareas suspendidas (en_espera) no cuentan como vencidas.
    expect(m1).toContain("t.status IN ('pendiente', 'en_progreso')");
    // "Hoy" se calcula en hora de Argentina (la DB trabaja en UTC).
    expect(m1).toContain("America/Argentina/Buenos_Aires");
    // El alcance por rol.
    expect(m1).toContain("v_ver_todos := (v_role IN ('super_admin', 'broker'));");
  });

  test('M2: la corrección del append (jsonb_array_append NO existe)', () => {
    // Bug real: la 1ª versión de la RPC quedó rota (42883) porque en
    // Postgres el array jsonb se concatena con `||`, no con jsonb_array_append.
    expect(m2).toContain('v_items := v_items || jsonb_build_array(v_item);');
    // En el SQL EJECUTABLE no puede quedar jsonb_array_append (el comentario
    // que explica el bug sí lo nombra).
    const sql = m2.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toContain('jsonb_array_append');
    expect(m2).toContain('CREATE OR REPLACE FUNCTION public.mi_dia(p_user_id uuid DEFAULT NULL)');
    // Los grants se mantienen tras el recreate.
    expect(m2).toContain('REVOKE ALL ON FUNCTION public.mi_dia(uuid) FROM PUBLIC, anon;');
    expect(m2).toContain('GRANT EXECUTE ON FUNCTION public.mi_dia(uuid) TO authenticated, service_role;');
  });

  test('front: el botón existe y llama a la RPC', () => {
    expect(htmlSrc).toContain('id="crmMiDiaBtn"');
    expect(htmlSrc).toContain('Mi día');
    expect(crmSrc).toContain('async function openMiDia() {');
    expect(crmSrc).toContain("db().rpc('mi_dia')");
    expect(crmSrc).toContain("miDiaBtn.addEventListener('click', openMiDia);");
    // Sólo en el modo leads (es la agenda del agente, no de los propietarios).
    expect(crmSrc).toContain("if (miDiaBtn) miDiaBtn.style.display = ownersMode ? 'none' : '';");
    // Expuesta para los demás módulos.
    expect(crmSrc).toContain('openMiDia: openMiDia');
  });

  test('front: los conteos se muestran aparte del top 3', () => {
    expect(crmSrc).toContain('function miDiaConteosHtml(conteos) {');
    expect(crmSrc).toContain('miDiaConteosHtml(d.conteos)');
    expect(crmSrc).toContain("k: 'seguimientos', l: 'seguimientos vencidos'");
    expect(crmSrc).toContain("k: 'sin_contacto', l: 'sin ningún contacto'");
  });

  test('front: cada ítem tiene su acción de 1 clic', () => {
    expect(crmSrc).toContain('data-midia-agenda');
    expect(crmSrc).toContain('data-midia-reactivar=');
    expect(crmSrc).toContain('data-midia-contactado=');
    expect(crmSrc).toContain('data-midia-tarea=');
    expect(crmSrc).toContain('data-midia-abrir=');
    // "Ver agenda" usa la API de navegación del panel.
    expect(appSrc).toContain('window.adminApp.navigateTo = function (section, opts)');
    expect(crmSrc).toContain("window.adminApp.navigateTo('tab-agenda')");
    // Las acciones reusan los puntos únicos del CRM (no lógica duplicada).
    expect(crmSrc).toContain('await markLeadContacted(leadId,');
    expect(crmSrc).toContain("db().rpc('lead_reactivar', { p_lead_id: leadId })");
  });

  test('behavioral: el ítem se renderiza con la acción que corresponde', () => {
    const escFrom = crmSrc.indexOf('function esc(s) {');
    const escTo = crmSrc.indexOf('function safeCssUrl(u) {');
    const tipoFrom = crmSrc.indexOf('var MI_DIA_TIPO = {');
    const tipoTo = crmSrc.indexOf('function miDiaItemHtml(it) {');
    const itemFrom = tipoTo;
    const itemTo = crmSrc.indexOf('function miDiaConteosHtml(conteos) {');
    expect(escFrom).toBeGreaterThan(-1);
    const sandbox = {
      window: {}, console,
      STATUS_LABELS: { nuevo: 'Nuevo', contactado: 'Contactado' },
      /* la RPC ya devuelve el teléfono normalizado; el link se arma acá */
      bandejaWaLink: (tel) => (tel ? 'https://wa.me/' + String(tel).replace(/[^0-9]/g, '') : null),
    };
    vm.createContext(sandbox);
    vm.runInContext(crmSrc.slice(escFrom, escTo), sandbox);
    vm.runInContext(crmSrc.slice(tipoFrom, tipoTo), sandbox);
    vm.runInContext(crmSrc.slice(itemFrom, itemTo), sandbox);
    const item = sandbox.miDiaItemHtml;

    // 1) Seguimiento vencido → marcar contactado + WhatsApp + abrir.
    const seg = item({ tipo: 'seguimiento', accion: 'contactar', lead_id: 'u1', nombre: 'Ana Pérez', telefono: '+54 351 555-1234', stage: 'contactado', detalle: 'Venció el 26/10/2026' });
    expect(seg).toContain('data-midia-contactado="u1"');
    expect(seg).toContain('data-midia-abrir="u1"');
    expect(seg).toContain('wa.me/543515551234');
    expect(seg).toContain('Seguimiento vencido');
    // El nombre se escapa (nada de HTML crudo del lead).
    expect(seg).toContain('Ana Pérez');
    const xss = item({ tipo: 'seguimiento', accion: 'contactar', lead_id: 'u2', nombre: '<img src=x onerror=alert(1)>' });
    expect(xss).not.toContain('<img');
    expect(xss).toContain('&lt;img src=x onerror=alert(1)&gt;');

    // 2) Lead que volvió de "en espera" → REACTIVAR (no "marcar contactado").
    const esp = item({ tipo: 'espera', accion: 'reactivar', lead_id: 'u3', nombre: 'Beto', detalle: 'Volvió el 01/12/2026' });
    expect(esp).toContain('data-midia-reactivar="u3"');
    expect(esp).not.toContain('data-midia-contactado');

    // 3) Tarea vencida → completar.
    const tar = item({ tipo: 'tarea', accion: 'tarea', lead_id: 'u4', tarea_id: 't1', nombre: 'Caro', detalle: 'Encuesta sin responder' });
    expect(tar).toContain('data-midia-tarea="t1"');
    expect(tar).toContain('data-lead="u4"');

    // 4) Visita → ir a la agenda.
    const vis = item({ tipo: 'visita', accion: 'agenda', lead_id: 'u5', nombre: 'Dani', detalle: '04/12 10:00 · DA-P0002' });
    expect(vis).toContain('data-midia-agenda');
    expect(vis).not.toContain('data-midia-contactado');
  });

  test('CSS: la piece de Mi día tiene estilo', () => {
    expect(cssSrc).toContain('.crm-midia-item');
    expect(cssSrc).toContain('.crm-midia-chip');
  });
});
