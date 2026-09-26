-- =====================================================================
-- Agenda fase 2: no_show, recordatorios, reprogramaciones, check-in por QR.
-- =====================================================================

ALTER TYPE public.visit_status ADD VALUE IF NOT EXISTS 'no_show';
ALTER TYPE public.visit_status ADD VALUE IF NOT EXISTS 'en_curso';

BEGIN;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_2h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reschedule_count integer NOT NULL DEFAULT 0;

-- Reemplaza la version de 2 argumentos (sin p_reason) por la de 3,
-- agregando la accion 'checkin' para el QR de llegada.
DROP FUNCTION IF EXISTS public.update_visit_status_by_token(text, text);

CREATE OR REPLACE FUNCTION public.update_visit_status_by_token(p_token text, p_action text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_status public.visit_status;
  v_updated integer := 0;
BEGIN
  IF lower(p_action) = 'confirmar' THEN
    v_new_status := 'confirmada'::public.visit_status;
  ELSIF lower(p_action) = 'cancelar' THEN
    v_new_status := 'cancelada'::public.visit_status;
  ELSIF lower(p_action) = 'checkin' THEN
    UPDATE public.visits v
       SET check_in = COALESCE(v.check_in, now()),
           status = CASE
                      WHEN v.status IN ('pendiente','confirmada') THEN 'en_curso'::public.visit_status
                      ELSE v.status
                    END,
           updated_at = now()
     WHERE v.confirmation_token = p_token
       AND v.status IN ('pendiente','confirmada','en_curso');
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'visita no encontrada o ya cerrada');
    END IF;
    RETURN jsonb_build_object('ok', true, 'status', 'en_curso');
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'accion no valida');
  END IF;

  UPDATE public.visits v
     SET status = v_new_status,
         updated_at = now(),
         confirmed_at = CASE WHEN lower(p_action) = 'confirmar' THEN now() ELSE v.confirmed_at END,
         cancel_reason = CASE WHEN lower(p_action) = 'cancelar' THEN COALESCE(p_reason, 'Cancelado por el cliente') ELSE v.cancel_reason END
   WHERE v.confirmation_token = p_token
     AND v.status = 'pendiente'::public.visit_status;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'visita no encontrada o no pendiente');
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', v_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.update_visit_status_by_token(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_visit_status_by_token(text, text, text) TO anon;

COMMIT;
