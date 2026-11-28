-- ============================================
-- 20261128000010 — Operación proactiva: dueño, escalado y vencidas
-- ============================================
-- Hallazgos reales (28/11/2026, sólo lectura en producción):
--   · `mi_dia` y `mi_dia_agenda` filtraban las tareas por `leads.assigned_to`
--     (el dueño del lead), NO por `lead_tasks.assigned_to` (quien hace la
--     tarea). Hay 6 tareas vencidas cuyo agente de tarea difiere del agente
--     del lead → el mail decía "no tenés tareas" mientras las tenía.
--   · 29 tareas vencidas, la más vieja del 16/9, todas con recordatorio
--     enviado y NINGUNA escalada: el dueño no tiene forma de verlas.
--   · 7 alertas `lead_followup_overdue` abiertas (27/10→27/11), todas sin
--     `assigned_to`: la conversión alerta→tarea existe en el panel pero nadie
--     la dispara, así que las alertas envejecen sin dueño.
--
-- Fix en 3 capas, sin borrar ni reescribir datos:
--   1) filtro `COALESCE(t.assigned_to, l.assigned_to)` en las dos RPCs;
--   2) `mi_dia` devuelve `vencidas` (top 10) + `escaladas` para que la UI
--      muestre el inventario completo detrás del top 3;
--   3) dos funciones con `p_dry_run` (verificación en producción SIN escribir)
--      y un cron diario que escala tareas >7d y convierte alertas en tareas
--      con la marca `[alert:<id>]`, idéntica a la del botón manual.
--
-- Nota: `supervision_alerts` NO tiene `updated_at` (usar created_at).
-- Las funciones nuevas heredan EXECUTE de PUBLIC: se revoca explícitamente
-- también a `anon` y `authenticated` y se da sólo `service_role` (el cron
-- corre como dueño de la función, con EXECUTE implícito).
-- ============================================

DROP FUNCTION IF EXISTS public.mi_dia(uuid, boolean);
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
  v_vencidas jsonb := '[]'::jsonb;
  v_item jsonb;
  v_lead uuid;
  v_picked uuid[] := ARRAY[]::uuid[];
  v_c_vis integer := 0;
  v_c_vis_semana integer := 0;
  v_c_esp integer := 0;
  v_c_seg integer := 0;
  v_c_tar integer := 0;
  v_c_con integer := 0;
  v_c_esc integer := 0;
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
  --    ⚠️ Dueño de la tarea = lead_tasks.assigned_to, con fallback al agente
  --    del lead sólo si la tarea no tiene nadie asignado. Antes se usaba
  --    SIEMPRE leads.assigned_to y 6 tareas quedaban fuera del mail.
  ------------------------------------------------------------------
  SELECT count(*) INTO v_c_tar
    FROM public.lead_tasks t
    JOIN public.leads l ON l.id = t.lead_id
   WHERE t.status IN ('pendiente', 'en_progreso')
     AND t.due_at < now()
     AND l.deleted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND (v_ver_todos OR COALESCE(t.assigned_to, l.assigned_to) = v_agent);

  SELECT count(*) INTO v_c_esc
    FROM public.lead_tasks t
    JOIN public.leads l ON l.id = t.lead_id
   WHERE t.status IN ('pendiente', 'en_progreso')
     AND t.due_at < now() - interval '7 days'
     AND l.deleted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND (v_ver_todos OR COALESCE(t.assigned_to, l.assigned_to) = v_agent);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tipo', 'tarea', 'tarea_id', x.id, 'lead_id', x.lead_id,
           'titulo', x.title, 'nombre', x.full_name,
           'telefono', COALESCE(NULLIF(x.whatsapp, ''), x.phone),
           'fecha', x.due_at, 'priority', x.priority,
           'escalada', x.due_at < now() - interval '7 days',
           'vencimiento', to_char(x.due_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
         ) ORDER BY x.due_at), '[]'::jsonb)
    INTO v_vencidas
    FROM (
      SELECT t.id, t.lead_id, t.title, t.due_at, t.priority,
             l.full_name, l.whatsapp, l.phone
        FROM public.lead_tasks t
        JOIN public.leads l ON l.id = t.lead_id
       WHERE t.status IN ('pendiente', 'en_progreso')
         AND t.due_at < now()
         AND l.deleted_at IS NULL
         AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
         AND (v_ver_todos OR COALESCE(t.assigned_to, l.assigned_to) = v_agent)
       ORDER BY t.due_at ASC
       LIMIT 10
    ) x;

  SELECT jsonb_build_object(
           'tipo', 'tarea', 'prioridad', 4, 'accion', 'tarea',
           'lead_id', l.id, 'tarea_id', t.id,
           'nombre', l.full_name,
           'telefono', COALESCE(NULLIF(l.whatsapp, ''), l.phone),
           'titulo', CASE WHEN t.due_at < now() - interval '7 days' THEN 'Tarea ESCALADA' ELSE 'Tarea vencida' END,
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
     AND (v_ver_todos OR COALESCE(t.assigned_to, l.assigned_to) = v_agent)
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
    'vencidas', v_vencidas,
    'conteos', jsonb_build_object(
      'visitas', v_c_vis,
      'visitas_semana', v_c_vis_semana,
      'esperas', v_c_esp,
      'seguimientos', v_c_seg,
      'tareas', v_c_tar,
      'escaladas', v_c_esc,
      'sin_contacto', v_c_con
    ),
    'total', v_c_vis + v_c_esp + v_c_seg + v_c_tar + v_c_con
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mi_dia(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_dia(uuid, boolean) TO authenticated, service_role;

-- `mi_dia_agenda` (el mail): mismo dueño de tarea, mismo p_solo_propio.
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
  v_uid uuid := COALESCE(p_user_id, auth.uid());
  v_role text;
  v_agent uuid;
  v_agente text;
  v_ver_todos boolean;
  v_dias integer := LEAST(GREATEST(COALESCE(p_dias, 3), 1), 14);
  v_desde timestamptz;
  v_hasta timestamptz;
  v_visitas jsonb := '[]'::jsonb;
  v_tareas jsonb := '[]'::jsonb;
  v_c_vis integer := 0;
  v_c_tar integer := 0;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
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

  SELECT count(*) INTO v_c_vis
    FROM public.visits v
   WHERE v.deleted_at IS NULL
     AND v.status IN ('pendiente', 'confirmada')
     AND v.visit_date >= v_desde AND v.visit_date < v_hasta
     AND (v_ver_todos OR v.agent_id = v_agent);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tipo', 'visita', 'visita_id', x.id, 'lead_id', x.lead_id,
           'fecha', x.visit_date,
           'nombre', COALESCE(NULLIF(x.client_name, ''), x.full_name),
           'telefono', x.client_phone,
           'titulo', 'Visita',
           'detalle', to_char(x.visit_date at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')
                      || CASE WHEN x.property_code IS NOT NULL THEN ' · ' || x.property_code ELSE '' END
         ) ORDER BY x.visit_date), '[]'::jsonb)
    INTO v_visitas
    FROM (
      SELECT v.id, v.lead_id, v.visit_date, v.client_name, v.client_phone,
             l.full_name, p.property_code
        FROM public.visits v
        LEFT JOIN public.leads l ON l.id = v.lead_id
        LEFT JOIN public.properties p ON p.id = v.property_id
       WHERE v.deleted_at IS NULL
         AND v.status IN ('pendiente', 'confirmada')
         AND v.visit_date >= v_desde AND v.visit_date < v_hasta
         AND (v_ver_todos OR v.agent_id = v_agent)
       ORDER BY v.visit_date ASC
       LIMIT 10
    ) x;

  SELECT count(*) INTO v_c_tar
    FROM public.lead_tasks t
    JOIN public.leads l ON l.id = t.lead_id
   WHERE t.status IN ('pendiente', 'en_progreso')
     AND t.due_at >= v_desde AND t.due_at < v_hasta
     AND l.deleted_at IS NULL
     AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND (v_ver_todos OR COALESCE(t.assigned_to, l.assigned_to) = v_agent);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tipo', 'tarea', 'tarea_id', x.id, 'lead_id', x.lead_id,
           'fecha', x.due_at, 'nombre', x.full_name,
           'telefono', COALESCE(NULLIF(x.whatsapp, ''), x.phone),
           'titulo', x.title,
           'detalle', to_char(x.due_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')
                      || ' · ' || x.priority
         ) ORDER BY x.due_at), '[]'::jsonb)
    INTO v_tareas
    FROM (
      SELECT t.id, t.lead_id, t.title, t.priority, t.due_at,
             l.full_name, l.whatsapp, l.phone
        FROM public.lead_tasks t
        JOIN public.leads l ON l.id = t.lead_id
       WHERE t.status IN ('pendiente', 'en_progreso')
         AND t.due_at >= v_desde AND t.due_at < v_hasta
         AND l.deleted_at IS NULL
         AND l.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
         AND (v_ver_todos OR COALESCE(t.assigned_to, l.assigned_to) = v_agent)
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

--------------------------------------------------------------------
-- Escalado: tareas vencidas hace > N días → alerta de supervisión.
-- `p_dry_run=true` cuenta sin escribir (verificación en producción).
--------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_escalar_tareas_vencidas(
  p_dias integer DEFAULT 7,
  p_dry_run boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  r record;
  v_n integer := 0;
  v_dias integer := GREATEST(COALESCE(p_dias, 7), 1);
BEGIN
  FOR r IN
    SELECT t.id AS task_id, t.lead_id, t.title, t.due_at,
           t.assigned_to AS task_agent, l.assigned_to AS lead_agent,
           l.full_name
      FROM public.lead_tasks t
      JOIN public.leads l ON l.id = t.lead_id
     WHERE t.status IN ('pendiente', 'en_progreso')
       AND t.due_at < now() - (v_dias || ' days')::interval
       AND l.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.supervision_alerts a
          WHERE a.alert_type = 'task_overdue_escalated'
            AND a.evidence ->> 'task_id' = t.id::text
       )
     ORDER BY t.due_at ASC
  LOOP
    IF NOT COALESCE(p_dry_run, false) THEN
      INSERT INTO public.supervision_alerts (
        module, severity, alert_type, title, description, evidence, status, assigned_to
      ) VALUES (
        'crm', 'high', 'task_overdue_escalated',
        'Tarea vencida hace más de ' || v_dias || ' días: ' || left(COALESCE(r.title, 'sin título'), 120),
        COALESCE(r.full_name, 'Lead') || ' · venció el '
          || to_char(r.due_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
          || '. La tarea sigue abierta y nadie la escaló.',
        jsonb_build_object(
          'task_id', r.task_id::text, 'lead_id', r.lead_id::text,
          'assigned_to', COALESCE(r.task_agent, r.lead_agent)::text,
          'due_at', r.due_at, 'dias', v_dias
        ),
        'open',
        COALESCE(r.task_agent, r.lead_agent)
      );
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.crm_escalar_tareas_vencidas(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_escalar_tareas_vencidas(integer, boolean) TO service_role;

--------------------------------------------------------------------
-- Alertas de follow-up vencido → tareas del CRM, con la MISMA marca
-- `[alert:<id>]` que usa el botón manual del panel (dedup idempotente).
--------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_alertas_a_tareas(
  p_limit integer DEFAULT 50,
  p_dry_run boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  r record;
  v_n integer := 0;
  v_due timestamptz;
  v_lead_agent uuid;
BEGIN
  FOR r IN
    SELECT a.id AS alert_id, a.title, a.description, a.severity, a.evidence,
           (a.evidence ->> 'lead_id')::uuid AS lead_id
      FROM public.supervision_alerts a
     WHERE a.alert_type = 'lead_followup_overdue'
       AND a.status = 'open'
       AND (a.evidence ->> 'lead_id') ~ '^[0-9a-fA-F-]{36}$'
       AND NOT EXISTS (
         SELECT 1 FROM public.lead_tasks t
          WHERE t.lead_id = (a.evidence ->> 'lead_id')::uuid
            AND t.description LIKE '%[alert:' || a.id::text || ']%'
       )
     ORDER BY a.created_at ASC
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    SELECT assigned_to INTO v_lead_agent FROM public.leads WHERE id = r.lead_id;
    v_due := CASE WHEN (r.evidence ->> 'due_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                  THEN (r.evidence ->> 'due_at')::timestamptz
                  ELSE now() + interval '24 hours' END;
    IF NOT COALESCE(p_dry_run, false) THEN
      INSERT INTO public.lead_tasks (
        lead_id, type, contact_type, title, description, priority, status,
        due_at, assigned_to, remind_before_minutes, created_at, updated_at
      ) VALUES (
        r.lead_id, 'contact', 'whatsapp',
        left(COALESCE(r.title, 'Seguimiento pendiente'), 180),
        left('[alert:' || r.alert_id::text || '] ' || COALESCE(r.description, 'Tarea creada desde una alerta de supervisión.'), 2000),
        CASE WHEN r.severity IN ('critical', 'high') THEN 'alta' ELSE 'media' END,
        'pendiente', v_due, COALESCE((r.evidence ->> 'assigned_to')::uuid, v_lead_agent),
        1440, now(), now()
      );
      UPDATE public.supervision_alerts
         SET status = 'assigned',
             assigned_to = COALESCE((r.evidence ->> 'assigned_to')::uuid, v_lead_agent),
             assigned_at = now(),
             notes = 'Convertida en tarea automáticamente (' || r.alert_id::text || ')'
       WHERE id = r.alert_id;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.crm_alertas_a_tareas(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_alertas_a_tareas(integer, boolean) TO service_role;

-- Un solo cron, 11:30 ART. El command llama a dos funciones escalares en un
-- SELECT: NO usa current_setting (devuelve NULL en este proyecto) ni secretos.
SELECT cron.unschedule('crm-operacion-proactiva')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crm-operacion-proactiva');

SELECT cron.schedule(
  'crm-operacion-proactiva',
  '30 14 * * *',
  $$ SELECT public.crm_escalar_tareas_vencidas(), public.crm_alertas_a_tareas(); $$
);
