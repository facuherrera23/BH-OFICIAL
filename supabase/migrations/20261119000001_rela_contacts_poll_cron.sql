-- Captación de leads de ZonaProp/Open RELA: polling de contactos.
-- El registro de callbacks del lado de QuintoAndar responde 500
-- "Access is denied" (SP-61526), así que la única viva de captación es
-- GET /v1/inmobiliarias/{codigo}/mensajes. rela-sync ya implementa el poll
-- (compartido en _shared/rela-leads.ts); acá sólo se programa su ejecución.
--
-- Patrón canónico del proyecto (AGENTS.md): URL HARDCODEADA + x-sync-secret
-- leído de zernio_config en runtime. current_setting('app.settings.*')
-- devuelve NULL en este proyecto y ya rompió 4 crons en silencio.
-- rela-sync tiene verify_jwt OFF → figura en NO_VERIFY de deploy.yml y en
-- CALLED_WITHOUT_JWT de tests/functions-deploy.spec.js.

SELECT cron.unschedule('rela-contacts-poll')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rela-contacts-poll');

SELECT cron.schedule(
  'rela-contacts-poll',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/rela-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
    ),
    body := '{"days": 2}'::jsonb
  );
  $$
);
