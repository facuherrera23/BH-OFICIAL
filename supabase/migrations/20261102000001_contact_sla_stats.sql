-- ============================================================
-- SLA de primer contacto — KPIs para el digest semanal (2026-11-02)
--
-- Mide dónde muere el funnel comercial: el canal ML entra perfecto
-- (43 leads en 60 días, 0 perdidas en el ledger) pero 24 quedaron en
-- cerrado_perdido y 0 se contactaron en <2 h. Con el SLA en
-- _shared/firstContact.ts, todo lead que entra solo nace con una
-- lead_task de 2 h + next_followup_at. Esta RPC agrega exacto
-- server-side lo que el digest semanal muestra al dueño:
--   · distribución de tiempo al primer contacto (<2h / 2-24h / >24h / sin)
--   · mediana de horas al primer contacto (percentile_cont)
--   · corte específico del canal ML (el único con volumen hoy)
--
-- Excluye source='newsletter' (suscriptores, no leads de contacto) y
-- los eliminados (deleted_at). SECURITY DEFINER + search_path vacío +
-- EXECUTE solo service_role (mismo hardening que supervision_digest_stats).
-- ============================================================

CREATE OR REPLACE FUNCTION public.supervision_digest_contact_sla(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total integer;
  v_under2 integer;
  v_2_24 integer;
  v_over24 integer;
  v_never integer;
  v_median_hours numeric;
  v_ml_total integer;
  v_ml_under2 integer;
  v_untouched_stale integer;
BEGIN
  SELECT count(*) INTO v_total
  FROM public.leads
  WHERE created_at >= p_from AND created_at < p_to
    AND deleted_at IS NULL
    AND (source IS NULL OR source <> 'newsletter');

  SELECT
    count(*) FILTER (WHERE last_contacted_at IS NOT NULL AND last_contacted_at <= created_at + interval '2 hours'),
    count(*) FILTER (WHERE last_contacted_at IS NOT NULL AND last_contacted_at > created_at + interval '2 hours'
                       AND last_contacted_at <= created_at + interval '24 hours'),
    count(*) FILTER (WHERE last_contacted_at IS NOT NULL AND last_contacted_at > created_at + interval '24 hours'),
    count(*) FILTER (WHERE last_contacted_at IS NULL)
  INTO v_under2, v_2_24, v_over24, v_never
  FROM public.leads
  WHERE created_at >= p_from AND created_at < p_to
    AND deleted_at IS NULL
    AND (source IS NULL OR source <> 'newsletter');

  /* Mediana de horas al primer contacto — solo los que tuvieron contacto. */
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY
           EXTRACT(EPOCH FROM (last_contacted_at - created_at)) / 3600.0)
  INTO v_median_hours
  FROM public.leads
  WHERE created_at >= p_from AND created_at < p_to
    AND deleted_at IS NULL
    AND last_contacted_at IS NOT NULL;

  /* Corte del canal ML (el que mueve el volumen hoy). */
  SELECT count(*),
         count(*) FILTER (WHERE last_contacted_at IS NOT NULL
                            AND last_contacted_at <= created_at + interval '2 hours')
  INTO v_ml_total, v_ml_under2
  FROM public.leads
  WHERE created_at >= p_from AND created_at < p_to
    AND deleted_at IS NULL
    AND source = 'ml';

  /* Backlog vivo: leads activos sin contacto hace >48 h (los que todavía
     se pueden rescatar — mismo corte que el KPI "Sin contacto +48h"). */
  SELECT count(*) INTO v_untouched_stale
  FROM public.leads
  WHERE deleted_at IS NULL
    AND stage NOT IN ('cerrado_ganado', 'cerrado_perdido')
    AND (last_contacted_at IS NULL OR last_contacted_at < now() - interval '48 hours');

  RETURN jsonb_build_object(
    'total', v_total,
    'contactUnder2h', v_under2,
    'contact2to24h', v_2_24,
    'contactOver24h', v_over24,
    'neverContacted', v_never,
    'medianHours', v_median_hours,
    'mlTotal', v_ml_total,
    'mlUnder2h', v_ml_under2,
    'untouchedStale', v_untouched_stale
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.supervision_digest_contact_sla(timestamptz, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supervision_digest_contact_sla(timestamptz, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.supervision_digest_contact_sla(timestamptz, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.supervision_digest_contact_sla(timestamptz, timestamptz) TO service_role;
