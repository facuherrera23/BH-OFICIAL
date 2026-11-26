-- ---------------------------------------------------------------------------
-- REPARTO AUTOMÁTICO DE LEADS SIN AGENTE (2026-11-26).
--
-- El problema medido: 9 leads VIVOS sin assigned_to (nadie es dueño) — ML y
-- RELA crean leads solos y quedan huérfanos; "Sin asignar" era un filtro,
-- no una regla.
--
-- RPC repartir_leads_sin_agente(): asigna cada lead vivo sin agente al
-- agente ACTIVO con MENOS leads vivos (round-robin por carga de trabajo),
-- con traza en el timeline del lead. Si no hay agentes activos, abre una
-- alerta de supervisión (alert_type='leads_sin_agente') en vez de perderse
-- en silencio.
--
-- Gate: super_admin/broker (llamada desde el CRM) — y contextos SIN usuario
-- (el cron corre como postgres y service_role), que son de confianza: la RPC
-- no tiene EXECUTE para anon, así que el bypass de uid NULL no es alcanzable
-- desde la web.
--
-- Cron lead-reparto-daily (09:05 ART = '5 12 * * *'): llamada SQL DIRECTA
-- (no hace falta edge function para un UPDATE). Aditiva: no toca filas al
-- instalarse; en runtime sólo escribe assigned_to + trazas.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.repartir_leads_sin_agente()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
     Danilo (28 vivos) no acumula más mientras Helmut (5) queda vacío. */
  CREATE TEMP TABLE _reparto_carga ON COMMIT DROP AS
    SELECT a.id, a.full_name,
           (SELECT count(*) FROM public.leads l
             WHERE l.assigned_to = a.id AND l.deleted_at IS NULL
               AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido')) AS carga
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
     primero (FIFO), y cada asignación recalcula el destino menos cargado. */
  FOR v_orphan IN
    SELECT l.id, l.full_name, l.source
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND l.assigned_to IS NULL
       AND l.stage NOT IN ('cerrado_ganado', 'cerrado_perdido')
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
$$;

REVOKE ALL ON FUNCTION public.repartir_leads_sin_agente() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repartir_leads_sin_agente() TO authenticated, service_role;

COMMENT ON FUNCTION public.repartir_leads_sin_agente() IS
  'Asigna los leads vivos sin agente al agente activo con menos carga (round-robin por carga). Si no hay agentes activos, abre una alerta de supervisión.';

-- Cron diario 09:05 ART (después del crm-followup-alerts de las 09:00):
-- llamada SQL DIRECTA (misma forma que crm-followup-alerts/crm-stale-leads,
-- sin edge function porque no hace falta).
SELECT cron.schedule(
  'lead-reparto-daily',
  '5 12 * * *',
  'SELECT public.repartir_leads_sin_agente()'
);
