// RECORDATORIO REAL DE TAREAS DE LEAD (2026-11-26).
//
// El bug: lead_tasks.remind_before_minutes estaba cargado en las 273 tareas y
// NINGÚN cron lo leía (cosmético). La única familia con recordatorios era
// owner_tasks. Medido: 46 tareas pendientes, 21 vencidas, 0 avisos.
//
// Contrato (espejo del patrón probado de owner-tasks-reminder):
//   · columna lead_tasks.reminder_sent_at (dedup por tarea),
//   · edge function con x-sync-secret (zernio_config), deploy sin verify_jwt,
//   · disparo now() >= due_at - remind_before_minutes (default 1440),
//   · marca INMEDIATA después de confirmar cada envío,
//   · tareas de leads muertos/cerrados, sin agente o sin email → marcadas y
//     salteadas (evita reintentos infinitos cada 15 min),
//   · cron cada 15 min con URL hardcodeada + secret de zernio_config.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const migCol = read('supabase/migrations/20261126000007_lead_tasks_reminder.sql');
const migCron = read('supabase/migrations/20261126000008_lead_tasks_reminder_cron.sql');
const fn = read('supabase/functions/lead-tasks-reminder/index.ts');
const deploy = read('.github/workflows/deploy.yml');
const ownerFn = read('supabase/functions/owner-tasks-reminder/index.ts');

test.describe('Recordatorio de tareas de lead (lead-tasks-reminder)', () => {
  test('migración: columna de control aditiva (mismo patrón que owner_tasks)', () => {
    expect(migCol).toContain('ALTER TABLE public.lead_tasks ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;');
    expect(migCol).not.toMatch(/DROP\s+COLUMN/i);
    expect(migCol).not.toMatch(/DELETE\s+FROM/i);
    expect(migCol).not.toMatch(/UPDATE\s+public\./i);
    // El par propietario tiene la columna gemela (el patrón que se copia).
    expect(ownerFn).toContain('reminder_sent_at');
  });

  test('edge function: gate x-sync-secret y client con el env correcto', () => {
    // El gate: el cron no puede mandar JWT (mismo patrón que owner-tasks-reminder).
    expect(fn).toContain('x-sync-secret');
    expect(fn).toContain("zernio_config");
    expect(fn).toContain("'sync_secret'");
    expect(fn).toContain('401');
    // Env var REAL (owner-tasks-reminder usa SUPABASE_SERVICE_ROLE_KEY; un
    // nombre equivocado acá = cliente nulo = cron muerto en silencio).
    expect(fn).toContain('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!');
    expect(fn).not.toContain('Deno.env.get("SERVICE_ROLE_KEY")');
  });

  test('edge function: disparo por remind_before_minutes y marca inmediata', () => {
    // Disparo: now() >= due_at - remind_before_minutes (default 1440 = 24 h).
    expect(fn).toContain('(task.remind_before_minutes || 1440) * 60 * 1000');
    expect(fn).toContain('Date.now() < triggerAt.getTime()');
    // Una tarea ya vencida dispara en la primera corrida (una sola vez).
    expect(fn).toContain('.is("reminder_sent_at", null)');
    // La marca es POR TAREA, después de confirmar el envío (no batch al final).
    expect(fn).toMatch(/if \(!result\.success\) \{\s*\n\s*throw new Error\(result\.error \|\| "send failed"\);\s*\n\s*\}\s*\n\s*\n\s*\/\/ Marcar enviado INMEDIATAMENTE después de confirmar esta tarea\.\s*\n\s*await mark\(\);/);
    // Y el fallo de envío NO marca (la próxima corrida reintenta).
    expect(fn).toContain('la próxima corrida lo reintenta');
  });

  test('edge function: la bandeja es accionable — salta leads muertos/cerrados y faltantes', () => {
    expect(fn).toContain('STAGES_MUERTOS');
    expect(fn).toContain('new Set(["cerrado_ganado", "cerrado_perdido"])');
    expect(fn).toContain('if (!lead || lead.deleted_at)');
    expect(fn).toContain('if (!task.assigned_to)');
    expect(fn).toContain('sin email para el agente');
    // Respeta la preferencia de email apagada (mismo check que owner-tasks).
    expect(fn).toContain('notification_preferences');
    expect(fn).toContain('prefs.email === false');
    // El join trae el lead (nombre para el email y stage/deleted para filtrar).
    expect(fn).toContain('lead:leads(id, full_name, stage, deleted_at)');
  });

  test('cron: cada 15 min, URL hardcodeada + secret de zernio_config (nunca current_setting)', () => {
    expect(migCron).toContain("cron.schedule(\n  'lead-tasks-reminder',\n  '*/15 * * * *'");
    expect(migCron).toContain("url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/lead-tasks-reminder'");
    expect(migCron).toContain("x-sync-secret");
    expect(migCron).toContain("SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1");
    // La clase de bug más cara del proyecto: current_setting('app.settings.*')
    // es NULL acá → 3.999 corridas fallidas del cron viejo de propietarios.
    // (En el comando del cron, no en el comentario que lo explica.)
    const comando = migCron.slice(migCron.indexOf('$$'));
    expect(comando).not.toContain('current_setting');
    // Y avisa el orden de despliegue (cron después del deploy del CI).
    expect(migCron).toContain('DESPUÉS de que el CI deploye');
  });

  test('CI: la función va en NO_VERIFY y en el mapa de llamadas sin JWT', () => {
    expect(deploy).toMatch(/"lead-tasks-reminder"/);
    expect(read('tests/functions-deploy.spec.js')).toMatch(/fn: 'lead-tasks-reminder'/);
  });
});
