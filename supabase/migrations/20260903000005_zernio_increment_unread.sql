-- ============================================================
-- 20260903000005_zernio_increment_unread.sql
-- ============================================================
-- RPC atómico para incrementar unread_count + actualizar last_message
-- de una conversación en una sola transacción.
-- Reemplaza el patrón read-then-write del webhook que tenía race
-- condition bajo concurrencia.
-- ============================================================

CREATE OR REPLACE FUNCTION public.zernio_increment_unread(
  p_conversation_id text,
  p_last_message_at timestamptz,
  p_last_message_preview text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE zernio_conversations
  SET unread_count = COALESCE(unread_count, 0) + 1,
      last_message_at = GREATEST(COALESCE(last_message_at, p_last_message_at), p_last_message_at),
      last_message_preview = p_last_message_preview
  WHERE id = p_conversation_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.zernio_increment_unread TO service_role;
