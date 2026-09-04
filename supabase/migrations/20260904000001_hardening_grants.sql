-- ============================================================
-- HARDENING: EXECUTE GRANTS en funciones system-only
-- ============================================================
-- Cierra el acceso público/anon/authenticated a funciones internas
-- (audit log, supervision, ML, queues). El backend las sigue corriendo
-- con service_role (forzado). No toca tablas ni datos.
-- Reversible: GRANT EXECUTE TO authenticated si algo falla.
-- ============================================================

-- Audit log internas
REVOKE EXECUTE ON FUNCTION public.insert_audit_log(uuid, text, uuid, text, text, text, uuid, text, uuid, text, jsonb, jsonb, text[], jsonb, text, text, inet, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_log_integrity_fn FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_trigger_fn FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_audit_log_integrity FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.backfill_audit_log_hashes FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_audit_log FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_audit_log_hash(uuid) FROM PUBLIC, anon, authenticated;

-- Supervisión core
REVOKE EXECUTE ON FUNCTION public.evaluate_supervision_rules FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.detect_supervision_anomalies FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_supervision_baselines FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_supervision_alerts FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_supervision_all FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_supervision_alert(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.run_supervision_digest(text) FROM PUBLIC, anon, authenticated;

-- ML scoring / prediction
REVOKE EXECUTE ON FUNCTION public.calculate_all_risk_scores(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_user_risk_score(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.evaluate_ml_prediction(uuid, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_ml_prediction(text, uuid, jsonb, boolean, boolean, numeric, numeric, boolean, timestamptz, timestamptz, jsonb, jsonb) FROM PUBLIC, anon, authenticated;

-- ML sync queue
REVOKE EXECUTE ON FUNCTION public.ml_enqueue FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_enqueue_batch FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_claim_jobs FROM PUBLIC, anon, authenticated;

-- Grants a service_role para que el backend las siga usando
GRANT EXECUTE ON FUNCTION public.insert_audit_log TO service_role;
GRANT EXECUTE ON FUNCTION public.audit_log_integrity_fn TO service_role;
GRANT EXECUTE ON FUNCTION public.audit_trigger_fn TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_audit_log_integrity TO service_role;
GRANT EXECUTE ON FUNCTION public.backfill_audit_log_hashes TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_audit_log TO service_role;
GRANT EXECUTE ON FUNCTION public.update_audit_log_hash TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_supervision_rules TO service_role;
GRANT EXECUTE ON FUNCTION public.detect_supervision_anomalies TO service_role;
GRANT EXECUTE ON FUNCTION public.calculate_supervision_baselines TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_supervision_alerts TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_supervision_all TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_supervision_alert TO service_role;
GRANT EXECUTE ON FUNCTION public.run_supervision_digest TO service_role;
GRANT EXECUTE ON FUNCTION public.calculate_all_risk_scores TO service_role;
GRANT EXECUTE ON FUNCTION public.calculate_user_risk_score TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_ml_prediction TO service_role;
GRANT EXECUTE ON FUNCTION public.log_ml_prediction TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_enqueue TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_enqueue_batch TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_claim_jobs TO service_role;

-- VERIFICACION: debe dar 1
SELECT 'hardering_done' AS signal;
