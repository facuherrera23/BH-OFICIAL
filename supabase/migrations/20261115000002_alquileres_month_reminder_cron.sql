-- Módulo "Administración de Alquileres" — Bloque 2.C: recordatorio de cierre
-- de mes. Cron los días 2 y 3 de cada mes a las 12:00 ART (15:00 UTC): si el
-- mes anterior no fue cerrado en el módulo (hist sin 'YYYY-MM'), la edge
-- function alquileres-month-reminder avisa por email al usuario del módulo.
-- Dedupe por audit_log dentro de la función (1 email/mes máx).
--
-- Patrón del fix 20261015000004 (AGENTS.md): URL hardcodeada + x-sync-secret
-- leído de zernio_config en runtime — NUNCA los settings de sesión de la app
-- (NULL en este proyecto: 3.999 corridas rotas ya por ese patrón).
-- verify_jwt OFF → 'alquileres-month-reminder' en NO_VERIFY de deploy.yml.

SELECT cron.unschedule('alquileres-month-reminder')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alquileres-month-reminder');

SELECT cron.schedule(
  'alquileres-month-reminder',
  '0 15 2,3 * *',
  $$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/alquileres-month-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
