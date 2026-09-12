-- Limpieza de scaffold sin uso (auditoría 2026-09-11).
-- Tablas con 0 filas, sin referencias desde assets/js ni edge functions, que solo
-- alimentan shadow-pipelines de "ML/AI" que nunca se implementaron.
--
-- NOTA: document_requirements NO se toca — la usa loadOwnerChecklist (admin-app.js).
-- NOTA: user_risk_scores era alimentada por el cron 'calculate-risk-scores'
--       (cada hora) — se desprograma acá para no dejar un job roto apuntando a
--       una tabla inexistente.

-- 1) Cron huérfano
SELECT cron.unschedule('calculate-risk-scores');

-- 2) Funciones del scaffolding (firmas exactas según pg_proc al 2026-09-11)
DROP FUNCTION IF EXISTS public.evaluate_ml_prediction(uuid, boolean, uuid, text);
DROP FUNCTION IF EXISTS public.log_ml_prediction(text, uuid, jsonb, boolean, boolean, numeric, numeric, boolean, timestamptz, timestamptz, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.calculate_all_risk_scores(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.calculate_user_risk_score(uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.log_api_key_access(text, text, text, text, jsonb);

-- 3) Tablas muertas
DROP TABLE IF EXISTS public.ml_predictions_log CASCADE;
DROP TABLE IF EXISTS public.ml_model_metrics CASCADE;
DROP TABLE IF EXISTS public.user_risk_scores CASCADE;
DROP TABLE IF EXISTS public.api_key_audit CASCADE;
