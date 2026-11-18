-- ============================================
-- 20261118000003 — Estado y alarma de captación
-- ============================================
-- MOTIVO (auditoría 18/11/2026): el embudo estaba ciego.
--   • ML dejó de entregar consultas el 10/11 (0 eventos vis_leads desde entonces)
--     y NADIE lo notó: el panel de Portales mostraba "conectado" + "N avisos
--     activos", nunca "última consulta".
--   • RELA nunca recibió un solo callback (rela_webhook_events = 0 filas desde
--     siempre) pero el panel no lo decía → el dueño creía que estaba integrado.
--   • La landing no tiene medición de tráfico: GA4/Clarity solo cargan con
--     consentimiento 'all' y no hay beacon propio → no se sabe si entra gente.
--
-- QUÉ HACE ESTA MIGRACIÓN:
--   1. bh_captacion_status()   → estado real por canal (lectura, para el panel).
--   2. bh_check_captacion_health() → abre/cierra una alerta en supervision_alerts
--      cuando un canal con publicaciones activas deja de entregar consultas.
--   3. Cron horario de la alarma.
--
-- REGLA DURA: solo lectura sobre los datos de captación (conteos + fechas).
-- No toca leads, no borra nada. Las alertas se auto-resuelven cuando el
-- canal vuelve (queda el histórico, como la alarma de Disk IO).
-- ============================================

-- ------------------------------------------------------------
-- 1. Estado de captación por canal (lectura)
-- ------------------------------------------------------------
-- Canales:
--   ml      → Mercado Libre (webhook vis_leads + sweep)
--   rela    → ZonaProp/RELA (callback; hoy 100% alta manual del dueño)
--   web     → landing + fichas (formulario / handoff de WhatsApp)
CREATE OR REPLACE FUNCTION public.bh_captacion_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_ml_publicadas       integer := 0;
  v_ml_ultimo_evento    timestamptz;
  v_ml_eventos_7d       integer := 0;
  v_ml_leads_7d         integer := 0;
  v_ml_leads_30d        integer := 0;
  v_ml_ultimo_lead      timestamptz;

  v_rela_publicados     integer := 0;
  v_rela_bloqueados     integer := 0;
  v_rela_ultimo_evento  timestamptz;
  v_rela_eventos_7d     integer := 0;
  v_rela_leads_7d       integer := 0;
  v_rela_leads_30d      integer := 0;
  v_rela_ultimo_lead    timestamptz;

  v_web_leads_7d        integer := 0;
  v_web_leads_30d       integer := 0;
  v_web_ultimo_lead     timestamptz;

  v_ml_estado           text;
  v_rela_estado         text;
  v_web_estado          text;
  v_ml_silencio_dias    integer;
  v_rela_silencio_dias  integer;
  v_web_silencio_dias   integer;
BEGIN
  -- ---------- Mercado Libre ----------
  SELECT count(*) INTO v_ml_publicadas
  FROM public.ml_listings WHERE ml_status = 'active';

  SELECT max(received_at),
         count(*) FILTER (WHERE received_at > now() - interval '7 days')
  INTO v_ml_ultimo_evento, v_ml_eventos_7d
  FROM public.ml_webhook_events WHERE topic = 'vis_leads';

  SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days'),
         count(*) FILTER (WHERE created_at > now() - interval '30 days'),
         max(created_at)
  INTO v_ml_leads_7d, v_ml_leads_30d, v_ml_ultimo_lead
  FROM public.leads WHERE source = 'ml' AND deleted_at IS NULL;

  -- ---------- RELA / ZonaProp ----------
  SELECT count(*) FILTER (WHERE status = 'PUBLISHED'),
         count(*) FILTER (WHERE status = 'BLOCKED')
  INTO v_rela_publicados, v_rela_bloqueados
  FROM public.rela_listings;

  SELECT max(received_at),
         count(*) FILTER (WHERE received_at > now() - interval '7 days')
  INTO v_rela_ultimo_evento, v_rela_eventos_7d
  FROM public.rela_webhook_events;

  SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days'),
         count(*) FILTER (WHERE created_at > now() - interval '30 days'),
         max(created_at)
  INTO v_rela_leads_7d, v_rela_leads_30d, v_rela_ultimo_lead
  FROM public.leads WHERE source = 'rela_zonaprop' AND deleted_at IS NULL;

  -- ---------- Web (landing + fichas) ----------
  -- 'whatsapp' = handoff del click de WhatsApp en el sitio (origen del canal).
  SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days'),
         count(*) FILTER (WHERE created_at > now() - interval '30 days'),
         max(created_at)
  INTO v_web_leads_7d, v_web_leads_30d, v_web_ultimo_lead
  FROM public.leads
  WHERE source IN ('landing_page', 'landing', 'web', 'contacto', 'whatsapp')
    AND deleted_at IS NULL;

  -- ---------- Semáforos ----------
  IF v_ml_publicadas = 0 THEN
    v_ml_estado := 'sin_publicaciones';
  ELSIF v_ml_leads_7d > 0 OR v_ml_eventos_7d > 0 THEN
    v_ml_estado := 'ok';
  ELSE
    v_ml_estado := 'sin_consultas';
  END IF;

  IF v_rela_leads_7d > 0 THEN
    v_rela_estado := 'ok';
  ELSIF v_rela_publicados > 0 AND v_rela_eventos_7d = 0 THEN
    v_rela_estado := 'sin_callbacks';
  ELSIF v_rela_publicados = 0 AND v_rela_bloqueados > 0 THEN
    v_rela_estado := 'avisos_bloqueados';
  ELSE
    v_rela_estado := 'sin_avisos';
  END IF;

  IF v_web_leads_7d > 0 THEN
    v_web_estado := 'ok';
  ELSE
    v_web_estado := 'sin_captura';
  END IF;

  v_ml_silencio_dias   := CASE WHEN v_ml_ultimo_lead IS NULL THEN NULL
                                ELSE GREATEST(floor(extract(epoch FROM (now() - v_ml_ultimo_lead)) / 86400)::integer, 0) END;
  v_rela_silencio_dias := CASE WHEN v_rela_ultimo_lead IS NULL THEN NULL
                                ELSE GREATEST(floor(extract(epoch FROM (now() - v_rela_ultimo_lead)) / 86400)::integer, 0) END;
  v_web_silencio_dias  := CASE WHEN v_web_ultimo_lead IS NULL THEN NULL
                                ELSE GREATEST(floor(extract(epoch FROM (now() - v_web_ultimo_lead)) / 86400)::integer, 0) END;

  RETURN jsonb_build_object(
    'generado_at', now(),
    'ml', jsonb_build_object(
      'estado', v_ml_estado,
      'publicaciones_activas', v_ml_publicadas,
      'eventos_vis_leads_7d', v_ml_eventos_7d,
      'ultimo_evento', v_ml_ultimo_evento,
      'leads_7d', v_ml_leads_7d,
      'leads_30d', v_ml_leads_30d,
      'ultimo_lead', v_ml_ultimo_lead,
      'silencio_dias', v_ml_silencio_dias
    ),
    'rela', jsonb_build_object(
      'estado', v_rela_estado,
      'avisos_publicados', v_rela_publicados,
      'avisos_bloqueados', v_rela_bloqueados,
      'eventos_7d', v_rela_eventos_7d,
      'ultimo_evento', v_rela_ultimo_evento,
      'leads_7d', v_rela_leads_7d,
      'leads_30d', v_rela_leads_30d,
      'ultimo_lead', v_rela_ultimo_lead,
      'silencio_dias', v_rela_silencio_dias
    ),
    'web', jsonb_build_object(
      'estado', v_web_estado,
      'leads_7d', v_web_leads_7d,
      'leads_30d', v_web_leads_30d,
      'ultimo_lead', v_web_ultimo_lead,
      'silencio_dias', v_web_silencio_dias
    )
  );
END
$fn$;

-- ------------------------------------------------------------
-- 2. Alarma: abre/cierra alertas de captación
-- ------------------------------------------------------------
-- ML: hay publicaciones activas pero 0 consultas en 48 h → alerta.
-- RELA: hay avisos publicados pero 0 callbacks en 7 días → alerta.
-- (Si no hay publicaciones/avisos no hay nada que capturing → no alerta:
--  es el caso normal de "todavía no publicamos en ese canal".)
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
               COALESCE(to_char(v_st -> 'ml' ->> 'ultimo_lead', 'DD/MM/YYYY HH24:MI'), 'nunca')),
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

-- ------------------------------------------------------------
-- 3. Permisos
-- ------------------------------------------------------------
-- La función de ESCRITURA (alarma) es solo service_role: crea alertas.
REVOKE ALL ON FUNCTION public.bh_captacion_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bh_check_captacion_health(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bh_captacion_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bh_check_captacion_health(integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 4. Cron horario
-- ------------------------------------------------------------
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'bh-captacion-health-hourly';
SELECT cron.schedule(
  'bh-captacion-health-hourly',
  '20 * * * *',
  $cron$
  SELECT public.bh_check_captacion_health();
  $cron$
);
