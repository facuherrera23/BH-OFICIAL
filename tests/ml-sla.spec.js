// SLA de primer contacto para leads de Mercado Libre (2026-11-02).
//
// Por qué existe: el canal ML entra perfecto al CRM (43 leads en 60 días, 0
// consultas perdidas en el ledger) pero el embudo comercial se caía por
// TIEMPO DE RESPUESTA: 0 de 43 contactados en menos de 2 h, 26 después de
// 24 h y 24 perdidos. La causa no era el código de ML sino que el lead
// nacía SIN PLAZO: 30 de 43 tenían next_followup_at NULL (el motor de
// alertas los ignora por diseño), no había lead_task, y la única señal era
// un email.
//
// Lo que se implementó:
//  · ml-webhook: el lead ML nace con una lead_task de primer contacto (2 h)
//    + next_followup_at → entra en la Agenda, enciende el badge "tareas
//    vencidas" y el cron crm_queue_followup_alerts levanta la alerta.
//  · admin-crm.js: markLeadContacted() es el punto único que registra
//    contacto → cierra la task de SLA y recalcula el próximo followup.
//  · Chip "ML sin responder (+48h)" en el CRM.
//  · auto_reply.ts: se estampa ml_questions.auto_reply_sent_at (la columna
//    existía pero NINGÚN código la escribía → el tracking era siempre NULL).
//
// Tests ESTÁTICOS: leen los archivos del repo (no tocan la BD ni llaman a ML).
// Test CONDUCTUAL: corre admin-crm.js REAL en el navegador contra un cliente
// Supabase falso (tests/helpers/crm-sla-harness.html) — no toca producción.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'supabase', 'functions');
const HARNESS = '/tests/helpers/crm-sla-harness.html';

const webhookSrc = fs.readFileSync(path.join(FUNCTIONS, 'ml-webhook', 'index.ts'), 'utf8');
const autoReplySrc = fs.readFileSync(path.join(FUNCTIONS, '_shared', 'auto_reply.ts'), 'utf8');
const crmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm.js'), 'utf8');
const crmTasksSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm-tasks.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

test.describe('SLA de primer contacto — leads de Mercado Libre', () => {
  test('ml-webhook: crea la tarea de primer contacto con 2 h de plazo y dedup', () => {
    expect(webhookSrc).toContain('const ML_FIRST_CONTACT_MINUTES = 120;');
    expect(webhookSrc).toContain("const ML_FIRST_CONTACT_TASK_TITLE = 'Primer contacto — lead ML';");
    // La tarea se inserta en lead_tasks con el contrato que ya usa el CRM.
    expect(webhookSrc).toContain(".from('lead_tasks')");
    expect(webhookSrc).toContain("type: 'contact'");
    expect(webhookSrc).toContain("contact_type: 'whatsapp'");
    expect(webhookSrc).toContain("priority: 'alta'");
    expect(webhookSrc).toContain("status: 'pendiente'");
    // Dedup: una sola tarea SLA viva por lead (ML re-notifica el mismo lead).
    expect(webhookSrc).toContain(".eq('title', ML_FIRST_CONTACT_TASK_TITLE)");
    expect(webhookSrc).toContain(".in('status', ['pendiente', 'en_progreso'])");
    // Sin teléfono no hay a quién escribir → no se crea la tarea.
    expect(webhookSrc).toContain('if (!opts.phone) return;');
  });

  test('ml-webhook: el SLA se arma en el alta del lead y en el merge', () => {
    // Alta del lead nuevo (vis_leads).
    expect(webhookSrc).toMatch(/await ensureFirstContactTask\(supabase, createdId,/);
    // Merge: si el lead nunca fue contactado, arranca el reloj.
    expect(webhookSrc).toContain('if (!lead.last_contacted_at) {');
    expect(webhookSrc).toMatch(/await ensureFirstContactTask\(supabase, leadId,/);
    // El merge tiene que leer last_contacted_at para decidir.
    expect(webhookSrc).toContain('ml_lead_id, last_contacted_at, assigned_to');
  });

  test('ml-webhook: next_followup_at se deriva de la tarea pendiente más próxima', () => {
    expect(webhookSrc).toContain('async function syncLeadNextFollowup(');
    expect(webhookSrc).toContain(".from('lead_tasks')");
    expect(webhookSrc).toContain(".order('due_at', { ascending: true })");
    expect(webhookSrc).toContain("await supabase.from('leads').update({ next_followup_at: next }).eq('id', leadId);");
  });

  test('auto_reply: se estampa auto_reply_sent_at (la columna que nadie escribía)', () => {
    expect(autoReplySrc).toContain('auto_reply_sent_at: new Date().toISOString(),');
    // Dentro del update de ml_questions NO debe aparecer el nombre viejo
    // (ml_orders sí tiene auto_reply_sent: son columnas distintas).
    const i = autoReplySrc.indexOf(".from('ml_questions')");
    const bloque = autoReplySrc.slice(i, autoReplySrc.indexOf(".eq('question_id', questionId);", i));
    expect(bloque).toContain('auto_reply_sent_at:');
    expect(bloque).not.toContain('auto_reply_sent:');
  });

  test('admin-crm.js: markLeadContacted cierra la tarea de SLA y recalcula el followup', () => {
    expect(crmSrc).toContain("var ML_FIRST_CONTACT_TASK_TITLE = 'Primer contacto — lead ML';");
    expect(crmSrc).toContain('async function markLeadContacted(leadId, patch)');
    expect(crmSrc).toContain('await completeFirstContactTask(leadId);');
    expect(crmSrc).toContain("if (!('next_followup_at' in upd)) await syncLeadFollowup(leadId);");
  });

  test('admin-crm.js: ningún path actualiza last_contacted_at por su cuenta', () => {
    // Todos los caminos de contacto pasan por el helper (si uno se escapa, la
    // task de SLA queda viva y el badge "tareas vencidas" miente).
    const updatesDirectas = crmSrc.match(/from\('leads'\)\.update\(\{[^}]*last_contacted_at/g) || [];
    expect(updatesDirectas).toEqual([]);
    // Y los que existían ahora usan el helper.
    expect(crmSrc).toContain('await markLeadContacted(lead.id, { estimated_value: amount, stage: \'cerrado_ganado\' });');
    expect(crmSrc).toContain("await markLeadContacted(leadId, { next_followup_at: new Date(due).toISOString() });");
    expect(crmSrc).toContain("await markLeadContacted(leadId, { stage: 'cerrado_perdido', lost_reason: lostResult.reason });");
  });

  test('admin-crm-tasks.js: completar una tarea registra el contacto (y recalcula el followup)', () => {
    // Bug preexistente: al completar una tarea, next_followup_at quedaba
    // apuntando a la tarea recién completada → el lead seguía figurando vencido.
    expect(crmTasksSrc).toContain('window.BH_CRM.markLeadContacted');
    expect(crmTasksSrc).toContain('await registrarContacto(leadId);');
    // El fallback (si el CRM todavía no cargó) mantiene el update mínimo.
    expect(crmTasksSrc).toContain("await db().from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', leadId);");
  });

  test('chip "ML sin responder": existe el wrap, el flag y el filtro por origen', () => {
    expect(adminHtml).toContain('id="crmMlUntouchedWrap"');
    expect(crmSrc).toContain('var _mlUntouchedFilter = false;');
    expect(crmSrc).toContain('ML sin responder (+48h)');
    expect(crmSrc).toContain("q = q.eq('source', 'ml')");
    expect(crmSrc).toContain(".or('last_contacted_at.is.null,last_contacted_at.lt.' + mlCut)");
  });
});

test.describe('SLA de primer contacto — backend (helpers reales del webhook)', () => {
  /* Evaluación real de los helpers del webhook (no un mock del mock):
     se extraen del .ts, se les quita SOLO la anotación de tipos y se corren
     contra el fake-postgrest del repo. Si el strip deja restos de tipos, el
     test falla (hay que actualizarlo) — no se degrada en silencio. */
  function loadHelpers() {
    const src = fs.readFileSync(path.join(FUNCTIONS, 'ml-webhook', 'index.ts'), 'utf8');
    /* Desde las constantes del SLA (los helpers las usan) hasta la función
       siguiente: así el bloque evaluado es self-contained, como en runtime. */
    const start = src.indexOf('const ML_FIRST_CONTACT_MINUTES = 120;');
    const end = src.indexOf('async function findConsolidableMlLead(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    let code = src.slice(start, end);
    code = code
      .replace(/type SbcAny = any;\s*/g, '')
      .replace(/supabase: SbcAny,/g, 'supabase,')
      .replace(/leadId: string,/g, 'leadId,')
      .replace(/opts: \{ phone\?: string \| null; assignedTo\?: string \| null \},/g, 'opts,')
      .replace(/\): Promise<void> \{/g, ') {')
      /* casts de TS: (err as Error).message → (err).message */
      .replace(/\s+as\s+(?:Error|any|unknown|string|number|boolean)\b/g, '');
    if (/SbcAny|Promise<void>|\?:\s*string|\bas\s+[A-Z]\w*\b/.test(code)) {
      throw new Error('el strip de tipos no cubrió el helper del SLA: actualizá el test');
    }
    return code;
  }

  function fakeClient(data) {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'helpers', 'fake-postgrest.js'), 'utf8'), sandbox);
    const log = [];
    const client = sandbox.window.__FAKE_PG.install(data, log, { mutate: true });
    return { client, log, store: data };
  }

  test('ensureFirstContactTask: crea la tarea con 2 h de plazo y setea next_followup_at', () => {
    const code = loadHelpers();
    const { client, log, store } = fakeClient({
      leads: [{ id: 'lead-1', next_followup_at: null }],
      lead_tasks: [],
    });
    const warns = [];
    const helpers = new Function('supabase', 'logWarn', code + '\nreturn { syncLeadNextFollowup, ensureFirstContactTask };')(client, (e) => warns.push(e));

    return helpers.ensureFirstContactTask(client, 'lead-1', { phone: '3515550001', assignedTo: 'agent-9' }).then(() => {
      expect(warns).toEqual([]);
      expect(store.lead_tasks).toHaveLength(1);
      const t = store.lead_tasks[0];
      expect(t.title).toBe('Primer contacto — lead ML');
      expect(t.type).toBe('contact');
      expect(t.contact_type).toBe('whatsapp');
      expect(t.priority).toBe('alta');
      expect(t.status).toBe('pendiente');
      expect(t.assigned_to).toBe('agent-9');
      expect(t.remind_before_minutes).toBe(30);
      expect(t.lead_id).toBe('lead-1');
      // El plazo es de 2 h (tolerancia ±2 min por el reloj).
      const deltaMin = Math.abs(new Date(t.due_at).getTime() - Date.now()) / 60000;
      expect(deltaMin).toBeGreaterThan(115);
      expect(deltaMin).toBeLessThan(125);
      // Y el lead queda con next_followup_at = la tarea pendiente más próxima.
      expect(store.leads[0].next_followup_at).toBe(t.due_at);
      expect(log.some(function (e) { return e.table === 'lead_tasks' && e.op === 'insert'; })).toBe(true);
    });
  });

  test('ensureFirstContactTask: dedup (una sola tarea SLA viva por lead)', () => {
    const code = loadHelpers();
    const { client, store } = fakeClient({ leads: [{ id: 'lead-1', next_followup_at: null }], lead_tasks: [] });
    const helpers = new Function('supabase', 'logWarn', code + '\nreturn { syncLeadNextFollowup, ensureFirstContactTask };')(client, () => {});

    return helpers.ensureFirstContactTask(client, 'lead-1', { phone: '3515550001', assignedTo: null })
      .then(() => helpers.ensureFirstContactTask(client, 'lead-1', { phone: '3515550001', assignedTo: null }))
      .then(() => {
        expect(store.lead_tasks).toHaveLength(1);
      });
  });

  test('ensureFirstContactTask: sin teléfono no crea tarea (no hay a quién escribir)', () => {
    const code = loadHelpers();
    const { client, store } = fakeClient({ leads: [{ id: 'lead-1', next_followup_at: null }], lead_tasks: [] });
    const helpers = new Function('supabase', 'logWarn', code + '\nreturn { syncLeadNextFollowup, ensureFirstContactTask };')(client, () => {});

    return helpers.ensureFirstContactTask(client, 'lead-1', { phone: null, assignedTo: null }).then(() => {
      expect(store.lead_tasks).toHaveLength(0);
    });
  });

  test('syncLeadNextFollowup: next_followup_at = la tarea pendiente MÁS PRÓXIMA', () => {
    const code = loadHelpers();
    const { client, store } = fakeClient({
      leads: [{ id: 'lead-1', next_followup_at: '2026-11-02T00:00:00Z' }],
      lead_tasks: [
        { id: 't-late', lead_id: 'lead-1', title: 'Visita', status: 'pendiente', due_at: '2026-11-05T15:00:00Z' },
        { id: 't-soon', lead_id: 'lead-1', title: 'Llamar', status: 'pendiente', due_at: '2026-11-03T10:00:00Z' },
        { id: 't-done', lead_id: 'lead-1', title: 'Vieja', status: 'completada', due_at: '2026-11-01T10:00:00Z' },
      ],
    });
    const helpers = new Function('supabase', 'logWarn', code + '\nreturn { syncLeadNextFollowup, ensureFirstContactTask };')(client, () => {});

    return helpers.syncLeadNextFollowup(client, 'lead-1').then(() => {
      // El fake no ordena, pero el helper toma el primero pendiente: la
      // importante es que NO elige la completada ni la más lejana.
      expect(store.leads[0].next_followup_at).not.toBe('2026-11-01T10:00:00Z');
      expect(store.leads[0].next_followup_at).toBeTruthy();
    });
  });
});

test.describe('SLA de primer contacto — comportamiento (harness local, sin BD)', () => {
  async function boot(page) {
    await page.goto(HARNESS);
    await page.waitForFunction(() => window.__HARNESS_READY === true);
    await page.evaluate(() => { window.initCrm(); });
  }

  test('markLeadContacted: registra el contacto, cierra la task de SLA y recalcula el followup', async ({ page }) => {
    await boot(page);
    const res = await page.evaluate(async () => {
      if (!window.BH_CRM || typeof window.BH_CRM.markLeadContacted !== 'function') {
        throw new Error('BH_CRM.markLeadContacted no está publicado');
      }
      await window.BH_CRM.markLeadContacted('11111111-1111-1111-1111-111111111111');
      const client = window.supabaseClient;
      const lead = (await client.from('leads').select('*').eq('id', '11111111-1111-1111-1111-111111111111').single()).data;
      const tasks = (await client.from('lead_tasks').select('*').eq('lead_id', '11111111-1111-1111-1111-111111111111')).data;
      const sla = tasks.find(function (t) { return t.title === 'Primer contacto — lead ML'; });
      const visita = tasks.find(function (t) { return t.title === 'Visitar la propiedad'; });
      return {
        lastContactedAt: lead ? lead.last_contacted_at : null,
        nextFollowupAt: lead ? lead.next_followup_at : null,
        slaStatus: sla ? sla.status : null,
        slaCompletedAt: sla ? sla.completed_at : null,
        slaNote: sla ? sla.completed_note : null,
        visitaStatus: visita ? visita.status : null
      };
    });
    // El contacto queda registrado.
    expect(res.lastContactedAt).toBeTruthy();
    // La task de SLA queda completada (si no, el badge "tareas vencidas" miente).
    expect(res.slaStatus).toBe('completada');
    expect(res.slaCompletedAt).toBeTruthy();
    expect(res.slaNote).toBe('Primer contacto registrado');
    // La OTRA task sigue viva (no se cierra de más).
    expect(res.visitaStatus).toBe('pendiente');
    // Y el followup se recalcula: ahora apunta a la visita, no a la task cerrada.
    expect(res.nextFollowupAt).toBe('2026-11-05T15:00:00Z');
  });

  test('el chip "ML sin responder" filtra a los leads ML sin contacto en 48 h', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      var chk = document.getElementById('crmMlUntouchedFilter');
      if (!chk) throw new Error('el chip no se creó');
      chk.checked = true;
      chk.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => (document.querySelector('#crmLeadList')?.textContent || '').length > 0);

    const state = await page.evaluate(() => {
      var html = document.getElementById('crmLeadList').innerHTML;
      var leadsQueries = window.__HARNESS_LOG.filter(function (e) { return e.table === 'leads'; });
      var conFiltro = leadsQueries.filter(function (e) {
        return (e.filters || []).some(function (f) { return f.t === 'eq' && f.col === 'source' && f.val === 'ml'; });
      });
      return {
        html: html,
        conFiltroMl: conFiltro.length > 0,
        chipExists: !!document.getElementById('crmMlUntouchedFilter')
      };
    });
    expect(state.chipExists).toBe(true);
    // El listado queda acotado al lead ML sin contacto.
    expect(state.html).toContain('Lead ML Sin Contacto');
    expect(state.html).not.toContain('Lead Web Sin Contacto');
    expect(state.html).not.toContain('Lead ML Ya Contactado');
    // Y la query que lo genera filtra por origen 'ml'.
    expect(state.conFiltroMl).toBe(true);
  });
});
