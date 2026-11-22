-- ============================================
-- 20261122000001 — Alarma de API de RELA caída (auto-resuelve)
-- ============================================
-- Motivo (2026-11-22): el sandbox de Open RELA
-- (https://api-zp-sandbox-open.navent.com) volvió a responder HTTP 521.
-- `rela-sync` ya es fail-soft (commit 28fe5d8): guarda el motivo en
-- `rela_config.last_error` y responde degraded:true, pero nadie lo miraba —
-- el cron seguía marcando "succeeded" porque pg_net reporta el SELECT, no
-- la respuesta HTTP de la edge function.
--
-- Esta migración RECREA `bh_check_captacion_health(integer, integer)` con un
-- cuarto bloque que abre `rela_api_down` cuando `last_error` está presente y
-- la cierra sola cuando `rela-sync` la limpia tras una corrida exitosa.
-- No agrega parámetros (la firma con 2 args ya tiene los GRANT correctos) y
-- no necesita nueva edge function ni nuevo cron: usa `bh-captacion-health-hourly`.
--
-- REGLA: una migración ya aplicada NO se edita (por eso va en archivo nuevo).
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
  v_rela_api_error   text;
  v_rela_api_last    timestamptz;
  v_rela_api_base    text;
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

  -- ---------- RELA API caída (521 / login / red) ----------
  -- `rela-sync` (fail-soft) escribe last_error en cada fallo y la limpia en
  -- el primer polling exitoso. No hace falta ninguna llamada de red acá: la
  -- señal ya la dejó el cron que corre cada 10 min.
  SELECT last_error, last_sync_at, base_url
  INTO v_rela_api_error, v_rela_api_last, v_rela_api_base
  FROM public.rela_config WHERE id = true;

  SELECT count(*) INTO v_open_alert
  FROM public.supervision_alerts
  WHERE alert_type = 'rela_api_down' AND status = 'open';

  IF v_rela_api_error IS NOT NULL THEN
    IF v_open_alert = 0 THEN
      INSERT INTO public.supervision_alerts
        (module, severity, alert_type, title, description, evidence, status)
      VALUES (
        'portales',
        'high',
        'rela_api_down',
        'RELA / ZonaProp: la API no responde',
        format('El último polling de contactos falló: %s. Última corrida: %s. Mientras la API esté caída no se importan contactos ni se pueden publicar avisos. El cron reintenta cada 10 minutos y esta alarma se cierra sola en cuanto vuelva.',
               left(v_rela_api_error, 300),
               COALESCE(to_char(v_rela_api_last, 'DD/MM/YYYY HH24:MI'), 'nunca')),
        jsonb_build_object(
          'last_error', left(v_rela_api_error, 500),
          'last_sync_at', v_rela_api_last,
          'base_url', v_rela_api_base
        ),
        'open'
      );
      v_created := v_created + 1;
    END IF;
  ELSIF v_open_alert > 0 THEN
    UPDATE public.supervision_alerts
    SET status = 'resolved',
        resolved_at = now(),
        notes = COALESCE(notes || ' | ', '') || 'Auto-resuelto: la API de RELA volvió a responder.'
    WHERE alert_type = 'rela_api_down' AND status = 'open';
    GET DIAGNOSTICS v_resolved = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'estado', v_st,
    'alerts_created', v_created,
    'alerts_resolved', v_resolved
  );
END
$fn$;

-- La firma NO cambia (integer, integer): los GRANT existentes se conservan.
-- Se re-afirman igual que en 20261118000004 por el default privileges de
-- Supabase, que puede re-otorgar EXECUTE a authenticated.
REVOKE ALL ON FUNCTION public.bh_check_captacion_health(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bh_check_captacion_health(integer, integer) TO service_role;
