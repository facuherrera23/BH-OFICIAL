-- ============================================================
-- Retención de ml_webhook_events (2026-11-02)
--
-- El diario del webhook de ML recibe ~5k eventos/día, la gran mayoría
-- ruido de eco (items re-notificados sin cambios). En 4 semanas ya hay
-- 155k filas. Sin política, en un año son ~2M.
--
-- Política (decisión 2026-11-02, propietario OK):
--   · Ruido (tópicos que NO son vis_leads/questions) procesado hace >21 días
--     → se borra. El ruido no sirve para diagnosticar después de 2 semanas.
--   · Valiosos (vis_leads/questions — las consultas de inmuebles que se
--     re-importan si ML las re-habilita) y eventos stuck/failed → se
--     conservan 180 días.
--   · Lote máximo por corrida: 50k filas (el cron diario va vaciando sin
--     bloqueos largos).
--
-- Función SQL pura + cron directo (patrón purge_supervision_alerts: sin
-- HTTP ni secrets — el cron corre como postgres).
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_ml_webhook_events(p_max_rows integer DEFAULT 50000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_noise integer := 0;
  v_old integer := 0;
BEGIN
  /* Ruido: items y otros tópicos procesados hace más de 21 días. */
  DELETE FROM public.ml_webhook_events
  WHERE id IN (
    SELECT id FROM public.ml_webhook_events
    WHERE status = 'processed'
      AND topic NOT IN ('vis_leads', 'questions')
      AND received_at < now() - interval '21 days'
    ORDER BY received_at
    LIMIT GREATEST(p_max_rows, 1)
  );
  GET DIAGNOSTICS v_noise = ROW_COUNT;

  /* Valiosos (vis_leads/questions) y eventos stuck: más de 180 días. */
  DELETE FROM public.ml_webhook_events
  WHERE id IN (
    SELECT id FROM public.ml_webhook_events
    WHERE received_at < now() - interval '180 days'
    ORDER BY received_at
    LIMIT GREATEST(p_max_rows, 1)
  );
  GET DIAGNOSTICS v_old = ROW_COUNT;

  RETURN jsonb_build_object('noise_deleted', v_noise, 'old_deleted', v_old);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_ml_webhook_events(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_ml_webhook_events(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.purge_ml_webhook_events(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_ml_webhook_events(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_ml_webhook_events(integer) TO postgres;

-- Cron diario 04:45 ART (07:45 UTC) — lejos del backup-snapshot (04:00 ART).
SELECT cron.schedule(
  'ml-webhook-events-purge-daily',
  '45 7 * * *',
  $cron$SELECT public.purge_ml_webhook_events()$cron$
);
