-- ---------------------------------------------------------------------------
-- CRON del recordatorio de tareas de lead (2026-11-26).
--
-- Patrón EXACTO de owner-tasks-reminder (que ya funciona y fue verificado
-- end-to-end): URL hardcodeada (current_setting('app.settings.*') es NULL en
-- este proyecto — 3.999 corridas fallidas por eso) + auth por x-sync-secret
-- leído de zernio_config en runtime (el cron corre como owner de la tabla,
-- RLS no aplica). Cada 15 min, igual que su par de propietarios.
--
-- ⚠️ Aplicar DESPUÉS de que el CI deploye la edge function lead-tasks-reminder:
-- si el cron corre antes de un deploy exitoso, cada corrida da 404 en silencio.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'lead-tasks-reminder',
  '*/15 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/lead-tasks-reminder',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (SELECT value->>'secret' FROM public.zernio_config WHERE key = 'sync_secret' LIMIT 1)
      ),
      body := '{}'::jsonb
    );
  $$
);
