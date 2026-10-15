-- Fix de entrega de 3 crons (hallazgo de la verificación end-to-end del fix P2,
-- 2026-10-15). current_setting('app.settings.*') es NULL en este proyecto
-- (mismo bug documentado del incidente 2026-10-08 con ml-questions-sweep):
--
-- 1. supervision-digest-weekly: Authorization armado con
--    current_setting('app.settings.service_role_key') → NULL → header ausente
--    → la función respondía 401 en cada corrida: el digest NUNCA llegó por
--    cron (el envío exitoso del 2026-10-12 fue un disparo manual).
-- 2. owner-tasks-reminder: URL armada con current_setting('app.settings.supabase_url')
--    → NULL → "null value in column url" en cada corrida: 3.999 fallos
--    consecutivos (nunca envió recordatorios desde ~septiembre).
-- 3. monthly-commission-liquidation: Authorization desde vault('service_role_key')
--    con guard WHERE EXISTS — el secret nunca existió → no-op silencioso: la
--    liquidación mensual no corría.
--
-- Patrón correcto (ver AGENTS.md y crons operativos: ml-sync, zernio-sync,
-- backup-snapshot): URL hardcodeada + x-sync-secret compartido
-- (zernio_config key='sync_secret'), que las 3 funciones ahora validan.
-- El secret se lee de zernio_config en runtime (el cron corre como owner de
-- la tabla: RLS no aplica al owner) para no duplicar el literal en cron.job.

SELECT cron.schedule(
  'supervision-digest-weekly',
  '0 11 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/supervision-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'owner-tasks-reminder',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/owner-tasks-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'monthly-commission-liquidation',
  '0 2 1 * *',
  $$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/monthly_commission_liquidation',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
