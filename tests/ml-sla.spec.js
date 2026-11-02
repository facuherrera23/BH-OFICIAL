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
