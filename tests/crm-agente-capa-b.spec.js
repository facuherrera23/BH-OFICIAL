// Guard de la Capa B (28/11/2026), pedida por el dueño sobre herramientas del agente:
//   2) Buscador anti-duplicados: señal inline apoyada en leads_duplicados() que
//      abre el overlay de fusión existente (NO reimplementa la fusión).
//   4) Plantillas por etapa: la plantilla WhatsApp sugerida depende del stage.
//   5) Handoff entre agentes: pase con nota + tareas abiertas + traza.
//
// Sin RPC ni migración nueva. Los behavioral corren el admin-crm.js REAL
// contra el harness con Supabase falso (tests/helpers/crm-lead-panel-harness.html).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const crmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

async function abrirHarness(page) {
  const errores = [];
  page.on('pageerror', e => errores.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  await page.goto('/tests/helpers/crm-lead-panel-harness.html');
  await page.waitForFunction(() => window.__HARNESS_READY === true);
  await page.evaluate(() => window.initCrm());
  return errores;
}

test.describe('CRM — mejoras del agente (Capa B)', () => {
  test('buscador anti-duplicados reutiliza leads_duplicados() y el overlay existente', () => {
    expect(adminHtml).toContain('id="crmDupHint"');
    expect(crmSrc).toContain('actualizarDupHint();  /* Capa B');
    expect(crmSrc).toContain("db().rpc('leads_duplicados')");
    expect(crmSrc).toContain('data-dup-hint-open');
    expect(crmSrc).toContain("if (e.target.closest('[data-dup-hint-open]')) openDuplicados();");
    // La fusión sigue viviendo en un solo lugar (el overlay de duplicados).
    // El marker va sin \n: admin-crm.js usa CRLF en disco.
    const hintFn = crmSrc.slice(crmSrc.indexOf('async function actualizarDupHint'), crmSrc.indexOf('DUPLICADOS (2026-11-26):'));
    expect(hintFn).not.toContain("rpc('fusionar_leads'");
    expect(hintFn).not.toContain("from('leads').update");
  });

  test('plantilla WhatsApp sugerida según etapa, sin escribir en la conversación', () => {
    expect(crmSrc).toContain('var STAGE_TEMPLATE = {');
    for (const [k, v] of Object.entries({
      nuevo: 'primer_contacto', contactado: 'seguimiento', calificado: 'compartir_ficha',
      visita_agendada: 'visita_propuesta', visita_realizada: 'post_visita',
      negociacion: 'seguimiento', cerrado_ganado: '', cerrado_perdido: ''
    })) {
      expect(crmSrc).toContain(k + ": '" + v + "'");
    }
    expect(crmSrc).toContain("STAGE_TEMPLATE[normalizeStage(lead.stage || 'nuevo')]");
    expect(crmSrc).toContain("(según etapa)");
    // Es sólo una sugerencia del selector: el botón sigue usando la elección del agente.
    expect(crmSrc).toContain("var tpl = WA_TEMPLATES.filter(function (t) { return t.id === sel.value; })[0]");
  });

  test('handoff: gate super_admin, lead primero, tareas abiertas y traza', () => {
    expect(crmSrc).toContain('id="crmHandoffBtn"');
    expect(crmSrc).toContain(".role === 'super_admin')");
    expect(crmSrc).toContain("HANDOFF_TASK_STATUSES = ['pendiente', 'en_progreso', 'en_espera']");
    expect(crmSrc).toContain("title: 'Handoff de ' + quien + ' a ' + destino.full_name");
    // _agents ya viene filtrado por loadAgents(): no se puede chequear
    // deleted_at en el destino porque ese campo NO está en el select.
    const abrirFn = crmSrc.slice(crmSrc.indexOf('function openHandoff('), crmSrc.indexOf('async function handoffLead'));
    expect(abrirFn).not.toContain('deleted_at');
    const fn = crmSrc.slice(crmSrc.indexOf('async function handoffLead'), crmSrc.indexOf('/* Modal selector de propiedad'));
    const iLead = fn.indexOf("from('leads').update");
    const iTasks = fn.indexOf("from('lead_tasks').update");
    const iNote = fn.indexOf("from('lead_activities').insert");
    expect(iLead).toBeGreaterThan(-1);
    expect(iTasks).toBeGreaterThan(iLead);
    expect(iNote).toBeGreaterThan(iTasks);
    // 0 filas por RLS se detecta (no se mueve nada en silencio).
    expect(fn).toContain("!upd.data || !upd.data.length");
    expect(fn).not.toContain('rpc(');
  });

  test('behavioral: el hint aparece en la búsqueda y abre la fusión existente', async ({ page }) => {
    const errores = await abrirHarness(page);
    await page.evaluate(async () => {
      document.getElementById('crmSearch').value = 'Lead';
      await window.BH_CRM.refresh();
    });
    await page.waitForFunction(() => {
      const h = document.getElementById('crmDupHint');
      return h && h.style.display !== 'none' && h.textContent.indexOf('mismo email o teléfono') !== -1;
    }, { timeout: 10000 });
    const hint = await page.evaluate(() => ({
      texto: document.getElementById('crmDupHint').textContent,
      boton: !!document.querySelector('#crmDupHint [data-dup-hint-open]')
    }));
    expect(hint.texto).toContain('2 de los contactos');
    expect(hint.boton).toBe(true);
    await page.click('#crmDupHint [data-dup-hint-open]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-dup-body]');
      return !!b && b.querySelectorAll('input[type="radio"]').length === 2;
    }, { timeout: 10000 });
    expect(errores).toEqual([]);
  });

  test('behavioral: plantilla por etapa y handoff con nota, tarea y traza', async ({ page }) => {
    const errores = await abrirHarness(page);
    // 'calificado' → compartir_ficha (seleccionada, marcada como sugerencia).
    await page.evaluate(() => window.BH_CRM.open('22222222-2222-2222-2222-222222222222'));
    await page.waitForFunction(() => !!document.querySelector('#crmMsgTemplate'));
    let tpl = await page.evaluate(() => {
      const s = document.getElementById('crmMsgTemplate');
      return { value: s.value, label: s.selectedOptions[0].textContent, handoff: !!document.querySelector('#crmHandoffBtn') };
    });
    expect(tpl).toEqual({ value: 'compartir_ficha', label: 'Compartir ficha (según etapa)', handoff: true });

    await page.click('#crmHandoffBtn');
    await page.waitForFunction(() => !!document.querySelector('[data-handoff-submit]'));
    await page.evaluate(() => {
      document.getElementById('handoffAgent').value = 'agente-2';
      document.getElementById('handoffNote').value = 'Hablamos, quiere verla el sábado.';
    });
    await page.click('[data-handoff-submit]');
    await page.waitForFunction(() => !document.querySelector('[data-handoff-submit]'));

    const estado = await page.evaluate(() => {
      const log = window.__HARNESS_LOG || [];
      return {
        leadUpdate: log.filter(x => x.op === 'update' && x.table === 'leads' && x.payload && x.payload.assigned_to === 'agente-2'),
        taskUpdate: log.filter(x => x.op === 'update' && x.table === 'lead_tasks' && x.payload && x.payload.assigned_to === 'agente-2'),
        nota: log.filter(x => x.op === 'insert' && x.table === 'lead_activities' && x.payload && x.payload[0] && String(x.payload[0].title).indexOf('Handoff de') === 0),
        lead: (window.__FAKE_PG.store().leads || []).filter(l => l.id === '22222222-2222-2222-2222-222222222222')[0]
      };
    });
    expect(estado.leadUpdate.length).toBe(1);
    expect(estado.taskUpdate.length).toBe(1);
    expect(estado.nota.length).toBe(1);
    expect(estado.nota[0].payload[0].description).toContain('Hablamos, quiere verla el sábado.');
    expect(estado.nota[0].payload[0].description).toContain('Tareas abiertas pasadas a Agente Dos: 1.');
    expect(estado.lead.assigned_to).toBe('agente-2');
    expect(errores).toEqual([]);
  });
});
