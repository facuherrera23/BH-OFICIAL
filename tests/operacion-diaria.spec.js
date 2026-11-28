// OPERACIÓN DIARIA — 4 mejoras aprobadas 28/11/2026.
//
// 1) "Mi día" accionable en el Dashboard (misma RPC y mismas acciones del CRM,
//    con p_solo_propio=true: en un equipo de dos super_admin la visión global
//    no sirve para "qué hago YO").
// 2) Motivo de pérdida obligatorio: el panel lateral y el Dashboard ya no
//    dejan pasar un lead cerrado_perdido sin razón (35 en producción).
// 3) Reparto de huérfanos con vista previa real (ver reparto-leads.spec.js).
// 4) Alertas → tareas del CRM, con el bug de `updated_at` arreglado.
//
// Los guards son estáticos a propósito: los módulos del admin corren en
// `'use strict'` y los errores de runtime se tragan en los catch. El guard
// conductual de undeclared-vars (tests/helpers/audit-undeclared.cjs) corre
// sobre TODO el repo en la suite general.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('admin.html');
const app = read('assets/js/admin-app.js');
const crm = read('assets/js/admin-crm.js');
const sup = read('assets/js/admin-supervision.js');

test.describe('Operación diaria — Mi día en el Dashboard', () => {
  test('el panel existe y su botón abre la bandeja completa del CRM', () => {
    expect(html).toContain('id="dashMiDiaPanel"');
    expect(html).toContain('id="dashMiDiaBody"');
    expect(html).toContain('id="dashMiDiaSub"');
    expect(html).toContain('data-action="openMiDiaPanel"');
    expect(app).toContain('window.adminApp.openMiDiaPanel = function () {');
    expect(app).toContain("window.BH_CRM.openMiDia === 'function'");
    // No se implementa un nuevo flujo: se delega en el CRM.
    expect(app).toContain('window.BH_CRM.mountMiDiaPanel(body, $(\'#dashMiDiaSub\'))');
  });

  test('loadDashboard lo monta fuera del try general (fallo aislado)', () => {
    expect(app).toContain('renderDashMiDia();');
    const load = app.slice(app.indexOf('async function loadDashboard()'), app.indexOf('async function loadDashboard()') + 1500);
    expect(load).toContain('renderDashAlquileres();');
    expect(load).toContain('renderDashMiDia();');
    expect(load.indexOf('renderDashMiDia();')).toBeLessThan(load.indexOf('try {'));
  });

  test('la RPC se llama con p_solo_propio=true y conserva el default global', () => {
    expect(crm).toContain('async function miDiaRender(body, sub, soloPropio)');
    expect(crm).toContain("db().rpc('mi_dia', soloPropio ? { p_solo_propio: true } : {})");
    expect(crm).toContain('async function mountMiDiaPanel(el, subExterno)');
    expect(crm).toContain('bindMiDiaActions(body, { body: body, sub: sub, soloPropio: true, cerrar: null })');
    // El overlay de la bandeja NO cambia: sigue con visión global.
    expect(crm).toContain('await miDiaRender(body, sub, false);');
    expect(crm).toContain('mountMiDiaPanel: mountMiDiaPanel');
    // Las acciones (contactar / tarea / reactivar) pasan el mismo scope.
    expect(crm).toContain('miDiaMarcarContactado(contactado, ctx.body, ctx.sub, ctx.soloPropio, render)');
    expect(crm).toContain('miDiaCompletarTarea(tarea, ctx.body, ctx.sub, ctx.soloPropio, render)');
    expect(crm).toContain('render(ctx.body, ctx.sub, ctx.soloPropio).then');
  });
});

test.describe('Operación diaria — motivo de pérdida', () => {
  test('el Dashboard muestra "sin motivo" en vez de ocultarlo', () => {
    const fn = app.slice(app.indexOf('async function renderDashLostReasons()'), app.indexOf('async function renderDashLostReasons()') + 6000);
    expect(fn).not.toContain(".not('lost_reason', 'is', null)");
    expect(fn).toContain("const k = r.lost_reason || 'sin_motivo'");
    expect(fn).toContain("sin_motivo: 'Sin motivo'");
    expect(fn).toContain('data-lost-fijar');
    expect(fn).toContain("window.BH_CRM.showLostReasonModal()");
    expect(fn).toContain("window.BH_CRM.setLostReason(btn.getAttribute('data-lost-fijar'), lost)");
  });

  test('el panel lateral también pide el motivo al editar un lead ya perdido', () => {
    expect(crm).toContain('async function setLostReason(leadId, lost)');
    expect(crm).toContain("eq('id', leadId)");
    expect(crm).toContain("setLostReason: setLostReason");
    expect(crm).toContain("showLostReasonModal: showLostReasonModal");
    const side = crm.slice(crm.indexOf('function bindSideSave('), crm.indexOf('function bindSideSave(') + 5000);
    expect(side).toContain("normalizeStage(d.stage) === 'cerrado_perdido' && !lead.lost_reason");
  });
});

test.describe('Operación diaria — alertas de supervisión', () => {
  test('Reconocer/Resolver usa columnas reales (NO updated_at)', () => {
    const fn = sup.slice(sup.indexOf('async function updateAlertStatus'), sup.indexOf('async function updateAlertStatus') + 1200);
    expect(fn).not.toContain('updated_at');
    expect(fn).toContain('var patch = { status: newStatus };');
    expect(fn).toContain('patch.acknowledged_at = now');
    expect(fn).toContain('patch.resolved_at = now');
    expect(fn).toContain('patch.dismissed_at = now');
    expect(fn).toMatch(/supervision_alerts'\)\.update\(patch\)/);
  });

  test('Convertir en tarea reusa lead_tasks y es idempotente', () => {
    expect(sup).toContain('async function alertToTask(alert)');
    expect(sup).toContain("var marca = '[alert:' + alert.id + ']'");
    expect(sup).toContain("from('lead_tasks').select('id').eq('lead_id', leadId).like('description', '%' + marca + '%')");
    expect(sup).toContain("from('lead_tasks').insert([{");
    expect(sup).toContain("status: 'pendiente'");
    expect(sup).toContain('assigned_to: ev.assigned_to || null');
    expect(sup).toContain('due_at: due');
    expect(sup).toContain("status: 'assigned'");
    expect(sup).toContain("'Convertida en tarea '");
    expect(sup).toContain('sup-alert-task');
    expect(sup).toContain('var taskBtn = ev.target.closest(\'.sup-alert-task\')');
    // Sin onclick inline (CSP) y con feedback visible.
    expect(sup).toContain("window.__BH.showToast('Tarea creada en el CRM desde la alerta.'");
  });
});

test.describe('Operación diaria — backfill guiado de motivos (28/11)', () => {
  const backfillSql = read('supabase/migrations/20261128000011_backfill_motivos.sql');

  test('la RPC es SÓLO LECTURA: sugiere desde el timeline y no escribe', () => {
    expect(backfillSql).toContain(
      'CREATE OR REPLACE FUNCTION public.crm_motivos_pendientes(p_limit integer DEFAULT 50)',
    );
    expect(backfillSql).toContain("SET search_path = ''");
    expect(backfillSql).toContain(
      'REVOKE ALL ON FUNCTION public.crm_motivos_pendientes(integer) FROM PUBLIC, anon;',
    );
    expect(backfillSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.crm_motivos_pendientes(integer) TO authenticated, service_role;',
    );
    const sql = backfillSql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/);
    expect(sql).not.toMatch(/\bUPDATE\b/);
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).toContain("'sugerido'");
    expect(sql).toContain("'indicio'");
    expect(sql).toContain('ORDER BY la.created_at DESC');
  });

  test('el Dashboard ofrece el backfill y el overlay confirma antes de escribir', () => {
    const fn = app.slice(app.indexOf('async function renderDashLostReasons()'), app.indexOf('async function renderDashLostReasons()') + 6000);
    expect(fn).toContain('data-lost-backfill');
    expect(fn).toContain('window.BH_CRM.openLostReasonBackfill');
    expect(fn).toContain('await renderDashLostReasons()');

    expect(crm).toContain('async function openLostReasonBackfill()');
    expect(crm).toContain("db().rpc('crm_motivos_pendientes', { p_limit: 50 })");
    expect(crm).toContain('openLostReasonBackfill: openLostReasonBackfill');
    const bf = crm.slice(crm.indexOf('async function openLostReasonBackfill()'), crm.indexOf('function bindLeadTaskForm('));
    expect(bf).toContain('LOST_REASON_LABELS[x.sugerido]');
    expect(bf).toContain("var pick = LOST_REASON_LABELS[x.sugerido] ? x.sugerido : 'otro';");
    expect(bf).toContain("opciones.replace('value=\"' + esc(pick) + '\"'");
    expect(bf).toContain('data-bf-check');
    expect(bf).toContain('await setLostReason(id,'); // reutiliza el camino del modal
    expect(bf).toContain('window.__BH && window.__BH.showConfirmDialog');
    expect(bf).not.toContain('window.showConfirmDialog'); // no es global
    expect(bf).not.toMatch(/[^.]\bconfirm\(/); // ni confirm() nativo
  });
});

test.describe('Operación diaria — encuesta post-visita automática (28/11)', () => {
  const agenda = read('assets/js/admin-agenda.js');
  const encuestaSql = read('supabase/migrations/20261128000012_encuesta_ciclo_cerrado.sql');

  test('el check-out y el panel envían sin pedir confirm', () => {
    const ofrecer = crm.slice(crm.indexOf('async function offerSurveyAfterVisit('), crm.indexOf('/* ── Encuesta de visita'));
    expect(ofrecer).not.toContain('showConfirmDialog');
    expect(ofrecer).not.toContain('confirm(');
    expect(ofrecer).toContain('sendSurveyForProperty(lead, vr.data.property_id');
    expect(ofrecer).toContain('openEarly');

    const checkout = agenda.slice(agenda.indexOf('window.adminApp.checkoutVisit'), agenda.indexOf('function remindUpcomingVisits'));
    expect(checkout).not.toContain('¿Enviar encuesta?');
    expect(checkout).toContain('window.BH_CRM.sendSurvey(');
    expect(checkout).toContain('true /* abre la pestaña antes de los awaits (popup blocker) */');
  });

  test('la pestaña se abre ANTES del primer await y el link nunca se pierde', () => {
    const fn = crm.slice(crm.indexOf('async function sendSurveyForProperty('), crm.indexOf('/* Actualiza el estado del chip'));
    const apertura = fn.indexOf("window.open('about:blank'");
    const primerAwait = fn.indexOf('await ensureSurveyToken');
    expect(apertura).toBeGreaterThan(-1);
    expect(apertura).toBeLessThan(primerAwait);
    expect(fn).toContain('popup.location.replace(url)');
    expect(fn).toContain('Pegalo en el chat del lead');
    expect((fn.match(/popup\.close\(\)/g) || []).length).toBe(3); // finalizada, sin WhatsApp y error
    // El botón manual NO pide apertura temprana (no hay doble pestaña).
    expect(crm).toContain('sendSurveyForProperty(lead, propId, propTitle, panel);');
  });

  test('el cron cierra el ciclo de las encuestas que nadie respondió', () => {
    expect(encuestaSql).toContain("interval '96 hours'");
    expect(encuestaSql).toContain("interval '7 days'");
    expect(encuestaSql).toContain('SET finalized = true');
  });
});

test.describe('Operación diaria — mejoras 4 y 5 del diagnóstico en frío (28/11)', () => {
  const escalado = read('supabase/migrations/20261128000015_escalado_visible.sql');
  const score = read('supabase/migrations/20261128000016_encuesta_score.sql');

  test('escalado visible: nota en el timeline y aviso al dueño (misma firma)', () => {
    expect(escalado).toMatch(
      /CREATE OR REPLACE FUNCTION public\.crm_escalar_tareas_vencidas\(\s*p_dias integer DEFAULT 7,\s*p_dry_run boolean DEFAULT false\s*\)/,
    );
    expect(escalado).not.toMatch(/DROP\s+FUNCTION/);
    // Dueño = super_admin activo; la alerta se le asigna a él (no al agente,
    // que no tiene acceso al Centro de Supervisión).
    expect(escalado).toMatch(/p\.role::text = 'super_admin' AND p\.is_active = true/);
    expect(escalado).toContain('COALESCE(v_owner, r.task_agent, r.lead_agent)');
    expect(escalado).toContain("'owner_notified', (v_owner IS NOT NULL)::text");
    expect(escalado).toContain('Aviso al dueño del agente:');
    expect(escalado).toContain('notes'); // supervision_alerts.notes (columna real)
    // Traza en el timeline, con dedup por tarea para no repetir notas.
    expect(escalado).toContain("'Tarea escalada automáticamente'");
    expect(escalado).toMatch(/la\.description LIKE '%' \|\| r\.task_id::text \|\| '%'/);
    // p_dry_run cuenta sin escribir nada (ni alertas ni notas).
    expect(escalado).toMatch(/IF NOT COALESCE\(p_dry_run, false\) THEN/);
    // El chip ya existe en Mi día: el escalado deja de ser invisible.
    expect(crm).toContain("Number(c.escaladas) + ' escaladas (&gt;7d)");
  });

  test('score de encuesta en lead_activities sin tocar las keys de answers', () => {
    // Misma firma en los dos RPC (sin sobrecargas ni DROP).
    expect(score).toContain('CREATE OR REPLACE FUNCTION public.survey_submit_by_token(p_token text, p_answers jsonb, p_finalize boolean DEFAULT false)');
    expect(score).toContain('CREATE OR REPLACE FUNCTION public.survey_pending_reminders(p_dry_run boolean DEFAULT false)');
    expect(score).not.toMatch(/DROP\s+FUNCTION/);
    // Score = promedio de los 5 sliders, leído de answers, NUNCA escrito en él.
    expect(score).toContain("ARRAY['ubicacion','superficie','distribucion','conservacion','general']");
    expect(score).toMatch(/round\(avg\(\(v_merged ->> s\.k\)::numeric\)\)::int INTO v_score/);
    expect(score).toMatch(/round\(avg\(\(r\.answers ->> s\.k\)::numeric\)\)::int INTO v_score/);
    expect(score).not.toContain("jsonb_build_object('score'");
    expect(score).not.toMatch(/answers\s*=\s*[^;]*score/i);
    // Se escribe SOLO en la nota del timeline (finalización, parcial y cierre).
    expect(score).toContain("'Score: ' || v_score || '/10");
    expect(score).toContain("'Encuesta cerrada sin respuesta'");
    expect(score).toContain("'Se enviaron 2 recordatorios para ' || v_prop");
    // El cierre automático con dry_run sigue sin escribir.
    expect(score).toContain('IF NOT COALESCE(p_dry_run, false) THEN');
  });
});
