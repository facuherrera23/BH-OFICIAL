-- ---------------------------------------------------------------------------
-- P1-8 (2026-11-27): "MI DÍA" — las 3 acciones más urgentes del agente.
--
-- Diagnóstico: "Mi bandeja" (2026-11-26) trae TODO lo que hay que atender
-- (5 secciones, hasta 90 filas). Para el dueño que es un inventario; para el
-- agente que tiene que trabajar HOY es demasiado: abre la bandeja, ve 21
-- seguimientos + 14 visitas + 9 sin dueño y no sabe por dónde empezar.
--
-- Lo que faltaba: una respuesta de una línea a "¿qué hago ahora?" — las 3
-- acciones más urgentes, en orden, con el lead y el teléfono a mano.
--
-- Reglas de la RPC `mi_dia(p_user_id uuid DEFAULT NULL)`:
--   · SECURITY DEFINER + `search_path = ''` (objetos calificados) + sin anon.
--   · Alcance por rol (igual que mi_bandeja): super_admin/broker ven todo;
--     un agente ve sólo lo suyo (assigned_to = su agente).
--   · 5 categorías, en este ORDEN de urgencia, y se cortan en 3:
--       1. visita  → la visita de HOY (o la próxima si no hay ninguna hoy)
--       2. espera  → un lead que volvió de "en espera" (hay que decidir)
--       3. seguimiento → el seguimiento más viejo que ya venció
--       4. tarea   → la tarea más vieja que ya venció
--       5. contacto → el lead sin NINGÚN contacto (más viejo primero)
--     Un lead no se repite: si ya apareció en una categoría, queda fuera de
--     las siguientes (v_picked).
--   · Devuelve además los CONTEOS por categoría: "y 4 seguimientos más
--     vencidos" — el top 3 no puede tapar el volumen.
--   · Los conteos usan EXACTAMENTE el mismo filtro que el ítem → el número
--     que ve el agente ES el número real.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mi_dia(p_user_id uuid DEFAULT NULL)
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
  v_ver_todos := (v_role IN ('super_admin', 'broker'));

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
    v_items := jsonb_array_append(v_items, v_item);
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
    v_items := jsonb_array_append(v_items, v_item);
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
    v_items := jsonb_array_append(v_items, v_item);
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
    v_items := jsonb_array_append(v_items, v_item);
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
     AND (v_ver_todos OR l.assigned_to = v_agent OR l.assigned_to IS NULL);

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
     AND (v_ver_todos OR l.assigned_to = v_agent OR l.assigned_to IS NULL)
     AND NOT (l.id = ANY(v_picked))
   ORDER BY l.created_at ASC
   LIMIT 1;
  IF FOUND AND jsonb_array_length(v_items) < 3 THEN
    v_items := jsonb_array_append(v_items, v_item);
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

REVOKE ALL ON FUNCTION public.mi_dia(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_dia(uuid) TO authenticated, service_role;
