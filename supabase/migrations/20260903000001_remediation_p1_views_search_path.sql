-- =====================================================================
-- 20260903000001_remediation_p1_views_search_path
-- R-3.5 [F-10] Vistas security_invoker para profiles/agents (limitar columnas expuestas)
-- R-3.7 [F-12] SET search_path = '' en todas las funciones SECURITY DEFINER
-- =====================================================================

BEGIN;

-- ----------------------------------------------------------------------
-- R-3.5 [F-10] Vistas security_invoker para profiles y agents
-- Exposición mínima a `authenticated` (sin emails privados, comisiones, etc.)
-- El público sigue viendo agents activos via policy agents_select.
-- ----------------------------------------------------------------------

-- Vista para profiles (solo columnas necesarias para UI)
DROP VIEW IF EXISTS public.staff_profiles_view;
CREATE VIEW public.staff_profiles_view
WITH (security_invoker = true) AS
SELECT
  id,
  full_name,
  role,
  is_active,
  created_at
FROM public.profiles;

GRANT SELECT ON public.staff_profiles_view TO authenticated;

-- Vista para agents (sin rates de comisión ni matrícula para no-admin)
DROP VIEW IF EXISTS public.staff_agents_view;
CREATE VIEW public.staff_agents_view
WITH (security_invoker = true) AS
SELECT
  id,
  full_name,
  matricula,
  status,
  profile_id,
  created_at
FROM public.agents;

GRANT SELECT ON public.staff_agents_view TO authenticated;

-- ----------------------------------------------------------------------
-- R-3.7 [F-12] SET search_path = '' en todas las funciones SECURITY DEFINER
-- (excluyendo las que ya tienen search_path fijo en migraciones previas)
-- Lista basada en pg_proc + advisor WARN de "security_definer_view"
-- Usamos EXECUTE dinámico para evitar error de parseo en funciones inexistentes.
-- ----------------------------------------------------------------------

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef  -- SECURITY DEFINER
      AND p.proname IN (
        'update_updated_at', 'set_property_code_on_insert', 'set_property_code',
        'generate_property_code', 'count_pending_visits_for_lead', 'is_super_admin',
        'audit_trigger_fn', 'audit_log_integrity_fn', 'set_assigned_at_fn',
        'update_notification_prefs_updated_at', 'zernio_set_broker_id',
        'zernio_messages_set_broker_id', 'profiles_sensitive_audit_fn',
        'get_sidebar_badge_counts', 'trigger_commission_on_property_closed',
        'get_visit_by_token', 'update_visit_status_by_token', 'portal_validate_token',
        'rela_portal_status'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %I(%s) SET search_path = ''''', fn.proname, fn.args);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------
-- Verificación: advisor ya no debe mostrar WARN de security_definer_view
-- ni de search_path mutable en funciones SECURITY DEFINER.
-- ----------------------------------------------------------------------

COMMIT;