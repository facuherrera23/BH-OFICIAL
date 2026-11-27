-- ---------------------------------------------------------------------------
-- P1-6 (2026-11-27): ETAPA "EN ESPERA" — funciones (la etapa y la columna ya
-- están en 20261127000003_lead_stage_en_espera.sql).
--
-- Qué hace este archivo:
--   1. Trigger que limpia `stage_previo` cuando el lead sale de "en espera"
--      por cualquier vía (no sólo por la RPC de reactivación).
--   2. `compute_lead_score`: aparcar un lead NO degrada su score (conserva los
--      puntos de la etapa desde la que se colgó). Antes, con el `case` sin
--      esta etapa, el score caía a 0 y el lead desaparecía del ranking.
--   3. `trg_visits_sync_lead_stage`: agendar una visita DESPIERTA un lead
--      en espera (si no, un lead colgado con visita nueva quedaba invisible).
--   4. RPC `lead_pasar_a_espera` / `lead_reactivar`: el botón de 1 clic.
--   5. `mi_bandeja` + `get_sidebar_badge_counts`: los leads en espera NO
--      anyone's la cola de trabajo (ni por tareas, ni por "sin agente") hasta
--      que llega su fecha de regreso; el badge y la bandeja siguen cuadrando.
--   6. `repartir_leads_sin_agente`: un lead en espera no ocupa carga de un
--      agente ni entra en el reparto (nadie tiene que reclamarlo mientras
--      está colgado).
--   7. Bonus de higiene: el badge de "tareas vencidas" contar 22 tareas de las
--      cuales 9 eran de leads CERRADOS y 4 de leads BORRADOS (59 % de ruido).
--      Ahora sólo cuenta tareas de leads vivos → el número honesto.
--
-- Aditiva: CREATE OR REPLACE de funciones. No borra filas.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1) La etapa previa se limpia sola si el lead sale de "en espera" por
--    cualquier vía (dropdown, visita, edición manual).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_leads_stage_previo_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.stage::text IS DISTINCT FROM OLD.stage::text
     AND NEW.stage::text <> 'en_espera' THEN
    NEW.stage_previo := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_leads_stage_previo ON public.leads;
CREATE TRIGGER trg_leads_stage_previo
  BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_leads_stage_previo_cleanup();

-- ---------------------------------------------------------------------------
-- 2) Score: "en espera" conserva los puntos de la etapa anterior.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_lead_score()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_stage text;
  v_stage_previo text;
  stage_pts int;
  contacto_pts int;
  interes_pts int;
  propiedad_pts int;
  origen_pts int;
begin
  v_stage := NEW.stage::text;
  if TG_OP = 'UPDATE' then
    v_stage_previo := OLD.stage::text;
  else
    v_stage_previo := null;
  end if;

  stage_pts := case v_stage
    when 'nuevo' then 0
    when 'contactado' then 10
    when 'calificado' then 15
    when 'visita_agendada' then 20
    when 'visita_realizada' then 25
    when 'negociacion' then 30
    when 'cerrado_ganado' then 40
    when 'cerrado_perdido' then 0
    /* "En espera" NO degrada el score: conserva los puntos de la etapa desde
       la que se colgó el lead. Si no, aparcar un lead lo hundía a 0 puntos
       y desaparecía del ranking de prioridades. */
    when 'en_espera' then case v_stage_previo
      when 'contactado' then 10
      when 'calificado' then 15
      when 'visita_agendada' then 20
      when 'visita_realizada' then 25
      when 'negociacion' then 30
      when 'cerrado_ganado' then 40
      else 0
    end
    else 0
  end;

  contacto_pts := ((NEW.phone is not null and btrim(NEW.phone) <> '')::int * 5)
                    + ((NEW.whatsapp is not null and btrim(NEW.whatsapp) <> '')::int * 5)
                    + ((NEW.email is not null and btrim(NEW.email) <> '')::int * 5);
  interes_pts := ((NEW.budget_usd is not null and NEW.budget_usd > 0)::int * 10)
                   + ((NEW.preferred_zone is not null and btrim(NEW.preferred_zone) <> '')::int * 5)
                   + ((NEW.tipo_cliente is not null)::int * 5)
                   + ((NEW.operation_type is not null)::int * 5);
  propiedad_pts := (NEW.property_id is not null)::int * 10;
  origen_pts := case NEW.source when 'referido' then 10 when 'ml' then 5 when 'landing_page' then 5 when 'whatsapp' then 5 else 0 end;

  NEW.lead_score := least(100, stage_pts + contacto_pts + interes_pts + propiedad_pts + origen_pts);
  NEW.lead_score_breakdown := jsonb_build_object(
    'etapa', stage_pts,
    'contacto', contacto_pts,
    'interes', interes_pts,
    'propiedad', propiedad_pts,
    'origen', origen_pts
  );
  return NEW;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Agendar una visita despierta un lead en espera.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_visits_sync_lead_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Visita vinculada a lead abierto en etapas tempranas -> visita_agendada.
  -- P1-6: también despierta un lead en espera (si no, un lead colgado con
  -- visita nueva quedaba invisible para el agente).
  if NEW.lead_id is not null and (OLD.lead_id is null or OLD.lead_id is distinct from NEW.lead_id) then
    update public.leads
       set stage = 'visita_agendada', updated_at = now()
     where id = NEW.lead_id
       and stage in ('nuevo', 'contactado', 'calificado', 'en_espera');
  end if;
  return NEW;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4) RPC: pasar a espera / reactivar.
--
-- SEGURIDAD: son SECURITY DEFINER (saltan RLS) → el alcance de la policy
-- `leads_update` se replica EXPLÍCITAMENTE: super_admin, o el agente
-- asignado al lead es del caller, o el agente que lo creó es del caller.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_pasar_a_espera(
  p_lead_id uuid,
  p_hasta timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_lead public.leads%rowtype;
  v_hasta timestamptz;
  v_stage_previo text;
  v_tareas integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;

  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;

  SELECT l.* INTO v_lead FROM public.leads l WHERE l.id = p_lead_id;
  IF NOT FOUND OR v_lead.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'el lead no existe');
  END IF;

  IF NOT (
       v_role = 'super_admin'
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = v_lead.assigned_to AND a.profile_id = v_uid)
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = v_lead.created_by AND a.profile_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'No tenés permiso sobre este lead' USING ERRCODE = '42501';
  END IF;

  IF v_lead.stage::text IN ('cerrado_ganado', 'cerrado_perdido') THEN
    RETURN jsonb_build_object('error', 'el lead ya está cerrado');
  END IF;

  v_hasta := COALESCE(p_hasta, now() + interval '7 days');
  IF v_hasta <= now() THEN
    v_hasta := now() + interval '1 day';
  END IF;

  /* Si ya estaba en espera se conserva la etapa original (no se pisa con
     'en_espera' ni con la etapa de la que se colgó). */
  v_stage_previo := CASE
    WHEN v_lead.stage::text = 'en_espera' THEN v_lead.stage_previo
    ELSE v_lead.stage::text
  END;

  UPDATE public.leads
     SET stage = 'en_espera',
         stage_previo = v_stage_previo,
         next_followup_at = v_hasta,
         updated_at = now()
   WHERE id = p_lead_id;

  /* Las tareas del lead se suspenden: no vencen, no avisan y no cuentan en
     el backlog hasta que el lead vuelva. */
  UPDATE public.lead_tasks
     SET status = 'en_espera', updated_at = now()
   WHERE lead_id = p_lead_id AND status IN ('pendiente', 'en_progreso');
  GET DIAGNOSTICS v_tareas = ROW_COUNT;

  INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
  VALUES (
    p_lead_id, 'note', 'Lead en espera',
    'El lead quedó en espera hasta el '
      || to_char(v_hasta at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI')
      || '. Vuelve solo a la bandeja cuando llegue esa fecha; se reactivan '
      || v_tareas || ' tarea(s) en el momento.'
  );

  PERFORM public.insert_audit_log(
    p_user_id := v_uid,
    p_role_snapshot := v_role,
    p_action := 'lead_en_espera',
    p_module := 'crm',
    p_table_name := 'leads',
    p_record_id := p_lead_id,
    p_entity_type := 'leads',
    p_entity_id := p_lead_id,
    p_entity_label := v_lead.full_name,
    p_metadata := jsonb_build_object('hasta', v_hasta, 'stage_previo', v_stage_previo, 'tareas_suspendidas', v_tareas)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'lead_id', p_lead_id,
    'hasta', v_hasta,
    'stage_previo', v_stage_previo,
    'tareas_suspendidas', v_tareas
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.lead_reactivar(p_lead_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_lead public.leads%rowtype;
  v_stage text;
  v_next timestamptz;
  v_tareas integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;

  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;

  SELECT l.* INTO v_lead FROM public.leads l WHERE l.id = p_lead_id;
  IF NOT FOUND OR v_lead.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'el lead no existe');
  END IF;

  IF NOT (
       v_role = 'super_admin'
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = v_lead.assigned_to AND a.profile_id = v_uid)
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = v_lead.created_by AND a.profile_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'No tenés permiso sobre este lead' USING ERRCODE = '42501';
  END IF;

  IF v_lead.stage::text <> 'en_espera' THEN
    RETURN jsonb_build_object('error', 'el lead no está en espera');
  END IF;

  /* Vuelve a la etapa desde la que se colgó; si no se sabe, a "contactado"
     (nunca a una etapa terminal). */
  v_stage := COALESCE(NULLIF(v_lead.stage_previo, ''), 'contactado');
  IF v_stage NOT IN ('nuevo', 'contactado', 'calificado', 'visita_agendada', 'visita_realizada', 'negociacion') THEN
    v_stage := 'contactado';
  END IF;

  UPDATE public.leads
     SET stage = v_stage::lead_stage,
         stage_previo = NULL,
         next_followup_at = NULL,
         updated_at = now()
   WHERE id = p_lead_id;

  /* Las tareas vuelven a la cola y el followup se recalcula con la más
     próxima (misma regla que `syncLeadFollowup` en el front). */
  UPDATE public.lead_tasks
     SET status = 'pendiente', updated_at = now()
   WHERE lead_id = p_lead_id AND status = 'en_espera';
  GET DIAGNOSTICS v_tareas = ROW_COUNT;

  SELECT min(t.due_at) INTO v_next
    FROM public.lead_tasks t
   WHERE t.lead_id = p_lead_id
     AND t.status IN ('pendiente', 'en_progreso')
     AND t.due_at IS NOT NULL;

  UPDATE public.leads SET next_followup_at = v_next WHERE id = p_lead_id;

  INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
  VALUES (
    p_lead_id, 'note', 'Lead reactivado',
    'El lead volvió a "' || v_stage || '" y se reaktivaron ' || v_tareas || ' tarea(s).'
  );

  PERFORM public.insert_audit_log(
    p_user_id := v_uid,
    p_role_snapshot := v_role,
    p_action := 'lead_reactivado',
    p_module := 'crm',
    p_table_name := 'leads',
    p_record_id := p_lead_id,
    p_entity_type := 'leads',
    p_entity_id := p_lead_id,
    p_entity_label := v_lead.full_name,
    p_metadata := jsonb_build_object('stage', v_stage, 'tareas_reactivadas', v_tareas)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'lead_id', p_lead_id,
    'stage', v_stage,
    'tareas_reactivadas', v_tareas,
    'next_followup_at', v_next
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.lead_reactivar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_reactivar(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.lead_pasar_a_espera(uuid, timestamptz) IS
  'Coloca el lead en la etapa en_espera hasta la fecha de regreso (default 7 días) y suspende sus tareas.';
COMMENT ON FUNCTION public.lead_reactivar(uuid) IS
  'Saca el lead de en_espera, lo devuelve a su etapa previa y reactiva sus tareas.';

-- ---------------------------------------------------------------------------
-- 5) Mi bandeja: los leads en espera no anyone's la cola hasta que vuelve.
--    (la fecha de regreso es next_followup_at → la vuelta es automática)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mi_bandeja(p_user_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
DECLARE
  v_uid uuid := COALESCE(p_user_id, auth.uid());
  v_role text;
  v_agent uuid;
  v_ver_todos boolean;
  v_seg jsonb; v_tar jsonb; v_vis jsonb; v_sin jsonb; v_sto jsonb;
  v_seg_total integer; v_tar_total integer; v_vis_total integer;
  v_sin_total integer; v_sto_total integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;

  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  SELECT a.id INTO v_agent
    FROM public.agents a
   WHERE a.profile_id = v_uid AND a.status = 'activo' AND a.deleted_at IS NULL
   ORDER BY a.created_at
   LIMIT 1;
  v_ver_todos := (v_role IN ('super_admin', 'broker'));

  -- 1) Seguimientos vencidos (leads vivos con next_followup_at ya pasado).
  --    P1-6: un lead en espera vuelve acá SOLO cuando llega su fecha de
  --    regreso (next_followup_at). El flag 'espera' permite al front
  --    ofrecer "Reactivar" en vez de "Marcar contactado".
  WITH seg AS (
    SELECT l.id AS lead_id, l.full_name AS nombre, l.stage, l.source,
           l.next_followup_at AS vence,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono,
           l.lead_score AS score, a.full_name AS agente,
           (l.stage::text = 'en_espera') AS espera,
           (v_ver_todos OR l.assigned_to IS NOT DISTINCT FROM v_agent) AS mios
      FROM public.leads l
      LEFT JOIN public.agents a ON a.id = l.assigned_to
     WHERE l.deleted_at IS NULL
       AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido')
       AND l.next_followup_at IS NOT NULL AND l.next_followup_at < now()
       AND (v_ver_todos OR l.assigned_to = v_agent)
     ORDER BY l.next_followup_at ASC
     LIMIT 20
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'lead_id', lead_id, 'nombre', nombre, 'stage', stage, 'source', source,
           'vence', vence, 'telefono', telefono, 'score', score,
           'agente', agente, 'espera', espera, 'mios', mios) ORDER BY vence NULLS LAST), '[]'::jsonb)
    INTO v_seg
    FROM seg;

  SELECT count(*) INTO v_seg_total
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido')
     AND l.next_followup_at IS NOT NULL AND l.next_followup_at < now()
     AND (v_ver_todos OR l.assigned_to = v_agent);

  -- 2) Tareas de lead vencidas (pendientes con due_at ya pasado).
  --    P1-6: las tareas de un lead en espera están suspendidas (status
  --    'en_espera') y además se filtran por etapa: un lead colgado no
  --    reclama al agente.
  WITH tar AS (
    SELECT t.id AS tarea_id, t.lead_id, t.title, t.due_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono,
           l.full_name AS nombre, l.stage, a.full_name AS agente,
           (v_ver_todos OR l.assigned_to IS NOT DISTINCT FROM v_agent) AS mios
      FROM public.lead_tasks t
      JOIN public.leads l ON l.id = t.lead_id
      LEFT JOIN public.agents a ON a.id = l.assigned_to
     WHERE t.status IN ('pendiente', 'en_progreso')
       AND t.due_at < now()
       AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
       AND l.deleted_at IS NULL
       AND (v_ver_todos OR l.assigned_to = v_agent)
     ORDER BY t.due_at ASC
     LIMIT 20
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tarea_id', tarea_id, 'lead_id', lead_id, 'title', title, 'due_at', due_at,
           'telefono', telefono, 'nombre', nombre, 'stage', stage,
           'agente', agente, 'mios', mios) ORDER BY due_at NULLS LAST), '[]'::jsonb)
    INTO v_tar
    FROM tar;

  SELECT count(*) INTO v_tar_total
    FROM public.lead_tasks t
    JOIN public.leads l ON l.id = t.lead_id
   WHERE t.status IN ('pendiente', 'en_progreso')
     AND t.due_at < now()
     AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     AND l.deleted_at IS NULL
     AND (v_ver_todos OR l.assigned_to = v_agent);

  -- 3) Visitas próximas (pendientes/confirmadas de los próximos 7 días).
  WITH vis AS (
    SELECT v.id AS visita_id, v.lead_id, v.client_name, v.client_phone,
           v.visit_date, v.status,
           p.property_code, p.title AS propiedad,
           (v_ver_todos OR v.agent_id IS NOT DISTINCT FROM v_agent) AS mios
      FROM public.visits v
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE v.deleted_at IS NULL
       AND v.status IN ('pendiente', 'confirmada')
       AND v.visit_date >= now()
       AND v.visit_date <= now() + interval '7 days'
       AND (v_ver_todos OR v.agent_id = v_agent)
     ORDER BY v.visit_date ASC
     LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'visita_id', visita_id, 'lead_id', lead_id, 'client_name', client_name,
           'telefono', client_phone, 'visit_date', visit_date, 'status', status,
           'property_code', property_code, 'propiedad', propiedad, 'mios', mios)
           ORDER BY visit_date NULLS LAST), '[]'::jsonb)
    INTO v_vis
    FROM vis;

  SELECT count(*) INTO v_vis_total
    FROM public.visits v
   WHERE v.deleted_at IS NULL
     AND v.status IN ('pendiente', 'confirmada')
     AND v.visit_date >= now()
     AND v.visit_date <= now() + interval '7 days'
     AND (v_ver_todos OR v.agent_id = v_agent);

  -- 4) Leads vivos sin agente (nadie es dueño — cualquiera puede reclamarlos).
  --    P1-6: un lead en espera no se reclama (no hay nada que hacer todavía).
  WITH sin AS (
    SELECT l.id AS lead_id, l.full_name AS nombre, l.stage, l.source, l.created_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono, l.lead_score AS score
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND l.assigned_to IS NULL
       AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     ORDER BY l.created_at DESC
     LIMIT 20
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'lead_id', lead_id, 'nombre', nombre, 'stage', stage, 'source', source,
           'created_at', created_at, 'telefono', telefono, 'score', score, 'mios', false)
           ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_sin
    FROM sin;

  SELECT count(*) INTO v_sin_total
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.assigned_to IS NULL
     AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera');

  -- 5) Consultas sin tocar (stage='nuevo' sin ningún contacto registrado).
  WITH sto AS (
    SELECT l.id AS lead_id, l.full_name AS nombre, l.stage, l.source, l.created_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono, l.lead_score AS score,
           a.full_name AS agente,
           (v_ver_todos OR l.assigned_to IS NOT DISTINCT FROM v_agent) AS mios
      FROM public.leads l
      LEFT JOIN public.agents a ON a.id = l.assigned_to
     WHERE l.deleted_at IS NULL
       AND l.stage = 'nuevo'
       AND l.last_contacted_at IS NULL
       AND (v_ver_todos OR l.assigned_to = v_agent OR l.assigned_to IS NULL)
     ORDER BY l.created_at ASC
     LIMIT 20
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'lead_id', lead_id, 'nombre', nombre, 'stage', stage, 'source', source,
           'created_at', created_at, 'telefono', telefono, 'score', score,
           'agente', agente, 'mios', mios) ORDER BY created_at ASC), '[]'::jsonb)
    INTO v_sto
    FROM sto;

  SELECT count(*) INTO v_sto_total
    FROM public.leads l
   WHERE l.deleted_at IS NULL
     AND l.stage = 'nuevo'
     AND l.last_contacted_at IS NULL
     AND (v_ver_todos OR l.assigned_to = v_agent OR l.assigned_to IS NULL);

  RETURN jsonb_build_object(
    'generado', now(),
    'ver_todos', v_ver_todos,
    'agente_id', v_agent,
    'seguimientos', v_seg,   'seguimientos_total', COALESCE(v_seg_total, 0),
    'tareas', v_tar,         'tareas_total', COALESCE(v_tar_total, 0),
    'visitas', v_vis,        'visitas_total', COALESCE(v_vis_total, 0),
    'sin_agente', v_sin,     'sin_agente_total', COALESCE(v_sin_total, 0),
    'sin_tocar', v_sto,      'sin_tocar_total', COALESCE(v_sto_total, 0),
    'total', COALESCE(v_seg_total, 0) + COALESCE(v_tar_total, 0)
           + COALESCE(v_sin_total, 0) + COALESCE(v_sto_total, 0)
  );
END;
 $$;

REVOKE ALL ON FUNCTION public.mi_bandeja(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_bandeja(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.mi_bandeja(uuid) IS
  'Mi bandeja: lo que hay que atender HOY (seguimientos vencidos, tareas vencidas, visitas próximas, leads sin agente, consultas sin tocar) — alcance por rol. Los leads en espera vuelven sólo cuando llega su fecha de regreso.';

-- ---------------------------------------------------------------------------
-- 6) Badge del sidebar: la misma suma que mi_bandeja (badge == bandeja) y el
--    badge de "tareas vencidas" HONESTO (sólo tareas de leads vivos).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sidebar_badge_counts(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_props integer; v_leads integer; v_visits integer; v_owners integer; v_tasaciones integer;
  v_owner_tasks_overdue integer; v_lead_tasks_overdue integer;
  v_owner_tasks_soon integer; v_lead_tasks_soon integer;
  v_tasks_overdue_total integer;
  v_chat_unread_total integer; v_chat_unread_conversations integer;
  v_props_stale integer;
  v_ml_failed_24h integer; v_ml_last_event_at timestamptz;
  v_visits_today integer;
  v_leads_new_24h integer;
  v_alq_contracts integer;
  v_mi_bandeja integer; v_agent_id uuid; v_ver_todos boolean;
begin
  select count(*) into v_props from public.properties where is_published = true;
  select count(*) into v_leads from public.leads where deleted_at is null and stage not in ('cerrado_ganado', 'cerrado_perdido');
  select count(*) into v_visits from public.visits where status = 'pendiente';
  select count(*) into v_owners from public.owners where deleted_at is null and status = 'activo';
  select count(*) into v_tasaciones from public.tasaciones;
  select count(*) into v_owner_tasks_overdue
    from public.owner_tasks t
    join public.owners o on o.id = t.owner_id
   where t.status in ('pendiente', 'en_progreso') and t.due_date < now()
     and o.deleted_at is null and o.status = 'activo';
  select count(*) into v_owner_tasks_soon
    from public.owner_tasks t
    join public.owners o on o.id = t.owner_id
   where t.status in ('pendiente', 'en_progreso') and t.due_date >= now() and t.due_date <= now() + interval '24 hours'
     and o.deleted_at is null and o.status = 'activo';
  /* P1-6 (2026-11-27): el badge de tareas vencidas contaba tareas de leads
     CERRADOS (9) y BORRADOS (4) — 13 de 22 (59 %) era ruido. Ahora sólo
     cuenta tareas de leads vivos y no colgados (etapa en_espera). */
  select count(*) into v_lead_tasks_overdue
    from public.lead_tasks t
    join public.leads l on l.id = t.lead_id
   where t.status in ('pendiente', 'en_progreso') and t.due_at < now()
     and l.deleted_at is null
     and l.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera');
  select count(*) into v_lead_tasks_soon
    from public.lead_tasks t
    join public.leads l on l.id = t.lead_id
   where t.status in ('pendiente', 'en_progreso') and t.due_at >= now() and t.due_at <= now() + interval '24 hours'
     and l.deleted_at is null
     and l.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera');
  v_tasks_overdue_total := coalesce(v_lead_tasks_overdue, 0) + coalesce(v_owner_tasks_overdue, 0);

  select count(*) into v_leads_new_24h from public.leads where deleted_at is null and created_at > now() - interval '24 hours';

  select coalesce(sum(unread_count), 0), count(*) filter (where unread_count > 0)
    into v_chat_unread_total, v_chat_unread_conversations
    from public.zernio_conversations;

  select count(*) into v_props_stale from public.properties p
   where p.is_published = true and p.deleted_at is null
     and coalesce(
       (select max(v.visit_date) from public.visits v where v.property_id = p.id),
       p.created_at
     ) < case
       when exists (select 1 from public.visits v2 where v2.property_id = p.id) then now() - interval '60 days'
       else now() - interval '30 days'
     end;

  select count(*) into v_ml_failed_24h from public.ml_webhook_events where status = 'failed' and received_at > now() - interval '24 hours';
  select max(received_at) into v_ml_last_event_at from public.ml_webhook_events;

  select count(*) into v_visits_today from public.visits
   where status = 'pendiente' and visit_date::date = (now() at time zone 'America/Argentina/Buenos_Aires')::date;

  select count(*) into v_alq_contracts
    from (
      select jsonb_array_elements(s.state->'props') prop
        from public.alquileres_state s
       where s.user_id = coalesce(p_user_id, auth.uid())
         and jsonb_typeof(s.state->'props') = 'array'
    ) x
    where substring(x.prop->>'fin' from 1 for 7) ~ '^[0-9]{4}-[0-9]{2}$'
      and ((substring(x.prop->>'fin' from 1 for 4)::int * 12 + substring(x.prop->>'fin' from 6 for 2)::int)
           - (date_part('year', now() at time zone 'America/Argentina/Buenos_Aires')::int * 12
              + date_part('month', now() at time zone 'America/Argentina/Buenos_Aires')::int)) between -3 and 2;

  -- mi bandeja (2026-11-26): lo que hay que atender HOY — seguimientos
  -- vencidos + tareas de lead vencidas (SÓLO leads vivos) + leads sin agente
  -- + consultas sin tocar. Mismo alcance y MISMA suma que mi_bandeja(p.id):
  -- el badge y el "total" de la bandeja no pueden decir números distintos.
  -- P1-6: los leads en espera no cuentan (esperan su fecha de regreso).
  select a.id into v_agent_id
    from public.agents a
   where a.profile_id = coalesce(p_user_id, auth.uid())
     and a.status = 'activo' and a.deleted_at is null
   order by a.created_at limit 1;
  select coalesce(p.role in ('super_admin', 'broker'), false) into v_ver_todos
    from public.profiles p where p.id = coalesce(p_user_id, auth.uid());
  v_ver_todos := coalesce(v_ver_todos, false);
  select
      coalesce((select count(*) from public.leads l
                 where l.deleted_at is null
                   and l.stage not in ('cerrado_ganado', 'cerrado_perdido')
                   and l.next_followup_at is not null and l.next_followup_at < now()
                   and (v_ver_todos or l.assigned_to = v_agent_id)), 0)
    + coalesce((select count(*) from public.lead_tasks t
                  join public.leads l2 on l2.id = t.lead_id
                 where t.status in ('pendiente', 'en_progreso') and t.due_at < now()
                   and l2.deleted_at is null
                   and l2.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
                   and (v_ver_todos or l2.assigned_to = v_agent_id)), 0)
    + coalesce((select count(*) from public.leads l4
                 where l4.deleted_at is null and l4.assigned_to is null
                   and l4.stage not in ('cerrado_ganado', 'cerrado_perdido', 'en_espera')), 0)
    + coalesce((select count(*) from public.leads l3
                 where l3.deleted_at is null and l3.stage = 'nuevo'
                   and l3.last_contacted_at is null
                   and (v_ver_todos or l3.assigned_to = v_agent_id or l3.assigned_to is null)), 0)
    into v_mi_bandeja;

  return json_build_object(
    'properties', v_props,
    'leads', v_leads,
    'visits', v_visits,
    'owners', v_owners,
    'tasaciones', v_tasaciones,
    'owner_tasks_overdue', v_owner_tasks_overdue,
    'owner_tasks_soon', v_owner_tasks_soon,
    'lead_tasks_overdue', v_lead_tasks_overdue,
    'lead_tasks_soon', v_lead_tasks_soon,
    'tasks_overdue_total', v_tasks_overdue_total,
    'leads_new_24h', v_leads_new_24h,
    'chat_unread_total', v_chat_unread_total,
    'chat_unread_conversations', v_chat_unread_conversations,
    'properties_stale', v_props_stale,
    'ml_failed_24h', v_ml_failed_24h,
    'ml_last_event_at', v_ml_last_event_at,
    'visits_today', v_visits_today,
    'alq_contracts_expiring', v_alq_contracts,
    'mi_bandeja', coalesce(v_mi_bandeja, 0)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7) Reparto automático: un lead en espera no ocupa carga ni entra en el
--    reparto (nadie tiene que reclamarlo mientras está colgado).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.repartir_leads_sin_agente()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_orphan RECORD;
  v_agent RECORD;
  v_asignados integer := 0;
  v_detalle jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
    IF v_role NOT IN ('super_admin', 'broker') THEN
      RAISE EXCEPTION 'Solo super_admin o broker pueden repartir leads';
    END IF;
  END IF;

  /* Carga actual por agente activo: el reparto es round-robin POR CARGA, así
     Danilo (28 vivos) no acumula más mientras Helmut (5) queda vacío.
     P1-6: los leads en espera NO cuentan carga (no se está trabajando). */
  CREATE TEMP TABLE _reparto_carga ON COMMIT DROP AS
    SELECT a.id, a.full_name,
           (SELECT count(*) FROM public.leads l
             WHERE l.assigned_to = a.id AND l.deleted_at IS NULL
               AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')) AS carga
      FROM public.agents a
     WHERE a.status = 'activo' AND a.deleted_at IS NULL;

  IF NOT EXISTS (SELECT 1 FROM _reparto_carga) THEN
    /* Sin agentes activos no hay a quién asignar: alerta en vez de silencio. */
    INSERT INTO public.supervision_alerts
      (user_id, module, severity, alert_type, title, description, evidence, status)
    VALUES
      (v_uid, 'crm', 'high', 'leads_sin_agente',
       'Leads vivos sin agente y sin agentes activos',
       'El reparto automático no encontró agentes activos: hay leads vivos sin dueño que nadie va a atender.',
       jsonb_build_object('funcion', 'repartir_leads_sin_agente'),
       'open');
    RETURN jsonb_build_object('asignados', 0, 'alerta', true, 'motivo', 'sin agentes activos');
  END IF;

  /* El más viejo primero: el lead que más tiempo espera es el que se reparte
     primero (FIFO), y cada asignación recalcula el destino menos cargado.
     P1-6: los leads en espera no entran al reparto. */
  FOR v_orphan IN
    SELECT l.id, l.full_name, l.source
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND l.assigned_to IS NULL
       AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
     ORDER BY l.created_at ASC
  LOOP
    SELECT c.id, c.full_name, c.carga
      INTO v_agent
      FROM _reparto_carga c
     ORDER BY c.carga ASC, c.id ASC
     LIMIT 1;

    UPDATE public.leads SET assigned_to = v_agent.id
     WHERE id = v_orphan.id AND assigned_to IS NULL;

    IF FOUND THEN
      UPDATE _reparto_carga SET carga = carga + 1 WHERE id = v_agent.id;
      INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
      VALUES (v_orphan.id, 'note',
              'Lead asignado a ' || v_agent.full_name,
              'Reparto automático de leads sin agente (por carga de trabajo).');
      v_asignados := v_asignados + 1;
      v_detalle := v_detalle || jsonb_build_object(
        'lead_id', v_orphan.id, 'nombre', v_orphan.full_name, 'agente', v_agent.full_name);
    END IF;
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, module, table_name, status, metadata)
  VALUES (v_uid, 'leads_repartidos', 'crm', 'leads', 'success',
          jsonb_build_object('asignados', v_asignados, 'detalle', v_detalle));

  RETURN jsonb_build_object(
    'asignados', v_asignados,
    'alerta', false,
    'detalle', v_detalle,
    'agentes', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'id', id, 'nombre', full_name, 'leads_vivos', carga) ORDER BY carga DESC), '[]'::jsonb)
                  FROM _reparto_carga)
  );
END;
$function$;
