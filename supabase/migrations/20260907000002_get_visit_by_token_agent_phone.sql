-- ============================================================
-- 20260907000002_get_visit_by_token_agent_phone
-- La página pública confirmar-visita.html usa este RPC para el
-- botón de WhatsApp, que debe apuntar al agente (no al cliente).
-- Antes devolvía solo agents.full_name; ahora incluye también phone.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_visit_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_client_name text;
  v_client_phone text;
  v_visit_date timestamptz;
  v_duration_minutes integer;
  v_notes text;
  v_status public.visit_status;
  v_agent_name text;
  v_agent_phone text;
BEGIN
  SELECT v.id, v.client_name, v.client_phone, v.visit_date, v.duration_minutes,
         v.notes, v.status, a.full_name, a.phone
    INTO v_id, v_client_name, v_client_phone, v_visit_date,
         v_duration_minutes, v_notes, v_status, v_agent_name, v_agent_phone
    FROM public.visits v
    LEFT JOIN public.agents a ON a.id = v.agent_id
   WHERE v.confirmation_token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', v_id,
    'client_name', v_client_name,
    'client_phone', v_client_phone,
    'visit_date', v_visit_date,
    'duration_minutes', v_duration_minutes,
    'notes', v_notes,
    'status', v_status,
    'agents', jsonb_build_object('full_name', v_agent_name, 'phone', v_agent_phone)
  );
END;
$function$;
