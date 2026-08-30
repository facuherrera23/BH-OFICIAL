-- ============================================================
-- MIGRATION: Fix P0 Security + Functional Issues (Post-Audit)
-- ============================================================
-- Fixes:
-- 1. RLS: service_role_tasaciones TO service_role (was PUBLIC - anon CRUD)
-- 2. RLS: admin_full_access_tasaciones TO authenticated (was PUBLIC)
-- 3. RLS: leads anon INSERT policy (landing contact form + newsletter)
-- 4. RLS: portal_settings_public_read -> authenticated only (leaks api_key/api_secret)
-- 5. Functions: REVOKE EXECUTE FROM PUBLIC, anon, authenticated on sensitive SECURITY DEFINER functions
-- 6. Functions: GRANT EXECUTE TO service_role on restricted functions
-- 7. Functions: Keep authenticated EXECUTE on get_sidebar_badge_counts, generate_property_code
-- 8. Views: ALTER VIEW ... SET (security_invoker = true) for 8 security definer views
-- 9. Indexes: DROP 5 unused indexes on audit_log (advisor flagged)
-- 10. Indexes: CREATE missing FK indexes for performance (advisor flagged)
-- ============================================================

-- ------------------------------------------------------------
-- 1. RLS FIXES - TASACIONES (P0-1: anon could CRUD everything)
-- ------------------------------------------------------------
ALTER POLICY service_role_tasaciones ON public.tasaciones TO service_role;
ALTER POLICY admin_full_access_tasaciones ON public.tasaciones TO authenticated;

-- ------------------------------------------------------------
-- 2. RLS FIX - LEADS ANON INSERT (P0-4: landing form broken)
-- ------------------------------------------------------------
-- Anon can insert leads from landing contact form (source='landing_page')
-- and newsletter form (source='newsletter'). No SELECT/UPDATE/DELETE.
CREATE POLICY leads_anon_insert ON public.leads
  FOR INSERT TO anon
  WITH CHECK (source IN ('landing_page', 'newsletter'));

-- ------------------------------------------------------------
-- 3. RLS FIX - PORTAL_SETTINGS PUBLIC READ LEAKS SECRETS
-- ------------------------------------------------------------
-- Current policy: TO public USING (true) exposes api_key/api_secret to anon
-- Fix: restrict to authenticated only (landing doesn't read portal_settings)
DROP POLICY IF EXISTS portal_settings_public_read ON public.portal_settings;
CREATE POLICY portal_settings_authenticated_read ON public.portal_settings
  FOR SELECT TO authenticated
  USING (true);

-- ------------------------------------------------------------
-- 4. FUNCTION SECURITY: REVOKE FROM PUBLIC/ANON/AUTHENTICATED
--     on sensitive SECURITY DEFINER functions
-- ------------------------------------------------------------
-- First: REVOKE ALL FROM PUBLIC on all public functions (clean slate)
-- Then: REVOKE FROM anon on all functions (anon should only have is_super_admin)
-- Then: REVOKE FROM authenticated on RESTRICTED set (dangerous/cron/edge-only)
-- Then: GRANT to service_role on all, + authenticated on needed ones

-- 4a. REVOKE ALL FROM PUBLIC on all public functions
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC;', f.nspname, f.proname, f.args);
  END LOOP;
END $$;

-- 4b. REVOKE FROM anon on all public functions (anon only keeps is_super_admin)
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT (p.proname = 'is_super_admin')  -- anon needs this for RLS policies
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM anon;', f.nspname, f.proname, f.args);
  END LOOP;
END $$;

-- 4c. REVOKE FROM authenticated on RESTRICTED functions (dangerous/cron/edge-only)
-- These functions should only be callable by service_role (and owner/postgres)
DO $$
DECLARE
  restricted_funcs TEXT[] := ARRAY[
    'insert_audit_log',
    'insert_usage_event',
    'backfill_audit_log_hashes',
    'update_audit_log_hash',
    'verify_audit_log_integrity',
    'purge_audit_log',
    'purge_supervision_alerts',
    'purge_supervision_all',
    'run_supervision_digest',
    'calculate_all_risk_scores',
    'calculate_user_risk_score',
    'calculate_supervision_baselines',
    'detect_supervision_anomalies',
    'evaluate_supervision_rules',
    'log_ml_prediction',
    'evaluate_ml_prediction',
    'notify_supervision_alert',
    'create_user_session',
    'close_user_session',
    'log_api_key_access'
  ];
  fname TEXT;
  fargs TEXT;
BEGIN
  FOREACH fname IN ARRAY restricted_funcs LOOP
    -- Get function arguments for each overload
    FOR fargs IN
      SELECT pg_get_function_identity_arguments(p.oid)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fname
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM authenticated;', fname, fargs);
    END LOOP;
  END LOOP;
END $$;

-- 4d. GRANT EXECUTE TO service_role on ALL public functions (edge functions use service_role)
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role;', f.nspname, f.proname, f.args);
  END LOOP;
END $$;

-- 4e. GRANT EXECUTE TO authenticated on functions needed by frontend/triggers
-- get_sidebar_badge_counts: admin panel RPC
-- generate_property_code: trigger chain (broker INSERT -> trigger -> this function)
-- count_pending_visits_for_lead: trigger chain (broker UPDATE visit -> trigger -> this)
-- is_super_admin: already public/anon/authenticated (not SECURITY DEFINER, but keep grants)
DO $$
DECLARE
  needed_funcs TEXT[] := ARRAY[
    'get_sidebar_badge_counts',
    'generate_property_code',
    'count_pending_visits_for_lead',
    'is_super_admin',
    'set_property_code',            -- legacy trigger-style, keep for authenticated
    'set_property_code_on_insert'   -- trigger fn, not definer but keep for authenticated
  ];
  fname TEXT;
  fargs TEXT;
BEGIN
  FOREACH fname IN ARRAY needed_funcs LOOP
    FOR fargs IN
      SELECT pg_get_function_identity_arguments(p.oid)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fname
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated;', fname, fargs);
    END LOOP;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 5. VIEWS: SECURITY INVOKER = TRUE (P0-3: 8 security definer views)
-- ------------------------------------------------------------
ALTER VIEW public.ml_model_performance SET (security_invoker = true);
ALTER VIEW public.daily_user_activity SET (security_invoker = true);
ALTER VIEW public.daily_module_activity SET (security_invoker = true);
ALTER VIEW public.open_alerts_by_user SET (security_invoker = true);
ALTER VIEW public.my_assigned_alerts SET (security_invoker = true);
ALTER VIEW public.purge_audit_log SET (security_invoker = true);
ALTER VIEW public.supervision_anomalies_recent SET (security_invoker = true);
ALTER VIEW public.current_user_risk_scores SET (security_invoker = true);

-- ------------------------------------------------------------
-- 6. INDEXES: DROP 5 UNUSED INDEXES ON AUDIT_LOG (advisor flagged)
-- ------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_audit_log_entity;
DROP INDEX IF EXISTS public.idx_audit_log_event_hash;
DROP INDEX IF EXISTS public.idx_audit_log_previous_hash;
DROP INDEX IF EXISTS public.idx_audit_log_request;
DROP INDEX IF EXISTS public.idx_audit_log_session;

-- ------------------------------------------------------------
-- 7. INDEXES: CREATE MISSING FK INDEXES (advisor flagged)
-- ------------------------------------------------------------
-- audit_log.broker_id -> agents.id (audit_log has 361 rows, important)
CREATE INDEX IF NOT EXISTS idx_audit_log_broker_id ON public.audit_log(broker_id);

-- properties FKs (18 rows, will grow)
CREATE INDEX IF NOT EXISTS idx_properties_agent_id ON public.properties(agent_id);
CREATE INDEX IF NOT EXISTS idx_properties_created_by ON public.properties(created_by);
CREATE INDEX IF NOT EXISTS idx_properties_owner_id ON public.properties(owner_id);

-- supervision_anomalies.baseline_id -> supervision_baselines.id (101 rows)
CREATE INDEX IF NOT EXISTS idx_supervision_anomalies_baseline_id ON public.supervision_anomalies(baseline_id);

-- visits FKs (public confirmation page uses visits)
CREATE INDEX IF NOT EXISTS idx_visits_created_by ON public.visits(created_by);
CREATE INDEX IF NOT EXISTS idx_visits_lead_id ON public.visits(lead_id);
CREATE INDEX IF NOT EXISTS idx_visits_property_id ON public.visits(property_id);

-- leads FKs (will have data once form works)
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON public.leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_property_id ON public.leads(property_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_by ON public.leads(created_by);

-- usage_events.broker_id -> agents.id
CREATE INDEX IF NOT EXISTS idx_usage_events_broker_id ON public.usage_events(broker_id);

-- portal_settings.updated_by -> profiles.id
CREATE INDEX IF NOT EXISTS idx_portal_settings_updated_by ON public.portal_settings(updated_by);

-- site_content.updated_by -> profiles.id
CREATE INDEX IF NOT EXISTS idx_site_content_updated_by ON public.site_content(updated_by);

-- zernio_messages.sent_by -> profiles.id
CREATE INDEX IF NOT EXISTS idx_zernio_messages_sent_by ON public.zernio_messages(sent_by);

-- agents FKs
CREATE INDEX IF NOT EXISTS idx_agents_created_by ON public.agents(created_by);
CREATE INDEX IF NOT EXISTS idx_agents_profile_id ON public.agents(profile_id);

-- commission_payments FKs
CREATE INDEX IF NOT EXISTS idx_commission_payments_commission_id ON public.commission_payments(commission_id);
CREATE INDEX IF NOT EXISTS idx_commission_payments_owner_id ON public.commission_payments(owner_id);

-- commissions.liquidation_id
CREATE INDEX IF NOT EXISTS idx_commissions_liquidation_id ON public.commissions(liquidation_id);

-- ml_listings.property_id
CREATE INDEX IF NOT EXISTS idx_ml_listings_property_id ON public.ml_listings(property_id);

-- ------------------------------------------------------------
-- 8. VISITS: ANON POLICY FOR PUBLIC CONFIRMATION PAGE
-- ------------------------------------------------------------
-- confirmar-visita.html uses anon client to:
-- 1. SELECT visits by confirmation_token (token in URL)
-- 2. UPDATE visits set status='confirmada' or 'cancelada'
-- Need anon SELECT/UPDATE on visits WHERE confirmation_token matches
CREATE POLICY visits_anon_select_by_token ON public.visits
  FOR SELECT TO anon
  USING (confirmation_token IS NOT NULL);

CREATE POLICY visits_anon_update_by_token ON public.visits
  FOR UPDATE TO anon
  USING (confirmation_token IS NOT NULL)
  WITH CHECK (confirmation_token IS NOT NULL);

-- ------------------------------------------------------------
-- END OF MIGRATION
-- ------------------------------------------------------------