-- ---------------------------------------------------------------------------
-- Resumen diario para agentes (2026-11-28).
--
-- Llama a la edge function `agent-daily-digest` todos los días a las 08:00 ART
-- (11:00 UTC). La función lee la MISMA RPC `mi_dia` que abre el botón del CRM
-- y manda por email el top 3 + los conteos, con dedupe por día en crm_envios.
--
-- Patrón EXACTO de los crons que ya funcionan (lead-tasks-reminder,
-- alquileres-month-reminder): URL hardcodeada + x-sync-secret leído de
-- zernio_config en runtime. Los settings de sesión de la app son NULL en
-- este proyecto (3.999 corridas rotas en 2026-10 por ese patrón).
--
-- ⚠️ Aplicar DESPUÉS de que el CI deploye la edge function: si el cron corre
-- antes, cada corrida da 404 en silencio. verify_jwt OFF → la función está
-- en NO_VERIFY de deploy.yml y en CALLED_WITHOUT_JWT del guard de tests.
-- ---------------------------------------------------------------------------

SELECT cron.unschedule('agent-daily-digest')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agent-daily-digest');

SELECT cron.schedule(
  'agent-daily-digest',
  '0 11 * * *',
  $$
    SELECT net.http_post(
      url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/agent-daily-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
      ),
      -- Arranca en dry_run: la primer corrida calcula el top 3 real contra
      -- producción SIN enviar correos. Se cambia a '{}' con OK del dueño.
      body := '{"dry_run":true}'::jsonb
    );
  $$
);
