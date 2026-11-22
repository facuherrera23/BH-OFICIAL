// RELA / ZonaProp — captación de contactos por polling (2026-11-19).
// Guards ESTÁTICOS: no tocan la BD ni la red.
//
// POR QUÉ: los callbacks no se pueden registrar (`PUT
// /v1/configuracion/callbacks` → 500 Access is denied del lado de
// QuintoAndar) y el panel decía "no trae leads". La captación viva es
// GET /v1/inmobiliarias/{codigo}/mensajes, compartida por el cron
// (rela-sync) y el botón (rela-contacts). El histórico DEBE importarse con
// preview previo: crear leads de golpe sin mostrar el impacto está prohibido.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const SHARED = read('supabase', 'functions', '_shared', 'rela-leads.ts');
const CALLBACKS = read('supabase', 'functions', 'rela-callbacks', 'index.ts');
const SYNC = read('supabase', 'functions', 'rela-sync', 'index.ts');
const CONTACTS = read('supabase', 'functions', 'rela-contacts', 'index.ts');
const MIGRATION = read('supabase', 'migrations', '20261119000001_rela_contacts_poll_cron.sql');
const PORTALES = read('assets', 'js', 'admin-portales.js');
const DEPLOY = read('.github', 'workflows', 'deploy.yml');

test.describe('RELA — captación de contactos por polling', () => {
  test('el motor compartido consulta /mensajes con dedupe por poll:', () => {
    expect(SHARED).toContain('export async function pullRelaContacts');
    expect(SHARED).toContain('/mensajes?');
    expect(SHARED).toContain('fromDate=');
    expect(SHARED).toContain('pageable.size=');
    expect(SHARED).toContain("eventId = `poll:");
    expect(SHARED).toContain('rela_webhook_events');
  });

  test('el mensaje completo viaja al motor (no se recorta a 5 campos)', () => {
    // Bug real pre-deploy: el preview guardaba sólo id/nombre/email/fecha/aviso
    // y el ingest leía telefono/textoMensaje de ese objeto -> siempre NULL.
    expect(SHARED).toContain('result.detalles.push({ ...m })');
    expect(SHARED).toContain('String(m.telefono)');
    expect(SHARED).toContain('m.textoMensaje');
    expect(SHARED).toContain('idAvisoNavplat: m.idAvisoNavplat');
  });

  test('el preview NO escribe y el default del cron es 2 días', () => {
    expect(SHARED).toContain('if (preview)');
    expect(SHARED).toContain('consolidados++');
    expect(SYNC).toContain('body.days ?? 2');
    expect(SYNC).toContain('pullRelaContacts(');
    expect(CONTACTS).toContain('body.days ?? 30');
  });

  test('DRY_RUN frena los avisos pero NO la captación (es gratis)', () => {
    const bloque = SYNC.slice(SYNC.indexOf('if (!cfgRow.dry_run)'), SYNC.indexOf('const results'));
    expect(bloque).toContain('.from(\'rela_listings\')');
    expect(SYNC.indexOf('pullRelaContacts(')).toBeLessThan(SYNC.indexOf('if (!cfgRow.dry_run)'));
    expect(SYNC).toContain('skipped:');
  });

  test('un 521 de la API NO tumba el cron: degrada con traza accionable', () => {
    // Incidente real 2026-11-21: api-zp-sandbox-open.navent.com respondió
    // 521 (Cloudflare "Web server is down") y rela-sync devolvió 500 en cada
    // corrida del cron, sin dejar last_error ni motivo en el response.
    const bloque = SYNC.slice(SYNC.indexOf('const contactDays'), SYNC.indexOf('/* El DRY_RUN'));
    expect(bloque).toContain('try {');
    expect(bloque).toContain('} catch (err) {');
    expect(bloque).toContain('contactsError');
    expect(bloque).toContain('console.error(');
    expect(SYNC).toContain('degraded: true');
    expect(SYNC).toContain('contacts_error: contactsError');
    expect(SYNC).toContain('...(contactsError ? { last_error: contactsError } : {})');
    // El success path NO puede perder el resumen de contactos.
    expect(SYNC).toContain(': { contacts })');
  });

  test('callback y polling comparten el mismo motor de leads', () => {
    expect(CALLBACKS).toContain('ingestRelaContact');
    expect(CALLBACKS).toContain("from '../_shared/rela-leads.ts'");
    expect(SYNC).toContain("from '../_shared/rela-leads.ts'");
    expect(CONTACTS).toContain("from '../_shared/rela-leads.ts'");
    // Los labels del enum son los reales (inventar uno da 22P02 silencioso).
    expect(SHARED).toContain('("cerrado_ganado","cerrado_perdido")');
  });

  test('rela-contacts exige JWT y rol, y audita preview e importación', () => {
    expect(CONTACTS).toContain("WRITE_ROLES = ['super_admin', 'broker']");
    expect(CONTACTS).toContain("auth.startsWith('Bearer ')");
    expect(CONTACTS).toContain("body.preview === true");
    expect(CONTACTS).toContain('rela_contacts_preview');
    expect(CONTACTS).toContain('rela_contacts_pull');
    expect(CONTACTS).toContain("supabase.rpc('insert_audit_log'");
    // verify_jwt ON: NO debe figurar en NO_VERIFY del CI.
    expect(DEPLOY).not.toContain('"rela-contacts"');
    expect(DEPLOY).toContain('"rela-sync"');
  });

  test('el cron usa URL hardcodeada + secreto de zernio_config', () => {
    expect(MIGRATION).toContain("cron.schedule(");
    expect(MIGRATION).toContain("'rela-contacts-poll'");
    expect(MIGRATION).toContain("'*/10 * * * *'");
    expect(MIGRATION).toContain("https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/rela-sync");
    expect(MIGRATION).toContain("'x-sync-secret'");
    expect(MIGRATION).toContain("key = 'sync_secret'");
    expect(MIGRATION).toContain("'{\"days\": 2}'::jsonb");
    // current_setting('app.settings.*') devuelve NULL en este proyecto.
    // (el comentario de la migración lo menciona; se analiza sólo el SQL)
    const sql = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toContain('current_setting(');
  });

  test('el panel muestra el preview antes de importar', () => {
    expect(PORTALES).toContain('data-action="relaPullContacts"');
    expect(PORTALES).toContain('window.adminApp.relaPullContacts');
    expect(PORTALES).toContain('window.adminApp.relaImportContacts');
    expect(PORTALES).toContain("preview: true");
    expect(PORTALES).toContain("preview: false");
    expect(PORTALES).toContain("'rela-contacts'");
    // El botón de importar SOLO existe en el resumen del preview.
    const summary = PORTALES.slice(PORTALES.indexOf('function relaContactsSummary'), PORTALES.indexOf('window.adminApp.relaPullContacts'));
    expect(summary).toContain('res.preview &&');
    expect(summary).toContain('data-action="relaImportContacts"');
    expect(PORTALES).toContain('Vista previa — no se creó ningún lead todavía');
  });

  test('la delegación genérica rutea data-action a window.adminApp', () => {
    const APP = read('assets', 'js', 'admin-app.js');
    expect(APP).toContain("window.adminApp[btn.dataset.action]");
  });

  test('el paso a producción está preparado por escrito, sin credenciales en el repo', () => {
    const docs = read('docs', 'integrations', 'RELA.md');
    const email = read('docs', 'integrations', 'RELA-EMAIL-QUINTOANDAR.md');
    const checklist = docs.slice(docs.indexOf('### Checklist: pasar RELA a producción'), docs.indexOf('## Arquitectura'));
    expect(checklist).toContain('RELA_BASE_URL=https://api-zp-open.navent.com');
    expect(checklist).toContain('RELA_CLIENT_SECRET');
    expect(checklist).toContain("update rela_config set base_url='https://api-zp-open.navent.com'");
    expect(checklist).toContain('dry_run');
    // El secreto nunca va al repo: sólo el placeholder del comando.
    expect(checklist).not.toMatch(/client_secret\s*[:=]\s*['"][A-Za-z0-9_-]{16,}/);
    // El reclamo actual pide fecha de vuelta del 521, callbacks y pack/créditos.
    expect(email).toContain('SP-61526');
    expect(email).toContain('integracion@ar.quintoandar.com');
    expect(email).toContain('Access is denied');
    expect(email).toContain('521');
    expect(email).toContain('Facundo Herrera Orquera');
  });
});
