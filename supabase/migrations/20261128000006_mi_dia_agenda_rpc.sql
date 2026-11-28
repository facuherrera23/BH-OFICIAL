-- ============================================
-- 20261128000006 — mi_dia_agenda: próximos N días para el mail diario
-- ============================================
-- MOTIVO: el resumen diario (agent-daily-digest) responde "¿qué hago ahora?"
-- con el top 3 de mi_dia, pero no muestra LO QUE YA ESTÁ AGENDADO. Un agente
-- que abre el mail a las 08:00 necesita ver también las visitas y tareas de
-- los próximos 3 días para organizar el día, sin abrir el panel.
--
-- Diseño (idéntico a mi_dia, sin duplicar su lógica de urgencia):
--   · SECURITY DEFINER + search_path='' + objects calificados.
--   · Alcance por rol: super_admin/broker ven todo; agente ve lo suyo
--     (visitas.agent_id / leads.assigned_to = su agente).
--   · Ventana en hora ART: desde medianoche de hoy hasta medianoche de
--     hoy + p_dias (default 3, clamp 1..14).
--   · Visitas: status pendiente/confirmada, sin deleted_at (labels REALES del
--     enum visit_status, verificados con enum_range: pendiente, confirmada,
--     completada, cancelada, en_curso, no_show). Nunca inventar labels.
--   · Tareas: status pendiente/en_progreso, lead vivo y no terminal (mismo
--     filtro de lead que mi_dia), due_at en la ventana.
--   · Top 10 por familia + conteo REAL completo (el mail no se infla y el
--     número que muestra es el que hay).
--   · La edge function maneja 'error'/'sin sesion' y degrada sin frenar el top 3.
-- ============================================

CREATE OR REPLACE FUNCTION public.mi_dia_agenda(
  p_user_id uuid DEFAULT NULL,
  p_dias integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid        uuid := COALESCE(p_user_id, auth.uid());
  v_role       text;
  v_agent      uuid;
  v_agente     text;
  v_ver_todos  boolean;
  v_dias       integer := LEAST(GREATEST(COALESCE(p_dias, 3), 1), 14);
  v_desde      timestamptz;
  v_hasta      timestamptz;
  v_visitas    jsonb := '[]'::jsonb;
  v_tareas     jsonb := '[]'::jsonb;
  v_c_vis      integer := 0;
  v_c_tar      integer := 0;
  v_hoy        date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;

  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  SELECT a.id, a.full_name INTO v_agent, v_agente
    FROM public.agents a
   WHERE a.profile_id = v_uid AND a.status = 'activo' AND a.deleted_at IS NULL
   ORDER BY a.created_at
   LIMIT 1;
  v_ver_todos := (v_role IN ('super_admin', 'broker'));

  v_desde := v_hoy::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires';
  v_hasta := (v_hoy + v_dias)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires';

  ------------------------------------------------------------------
  -- Visitas de los próximos días
  ------------------------------------------------------------------
  SELECT count(*) INTO v_c_vis
    FROM public.visits v
   WHERE v.deleted_at IS NULL
     AND v.status IN ('pendiente', 'confirmada')
     AND v.visit_date >= v_desde
     AND v.visit_date < v_hasta
     AND (v_ver_todos OR v.agent_id = v_agent);

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'tipo', 'visita',
             'visita_id', x.id,
             'lead_id', x.lead_id,
             'fecha', x.visit_date,
             'nombre', COALESCE(NULLIF(x.client_name, ''), x.full_name),
             'telefono', x.client_phone,
             'titulo', 'Visita',
             'detalle', to_char(x.visit_date at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')
                        || CASE WHEN x.property_code IS NOT NULL THEN ' · ' || x.property_code ELSE '' END
           ) ORDER BY x.visit_date
         ), '[]'::jsonb)
    INTO v_visitas
    FROM (
      SELECT v.id, v.lead_id, v.visit_date, v.client_name, v.client_phone,
             l.full_name, p.property_code
        FROM public.visits v
        LEFT JOIN public.leads l ON l.id = v.lead_id
        LEFT JOIN public.properties p ON p.id = v.property_id
       WHERE v.deleted_at IS NULL
         AND v.status IN ('pendiente', 'confirmada')
         AND v.visit_date >= v_desde
         AND v.visit_date < v_hasta
         AND (v_ver_todos OR v.agent_id = v_agent)
       ORDER BY v.visit_date ASC
       LIMIT 10
    ) x;

  ------------------------------------------------------------------
  -- Tareas con vencimiento en los próximos días
  ------------------------------------------------------------------
  SELECT count(*) INTO v_c_tar
    FROM public.lead_tasks t
    JOIN public.leads l ON l.id = t.lead_id
   WHERE t.status IN ('pendiente', 'en_progreso')
     AND t.due_at >= v_desde
     AND t.due_at < v_hasta
     AND l.deleted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND (v_ver_todos OR l.assigned_to = v_agent);

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'tipo', 'tarea',
             'tarea_id', x.id,
             'lead_id', x.lead_id,
             'fecha', x.due_at,
             'nombre', x.full_name,
             'telefono', COALESCE(NULLIF(x.whatsapp, ''), x.phone),
             'titulo', x.title,
             'detalle', to_char(x.due_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')
                        || ' · ' || x.priority
           ) ORDER BY x.due_at
         ), '[]'::jsonb)
    INTO v_tareas
    FROM (
      SELECT t.id, t.lead_id, t.title, t.priority, t.due_at,
             l.full_name, l.whatsapp, l.phone
        FROM public.lead_tasks t
        JOIN public.leads l ON l.id = t.lead_id
       WHERE t.status IN ('pendiente', 'en_progreso')
         AND t.due_at >= v_desde
         AND t.due_at < v_hasta
         AND l.deleted_at IS NULL
         AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
         AND (v_ver_todos OR l.assigned_to = v_agent)
       ORDER BY t.due_at ASC
       LIMIT 10
    ) x;

  RETURN jsonb_build_object(
    'ok', true,
    'agente', v_agente,
    'desde', v_desde,
    'hasta', v_hasta,
    'dias', v_dias,
    'visitas', v_visitas,
    'tareas', v_tareas,
    'conteos', jsonb_build_object(
      'visitas', v_c_vis,
      'tareas', v_c_tar,
      'total', v_c_vis + v_c_tar
    )
  );
END;
$function$;

-- Mismo contrato de permisos que mi_dia (anon NUNCA; authenticated con su uid).
REVOKE ALL ON FUNCTION public.mi_dia_agenda(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_dia_agenda(uuid, integer) TO authenticated, service_role;
