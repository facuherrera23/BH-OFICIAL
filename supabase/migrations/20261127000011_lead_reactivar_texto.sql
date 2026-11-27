-- ---------------------------------------------------------------------------
-- P1-6 (2026-11-27): FIX del texto de la traza de "Lead reactivado".
--
-- Contexto: al verificar que el repo reprodujera EXACTAMENTE el estado de
-- producción (comparando `pg_get_functiondef` antes y después de aplicar el
-- SQL del repo), apareció UNA diferencia real entre las 12 funciones de la
-- etapa "en espera": el texto de la actividad insertada por
-- `lead_reactivar`.
--
--   producción (correcto): 'El lead volvió a "X" y se reactivaron sus tareas.'
--   repo (typo):            'El lead volvió a "X" y se reaktivaron sus tareas.'
--                                  ^ una "k" de más
--
-- Es cosmético (no cambia el comportamiento), pero el texto se LE en el
-- timeline del lead: "reaktivaron" se ve como un error de escritura.
--
-- Se corrige con una migración NUEVA (las ya aplicadas no se editan) que
-- recrea la función con el texto correcto. El resto del cuerpo es idéntico
-- al de 20261127000007_lead_espera_fix_triggers.sql.
-- ---------------------------------------------------------------------------

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

  -- ⚠️ El tipo del enum va QUALIFICADO: con search_path = '' el nombre
  -- corto 'lead_stage' no resuelve (42704).
  UPDATE public.leads
     SET stage = v_stage::public.lead_stage,
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
    p_lead_id, 'status_change', 'Lead reactivado',
    'El lead volvió a "' || v_stage || '" y se reactivaron sus tareas.'
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

REVOKE ALL ON FUNCTION public.lead_reactivar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_reactivar(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.lead_reactivar(uuid) IS
  'Saca el lead de en_espera, lo devuelve a su etapa previa y reactiva sus tareas.';
