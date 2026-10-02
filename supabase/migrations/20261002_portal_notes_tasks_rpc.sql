-- Ronda 5: RPCs de interaccion del propietario.
-- portal_send_note: el owner deja una nota al asesor.
-- portal_complete_task: el owner marca una tarea como completada.
-- portal_log_access: registra un acceso al portal.

CREATE OR REPLACE FUNCTION public.portal_send_note(p_token text, p_text text, p_type text DEFAULT 'nota')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_token public.owner_portal_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.owner_portal_tokens t WHERE t.token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'token'); END IF;
  IF v_token.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'revoked'); END IF;
  IF v_token.expires_at IS NOT NULL AND v_token.expires_at < now() THEN RETURN jsonb_build_object('ok', false, 'error', 'expired'); END IF;
  IF length(trim(p_text)) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'texto_corto'); END IF;

  INSERT INTO public.owner_timeline_entries (owner_id, type, text, created_by)
    VALUES (v_token.owner_id, 'nota_propietario', p_text, NULL);
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.portal_complete_task(p_token text, p_task_id uuid, p_result_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_token public.owner_portal_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.owner_portal_tokens t WHERE t.token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'token'); END IF;
  IF v_token.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'revoked'); END IF;
  IF v_token.expires_at IS NOT NULL AND v_token.expires_at < now() THEN RETURN jsonb_build_object('ok', false, 'error', 'expired'); END IF;

  UPDATE public.owner_tasks
     SET status = 'completada', result_notes = p_result_notes, updated_at = now()
   WHERE id = p_task_id AND owner_id = v_token.owner_id;
  RETURN jsonb_build_object('ok', FOUND);
END;
$function$;

CREATE OR REPLACE FUNCTION public.portal_log_access(p_token text, p_event text DEFAULT 'page_view', p_metadata jsonb DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_token public.owner_portal_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.owner_portal_tokens t WHERE t.token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;

  INSERT INTO public.rate_limit_logs (id, event_type, event_subtype, status, metadata)
    VALUES (
      gen_random_uuid(), 'portal_access', p_event, 'allowed',
      jsonb_build_object('token', p_token, 'owner_id', v_token.owner_id) || COALESCE(p_metadata, '{}'::jsonb)
    );
  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_send_note(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_send_note(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.portal_complete_task(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_complete_task(text, uuid, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.portal_log_access(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_log_access(text, text, jsonb) TO anon, authenticated;
