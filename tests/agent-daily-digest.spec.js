// Resumen diario para agentes (2026-11-28): guard del Cron + de la Edge
// Function. El bug que evita este spec es la clase ya vista 4 veces en el
// proyecto: cron con verify_jwt ON → 401 antes de correr, o cron armado con
// current_setting('app.settings.*') → NULL → nunca llama. Acá se controlan
// además las reglas de negocio críticas:
//   · el top 3 NO se reimplementa: se llama a la RPC `mi_dia`;
//   · dedupe por día en crm_envios (un fallo se reintenta, un OK no se repite);
//   · `dry_run` NO envía correos (es el camino de verificación en producción).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const fn = read('supabase/functions/agent-daily-digest/index.ts');
const cron = read('supabase/migrations/20261128000002_agent_daily_digest_cron.sql');
const enable = read('supabase/migrations/20261128000003_agent_daily_digest_enable.sql');
const deployYml = read('.github/workflows/deploy.yml');

test.describe('Resumen diario para agentes — Mi día por email', () => {
  test('el cron llama a la función a las 08:00 ART con el patrón que funciona', () => {
    expect(cron).toContain("cron.schedule(");
    expect(cron).toContain("'agent-daily-digest'");
    expect(cron).toContain("'0 11 * * *'"); // 08:00 ART = 11:00 UTC
    expect(cron).toContain(
      'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/agent-daily-digest',
    );
    expect(cron).toContain('x-sync-secret');
    expect(cron).toContain("value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret'");
    // El patrón roto de los 4 crons de 2026-10: current_setting devuelve NULL.
    expect(cron).not.toContain('current_setting(');
    // Re-schedule idempotente: no duplica jobs en producción.
    expect(cron).toContain("cron.unschedule('agent-daily-digest')");
    // Primera etapa: sin correos reales hasta que el dueño lo apruebe.
    expect(cron).toContain('body := \'{"dry_run":true}\'::jsonb');
  });

  test('la habilitación conserva el jobid con cron.alter_job y envía sin dry_run', () => {
    // El arranque en dry_run se verificó en producción; el OK del dueño se
    // aplica con alter_job, NO con unschedule+schedule (perdería el historial).
    expect(enable).toContain('cron.alter_job(');
    expect(enable).not.toContain('cron.unschedule(');
    expect(enable).not.toContain('cron.schedule(');
    expect(enable).toContain("SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'agent-daily-digest'");
    expect(enable).toContain('job_id => v_jobid');
    expect(enable).toContain("body := '{}'::jsonb");
    // Los comentarios explican el arranque en dry_run; el COMANDO no debe
    // llevarlo (si no, el cron sigue sin enviar correos para siempre).
    const sqlSinComentarios = enable.replace(/--.*$/gm, '');
    expect(sqlSinComentarios).not.toContain('dry_run');
    expect(enable).toContain('timeout_milliseconds := 30000');
    expect(enable).toContain('x-sync-secret');
    expect(enable).not.toContain('current_setting(');
  });

  test('la función está en NO_VERIFY (sin JWT: el cron manda solo x-sync-secret)', () => {
    expect(deployYml).toMatch(/"agent-daily-digest"/);
    const noVerify = deployYml.match(/NO_VERIFY=\(([^)]*)\)/);
    expect(noVerify, 'NO_VERIFY debe existir sin comentarios con ) adentro').not.toBeNull();
    expect(noVerify[1]).toContain('"agent-daily-digest"');
  });

  test('autenticación: x-sync-secret contra zernio_config antes de cualquier lectura', () => {
    expect(fn).toContain("req.headers.get('x-sync-secret')");
    expect(fn).toContain(".eq('key', 'sync_secret')");
    const auth = fn.indexOf('No autorizado');
    const rpc = fn.indexOf("supabase.rpc('mi_dia'");
    expect(auth).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(auth);
  });

  test('el top 3 NO se reimplementa: se usa la RPC mi_dia con el profile del agente', () => {
    expect(fn).toContain("supabase.rpc('mi_dia', { p_user_id: perfil.id })");
    // Las 5 categorías viven SOLO en la RPC; si se copiaran acá divergirían.
    expect(fn).not.toContain("'tipo', 'visita'");
    expect(fn).not.toContain("'tipo', 'seguimiento'");
    expect(fn).not.toContain("'tipo', 'contacto'");
    expect(fn).toContain("from('agents')");
    expect(fn).toContain(".eq('status', 'activo')");
    expect(fn).toContain(".is('deleted_at', null)");
    expect(fn).toContain("from('profiles')");
    expect(fn).toContain("from('notification_preferences')");
    expect(fn).toContain("p.email === false");
  });

  test('dedupe por día: sóLO un envío OK bloquea; un error se reintenta', () => {
    expect(fn).toContain("from('crm_envios')");
    expect(fn).toContain(".eq('origen', 'agent_daily_digest')");
    expect(fn).toContain(".eq('estado', 'enviado')");
    expect(fn).toContain('.gte(\'created_at\', desde)');
    expect(fn).toContain('yaEnviados.has(ag.id)');
    expect(fn).toContain('const force = body.force === true');
    expect(fn).toContain("fechaArt(ahora)");
    expect(fn).toContain("T00:00:00-03:00"); // fecha ART, no UTC
  });

  test('traza en crm_envios con el helper que dispara la alerta crm_email_broken', () => {
    expect(fn).toContain("import { registrarEnvio } from '../_shared/envios.ts'");
    expect(fn).toContain("origen: 'agent_daily_digest'");
    expect(fn).toContain("canal: 'email'");
    expect(fn).toContain("agente_id: ag.id");
    // La traza NUNCA puede romper el envío: el helper tiene try/catch propio.
    expect(fn).not.toContain('.delete(');
    expect(fn).not.toContain('.update(');
  });

  test('dry_run calcula contra producción pero NO envía ni registra', () => {
    const dry = fn.indexOf('if (dryRun) {');
    const send = fn.indexOf('sendBrevoEmail(config, email, subject, html, text)');
    expect(dry).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(dry);
    // El bloque de dry_run termina con continue ANTES del envío.
    expect(fn.slice(dry, send)).toContain('continue;');
    expect(fn).toContain('const dryRun = body.dry_run === true');
  });

  test('el mail escapa los datos del lead y el teléfono va como link tel:', () => {
    expect(fn).toContain('function esc(v: unknown): string');
    expect(fn).toContain('esc(it.titulo');
    expect(fn).toContain('esc(it.detalle');
    expect(fn).toContain('esc(it.nombre');
    expect(fn).toContain('href="tel:${esc(telLink)}"');
    expect(fn).toContain('api.brevo.com/v3/smtp/email');
  });
});
