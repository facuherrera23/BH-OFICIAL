// SIGUIENTE MEJOR ACCIÓN (2026-11-26): tarjeta al tope de la ficha del lead.
//
// No inventa flujos nuevos: sugiere lo que corresponde según los datos del
// lead (dueño, tareas, origen ML, contacto, visita próxima, propiedades) y
// cada botón ejecuta un flujo que ya existía (WhatsApp, openVisitModal,
// CrTasks.showTaskForm, markLeadContacted, asignación, sugerencias).
//
// Prioridad (de siguientesAccionesDe): sin dueño → tarea vencida →
// ML sin responder → sin contacto → visita próxima → contacto viejo
// → sugerencias → tarea nueva.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const crmSrc = read('assets/js/admin-crm.js');
const cssSrc = read('assets/css/admin.css');

test.describe('Siguiente mejor acción en la ficha del lead', () => {
  test('la tarjeta vive al tope del panel y se cablea una sola vez', () => {
    expect(crmSrc).toContain('function siguientesAccionesDe(lead, props, visits, tasks) {');
    // El panel la inyecta ANTES de Contacto (al tope) y el binding es delegado.
    expect(crmSrc).toMatch(/'<div class="crm-side-body">' \+\s*\n\s*accionesHtml \+/);
    expect(crmSrc).toContain('function bindSiguientesAcciones(panel, lead) {');
    expect(crmSrc).toContain('bindSiguientesAcciones(panel, lead);');
    // Guard anti-doble-binding.
    expect(crmSrc).toContain('if (!wrap || wrap.dataset.sigBound) return;');
    // CSS del flash al ir a las sugerencias.
    expect(cssSrc).toContain('.crm-sig-flash');
  });

  test('cada acción ejecuta un flujo EXISTENTE (no duplica lógica)', () => {
    // WhatsApp: mismo canal del panel (wa.me) + log de actividad.
    expect(crmSrc).toContain("window.open('https://wa.me/' + wa + '?text=' + encodeURIComponent(text), '_blank', 'noopener');");
    // Visita: el modal de la agenda con el lead pre-cargado.
    expect(crmSrc).toContain('window.adminApp.openVisitModal({');
    expect(crmSrc).toMatch(/lead_id: lead\.id,\s*\n\s*client_name: lead\.full_name \|\| ''/);
    // Tareas: el formulario rápido del módulo de tareas (sin duplicar inserts).
    expect(crmSrc).toContain('window.CrmTasks.showTaskForm(lead.id, btn.getAttribute(\'data-sig-tarea\'), panel)');
    expect(crmSrc).toContain('window.CrmTasks.showTaskForm(lead.id, null, panel)');
    // Contactado: el punto ÚNICO del CRM (contacto + cierra tarea SLA + followup).
    expect(crmSrc).toContain("await markLeadContacted(lead.id, lead.stage === 'nuevo' ? { stage: 'contactado' } : null);");
    // Asignarme: la MISMA validación de agente activo que el resto del CRM.
    expect(crmSrc).toMatch(/\.eq\('profile_id', uid\)\.eq\('status', 'activo'\)\.is\('deleted_at', null\)\.maybeSingle\(\)/);
  });

  test('behavioral: la prioridad de las sugerencias es la documentada', () => {
    const from = crmSrc.indexOf('function siguientesAccionesDe(lead, props, visits, tasks) {');
    const to = crmSrc.indexOf('/* Render de la tarjeta:');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const sandbox = {
      waNumber: () => '5493515551234',
      fmtDateTime: () => 'fecha',
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(crmSrc.slice(from, to), sandbox);
    const f = sandbox.siguientesAccionesDe;
    const futura = new Date(Date.now() + 3600000).toISOString();
    const vencida = new Date(Date.now() - 86400000).toISOString();

    // 1) Sin dueño → la acción #1 es Asignármelo.
    const sinAgente = f({ stage: 'nuevo', source: 'ml' }, [], [], []);
    expect(sinAgente[0].id).toBe('asignarme');

    // 2) Con dueño y tarea vencida → la tarea vencida.
    const conTarea = f({ assigned_to: 'a', stage: 'contactado', source: 'ml' }, [], [], [{ id: 't1', title: 'Llamar', status: 'pendiente', due_at: vencida }]);
    expect(conTarea[0].id).toBe('tarea');
    expect(conTarea[0].label).toContain('Tarea vencida');
    expect(conTarea[0].tareaId).toBe('t1');

    // 3) ML sin responder → WhatsApp como primer contacto.
    const ml = f({ assigned_to: 'a', stage: 'nuevo', source: 'ml' }, [], [], []);
    expect(ml.some((a) => a.id === 'whatsapp' && a.razon.toLowerCase().includes('fuga'))).toBe(true);

    // 4) Visita próxima (sin tarea) → confirmar la visita.
    const visita = f({ assigned_to: 'a', stage: 'visita_agendada', source: 'ml', last_contacted_at: new Date().toISOString() }, [], [{ status: 'confirmada', visit_date: futura }], []);
    expect(visita.some((a) => a.id === 'whatsapp' && a.label.indexOf('Confirmar la visita') === 0)).toBe(true);

    // 5) Contacto viejo (>7 días) → seguimiento.
    const viejo = f({ assigned_to: 'a', stage: 'contactado', source: 'manual', last_contacted_at: new Date(Date.now() - 9 * 86400000).toISOString() }, [], [], []);
    expect(viejo.some((a) => a.label.indexOf('Sin contacto hace 9 días') === 0)).toBe(true);

    // 6) Sin propiedades vinculadas → sugerencias/vincular.
    const sinProps = f({ assigned_to: 'a', stage: 'contactado', source: 'manual', last_contacted_at: new Date().toISOString(), preferred_zone: 'Nueva Córdoba' }, [], [], []);
    expect(sinProps.some((a) => a.id === 'sugerencias')).toBe(true);

    // 7) Sin nada pendiente → crear tarea de seguimiento.
    const frio = f({ assigned_to: 'a', stage: 'contactado', source: 'manual', last_contacted_at: new Date().toISOString() }, [{ property_id: 'p' }], [], []);
    expect(frio.some((a) => a.id === 'tarea_nueva')).toBe(true);

    // 8) Máximo 3 acciones.
    const muchas = f({ stage: 'nuevo', source: 'ml', preferred_zone: 'Centro' }, [], [{ status: 'confirmada', visit_date: futura }], [{ id: 't1', title: 'X', status: 'pendiente', due_at: vencida }]);
    expect(muchas.length).toBeLessThanOrEqual(3);
    expect(muchas.length).toBe(3);

    // 9) Lead inexistente → sin acciones (sin crash).
    expect(f(null, [], [], [])).toEqual([]);
  });
});
