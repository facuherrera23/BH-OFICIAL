// Guardián de crons + secreto en runtime + agenda del resumen (28/11/2026).
// Tres clases de bug reales del proyecto, todas SILENCIOSAS:
//   · un cron falla 27 veces y pg_cron sigue diciendo "1 row" → nadie lo ve;
//   · el x-sync-secret está en claro en cron.job.command → rotarlo = 401 mudo;
//   · el mail diario responde "qué hago ahora" pero no muestra lo AGENDADO.
// Los guards son estáticos: el comportamiento en producción se verifica con
// las RPCs en vivo (sin imprimir secretos) y con `dry_run:true,force:true`.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const health = read('supabase/migrations/20261128000004_cron_health_alert.sql');
const secretRaw = read('supabase/migrations/20261128000005_cron_secret_runtime.sql');
const secret = secretRaw.replace(/--.*$/gm, ''); // los comentarios explican el jobid 1, el CÓDIGO no lo toca
const agenda = read('supabase/migrations/20261128000006_mi_dia_agenda_rpc.sql');
const agendaPermisos = read('supabase/migrations/20261128000007_mi_dia_agenda_revoke_auth.sql');
const fn = read('supabase/functions/agent-daily-digest/index.ts');
const digestSpec = read('tests/agent-daily-digest.spec.js');

test.describe('Guardián de crons → Supervisión', () => {
  test('la RPC existe con el contrato SECURITY DEFINER y sin anon', () => {
    expect(health).toContain('CREATE OR REPLACE FUNCTION public.bh_check_cron_health(');
    expect(health).toContain('RETURNS jsonb');
    expect(health).toContain('SECURITY DEFINER');
    expect(health).toContain("SET search_path = ''");
    expect(health).toContain(
      'REVOKE ALL ON FUNCTION public.bh_check_cron_health(integer) FROM PUBLIC, anon, authenticated;',
    );
    expect(health).toContain('GRANT EXECUTE ON FUNCTION public.bh_check_cron_health(integer) TO service_role;');
    // El cron corre como postgres: no depender de current_setting (devuelve NULL).
    expect(health).not.toContain('current_setting(');
  });

  test('lee cron.job_run_details en ventana y reporta el return_message real', () => {
    expect(health).toContain('FROM cron.job j');
    expect(health).toContain('JOIN cron.job_run_details r ON r.jobid = j.jobid');
    expect(health).toContain("r.status = 'failed'");
    expect(health).toContain('r.return_message');
    expect(health).toContain('r.start_time >= now() - (v_ventana || \' minutes\')::interval');
    // Sin esto dos corridas simultáneas abren dos alertas para el mismo job.
    expect(health).toContain('pg_advisory_xact_lock(hashtext(\'bh_check_cron_health\'))');
  });

  test('el detalle va en evidence (supervision_alerts NO tiene metadata)', () => {
    expect(health).toContain("'cron_failed'");
    expect(health).toContain("'high'");
    expect(health).toContain("'supervision'");
    expect(health).toContain("'jobname', v_job.jobname");
    expect(health).toContain("'mensaje', left(COALESCE(v_job.mensaje, ''), 500)");
    expect(health).not.toMatch(/metadata\s*=/);
    expect(health).not.toMatch(/metadata\s*->/);
    expect(health).not.toContain('updated_at'); // la tabla no tiene updated_at
  });

  test('dedupe por jobname y auto-resolución cuando el job vuelve a succeeded', () => {
    expect(health).toContain("evidence ->> 'jobname' = v_job.jobname");
    expect(health).toContain("status IN ('open', 'assigned', 'investigating', 'acknowledged')");
    expect(health).toContain("v_ultimo = 'succeeded'");
    expect(health).toContain("status = 'resolved'");
    expect(health).toContain('resolved_at = now()');
    expect(health).toContain("Auto-resuelto: el cron volvió a succeeded.");
  });

  test('el cron es cada 15 min y re-aplicar no cambia el jobid', () => {
    expect(health).toContain("'bh-cron-health-15min'");
    expect(health).toContain("'*/15 * * * *'");
    expect(health).toContain('cron.alter_job(');
    expect(health).toContain("SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'bh-cron-health-15min'");
    expect(health).not.toContain('cron.unschedule(');
  });
});

test.describe('Secretos de crons en runtime', () => {
  test('los 2 crons con el secret en claro pasan a leerlo de zernio_config', () => {
    expect(secret).toContain("'zernio-sync-every-2-min'");
    expect(secret).toContain("'backup-snapshot-daily'");
    expect((secret.match(/cron\.alter_job\(/g) || []).length).toBe(2);
    expect(secret).toContain("value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret'");
    expect(secret).toContain('timeout_milliseconds := 30000');
    expect(secret).not.toContain('current_setting(');
    // Ningún literal del secret en el código (sólo la referencia a la tabla).
    expect(secret).not.toMatch(/x-sync-secret'\s*,\s*'[A-Za-z0-9_\-]{16,}'/);
  });

  test('conserva jobids/historial y NO toca el secret distinto de ML sync', () => {
    expect(secret).toContain('job_id => v_jobid');
    expect(secret).not.toContain('cron.unschedule(');
    expect(secret).not.toContain('cron.schedule(');
    // jobid 1 usa vault.decrypted_secrets(name='ml_sync_secret'), otro valor.
    expect(secret).not.toContain('ml-sync-every-5-min');
    expect(secret).not.toContain('decrypted_secrets');
  });
});

test.describe('Agenda de próximos días en el mail', () => {
  test('la RPC reutiliza el alcance de mi_dia y labels REALES del enum', () => {
    expect(agenda).toContain('CREATE OR REPLACE FUNCTION public.mi_dia_agenda(');
    expect(agenda).toContain("SET search_path = ''");
    expect(agenda).toContain('SECURITY DEFINER');
    expect(agenda).toContain("v_role IN ('super_admin', 'broker')");
    expect(agenda).toContain('v.agent_id = v_agent');
    expect(agenda).toContain('l.assigned_to = v_agent');
    expect(agenda).toContain("v.status IN ('pendiente', 'confirmada')");
    expect(agenda).toContain("t.status IN ('pendiente', 'en_progreso')");
    // Los terminales son SOLO estos (ver enum_range(lead_stage)).
    expect(agenda).toContain("l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')");
    expect(agenda).not.toContain('cerrado_vendido');
    expect(agenda).not.toContain("'vendido'");
  });

  test('ventana ART de N días, top acotado y conteo REAL (no el del top)', () => {
    expect(agenda).toContain("(now() at time zone 'America/Argentina/Buenos_Aires')::date");
    expect(agenda).toContain("v_hoy::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires'");
    expect(agenda).toContain('LEAST(GREATEST(COALESCE(p_dias, 3), 1), 14)');
    expect(agenda).toContain('LIMIT 10');
    expect(agenda).toContain("'visitas', v_c_vis");
    expect(agenda).toContain("'tareas', v_c_tar");
    expect(agenda).toContain("'total', v_c_vis + v_c_tar");
  });

  test('permisos: anon/authenticated NUNCA (sólo la llama service_role)', () => {
    expect(agenda).toContain('SECURITY DEFINER');
    expect(agendaPermisos).toContain(
      'REVOKE ALL ON FUNCTION public.mi_dia_agenda(uuid, integer) FROM PUBLIC, anon, authenticated;',
    );
    expect(agendaPermisos).toContain(
      'GRANT EXECUTE ON FUNCTION public.mi_dia_agenda(uuid, integer) TO service_role;',
    );
  });

  test('el mail llama a la RPC, degrada sin frenar el top 3 y escapea los datos', () => {
    expect(fn).toContain("supabase.rpc('mi_dia_agenda', {");
    expect(fn).toContain('p_user_id: perfil.id');
    expect(fn).toContain('p_dias: 3');
    expect(fn).toContain('Agenda · próximos 3 días');
    expect(fn).toContain('Sin visitas ni tareas en los próximos 3 días.');
    expect(fn).toContain('esc(a.titulo || a.tipo || \'Pendiente\')');
    expect(fn).toContain('esc(a.nombre)');
    expect(fn).toContain('esc([when, a.detalle].filter(Boolean).join(\' · \'))');
    // La agenda se calcula AFUERA: buildContent es la única que renderiza.
    const rpc = fn.indexOf("supabase.rpc('mi_dia_agenda'");
    const build = fn.indexOf('buildContent(payload, agenda');
    expect(rpc).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(rpc);
    expect(fn).toContain('mi_dia_agenda falló');
  });

  test('el spec del digest ya documenta el contrato agregado', () => {
    expect(digestSpec).toContain('mi_dia_agenda');
  });
});
