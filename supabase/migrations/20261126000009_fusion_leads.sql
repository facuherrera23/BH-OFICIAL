-- ---------------------------------------------------------------------------
-- FUSIÓN DE LEADS DUPLICADOS (2026-11-26).
--
-- El problema medido: 48 de 124 leads vivos (39%) están en 38 grupos de
-- duplicados (mismo email o mismos últimos 8 dígitos de teléfono, cruzando
-- orígenes: ML vs manual vs RELA vs GVAmax). El agente llama dos veces al
-- mismo y el historial queda partido.
--
-- RPC 1 — leads_duplicados(): detecta los grupos (sólo lectura) para la
--         bandeja de duplicados del CRM.
-- RPC 2 — fusionar_leads(principal, duplicado): mue TODO el historial al
--         principal y da de baja el duplicado (soft-delete, nunca DELETE):
--           · lead_activities / lead_tasks  → se mueven (UPDATE lead_id).
--           · lead_properties              → se mueven sin chocar el PK
--             (lead_id, property_id): los vínculos repetidos se descartan.
--           · visits PENDIENTES/CONFIRMADAS → se mueven (el trigger
--             trg_visits_sync_lead_stage marca visita_agendada: correcto para
--             una visita viva). Las completadas/canceladas NO se mueven (el
--             trigger inventaría una etapa) → se documentan como nota en el
--             timeline del principal.
--           · visit_surveys → se mueven evitando el índice único parcial de
--             encuestas activas por (lead, propiedad).
--           · campos vacíos del principal ← los del duplicado (incluye
--             ml_lead_id, que es la clave de dedup de Mercado Libre).
--           · next_followup_at se recalcula (misma regla del trigger de
--             tareas: la más próxima pendiente).
--           · el duplicado queda en la papelera con lost_reason='duplicado'
--             (trazable, reversible desde la papelera del CRM).
--         Gate: sólo super_admin o broker (por profiles.role). Auditoría en
--         audit_log (user_id + metadata con los movimientos).
-- Aditiva: no borra leads (soft-delete), no toca filas al instalarse.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.leads_duplicados()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_grupos jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;
  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  IF v_role NOT IN ('super_admin', 'broker') THEN
    RETURN jsonb_build_object('error', 'solo super_admin o broker');
  END IF;

  WITH base AS (
    SELECT l.id, l.full_name, l.stage, l.source, l.created_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono, l.email,
           'email'::text AS tipo,
           lower(regexp_replace(l.email, '[^a-zA-Z0-9]', '', 'g')) AS k
      FROM public.leads l
     WHERE l.deleted_at IS NULL AND l.email IS NOT NULL AND l.email <> ''
    UNION ALL
    SELECT l.id, l.full_name, l.stage, l.source, l.created_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono, l.email,
           'tel'::text AS tipo,
           right(regexp_replace(COALESCE(l.whatsapp, l.phone, ''), '[^0-9]', '', 'g'), 8) AS k
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND COALESCE(l.whatsapp, l.phone, '') <> ''
       AND length(regexp_replace(COALESCE(l.whatsapp, l.phone, ''), '[^0-9]', '', 'g')) >= 8
  ),
  grupos AS (
    SELECT tipo, k, count(*) AS n, min(created_at) AS primero
      FROM base
     WHERE k IS NOT NULL AND k <> ''
     GROUP BY tipo, k
    HAVING count(*) > 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tipo', g.tipo,
           'clave', g.k,
           'n', g.n,
           'miembros', (
             SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'lead_id', b.id, 'nombre', b.full_name, 'stage', b.stage,
                      'source', b.source, 'created_at', b.created_at,
                      'telefono', b.telefono, 'email', b.email
                    ) ORDER BY b.created_at ASC), '[]'::jsonb)
               FROM base b
              WHERE b.tipo = g.tipo AND b.k = g.k
           )
         ) ORDER BY g.n DESC, g.primero ASC), '[]'::jsonb)
    INTO v_grupos
    FROM grupos g
   ORDER BY g.n DESC, g.primero ASC
   LIMIT 50;

  RETURN jsonb_build_object('grupos', v_grupos, 'n_grupos', COALESCE(jsonb_array_length(v_grupos), 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.fusionar_leads(p_principal uuid, p_duplicado uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_antes public.leads%ROWTYPE;
  v_dup public.leads%ROWTYPE;
  v_despues public.leads%ROWTYPE;
  v_act integer; v_tar integer; v_props integer; v_vis integer; v_surveys integer;
  v_visitas_muertas integer := 0;
  v_campos text[] := ARRAY[]::text[];
  v_notas text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'sin sesion';
  END IF;
  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  IF v_role NOT IN ('super_admin', 'broker') THEN
    RAISE EXCEPTION 'Solo super_admin o broker pueden fusionar leads';
  END IF;
  IF p_principal IS NULL OR p_duplicado IS NULL THEN
    RAISE EXCEPTION 'Faltan los leads a fusionar';
  END IF;
  IF p_principal = p_duplicado THEN
    RAISE EXCEPTION 'No se puede fusionar un lead consigo mismo';
  END IF;

  SELECT * INTO v_antes FROM public.leads WHERE id = p_principal;
  SELECT * INTO v_dup FROM public.leads WHERE id = p_duplicado;
  IF v_antes.id IS NULL OR v_dup.id IS NULL THEN
    RAISE EXCEPTION 'Lead inexistente';
  END IF;
  IF v_antes.deleted_at IS NOT NULL OR v_dup.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Uno de los leads está en la papelera';
  END IF;

  -- 1) Timeline completo.
  UPDATE public.lead_activities SET lead_id = p_principal WHERE lead_id = p_duplicado;
  GET DIAGNOSTICS v_act = ROW_COUNT;

  -- 2) Tareas (los triggers de recalc no corren: UPDATE de lead_id no es
  --    status/due_at → el followup se recalcula explícito más abajo).
  UPDATE public.lead_tasks SET lead_id = p_principal WHERE lead_id = p_duplicado;
  GET DIAGNOSTICS v_tar = ROW_COUNT;

  -- 3) Propiedades vinculadas (PK (lead_id, property_id): los repetidos fuera).
  DELETE FROM public.lead_properties lp
   WHERE lp.lead_id = p_duplicado
     AND EXISTS (SELECT 1 FROM public.lead_properties x
                  WHERE x.lead_id = p_principal AND x.property_id = lp.property_id);
  UPDATE public.lead_properties SET lead_id = p_principal WHERE lead_id = p_duplicado;
  GET DIAGNOSTICS v_props = ROW_COUNT;

  -- 4) Visitas VIVAS (el trigger trg_visits_sync_lead_stage marca
  --    visita_agendada al moverlas: correcto para una visita real).
  UPDATE public.visits SET lead_id = p_principal
   WHERE lead_id = p_duplicado AND status IN ('pendiente', 'confirmada');
  GET DIAGNOSTICS v_vis = ROW_COUNT;
  SELECT count(*) INTO v_visitas_muertas FROM public.visits WHERE lead_id = p_duplicado;

  -- 5) Encuestas (el índice único parcial de activas por (lead, propiedad)).
  DELETE FROM public.visit_surveys vs
   WHERE vs.lead_id = p_duplicado AND vs.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM public.visit_surveys x
                  WHERE x.lead_id = p_principal AND x.property_id = vs.property_id
                    AND x.archived_at IS NULL);
  UPDATE public.visit_surveys SET lead_id = p_principal WHERE lead_id = p_duplicado;
  GET DIAGNOSTICS v_surveys = ROW_COUNT;

  -- 6) Campos vacíos del principal ← los del duplicado (NUNCA se pisan datos).
  v_notas := NULL;
  IF COALESCE(NULLIF(v_dup.notes, ''), '') <> '' AND COALESCE(NULLIF(v_dup.notes, ''), '') <> COALESCE(NULLIF(v_antes.notes, ''), '') THEN
    v_notas := trim(COALESCE(NULLIF(v_antes.notes, ''), '')
      || CASE WHEN COALESCE(NULLIF(v_antes.notes, ''), '') <> '' THEN E'\n' ELSE '' END
      || '[Lead fusionado] ' || v_dup.notes);
  END IF;

  UPDATE public.leads p SET
      email = COALESCE(p.email, v_dup.email),
      phone = COALESCE(NULLIF(p.phone, ''), v_dup.phone),
      whatsapp = COALESCE(NULLIF(p.whatsapp, ''), v_dup.whatsapp),
      preferred_zone = COALESCE(NULLIF(p.preferred_zone, ''), v_dup.preferred_zone),
      preferred_type = COALESCE(p.preferred_type, v_dup.preferred_type),
      preferred_rooms = COALESCE(p.preferred_rooms, v_dup.preferred_rooms),
      preferred_contact_method = COALESCE(NULLIF(p.preferred_contact_method, ''), v_dup.preferred_contact_method),
      budget_usd = COALESCE(p.budget_usd, v_dup.budget_usd),
      estimated_value = COALESCE(p.estimated_value, v_dup.estimated_value),
      tipo_cliente = COALESCE(p.tipo_cliente, v_dup.tipo_cliente),
      operation_type = COALESCE(p.operation_type, v_dup.operation_type),
      property_id = COALESCE(p.property_id, v_dup.property_id),
      ml_lead_id = COALESCE(p.ml_lead_id, v_dup.ml_lead_id),
      consent_at = COALESCE(p.consent_at, v_dup.consent_at),
      created_at = LEAST(p.created_at, v_dup.created_at),
      notes = COALESCE(v_notas, p.notes)
   WHERE p.id = p_principal;

  SELECT * INTO v_despues FROM public.leads WHERE id = p_principal;
  IF COALESCE(v_antes.email, '') <> COALESCE(v_despues.email, '') THEN v_campos := v_campos || 'email'; END IF;
  IF COALESCE(v_antes.phone, '') <> COALESCE(v_despues.phone, '') THEN v_campos := v_campos || 'telefono'; END IF;
  IF COALESCE(v_antes.whatsapp, '') <> COALESCE(v_despues.whatsapp, '') THEN v_campos := v_campos || 'whatsapp'; END IF;
  IF COALESCE(v_antes.preferred_zone, '') <> COALESCE(v_despues.preferred_zone, '') THEN v_campos := v_campos || 'zona'; END IF;
  IF COALESCE(v_antes.budget_usd, 0) <> COALESCE(v_despues.budget_usd, 0) THEN v_campos := v_campos || 'presupuesto'; END IF;
  IF COALESCE(v_antes.tipo_cliente, '') <> COALESCE(v_despues.tipo_cliente, '') THEN v_campos := v_campos || 'tipo_cliente'; END IF;
  IF COALESCE(v_antes.operation_type, '') <> COALESCE(v_despues.operation_type, '') THEN v_campos := v_campos || 'operacion'; END IF;
  IF COALESCE(v_antes.ml_lead_id::text, '') <> COALESCE(v_despues.ml_lead_id::text, '') THEN v_campos := v_campos || 'ml_lead_id'; END IF;

  -- 7) Followup: MISMA regla que el trigger de tareas (la pendiente más próxima).
  UPDATE public.leads l
     SET next_followup_at = (
       SELECT min(t.due_at) FROM public.lead_tasks t
        WHERE t.lead_id = p_principal
          AND t.status IN ('pendiente', 'en_progreso')
          AND t.due_at IS NOT NULL
     )
   WHERE l.id = p_principal;

  -- 8) El duplicado va a la PAPELERA (soft-delete, nunca DELETE físico):
  --    conservar su fila es lo que hace la fusión reversible.
  UPDATE public.leads
     SET deleted_at = now(),
         lost_reason = 'duplicado',
         notes = 'Fusionado con el lead ' || p_principal::text || ' (' || to_char(now(), 'DD/MM/YYYY') || ')'
   WHERE id = p_duplicado;

  -- 9) Traza en el timeline del principal.
  INSERT INTO public.lead_activities (lead_id, activity_type, title, description)
  VALUES (p_principal, 'note',
          'Lead fusionado: ' || COALESCE(v_dup.full_name, 'sin nombre'),
          'Duplicado (origen ' || COALESCE(v_dup.source, '-') || ') consolidado en este lead. '
          || 'Movidos: ' || v_act || ' actividades, ' || v_tar || ' tareas, '
          || v_props || ' propiedades, ' || v_vis || ' visitas'
          || CASE WHEN v_visitas_muertas > 0 THEN ' (y ' || v_visitas_muertas || ' visitas cerradas quedaron en el lead original)' ELSE '' END
          || '.');

  -- 10) Auditoría.
  INSERT INTO public.audit_log (user_id, action, module, table_name, record_id, status, metadata)
  VALUES (v_uid, 'lead_merged', 'crm', 'leads', p_principal, 'success',
          jsonb_build_object(
            'principal', p_principal,
            'duplicado', p_duplicado,
            'actividades', v_act, 'tareas', v_tar, 'propiedades', v_props,
            'visitas', v_vis, 'encuestas', v_surveys,
            'campos_completados', to_jsonb(v_campos)
          ));

  RETURN jsonb_build_object(
    'principal', p_principal,
    'duplicado', p_duplicado,
    'actividades', v_act, 'tareas', v_tar, 'propiedades', v_props,
    'visitas', v_vis, 'encuestas', v_surveys,
    'visitas_cerradas', v_visitas_muertas,
    'campos_completados', to_jsonb(v_campos)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.leads_duplicados() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leads_duplicados() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fusionar_leads(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fusionar_leads(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.leads_duplicados() IS
  'Grupos de leads duplicados (mismo email o teléfono normalizado) — sólo lectura, para la bandeja de duplicados.';
COMMENT ON FUNCTION public.fusionar_leads(uuid, uuid) IS
  'Fusiona el duplicado en el principal: mueve timeline/tareas/propiedades/visitas vivas/encuestas, completa campos vacíos y manda el duplicado a la papelera (soft-delete).';
