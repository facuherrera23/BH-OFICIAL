// ETAPA "EN ESPERA" (P1-6 — 2026-11-27).
//
// Problema medido: el CRM no tenía forma de COLGAR un lead. Un prospecto que
// el cliente "va a consultar después" seguía en la cola: su tarea vencía, el
// recordatorio le avisaba al agente y el lead competía en el ranking de
// prioridades con los que sí había que trabajar hoy.
//
// La solución (3 capas, verificadas en producción con transacción + ROLLBACK):
//   1. Estado real en la DB: `lead_stage` gana el label `en_espera` (NO
//      terminal) + `leads.stage_previo` (la etapa desde la que se colgó) +
//      `lead_tasks.status` admite 'en_espera' (tarea suspendida).
//   2. RPCs `lead_pasar_a_espera` / `lead_reactivar` (SECURITY DEFINER,
//      search_path vacío, sin anon) que replican el alcance de la policy
//      `leads_update`.
//   3. Front: banner "En espera" + botón "Reactivar" en la ficha del lead,
//      botón "En espera" (1d / 3d / 1s), y "Reactivar" en Mi bandeja cuando
//      vuelve la fecha de regreso.
//
// Contrato del comportamiento:
//   · Un lead en espera NO aparece en la bandeja (ni por tareas, ni por
//     "sin agente") hasta que llega su fecha de regreso (`next_followup_at`).
//   · Sus tareas NO vencen, NO avisan y NO cuentan en el backlog.
//   · Al reactivarlo vuelve a `stage_previo` y sus tareas vuelven a la cola.
//
// Guards estáticos + behavioral del render de la bandeja (vm, sin DB).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const m1 = read('supabase/migrations/20261127000003_lead_stage_en_espera.sql');
const m2 = read('supabase/migrations/20261127000004_lead_espera_rpc.sql');
const m3 = read('supabase/migrations/20261127000006_lead_espera_fix_cast.sql');
const m4 = read('supabase/migrations/20261127000007_lead_espera_fix_triggers.sql');
const m5 = read('supabase/migrations/20261127000008_lead_espera_alertas_followup.sql');
const m6 = read('supabase/migrations/20261127000011_lead_reactivar_texto.sql');
const crmSrc = read('assets/js/admin-crm.js');
const appSrc = read('assets/js/admin-app.js');
const agentesSrc = read('assets/js/admin-agentes.js');
const agendaSrc = read('assets/js/admin-agenda.js');
const tasksSrc = read('assets/js/admin-crm-tasks.js');
const cssSrc = read('assets/css/admin.css');

test.describe('P1-6 — etapa "en espera" (lead colgado)', () => {
  test('M1: el enum, la columna stage_previo y el CHECK de tareas', () => {
    expect(m1).toContain("ALTER TYPE public.lead_stage ADD VALUE IF NOT EXISTS 'en_espera'");
    expect(m1).toMatch(/ADD COLUMN IF NOT EXISTS stage_previo/);
    // La tarea suspendida necesita un status propio (o entraba en el CHECK).
    expect(m1).toContain("'en_espera'");
    expect(m1).toMatch(/lead_tasks_status_check/);
    // Aditiva: no borra ni reescribe filas (el CHECK se ENSANCHA, no se
    // restringe: las tareas existentes siguen siendo válidas).
    expect(m1).not.toMatch(/DELETE\s+FROM/i);
    expect(m1).not.toMatch(/DROP\s+TABLE/i);
    expect(m1).not.toMatch(/TRUNCATE/i);
  });

  test('M2: RPCs de espera/reactivación con el alcance de la policy leads_update', () => {
    expect(m2).toContain('CREATE OR REPLACE FUNCTION public.lead_pasar_a_espera(');
    expect(m2).toContain('CREATE OR REPLACE FUNCTION public.lead_reactivar(p_lead_id uuid)');
    // SECURITY DEFINER + search_path vacío + sin anon.
    expect(m2).toContain('SECURITY DEFINER');
    expect(m2).toContain("SET search_path = ''");
    expect(m2).toContain('REVOKE ALL ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) FROM PUBLIC, anon;');
    expect(m2).toContain('GRANT EXECUTE ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) TO authenticated, service_role;');
    expect(m2).toContain('REVOKE ALL ON FUNCTION public.lead_reactivar(uuid) FROM PUBLIC, anon;');
    expect(m2).toContain('GRANT EXECUTE ON FUNCTION public.lead_reactivar(uuid) TO authenticated, service_role;');
    // El alcance se replica a mano (SECURITY DEFINER saltea RLS).
    expect(m2).toContain("v_role = 'super_admin'");
    expect(m2).toContain('a.profile_id = v_uid');
    // Sin sesión → error controlado (no crash).
    expect(m2).toContain("jsonb_build_object('error', 'sin sesion')");
    // Un lead terminal no se cuelga ni se reactiva.
    expect(m2).toContain("v_lead.stage::text IN ('cerrado_ganado', 'cerrado_perdido')");
    expect(m2).toContain("v_lead.stage::text <> 'en_espera'");
    // Traza: timeline + audit (helper canónico, no INSERT directo).
    expect(m2).toContain("'Lead en espera'");
    expect(m2).toContain('public.insert_audit_log(');
    expect(m2).toContain("p_action := 'lead_en_espera'");
    expect(m2).toContain("p_action := 'lead_reactivado'");
  });

  test('M2: la bandeja, el badge y el reparto excluyen a los leads colgados', () => {
    // Mi bandeja: las tareas de un lead colgado no son accionables.
    expect(m2).toContain("AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
    // El "sin agente" tampoco reclama leads colgados.
    expect(m2).toContain("AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
    // El badge usa EXACTAMENTE el mismo filtro que la bandeja (badge == bandeja).
    expect(m2).toContain("and l2.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
    expect(m2).toContain("and l4.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
    // El reparto no les asigna carga ni se los adjudica.
    expect(m2).toContain("AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')) AS carga");
    // El badge de tareas vencidas cuenta sólo leads VIVOS (antes contaba 9
    // tareas de leads cerrados y 4 de borrados = 59 % de ruido).
    expect(m2).toMatch(/select count\(\*\) into v_lead_tasks_overdue\s+from public\.lead_tasks t\s+join public\.leads l on l\.id = t\.lead_id/);
    expect(m2).toContain("and l.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
  });

  test('M3: el cast del enum va QUALIFICADO (con search_path vacío no resuelve)', () => {
    // Bug real atrapado por el test en vivo: 42704 type "lead_stage" does not exist.
    expect(m3).toContain("SET stage = v_stage::public.lead_stage,");
    // El tipo corto 'lead_stage' NO puede quedar en el SQL ejecutable.
    const sql = m3.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/v_stage::lead_stage/);
  });

  test('M4: score conservado, fecha de regreso intacta y orden de escrituras', () => {
    // El score de un lead colgado conserva los puntos de su etapa real
    // (OLD.stage ya era 'en_espera' en los updates posteriores → 0 puntos).
    expect(m4).toContain("if v_stage = 'en_espera' and NEW.stage_previo is not null");
    // La fecha de regreso no se pisa cuando se agrega/modifica una tarea.
    expect(m4).toContain("and l.stage::text <> 'en_espera'");
    // Orden de escrituras en lead_pasar_a_espera: tareas → actividad → lead.
    const fn = m4.slice(m4.indexOf('CREATE OR REPLACE FUNCTION public.lead_pasar_a_espera('));
    const iTarea = fn.indexOf("SET status = 'en_espera'");
    const iAct = fn.indexOf("INSERT INTO public.lead_activities");
    const iLead = fn.indexOf("SET stage = 'en_espera'");
    expect(iTarea).toBeGreaterThan(-1);
    expect(iAct).toBeGreaterThan(iTarea);
    expect(iLead).toBeGreaterThan(iAct);
    // Reactivar NO es un contacto con el cliente → activity_type 'status_change'.
    const fnR = m4.slice(m4.indexOf('CREATE OR REPLACE FUNCTION public.lead_reactivar('));
    expect(fnR).toContain("p_lead_id, 'status_change', 'Lead reactivado'");
  });

  test('M5: higiene de followup y de alertas (los 3 efectos que encontró el test en vivo)', () => {
    // BUG 4: la alerta de follow-up vencido ignora a los leads colgados.
    expect(m5).toContain("and l.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
    expect(m5).toContain("or l.stage = 'en_espera'");
    // BUG 5: un contacto posterior NO puede vaciar la fecha de regreso.
    expect(m5).toContain("when stage::text = 'en_espera' then next_followup_at");
    // ...y una red de seguridad a nivel de columna (cualquier vía).
    expect(m5).toContain('trg_leads_espera_keep_followup');
    expect(m5).toContain("NEW.stage::text = 'en_espera'");
    expect(m5).toContain('NEW.next_followup_at := OLD.next_followup_at;');
    // BUG 6: colgar un lead NO es un contacto con el cliente → la actividad
    // es 'status_change' (si fuera 'note', movería last_contacted_at).
    const fn = m5.slice(m5.indexOf('CREATE OR REPLACE FUNCTION public.lead_pasar_a_espera('));
    expect(fn).toContain("p_lead_id, 'status_change', 'Lead en espera'");
    expect(fn).not.toContain("p_lead_id, 'note', 'Lead en espera'");
    // Los grants se mantienen tras el recreate.
    expect(m5).toContain('REVOKE ALL ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) FROM PUBLIC, anon;');
    expect(m5).toContain('GRANT EXECUTE ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) TO authenticated, service_role;');
    // Aditiva.
    expect(m5).not.toMatch(/DELETE\s+FROM/i);
    expect(m5).not.toMatch(/DROP\s+TABLE/i);
  });

  test('M6: la traza de "Lead reactivado" no tiene el typo que traía el repo', () => {
    // El repo tenía "y se reaktivaron sus tareas." (con "k"). El texto se LEE
    // en el timeline del lead: se corrigió con una migración NUEVA (las
    // aplicadas no se editan). Este guard falla si alguien reintroduce el typo.
    expect(m6).toContain('CREATE OR REPLACE FUNCTION public.lead_reactivar(p_lead_id uuid)');
    expect(m6).toContain('y se reactivaron sus tareas.');
    // El SQL EJECUTABLE no puede traer el typo (el comentario que lo explica
    // sí lo nombra).
    const sqlEjecutable = m6.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sqlEjecutable).not.toContain('reaktivaron');
    // Y el resto del cuerpo se mantiene (no se pierde el fix del cast).
    expect(m6).toContain('v_stage::public.lead_stage');
    expect(m6).toContain('UPDATE public.lead_tasks');
    expect(m6).toContain("status = 'pendiente'");
    // Permisos.
    expect(m6).toContain('REVOKE ALL ON FUNCTION public.lead_reactivar(uuid) FROM PUBLIC, anon;');
    expect(m6).toContain('GRANT EXECUTE ON FUNCTION public.lead_reactivar(uuid) TO authenticated, service_role;');
    // La migración que trae el typo original no se edita (queda el fix).
    expect(m4).toContain('reaktivaron');
  });

  test('front CRM: la etapa existe, el panel NO la ofrece y el filtro SÍ', () => {
    expect(crmSrc).toContain("var LEAD_STATUSES_ALL = LEAD_STATUSES.concat(['en_espera']);");
    expect(crmSrc).toContain("en_espera: 'En espera'");
    // El <select> del panel usa el embudo (sin en_espera).
    expect(crmSrc).toContain("var sopts = LEAD_STATUSES.map(function (s)");
    expect(crmSrc).not.toContain("var sopts = LEAD_STATUSES_ALL.map(function (s)");
    // El filtro de estados SÍ la incluye.
    expect(crmSrc).toMatch(/stSel\.innerHTML[\s\S]{0,400}LEAD_STATUSES_ALL\.map/);
    // Con el lead colgado el select se replaces por texto (no se offerce).
    expect(crmSrc).toContain("normalizeStage(lead.stage || 'nuevo') === 'en_espera'");
    // Guardar sin select no debe pisar la etapa con NULL.
    expect(crmSrc).toContain("stage: v('crmDtlStatus') || (lead && lead.stage) || null,");
  });

  test('front CRM: banner, botones y llamadas a las RPCs', () => {
    expect(crmSrc).toContain('function leadEsperaHtml(lead) {');
    expect(crmSrc).toContain('class="crm-espera-banner"');
    expect(crmSrc).toContain('data-crm-reactivar="');
    expect(crmSrc).toContain('data-crm-esperar-dias="1"');
    expect(crmSrc).toContain("db().rpc('lead_pasar_a_espera', { p_lead_id: leadId, p_hasta: hasta })");
    expect(crmSrc).toContain("db().rpc('lead_reactivar', { p_lead_id: leadId })");
    // Exportadas para que otros módulos (agenda) las usen.
    expect(crmSrc).toContain('leadPasarAEspera: leadPasarAEspera');
    expect(crmSrc).toContain('leadReactivar: leadReactivar');
    // Un lead colgado no recibe sugerencias de trabajo ("mandar WhatsApp" etc.).
    expect(crmSrc).toContain("id: 'reactivar', label: 'Reactivar el lead'");
  });

  test('front CRM: Mi bandeja ofrece "Reactivar" en vez de "Marcar contactado"', () => {
    expect(crmSrc).toContain('data-bandeja-reactivar="');
    expect(crmSrc).toContain('async function bandejaReactivar(btn) {');
    expect(crmSrc).toContain("db().rpc('lead_reactivar', { p_lead_id: leadId })");
    expect(crmSrc).toContain('if (rea) { bandejaReactivar(rea); return; }');
  });

  test('los demás módulos conocen la etiqueta (nada de stage crudo en pantalla)', () => {
    expect(appSrc).toContain("'cerrado_perdido', 'en_espera']).default('nuevo')");
    expect(appSrc).toContain("en_espera: 'En espera'");
    // El funnel no pierde al lead colgado: se cuenta en su etapa previa.
    expect(appSrc).toContain("const stageEfectiva = (l) => (l && l.stage === 'en_espera' && l.stage_previo)");
    expect(appSrc).toContain("stage_previo");
    expect(agentesSrc).toContain("en_espera: 'En espera'");
    expect(agendaSrc).toContain("en_espera:'nuevos'");
    expect(tasksSrc).toContain("en_espera:'En espera'");
  });

  test('CSS: la etapa tiene su color y el banner/toolbar tienen estilo', () => {
    expect(cssSrc).toContain('.crm-status-dot--en_espera');
    expect(cssSrc).toContain('.crm-espera-banner');
    expect(cssSrc).toContain('.crm-espera-toolbar');
    expect(cssSrc).toContain('.crm-tl-status--espera');
  });

  test('behavioral: un lead en espera en la bandeja se ofrece con "Reactivar"', () => {
    const from = crmSrc.indexOf('function bandejaWaLink');
    const to = crmSrc.indexOf('async function openBandeja()');
    const escFrom = crmSrc.indexOf('function esc(s) {');
    const escTo = crmSrc.indexOf('function safeCssUrl(u) {');
    const aFrom = crmSrc.indexOf('var AR_MOBILE_AREAS = {');
    const nFrom = crmSrc.indexOf('function normalizeArPhone(phone) {');
    const nTo = crmSrc.indexOf('function waNumber(phone) {');
    const waFrom = crmSrc.indexOf('function waNumber(phone) {');
    const waTo = crmSrc.indexOf('function telNumber(phone) {');
    expect(from).toBeGreaterThan(-1);
    const sandbox = {
      STATUS_LABELS: { nuevo: 'Nuevo', contactado: 'Contactado', en_espera: 'En espera' },
      ORIGIN_LABELS: { ml: 'Mercado Libre' },
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

    // 1) Lead en espera (volvió su fecha de regreso) → "Reactivar", NO
    //    "Marcar contactado" (reactivarlo es lo que lo devuelve al embudo).
    const espera = item('seguimiento', {
      lead_id: 'uuid-espera', nombre: 'Ana Pérez', stage: 'en_espera', espera: true,
      source: 'ml', telefono: '+54 9 351 555-1234', mios: true,
      vence: '2026-12-04T14:00:00Z',
    }, true);
    expect(espera).toContain('data-bandeja-reactivar="uuid-espera"');
    expect(espera).not.toContain('data-bandeja-contactado');
    expect(espera).toContain('En espera');
    expect(espera).toContain('vuelve fecha 2026-12-04');

    // 2) Un lead normal sigue con "Marcar contactado" (no se rompió el flujo).
    const normal = item('seguimiento', {
      lead_id: 'uuid-2', nombre: 'Beto', stage: 'contactado', source: 'ml',
      telefono: '3515551234', mios: true,
    }, true);
    expect(normal).toContain('data-bandeja-contactado="uuid-2"');
    expect(normal).not.toContain('data-bandeja-reactivar');
  });
});
