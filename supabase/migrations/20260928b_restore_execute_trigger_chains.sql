-- REVERT de la parte riesgosa de las revocaciones de EXECUTE del 2026-09-28.
-- generate_property_code/set_property_code se invocan desde el INSERT de properties
-- con los privilegios del usuario autenticado (no son triggers): sin EXECUTE para
-- authenticated el alta de propiedades falla con "permission denied".
-- Se restaura authenticated en TODAS las funciones revocadas y anon en las que los
-- triggers de tablas anon-writable (leads) pueden requerir. Se CONSERVAN las partes
-- seguras de las migraciones anteriores: REVOKE a PUBLIC de las 10 internas,
-- GRANT a service_role y search_path fijado.

GRANT EXECUTE ON FUNCTION public.compute_lead_score() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.crm_flag_overdue_visits() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.crm_flag_stale_leads() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.crm_queue_followup_alerts() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.notify_new_lead() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.purge_rate_limit_logs() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.revoke_owner_tokens_on_delete() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.leads_followup_on_contact() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.leads_recalc_followup_on_task() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.zernio_increment_unread(text, timestamptz, text) TO authenticated, anon;

GRANT EXECUTE ON FUNCTION public.generate_property_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_property_code(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_property_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_assigned_at_fn() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_visits_lead_cancel_revert() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_visits_lead_completed_auto() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_visits_sync_lead_stage() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_notification_prefs_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.profiles_sensitive_audit_fn() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rela_portal_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.zernio_set_broker_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.zernio_messages_set_broker_id() TO authenticated;
