// MI BANDEJA (2026-11-26): "lo que hay que atender HOY" en un solo lugar.
//
//   · RPC mi_bandeja(p_user_id): 5 secciones accionables con alcance por rol
//     (super_admin/broker: todo; agente: lo suyo + lo sin dueño).
//   · get_sidebar_badge_counts v4: clave 'mi_bandeja' = el MISMO total que la
//     RPC (el badge y la bandeja no pueden decir números distintos).
//   · Botón #crmBandejaBtn en el CRM + overlay con acciones de 1 clic
//     (WhatsApp pre-cargado, marcar contactado, completar tarea, asignármelo).
//
// Guards estáticos + behavioral del render (vm, sin DB) + verificación en
// vivo documentada en el informe (badge 33 == total RPC 33 el 26/11/2026).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mig1 = read('supabase/migrations/20261126000004_mi_bandeja.sql');
const mig2 = read('supabase/migrations/20261126000005_mi_bandeja_ajustes.sql');
const mig3 = read('supabase/migrations/20261126000006_mi_bandeja_badge_total.sql');
const crmSrc = read('assets/js/admin-crm.js');
const htmlSrc = read('admin.html');
const cssSrc = read('assets/css/admin.css');

test.describe('Mi bandeja — lo que hay que atender hoy', () => {
  test('RPC mi_bandeja: SECURITY DEFINER, search_path vacío, sin anon', () => {
    expect(mig1).toContain('CREATE OR REPLACE FUNCTION public.mi_bandeja(p_user_id uuid DEFAULT NULL)');
    expect(mig1).toContain('SECURITY DEFINER');
    expect(mig1).toContain("SET search_path = ''");
    expect(mig1).toContain('REVOKE ALL ON FUNCTION public.mi_bandeja(uuid) FROM PUBLIC, anon;');
    expect(mig1).toContain('GRANT EXECUTE ON FUNCTION public.mi_bandeja(uuid) TO authenticated, service_role;');
    // Sin sesión → error controlado (no crash).
    expect(mig1).toContain("jsonb_build_object('error', 'sin sesion')");
    // Aditiva: no toca filas.
    expect(mig1).not.toMatch(/DELETE\s+FROM/i);
    expect(mig1).not.toMatch(/UPDATE\s+public\./i);
  });

  test('RPC mi_bandeja: las 5 secciones con totales y alcance por rol', () => {
    // Las 5 secciones + sus totales.
    for (const s of ['seguimientos', 'tareas', 'visitas', 'sin_agente', 'sin_tocar']) {
      expect(mig1).toContain("'" + s + "', v_");
      expect(mig1).toContain("'" + s + "_total'");
    }
    // Alcance por rol: super_admin/broker ven todo; un agente, lo suyo.
    expect(mig1).toContain("v_ver_todos := (v_role IN ('super_admin', 'broker'))");
    expect(mig1).toContain("(v_ver_todos OR l.assigned_to = v_agent)");
    // El agente sale por profile_id + activo (no por el id de agent).
    expect(mig1).toContain('WHERE a.profile_id = v_uid AND a.status = \'activo\' AND a.deleted_at IS NULL');
    // Terminal stages fuera en todas las secciones de deuda.
    expect(mig1).toMatch(/stage NOT IN \('cerrado_ganado', 'cerrado_perdido'\)/);
    // Telefonía lista para WhatsApp (whatsapp con fallback a phone).
    expect(mig1).toContain("COALESCE(NULLIF(l.whatsapp, ''), l.phone)");
  });

  test('ajustes: la bandeja es ACCIONABLE (sin tareas de leads cerrados) y mios respeta el rol', () => {
    // FIX 1: las tareas vencidas de leads CERRADOS no van a la bandeja.
    expect(mig2).toContain("AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido')");
    expect(mig2).toContain('la bandeja tiene que ser accionable');
    // FIX 2: 'mios' = puede escribir el lead (super_admin/broker → todo).
    expect(mig2).toMatch(/\(v_ver_todos OR l\.assigned_to IS NOT DISTINCT FROM v_agent\) AS mios/);
    expect(mig2).toMatch(/\(v_ver_todos OR v\.agent_id IS NOT DISTINCT FROM v_agent\) AS mios/);
    // FIX 3: el badge usa la misma regla de tareas vivas.
    expect(mig2).toContain("and l2.stage not in ('cerrado_ganado', 'cerrado_perdido')");
  });

  test('badge v4: mi_bandeja es el MISMO total que la RPC (badge == bandeja)', () => {
    expect(mig3).toContain("'mi_bandeja', coalesce(v_mi_bandeja, 0)");
    // Los 4 componentes en el MISMO orden/suma que mi_bandeja: seguimientos,
    // tareas vivas, leads sin agente y consultas sin tocar.
    expect(mig3).toContain("and l.next_followup_at is not null and l.next_followup_at < now()");
    expect(mig3).toContain("and l2.stage not in ('cerrado_ganado', 'cerrado_perdido')");
    expect(mig3).toContain('and l4.assigned_to is null');
    expect(mig3).toContain("l3.stage = 'nuevo'");
    expect(mig3).toContain('l3.last_contacted_at is null');
    // Las claves viejas del badge siguen (aditivo).
    for (const k of ['leads_new_24h', 'tasks_overdue_total', 'alq_contracts_expiring', 'visits_today']) {
      expect(mig3).toContain("'" + k + "'");
    }
  });

  test('el CRM tiene el botón Mi bandeja con contador', () => {
    expect(htmlSrc).toContain('id="crmBandejaBtn"');
    expect(htmlSrc).toContain('id="crmBandejaBadge"');
    expect(cssSrc).toContain('.crm-bandeja--alert');
    // Sin onclick inline (la CSP no tiene unsafe-inline para handlers).
    expect(htmlSrc).not.toMatch(/onclick="openBandeja/);
  });

  test('el CRM cablea la bandeja: RPC, acciones y contador', () => {
    expect(crmSrc).toContain("async function openBandeja() {");
    expect(crmSrc).toContain("db().rpc('mi_bandeja')");
    // Acciones por delegación (cero onclick inline).
    for (const attr of ['data-bandeja-wa', 'data-bandeja-abrir', 'data-bandeja-contactado', 'data-bandeja-tarea', 'data-bandeja-asignar']) {
      expect(crmSrc).toContain(attr);
    }
    // Punto único para "marcar contactado" (contacto + cierra tarea SLA + followup).
    expect(crmSrc).toContain('await markLeadContacted(leadId, stage === \'nuevo\' ? { stage: \'contactado\' } : null);');
    // El contador lee el cache del sidebar (sin RPC extra).
    expect(crmSrc).toContain('window.__BH.lastBadgeCounts.mi_bandeja');
    // Se cablea en init + _syncHeader (mostrar sólo en modo leads) + export.
    expect(crmSrc).toContain("bandejaBtn.addEventListener('click', openBandeja);");
    expect(crmSrc).toContain("if (bandejaBtn) bandejaBtn.style.display = ownersMode ? 'none' : '';");
    expect(crmSrc).toContain('openBandeja: openBandeja');
    // Y el contador se pinta también en loadLeads (fresca con cada refresh).
    expect(crmSrc).toContain('pintarBadgeBandeja(); /* contador del botón con el cache del sidebar RPC */');
  });

  test('behavioral: el render de la bandeja escapa datos y arma las acciones por tipo', () => {
    const from = crmSrc.indexOf('function bandejaWaLink');
    const to = crmSrc.indexOf('async function openBandeja()');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    // La cadena REAL de telefonía: AR_MOBILE_AREAS → normalizeArPhone → waNumber.
    const escFrom = crmSrc.indexOf('function esc(s) {');
    const escTo = crmSrc.indexOf('function safeCssUrl(u) {');
    const aFrom = crmSrc.indexOf('var AR_MOBILE_AREAS = {');
    const nFrom = crmSrc.indexOf('function normalizeArPhone(phone) {');
    const nTo = crmSrc.indexOf('function waNumber(phone) {');
    const waFrom = crmSrc.indexOf('function waNumber(phone) {');
    const waTo = crmSrc.indexOf('function telNumber(phone) {');
    const sandbox = {
      STATUS_LABELS: { nuevo: 'Nuevo', contactado: 'Contactado', visita_agendada: 'Visita agendada' },
      ORIGIN_LABELS: { ml: 'Mercado Libre', rela_zonaprop: 'ZonaProp (RELA)' },
      fmtDateTime: (d) => 'fecha ' + String(d).slice(0, 10),
      fmtDate: (d) => 'alta ' + String(d).slice(0, 10),
      window: {}, console,
    };
    vm.createContext(sandbox);
    vm.runInContext(crmSrc.slice(escFrom, escTo), sandbox);
    vm.runInContext(crmSrc.slice(aFrom, nFrom), sandbox);
    vm.runInContext(crmSrc.slice(nFrom, nTo), sandbox);
    vm.runInContext(crmSrc.slice(waFrom, waTo), sandbox);
    vm.runInContext(crmSrc.slice(from, to), sandbox);
    const item = sandbox.bandejaItemHtml;
    const seccion = sandbox.bandejaSeccionHtml;

    // 1) esc() SIEMPRE antes de innerHTML: un nombre con <script> no inyecta.
    const malicioso = item('seguimiento', {
      lead_id: 'uuid-1', nombre: '<script>alert(1)</script>', stage: 'nuevo',
      source: 'ml', telefono: '+54 9 351 555-1234', mios: true,
    }, true);
    expect(malicioso).not.toContain('<script>');
    expect(malicioso).toContain('&lt;script&gt;');

    // 2) Seguimiento propio → WhatsApp + Marcar contactado + Abrir.
    const mios = item('seguimiento', {
      lead_id: 'uuid-1', nombre: 'Ana Pérez', stage: 'contactado', source: 'ml',
      telefono: '+54 9 351 555-1234', mios: true,
    }, true);
    expect(mios).toContain('data-bandeja-wa');
    expect(mios).toContain('href="https://wa.me/5493515551234');
    expect(mios).toContain('data-bandeja-contactado="uuid-1"');
    expect(mios).toContain('data-bandeja-abrir="uuid-1"');

    // 3) Lead ajeno y sin rol para escribir → SIN "marcar contactado".
    const ajeno = item('seguimiento', {
      lead_id: 'uuid-2', nombre: 'Beto Díaz', stage: 'contactado', source: 'ml',
      telefono: '3515551234', mios: false, agente: 'Otro',
    }, false);
    expect(ajeno).not.toContain('data-bandeja-contactado');
    expect(ajeno).toContain('data-bandeja-wa'); // el chat se puede abrir igual

    // 4) El mismo lead ajeno, pero con verTodos → sí puede marcarlo.
    const conRol = item('seguimiento', {
      lead_id: 'uuid-2', nombre: 'Beto Díaz', stage: 'contactado', source: 'ml',
      telefono: '3515551234', mios: false, agente: 'Otro',
    }, true);
    expect(conRol).toContain('data-bandeja-contactado="uuid-2"');

    // 5) Tarea → "Completar" (con rol) y sin él.
    const tarea = item('tarea', {
      tarea_id: 't-1', lead_id: 'uuid-3', title: 'Llamar', nombre: 'Carla',
      telefono: '3515551234', mios: true,
    }, true);
    expect(tarea).toContain('data-bandeja-tarea="t-1"');
    const tareaAjena = item('tarea', {
      tarea_id: 't-1', lead_id: 'uuid-3', title: 'Llamar', nombre: 'Carla',
      telefono: '3515551234', mios: false,
    }, false);
    expect(tareaAjena).not.toContain('data-bandeja-tarea=');
    expect(tareaAjena).toContain('La tarea es de otro agente');

    // 6) Sin agente → "Asignármelo" y SIN marcar contactado.
    const sinAgente = item('sin_agente', {
      lead_id: 'uuid-4', nombre: 'Dario', stage: 'nuevo', source: 'rela_zonaprop',
      telefono: '', mios: false,
    }, false);
    expect(sinAgente).toContain('data-bandeja-asignar="uuid-4"');
    expect(sinAgente).not.toContain('data-bandeja-contactado');
    expect(sinAgente).toContain('is-disabled'); // WhatsApp sin número

    // 7) Visita: sin acciones de lead, con el link al cliente.
    const visita = item('visita', {
      visita_id: 'v-1', lead_id: 'uuid-5', client_name: 'Eva', client_phone: '3515551234',
      visit_date: '2026-12-01T15:00:00Z', status: 'confirmada', propiedad: 'DA-P0002', mios: true,
    }, true);
    expect(visita).toContain('DA-P0002');
    expect(visita).toContain('confirmada');
    expect(visita).not.toContain('data-bandeja-contactado');

    // 8) Sección vacía → mensaje amable, no un bloque roto.
    const vacia = seccion('Tareas vencidas', 'fas fa-list-check', '#FFB800', [], 0, 'tarea', true);
    expect(vacia).toContain('Nada pendiente acá');
    // 9) Con más filas que el límite → aviso "y N más".
    const conMas = seccion('Seguimientos', 'fas fa-clock', '#f87171', [{ lead_id: 'u', nombre: 'X', telefono: '3515551234', mios: true, stage: 'nuevo', source: 'ml' }], 12, 'seguimiento', true);
    expect(conMas).toContain('y 11 más');
  });
});
