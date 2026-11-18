-- ============================================
-- 20261118000004 — Fix de tipos en bh_check_captacion_health
-- ============================================
-- La migración 20261118000003 creó la función con un bug de tipos:
--   to_char(v_st -> 'ml' ->> 'ultimo_lead', 'DD/MM/YYYY HH24:MI')
-- `->>` devuelve TEXT, no timestamptz → ERROR 42883 al ejecutar la función
-- (la migración aplicó bien; el error aparecía al INVOCAR la alarma, que
--  es lo que hizo el primer test en producción).
--
-- REGLA del proyecto: una migración ya aplicada NO se edita → el fix va acá.
-- (En una base nueva se aplican 003 y 004 en orden y queda igual.)
--
-- Fix: castear a timestamptz antes de formatear. NULL → NULL → 'nunca'.
-- ============================================

CREATE OR REPLACE FUNCTION public.bh_check_captacion_health(
  p_ml_horas_sin_consultas integer DEFAULT 48,
  p_rela_dias_sin_callbacks integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_st            jsonb;
  v_ml_estado     text;
  v_rela_estado   text;
  v_ml_leads_24h  integer := 0;
  v_ml_leads_7d   integer := 0;
  v_ml_ultimo_lead_ts timestamptz;
  v_open_alert    integer := 0;
  v_created       integer := 0;
  v_resolved      integer := 0;
BEGIN
  v_st := public.bh_captacion_status();
  v_ml_estado   := v_st -> 'ml'   ->> 'estado';
  v_rela_estado := v_st -> 'rela' ->> 'estado';

  SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours'),
         count(*) FILTER (WHERE created_at > now() - interval '7 days')
  INTO v_ml_leads_24h, v_ml_leads_7d
  FROM public.leads WHERE source = 'ml' AND deleted_at IS NULL;

  -- `->>` devuelve texto: hay que castear antes de formatear la fecha.
  BEGIN
    v_ml_ultimo_lead_ts := (v_st #>> '{ml,ultimo_lead}')::timestamptz;
  EXCEPTION WHEN others THEN
    v_ml_ultimo_lead_ts := NULL;
  END;

  -- ---------- ML sin consultas ----------
  SELECT count(*) INTO v_open_alert
  FROM public.supervision_alerts
  WHERE alert_type = 'ml_sin_consultas' AND status = 'open';

  IF v_ml_estado = 'sin_consultas' THEN
    IF v_open_alert = 0 THEN
      INSERT INTO public.supervision_alerts
        (module, severity, alert_type, title, description, evidence, status)
      VALUES (
        'portales',
        'high',
        'ml_sin_consultas',
        'Mercado Libre: no llegan consultas de las publicaciones',
        format('Hay %s publicación(es) activa(s) en Mercado Libre pero no entró ninguna consulta en las últimas %s h (último lead: %s). El canal suele traer 30+ consultas/mes: revisá el tópico VIS Leads en el gestor de aplicaciones de ML y el acceso de lectura de leads de inmuebles de la app.',
               (v_st -> 'ml' ->> 'publicaciones_activas')::integer,
               p_ml_horas_sin_consultas,
               COALESCE(to_char(v_ml_ultimo_lead_ts, 'DD/MM/YYYY HH24:MI'), 'nunca')),
        jsonb_build_object(
          'publicaciones_activas', (v_st -> 'ml' ->> 'publicaciones_activas')::integer,
          'eventos_vis_leads_7d', (v_st -> 'ml' ->> 'eventos_vis_leads_7d')::integer,
          'leads_7d', v_ml_leads_7d,
          'leads_24h', v_ml_leads_24h,
          'ultimo_evento', v_st -> 'ml' ->> 'ultimo_evento',
          'ultimo_lead', v_st -> 'ml' ->> 'ultimo_lead',
          'umbral_horas', p_ml_horas_sin_consultas
        ),
        'open'
      );
      v_created := v_created + 1;
    END IF;
  ELSIF v_open_alert > 0 THEN
    UPDATE public.supervision_alerts
    SET status = 'resolved',
        resolved_at = now(),
        notes = COALESCE(notes || ' | ', '') || 'Auto-resuelto: volvieron las consultas de ML.'
    WHERE alert_type = 'ml_sin_consultas' AND status = 'open';
    GET DIAGNOSTICS v_resolved = ROW_COUNT;
  END IF;

  -- ---------- RELA sin callbacks ----------
  SELECT count(*) INTO v_open_alert
  FROM public.supervision_alerts
  WHERE alert_type = 'rela_sin_callbacks' AND status = 'open';

  IF v_rela_estado = 'sin_callbacks' THEN
    IF v_open_alert = 0 THEN
      INSERT INTO public.supervision_alerts
        (module, severity, alert_type, title, description, evidence, status)
      VALUES (
        'portales',
        'high',
        'rela_sin_callbacks',
        'RELA / ZonaProp: hay avisos publicados pero no llegan callbacks',
        format('Hay %s aviso(s) publicado(s) en RELA y no entró ningún callback en los últimos %s días. El endpoint de callbacks puede no estar configurado en el panel de RELA o el secret no coincidir.',
               (v_st -> 'rela' ->> 'avisos_publicados')::integer,
               p_rela_dias_sin_callbacks),
        jsonb_build_object(
          'avisos_publicados', (v_st -> 'rela' ->> 'avisos_publicados')::integer,
          'avisos_bloqueados', (v_st -> 'rela' ->> 'avisos_bloqueados')::integer,
          'eventos_7d', (v_st -> 'rela' ->> 'eventos_7d')::integer,
          'ultimo_evento', v_st -> 'rela' ->> 'ultimo_evento',
          'umbral_dias', p_rela_dias_sin_callbacks
        ),
        'open'
      );
      v_created := v_created + 1;
    END IF;
  ELSIF v_open_alert > 0 THEN
    UPDATE public.supervision_alerts
    SET status = 'resolved',
        resolved_at = now(),
        notes = COALESCE(notes || ' | ', '') || 'Auto-resuelto: volvieron los callbacks de RELA.'
    WHERE alert_type = 'rela_sin_callbacks' AND status = 'open';
    GET DIAGNOSTICS v_resolved = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'estado', v_st,
    'alerts_created', v_created,
    'alerts_resolved', v_resolved
  );
END
$fn$;

-- Los permisos se re-afirman (CREATE OR REPLACE conserva los grants, pero el
-- default privileges de Supabase pueden re-otorgar authenticated: se revoca).
REVOKE ALL ON FUNCTION public.bh_check_captacion_health(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bh_check_captacion_health(integer, integer) TO service_role;
