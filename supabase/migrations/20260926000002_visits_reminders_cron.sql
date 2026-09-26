-- Cron horario (minuto 15) que dispara la Edge Function visits-reminders.
SELECT cron.schedule(
  'visits-reminders',
  '15 * * * *',
  'SELECT net.http_post(
      current_setting(''app.settings.supabase_url'', true) || ''/functions/v1/visits-reminders'',
      ''{}''::jsonb,
      ''{}''::jsonb
  );'
) WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'visits-reminders'
);
