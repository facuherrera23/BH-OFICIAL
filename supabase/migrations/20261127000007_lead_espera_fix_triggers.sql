-- ---------------------------------------------------------------------------
-- P1-6 (2026-11-27): FIX de los 3 efectos colaterales que encontró el test
-- en vivo (ROLLBACK) de la etapa "en espera".
--
-- BUG 1 — `next_followup_at` quedaba NULL al aparcar y al reactivar.
--   Dos triggers de la casa tocan esa columna:
--     · `leads_recalc_followup_on_task` (AFTER UPDATE OF status, due_at sobre
--       lead_tasks) → recalcula el followup del lead con las tareas
--       PENDIENTES. Al suspender las tareas (status='en_espera') lo deja NULL.
--     · `leads_followup_on_contact` (AFTER INSERT sobre lead_activities con
--       activity_type 'call'/'note') → pone next_followup_at = NULL.
--   Fix: el UPDATE del lead va SIEMPRE AL FINAL (después de tocar tareas y de
--   escribir la actividad), y la actividad de "reactivar" es
--   activity_type='status_change' (reactivar NO es un contacto con el
--   cliente: no debe mover last_contacted_at).
--
-- BUG 2 — el score se caía a 0 al aparcar (65 → 40).
--   `compute_lead_score` tomaba la etapa anterior de OLD.stage, pero el
--   trigger de tareas dispara un SEGUNDO update sobre el lead: en ese
--   segundo update OLD.stage ya era 'en_espera' → 0 puntos de etapa.
--   Fix: cuando la etapa es 'en_espera' se usa `NEW.stage_previo` (la etapa
--   real desde la que se colgó), que es estable.
--
-- BUG 3 — una tarea nueva sobre un lead colgado pisaba la fecha de regreso.
--   Fix: `leads_recalc_followup_on_task` no toca los leads en 'en_espera':
--   mientras el lead está colgado, su fecha de vuelta es intangible.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- BUG 2: el score conserva los puntos de la etapa real del lead colgado.
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

  /* Si el lead está en espera, la etapa que manda es `stage_previo` (la real
     desde la que se colgó). OLD.stage ya sería 'en_espera' en los updates
     posteriores (p. ej. el que dispara el trigger de tareas) y con él el
     score se caía a 0. */
  if v_stage = 'en_espera' and NEW.stage_previo is not null and btrim(NEW.stage_previo) <> '' then
    v_stage_previo := NEW.stage_previo;
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
-- BUG 3: la fecha de vuelta de un lead colgado es intangible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leads_recalc_followup_on_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lead_id uuid := coalesce(NEW.lead_id, OLD.lead_id);
begin
  /* P1-6: un lead en espera conserva su fecha de regreso (next_followup_at)
     aunque se le agreguen o modifiquen tareas. */
  update public.leads l
     set next_followup_at = (
       select min(t.due_at)
       from public.lead_tasks t
       where t.lead_id = v_lead_id
         and t.status in ('pendiente', 'en_progreso')
         and t.due_at is not null
     )
   where l.id = v_lead_id
     and l.stage::text <> 'en_espera';
  return null;
end;
$function$;

-- ---------------------------------------------------------------------------
-- BUG 1: orden de las escrituras (el UPDATE del lead va al final).
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

  v_stage_previo := CASE
    WHEN v_lead.stage::text = 'en_espera' THEN v_lead.stage_previo
    ELSE v_lead.stage::text
  END;

  /* ORDEN IMPORTANTE (P1-6):
     1) las tareas se suspenden (su trigger recalcula el followup del lead),
     2) la actividad se escribe (su trigger también pone el followup en NULL),
     3) el lead se actualiza AL FINAL con la fecha de regreso. */

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

  UPDATE public.leads
     SET stage = 'en_espera',
         stage_previo = v_stage_previo,
         next_followup_at = v_hasta,
         updated_at = now()
   WHERE id = p_lead_id;

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

  v_stage := COALESCE(NULLIF(v_lead.stage_previo, ''), 'contactado');
  IF v_stage NOT IN ('nuevo', 'contactado', 'calificado', 'visita_agendada', 'visita_realizada', 'negociacion') THEN
    v_stage := 'contactado';
  END IF;

  /* ORDEN IMPORTANTE (P1-6): la actividad y las tareas van ANTES del update
     final del lead (sus triggers tocan next_followup_at).
     La actividad es 'status_change' y no 'note': reactivar NO es un contacto
     con el cliente → no debe mover last_contacted_at. */
  INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
  VALUES (
    p_lead_id, 'status_change', 'Lead reactivado',
    'El lead volvió a "' || v_stage || '" y se reaktivaron sus tareas.'
  );

  UPDATE public.lead_tasks
     SET status = 'pendiente', updated_at = now()
   WHERE lead_id = p_lead_id AND status = 'en_espera';
  GET DIAGNOSTICS v_tareas = ROW_COUNT;

  SELECT min(t.due_at) INTO v_next
    FROM public.lead_tasks t
   WHERE t.lead_id = p_lead_id
     AND t.status IN ('pendiente', 'en_progreso')
     AND t.due_at IS NOT NULL;

  UPDATE public.leads
     SET stage = v_stage::public.lead_stage,
         stage_previo = NULL,
         next_followup_at = v_next,
         updated_at = now()
   WHERE id = p_lead_id;

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
