-- zernio-sync: sincronizador incremental contra Zernio (cron cada 2 min).
-- Puentea la falta de webhook push: la API de Zernio no permite gestionar
-- webhooks (solo el dashboard, que maneja el dueño). El pull incremental trae
-- solo conversaciones con actividad nueva; los INSERT en zernio_messages
-- disparan el realtime ya cableado del panel (latencia <= 2 min).
-- Aplicada a producción como zernio_sync_cron (job cron id 25).
-- URL HARDCODEADA: gotcha del proyecto — current_setting('app.settings.supabase_url') es NULL.

INSERT INTO public.zernio_config (key, value)
VALUES ('sync_secret', '{"secret": "caddb570b4ac4dc8f78fd5d43f2be24c8d1a29b57db59df75d1f4f2e6f564db37f7"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

SELECT cron.unschedule('zernio-sync-every-2-min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'zernio-sync-every-2-min');

SELECT cron.schedule(
  'zernio-sync-every-2-min',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/zernio-sync',
    headers := '{"Content-Type": "application/json", "x-sync-secret": "caddb570b4ac4dc8f78fd5d43f2be24c8d1a29b57db59df75d1f4f2e6f564db37f7"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
