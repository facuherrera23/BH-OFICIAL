-- ---------------------------------------------------------------------------
-- HIGIENE DE ALERTAS (2026-11-27) — P0-1.
--
-- Diagnóstico del 27/11: el panel de Supervisión mostraba 25 alertas abiertas
-- y 19 eran RUIDO VIEJO:
--   · 14 × `crm_email_broken` (24/9 → 10/10): el aviso de que "el email del
--     CRM está caído" nunca se auto-resolvía, así que se acumulaban copias
--     idénticas de un incidente viejo.
--   ·  3 × `sensitive_config_change` (29/8 → 11/10): cambios de configuración
--     ya auditados hace semanas.
--   ·  2 × `visit_overdue` (21/11 y 26/11): FALSAS ALERTAS. Las dos visitas
--     están en `no_show` (el cliente no vino) — el auto-resolve de
--     `crm_flag_overdue_visits()` sólo cubría `completada`/`cancelada`, así
--     que pedía cerrar a mano visitas que ya se habían cerrado.
--
-- Qué hace esta migración:
--   1. Recrea `crm_flag_overdue_visits()` para que auto-resuelva también
--      `no_show` (y `en_curso` que quedó colgada), y para que NO reabra
--      alertas de visitas ya resueltas.
--   2. Cierra las 19 alertas viejas (no las borra: `status='resolved'` +
--      `notes` con el motivo → siguen en el histórico).
--   3. Deja las 6 `lead_followup_overdue` ABIERTAS: son reales (la más
--      reciente es del 26/11) y son justamente lo que el panel debe mostrar.
--
-- Nada se borra: todo es soft (status + notes + timestamps).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1) Función de detección de visitas vencidas (auto-resolve completo).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_flag_overdue_visits()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inserted int := 0;
  r record;
  v_fallback uuid;
BEGIN
  SELECT p.id INTO v_fallback
    FROM public.profiles p
   WHERE p.role = 'super_admin' AND p.is_active
   ORDER BY p.created_at
   LIMIT 1;

  -- Alertas nuevas: visitas ABIERTAS y vencidas (más de 2 h de atraso).
  FOR r IN
    SELECT v.id, v.client_name, v.visit_date, v.agent_id,
           a.profile_id AS agent_profile_id
      FROM public.visits v
      LEFT JOIN public.agents a ON a.id = v.agent_id
     WHERE v.deleted_at IS NULL
       AND v.status IN ('pendiente', 'confirmada', 'en_curso')
       AND v.visit_date < now() - interval '2 hours'
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM public.supervision_alerts s
       WHERE s.alert_type = 'visit_overdue'
         AND s.evidence->>'visit_id' = r.id::text
         AND s.status IN ('open', 'assigned', 'investigating')
    ) THEN
      INSERT INTO public.supervision_alerts
        (user_id, module, severity, alert_type, title, description, evidence, status)
      VALUES (
        COALESCE(r.agent_profile_id, v_fallback), 'agenda', 'medium', 'visit_overdue',
        'Visita sin cierre: ' || COALESCE(r.client_name, 'Visita'),
        'La visita de ' || COALESCE(r.client_name, 'este cliente') || ' era el ' ||
          to_char(r.visit_date AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI') ||
          ' y sigue abierta.',
        jsonb_build_object('visit_id', r.id, 'visit_date', r.visit_date, 'agent_id', r.agent_id),
        'open');
      inserted := inserted + 1;
    END IF;
  END LOOP;

  -- Auto-resolver: la visita ya NO está abierta.
  -- `no_show` (el cliente no vino) ES un cierre: pedirlo a mano era ruido.
  UPDATE public.supervision_alerts s
     SET status      = 'resolved',
         resolved_at = now(),
         notes       = COALESCE(s.notes, '') ||
                      ' Auto-resuelta ' || to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') ||
                      ': la visita ya no está abierta.'
   WHERE s.alert_type = 'visit_overdue'
     AND s.status IN ('open', 'assigned', 'investigating')
     AND EXISTS (
       SELECT 1
         FROM public.visits v
        WHERE v.id::text = s.evidence->>'visit_id'
          AND (v.deleted_at IS NOT NULL
               OR v.status IN ('completada', 'cancelada', 'no_show'))
     );

  RETURN inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_flag_overdue_visits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_flag_overdue_visits() TO service_role;

COMMENT ON FUNCTION public.crm_flag_overdue_visits() IS
  'Detecta visitas abiertas y vencidas (>2 h) y auto-resuelve la alerta cuando la visita se cierra (incluye no_show).';

-- ---------------------------------------------------------------------------
-- 2) Cerrar el ruido viejo (soft: status + notas, NO se borra nada).
-- ---------------------------------------------------------------------------

-- 14 × crm_email_broken (24/9 → 10/10): incidentes ya terminados.
UPDATE public.supervision_alerts
   SET status      = 'resolved',
       resolved_at = now(),
       notes       = COALESCE(notes, '') ||
                    ' Cerrada el 27/11/2026: alerta vieja (email del CRM verificado en pie — la traza vive en crm_envios).'
 WHERE alert_type = 'crm_email_broken'
   AND status IN ('open', 'assigned', 'investigating')
   AND created_at < '2026-10-15T00:00:00Z';

-- 3 × sensitive_config_change (29/8 → 11/10): cambios ya auditados.
UPDATE public.supervision_alerts
   SET status      = 'resolved',
       resolved_at = now(),
       notes       = COALESCE(notes, '') ||
                    ' Cerrada el 27/11/2026: cambio de configuración ya auditado (alerta vieja).'
 WHERE alert_type = 'sensitive_config_change'
   AND status IN ('open', 'assigned', 'investigating')
   AND created_at < '2026-11-01T00:00:00Z';

-- 2 × visit_overdue falsas: las resuelve la función recreada (visitas no_show).
SELECT public.crm_flag_overdue_visits();
