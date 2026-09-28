-- Estas funciones quedaban accesibles via grant a PUBLIC (anon/authenticated son
-- miembros de PUBLIC). Se revoca PUBLIC y se re-grantea service_role, que es el rol
-- que usan las Edge Functions. El owner (postgres/pg_cron) no se ve afectado y los
-- triggers no requieren EXECUTE para dispararse. Las publicas por token NO se tocan.

REVOKE EXECUTE ON FUNCTION public.compute_lead_score() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.crm_flag_overdue_visits() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.crm_flag_stale_leads() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.crm_queue_followup_alerts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.leads_followup_on_contact() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.leads_recalc_followup_on_task() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_new_lead() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_rate_limit_logs() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revoke_owner_tokens_on_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.zernio_increment_unread(text, timestamptz, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.compute_lead_score() TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_flag_overdue_visits() TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_flag_stale_leads() TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_queue_followup_alerts() TO service_role;
GRANT EXECUTE ON FUNCTION public.leads_followup_on_contact() TO service_role;
GRANT EXECUTE ON FUNCTION public.leads_recalc_followup_on_task() TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_new_lead() TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_rate_limit_logs() TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_owner_tokens_on_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.zernio_increment_unread(text, timestamptz, text) TO service_role;

-- get_sidebar_badge_counts: solo authenticated (el panel la llama con sesion).
REVOKE EXECUTE ON FUNCTION public.get_sidebar_badge_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sidebar_badge_counts(uuid) TO authenticated;
