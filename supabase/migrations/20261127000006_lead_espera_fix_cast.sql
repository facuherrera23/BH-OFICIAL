-- ---------------------------------------------------------------------------
-- P1-6 (2026-11-27): FIX del cast de enum en `lead_reactivar`.
--
-- El test en vivo (ROLLBACK) lo detectó:
--   ERROR:  42704: type "lead_stage" does not exist
--   UPDATE public.leads SET stage = v_stage::lead_stage ...
--
-- Causa: `lead_reactivar` tiene `SET search_path = ''` (buena práctica del
-- proyecto: las RPC no heredan nada del search_path del caller) → el tipo
-- `lead_stage` hay que CALIFICARLO: `public.lead_stage`.
--
-- Sin el fix, la RPC-breaking devolvía 42704 y el botón "Reactivar" no
-- funcionaba. Se corrige con una migración NUEVA (las aplicadas no se
-- editan) y se re-verifica en vivo.
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
    p_lead_id, 'note', 'Lead reactivado',
    'El lead volvió a "' || v_stage || '" y se reactivaron ' || v_tareas || ' tarea(s).'
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
