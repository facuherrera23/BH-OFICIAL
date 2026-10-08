-- Reversión de la encuesta HOJA DE VISITA (pedido del dueño 2026-10-08: no gustó el resultado).
-- Se eliminan todos los objetos de la migración 20261008000001_visit_surveys_encuesta_hoja_de_visita
-- y se restaura portal_get_extra_data a su versión anterior (sin hojas de visita).
-- La tabla visit_surveys estaba vacía (0 filas): no hubo pérdida de datos.

DROP FUNCTION IF EXISTS public.get_visit_survey_by_token(text);
DROP FUNCTION IF EXISTS public.submit_visit_survey_by_token(text, jsonb, boolean);
DROP POLICY IF EXISTS visit_surveys_select ON public.visit_surveys;
DROP TABLE IF EXISTS public.visit_surveys;

-- portal_get_extra_data: restaurada a su versión anterior (sin visit_surveys ni anotaciones
-- de encuesta en el historial). Cuerpo completo en producción; ver migración aplicada.
