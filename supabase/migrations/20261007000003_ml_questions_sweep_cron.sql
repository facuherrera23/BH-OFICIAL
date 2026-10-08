-- Cron cada 10 min: barre /questions/search?seller_id=... (API clásica, sí autorizada)
-- y re-inyecta al webhook las preguntas que el CRM todavía no procesó.
-- Fallback vigente mientras ML no habilita lectura de /vis/leads (403 PolicyAgent).
-- OJO: la URL va hardcodeada — current_setting('app.settings.supabase_url', true)
-- devuelve NULL en este proyecto y hacía fallar el job con url nula.
SELECT cron.unschedule('ml-questions-sweep') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'ml-questions-sweep'
);
SELECT cron.schedule(
  'ml-questions-sweep',
  '*/10 * * * *',
  $$select net.http_post(
      url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/ml-questions-sweep',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb
  )$$
);
