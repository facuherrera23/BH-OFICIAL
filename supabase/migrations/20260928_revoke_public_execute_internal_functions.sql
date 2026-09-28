-- Solo se revoca EXECUTE a anon y authenticated en funciones INTERNAS (cron/trigger).
-- Los RPC publicos por token (portal_get_portal_data, get_visit_by_token,
-- update_visit_status_by_token, log_visit_public_action, portal_validate_token) quedan
-- intactos: los usan las paginas publicas. get_sidebar_badge_counts necesita authenticated
-- (lo usa el panel), por eso solo se le quita anon.
-- pg_cron y los triggers no pasan por esos roles: no se rompe nada existente.

REVOKE EXECUTE ON FUNCTION public.compute_lead_score() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_flag_overdue_visits() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_flag_stale_leads() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_queue_followup_alerts() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_new_lead() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_rate_limit_logs() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_owner_tokens_on_delete() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.leads_followup_on_contact() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.leads_recalc_followup_on_task() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_property_code() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_property_code(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_property_code() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_assigned_at_fn() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_visits_lead_cancel_revert() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_visits_lead_completed_auto() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_visits_sync_lead_stage() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_notification_prefs_updated_at() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.profiles_sensitive_audit_fn() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rela_portal_status() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zernio_set_broker_id() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zernio_messages_set_broker_id() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zernio_increment_unread(text, timestamptz, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_sidebar_badge_counts(uuid) FROM anon;

-- Hardening: search_path fijo en las funciones flaggeadas (previene hijack por search_path)
ALTER FUNCTION public.gen_request_id() SET search_path = public;
ALTER FUNCTION public.sync_property_price_fields() SET search_path = public;
ALTER FUNCTION public.leads_followup_on_stage_close() SET search_path = public;
