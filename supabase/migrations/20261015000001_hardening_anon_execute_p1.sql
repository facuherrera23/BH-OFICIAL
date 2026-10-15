-- Hardening P1 (auditoría 2026-10-15): funciones internas SECURITY DEFINER
-- ejecutables por anon via RPC. Clasificación por invocador REAL, investigado
-- contra producción (triggers en pg_trigger, cuerpos de funciones, cron.job,
-- grep de .rpc() en frontend y edge functions):
--
--   GRUPO A — triggers sobre leads (tabla anon-writable: el formulario de
--   contacto del landing inserta leads con rol anon y dispara el trigger).
--   anon DEBE conservar EXECUTE o se rompe el alta pública de leads:
--     compute_lead_score(), notify_new_lead()
--   → SIN revocaciones (excepción justificada, igual que las RPC públicas
--     por token). Se congelan los grants correctos explicitamente.
--
--   GRUPO B — triggers sobre tablas authenticated-only (lead_activities,
--   lead_tasks, owners): authenticated conserva EXECUTE (el DML autenticado
--   dispara el trigger — lección del incidente 2026-09-28); anon nunca
--   escribe esas tablas (RLS) y se le revoca:
--     leads_followup_on_contact(), leads_recalc_followup_on_task(),
--     revoke_owner_tokens_on_delete()
--
--   GRUPO C — solo cron (pg_cron corre como postgres):
--     crm_flag_overdue_visits(), crm_flag_stale_leads(),
--     crm_queue_followup_alerts(), purge_rate_limit_logs(),
--     survey_pending_reminders()
--   → REVOKE a anon y authenticated (el frontend no las llama: grep verificado).
--
--   GRUPO D — solo RPC de Edge Functions con service_role:
--     backup_build_snapshot()  (backup-snapshot)
--     zernio_increment_unread(text, timestamptz, text)  (zernio-webhook)
--   → REVOKE a anon y authenticated; service_role conserva.
--
-- Verificación posterior obligatoria (regla de AGENTS.md): has_function_privilege
-- de la lista completa x (anon, authenticated, service_role, postgres).
-- Resultado verificado 2026-10-15: anon solo conserva Grupo A (2) + las RPC
-- públicas por token; advisor 25 → 15.

-- GRUPO B: triggers de tablas authenticated-only
REVOKE EXECUTE ON FUNCTION public.leads_followup_on_contact() FROM anon;
REVOKE EXECUTE ON FUNCTION public.leads_recalc_followup_on_task() FROM anon;
REVOKE EXECUTE ON FUNCTION public.revoke_owner_tokens_on_delete() FROM anon;

GRANT EXECUTE ON FUNCTION public.leads_followup_on_contact() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leads_recalc_followup_on_task() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_owner_tokens_on_delete() TO authenticated, service_role;

-- GRUPO C: funciones de cron
REVOKE EXECUTE ON FUNCTION public.crm_flag_overdue_visits() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_flag_stale_leads() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_queue_followup_alerts() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_rate_limit_logs() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.survey_pending_reminders() FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.crm_flag_overdue_visits() TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_flag_stale_leads() TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_queue_followup_alerts() TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_rate_limit_logs() TO service_role;
GRANT EXECUTE ON FUNCTION public.survey_pending_reminders() TO service_role;

-- GRUPO D: RPC de Edge Functions (service_role)
REVOKE EXECUTE ON FUNCTION public.backup_build_snapshot() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.zernio_increment_unread(text, timestamptz, text) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backup_build_snapshot() TO service_role;
GRANT EXECUTE ON FUNCTION public.zernio_increment_unread(text, timestamptz, text) TO service_role;

-- GRUPO A: sin cambios de permisos, congelar estado correcto
GRANT EXECUTE ON FUNCTION public.compute_lead_score() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.notify_new_lead() TO anon, authenticated, service_role;

-- REVERT (restaura el estado previo de 20260928b si algo rompiera):
-- GRANT EXECUTE ON FUNCTION public.leads_followup_on_contact() TO anon;
-- GRANT EXECUTE ON FUNCTION public.leads_recalc_followup_on_task() TO anon;
-- GRANT EXECUTE ON FUNCTION public.revoke_owner_tokens_on_delete() TO anon;
-- GRANT EXECUTE ON FUNCTION public.crm_flag_overdue_visits() TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.crm_flag_stale_leads() TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.crm_queue_followup_alerts() TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.purge_rate_limit_logs() TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.survey_pending_reminders() TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.backup_build_snapshot() TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.zernio_increment_unread(text, timestamptz, text) TO anon, authenticated;
