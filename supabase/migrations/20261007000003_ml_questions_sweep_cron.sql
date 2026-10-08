-- Cron cada 10 min: barre /questions/search?seller_id=... (API clásica, sí autorizada)
-- y re-inyecta al webhook las preguntas que el CRM todavía no procesó.
-- Fallback vigente mientras ML no habilita lectura de /vis/leads (403 PolicyAgent).
SELECT cron.schedule(
  'ml-questions-sweep',
  '*/10 * * * *',
  'SELECT net.http_post(
      current_setting(''app.settings.supabase_url'', true) || ''/functions/v1/ml-questions-sweep'',
      ''{}''::jsonb,
      ''{}''::jsonb
  );'
) WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'ml-questions-sweep'
);
