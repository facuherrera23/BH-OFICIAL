-- ============================================
-- 20261128000008 — mi_dia / mi_dia_agenda: alcance SOLO PROPIO para el mail
-- ============================================
-- Hallazgo real (28/11/2026): el resumen diario se envía por agente, pero
-- ambos agentes activos son super_admin y mi_dia da visión global a ese rol.
-- resultado: Danilo y Helmut recibían el MISMO top 3 (14 seguimientos
-- vencidos = 10 de Danilo + 4 de Helmut, y los 3 ítems del mail eran todos
-- de Helmut). Para el dueño está bien ver todo en el CRM; para el mail de
-- cada agente no sirve: no le dice "qué hago YO".
--
-- Fix: parámetro nuevo p_solo_propio boolean DEFAULT false. Con false (default)
-- el comportamiento es EXACTAMENTE el actual (CRM intacto, db().rpc('mi_dia')
-- sigue andando sin argumentos). Con true se ignora el alcance por rol y se
-- filtra por el agente vinculado al profile; además los leads SIN asignar
-- (que en la bandeja del agente sí se muestran) quedan fuera del mail.
--
-- Se Dropean las firmas viejas y se crean las nuevas: en Postgres un
-- CREATE OR REPLACE con otro número de argumentos crea una SOBRECARGA, no
-- reemplaza; dejar las dos haría ambigua la llamada por nombre. No se toca
-- ningún dato: son funciones, no tablas.
--
-- Permisos: mi_dia mantiene authenticated + service_role (lo llama el panel);
-- mi_dia_agenda sigue siendo SOLO service_role (lo llama el cron).
-- ============================================

DROP FUNCTION IF EXISTS public.mi_dia(uuid);
CREATE OR REPLACE FUNCTION public.mi_dia(p_user_id uuid DEFAULT NULL, p_solo_propio boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := COALESCE(p_user_id, auth.uid());
  v_role text;
  v_agent uuid;
  v_agente text;
  v_ver_todos boolean;
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_lead uuid;
  v_picked uuid[] := ARRAY[]::uuid[];
  v_c_vis integer := 0;
  v_c_vis_semana integer := 0;
  v_c_esp integer := 0;
  v_c_seg integer := 0;
  v_c_tar integer := 0;
  v_c_con integer := 0;
  /* "Hoy" en hora de Argentina (la DB trabaja en UTC). */
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_hoy_ts timestamptz := ((now() at time zone 'America/Argentina/Buenos_Aires')::date::timestamp
                           AT TIME ZONE 'America/Argentina/Buenos_Aires');
  v_manana_ts timestamptz := (((now() at time zone 'America/Argentina/Buenos_Aires')::date + 1)::timestamp
                           AT TIME ZONE 'America/Argentina/Buenos_Aires');
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
  v_ver_todos := (NOT COALESCE(p_solo_propio, false)) AND (v_role IN ('super_admin', 'broker'));

  ------------------------------------------------------------------
  -- 1) VISITA (hoy; si no hay ninguna, la próxima de la semana)
  ------------------------------------------------------------------
  SELECT count(*) INTO v_c_vis
    FROM public.visits v
   WHERE v.deleted_at IS NULL
     AND v.status IN ('pendiente', 'confirmada')
     AND v.visit_date >= v_hoy_ts AND v.visit_date < v_manana_ts
     AND (v_ver_todos OR v.agent_id = v_agent);

  SELECT count(*) INTO v_c_vis_semana
    FROM public.visits v
   WHERE v.deleted_at IS NULL
     AND v.status IN ('pendiente', 'confirmada')
     AND v.visit_date >= v_hoy_ts AND v.visit_date < v_manana_ts + interval '7 days'
     AND (v_ver_todos OR v.agent_id = v_agent);

  SELECT jsonb_build_object(
           'tipo', 'visita', 'prioridad', 1, 'accion', 'agenda',
           'lead_id', v.lead_id,
           'nombre', COALESCE(NULLIF(v.client_name, ''), l.full_name),
           'telefono', v.client_phone,
           'fecha', v.visit_date,
           'propiedad', p.property_code,
           'titulo', CASE WHEN v.visit_date < v_manana_ts THEN 'Visita de hoy' ELSE 'Próxima visita' END,
           'detalle', to_char(v.visit_date at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')
                     || CASE WHEN p.property_code IS NOT NULL THEN ' · ' || p.property_code ELSE '' END
         ), v.lead_id
    INTO v_item, v_lead
    FROM public.visits v
    LEFT JOIN public.leads l ON l.id = v.lead_id
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE v.deleted_at IS NULL
     AND v.status IN ('pendiente', 'confirmada')
     AND v.visit_date >= v_hoy_ts
     AND v.visit_date < v_manana_ts + interval '7 days'
     AND (v_ver_todos OR v.agent_id = v_agent)
   ORDER BY v.visit_date ASC
   LIMIT 1;
  IF FOUND AND jsonb_array_length(v_items) < 3 THEN
    v_items := v_items || jsonb_build_array(v_item);
    IF v_lead IS NOT NULL THEN v_picked := array_append(v_picked, v_lead); END IF;
  END IF;

  ------------------------------------------------------------------
  -- 2) ESPERA (volvió de "en espera": hay que decidir, no esperar)
  ------------------------------------------------------------------
  SELECT count(*) INTO v_c_esp
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.stage::text = 'en_espera'
     AND l.next_followup_at IS NOT NULL AND l.next_followup_at < now()
     AND (v_ver_todos OR l.assigned_to = v_agent);

  SELECT jsonb_build_object(
           'tipo', 'espera', 'prioridad', 2, 'accion', 'reactivar',
           'lead_id', l.id, 'nombre', l.full_name,
           'telefono', COALESCE(NULLIF(l.whatsapp, ''), l.phone),
           'fecha', l.next_followup_at,
           'stage_previo', l.stage_previo,
           'titulo', 'Volver de espera',
           'detalle', 'Volvió el ' || to_char(l.next_followup_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
                     || ' · vuelve a "' || COALESCE(l.stage_previo, 'su etapa') || '"'
         ), l.id
    INTO v_item, v_lead
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.stage::text = 'en_espera'
     AND l.next_followup_at IS NOT NULL AND l.next_followup_at < now()
     AND (v_ver_todos OR l.assigned_to = v_agent)
     AND NOT (l.id = ANY(v_picked))
   ORDER BY l.next_followup_at ASC
   LIMIT 1;
  IF FOUND AND jsonb_array_length(v_items) < 3 THEN
    v_items := v_items || jsonb_build_array(v_item);
    IF v_lead IS NOT NULL THEN v_picked := array_append(v_picked, v_lead); END IF;
  END IF;

  ------------------------------------------------------------------
  -- 3) SEGUIMIENTO (el más viejo que ya venció)
  ------------------------------------------------------------------
  SELECT count(*) INTO v_c_seg
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND l.next_followup_at IS NOT NULL AND l.next_followup_at < now()
     AND (v_ver_todos OR l.assigned_to = v_agent);

  SELECT jsonb_build_object(
           'tipo', 'seguimiento', 'prioridad', 3, 'accion', 'contactar',
           'lead_id', l.id, 'nombre', l.full_name,
           'telefono', COALESCE(NULLIF(l.whatsapp, ''), l.phone),
           'stage', l.stage,
           'fecha', l.next_followup_at,
           'titulo', 'Seguimiento vencido',
           'detalle', 'Venció el ' || to_char(l.next_followup_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
         ), l.id
    INTO v_item, v_lead
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND l.next_followup_at IS NOT NULL AND l.next_followup_at < now()
     AND (v_ver_todos OR l.assigned_to = v_agent)
     AND NOT (l.id = ANY(v_picked))
   ORDER BY l.next_followup_at ASC
   LIMIT 1;
  IF FOUND AND jsonb_array_length(v_items) < 3 THEN
    v_items := v_items || jsonb_build_array(v_item);
    IF v_lead IS NOT NULL THEN v_picked := array_append(v_picked, v_lead); END IF;
  END IF;

  ------------------------------------------------------------------
  -- 4) TAREA (la más vieja vencida)
  ------------------------------------------------------------------
  SELECT count(*) INTO v_c_tar
    FROM public.lead_tasks t
    JOIN public.leads l ON l.id = t.lead_id
   WHERE t.status IN ('pendiente', 'en_progreso')
     AND t.due_at < now()
     AND l.deleted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND (v_ver_todos OR l.assigned_to = v_agent);

  SELECT jsonb_build_object(
           'tipo', 'tarea', 'prioridad', 4, 'accion', 'tarea',
           'lead_id', l.id, 'tarea_id', t.id,
           'nombre', l.full_name,
           'telefono', COALESCE(NULLIF(l.whatsapp, ''), l.phone),
           'titulo', 'Tarea vencida',
           'detalle', t.title || ' · venció el '
                     || to_char(t.due_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
         ), l.id
    INTO v_item, v_lead
    FROM public.lead_tasks t
    JOIN public.leads l ON l.id = t.lead_id
   WHERE t.status IN ('pendiente', 'en_progreso')
     AND t.due_at < now()
     AND l.deleted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND (v_ver_todos OR l.assigned_to = v_agent)
     AND NOT (l.id = ANY(v_picked))
   ORDER BY t.due_at ASC
   LIMIT 1;
  IF FOUND AND jsonb_array_length(v_items) < 3 THEN
    v_items := v_items || jsonb_build_array(v_item);
    IF v_lead IS NOT NULL THEN v_picked := array_append(v_picked, v_lead); END IF;
  END IF;

  ------------------------------------------------------------------
  -- 5) CONTACTO (lead sin NINGÚN contacto, más viejo primero)
  ------------------------------------------------------------------
  SELECT count(*) INTO v_c_con
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.last_contacted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND l.created_at < now() - interval '24 hours'
     AND (v_ver_todos OR l.assigned_to = v_agent OR (NOT COALESCE(p_solo_propio, false) AND l.assigned_to IS NULL));

  SELECT jsonb_build_object(
           'tipo', 'contacto', 'prioridad', 5, 'accion', 'contactar',
           'lead_id', l.id, 'nombre', l.full_name,
           'telefono', COALESCE(NULLIF(l.whatsapp, ''), l.phone),
           'stage', l.stage,
           'fecha', l.created_at,
           'titulo', 'Nunca contactado',
           'detalle', 'Entró el ' || to_char(l.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
                     || ' y sigue sin un solo contacto'
         ), l.id
    INTO v_item, v_lead
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.last_contacted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND l.created_at < now() - interval '24 hours'
     AND (v_ver_todos OR l.assigned_to = v_agent OR (NOT COALESCE(p_solo_propio, false) AND l.assigned_to IS NULL))
     AND NOT (l.id = ANY(v_picked))
   ORDER BY l.created_at ASC
   LIMIT 1;
  IF FOUND AND jsonb_array_length(v_items) < 3 THEN
    v_items := v_items || jsonb_build_array(v_item);
    IF v_lead IS NOT NULL THEN v_picked := array_append(v_picked, v_lead); END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'agente', v_agente,
    'items', v_items,
    'conteos', jsonb_build_object(
      'visitas', v_c_vis,
      'visitas_semana', v_c_vis_semana,
      'esperas', v_c_esp,
      'seguimientos', v_c_seg,
      'tareas', v_c_tar,
      'sin_contacto', v_c_con
    ),
    'total', v_c_vis + v_c_esp + v_c_seg + v_c_tar + v_c_con
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mi_dia(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_dia(uuid, boolean) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.mi_dia_agenda(uuid, integer);
CREATE OR REPLACE FUNCTION public.mi_dia_agenda(
  p_user_id uuid DEFAULT NULL,
  p_dias integer DEFAULT 3,
  p_solo_propio boolean DEFAULT false
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
  v_ver_todos := (NOT COALESCE(p_solo_propio, false)) AND (v_role IN ('super_admin', 'broker'));

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

REVOKE ALL ON FUNCTION public.mi_dia_agenda(uuid, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mi_dia_agenda(uuid, integer, boolean) TO service_role;
