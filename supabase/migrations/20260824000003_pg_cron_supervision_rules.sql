-- ============================================================
-- BIENENHAUS - pg_cron Job para Evaluación de Reglas de Supervisión
-- Ejecuta evaluate_supervision_rules() cada 5 minutos
-- ============================================================

-- Habilitar pg_cron si no está habilitado
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Eliminar job existente si existe
SELECT cron.unschedule('evaluate-supervision-rules') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'evaluate-supervision-rules'
);

-- Programar evaluación cada 5 minutos
SELECT cron.schedule(
  'evaluate-supervision-rules',
  '*/5 * * * *',
  'SELECT evaluate_supervision_rules();'
);

-- Verificar job creado
SELECT * FROM cron.job WHERE jobname = 'evaluate-supervision-rules';