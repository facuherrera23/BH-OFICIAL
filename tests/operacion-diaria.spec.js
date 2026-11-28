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
    expect(crm).toContain('miDiaMarcarContactado(contactado, ctx.body, ctx.sub, ctx.soloPropio)');
    expect(crm).toContain('miDiaCompletarTarea(tarea, ctx.body, ctx.sub, ctx.soloPropio)');
    expect(crm).toContain('miDiaRender(ctx.body, ctx.sub, ctx.soloPropio).then');
  });
});

test.describe('Operación diaria — motivo de pérdida', () => {
  test('el Dashboard muestra "sin motivo" en vez de ocultarlo', () => {
    const fn = app.slice(app.indexOf('async function renderDashLostReasons()'), app.indexOf('async function renderDashLostReasons()') + 4200);
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
