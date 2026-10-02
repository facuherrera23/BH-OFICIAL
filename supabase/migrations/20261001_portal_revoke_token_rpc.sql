-- RPC para invalidar el token del portal al cerrar sesión.
-- Seguridad: solo válido con el token actual (el que revoca).

CREATE OR REPLACE FUNCTION public.portal_revoke_token(p_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.owner_portal_tokens
     SET revoked_at = now()
   WHERE token = p_token
     AND revoked_at IS NULL;
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_revoke_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_revoke_token(text) TO anon, authenticated;
