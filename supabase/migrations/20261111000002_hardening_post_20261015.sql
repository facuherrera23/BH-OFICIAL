-- Hardening de permisos post-barrido 2026-10-15 (advisor 2026-11-11).
--
-- Clase de bug: el hardening del 2026-10-15 (migracion 20261015000001)
-- clasifico y revoco EXECUTE de las funciones EXISTENTES, pero toda funcion
-- creada DESPUES hereda el grant default EXECUTE TO PUBLIC (Postgres da
-- EXECUTE a PUBLIC por defecto) — el hardening no tiene red de redes para
-- funciones nuevas. El advisor de seguridad volvia a marcar exactamente 2:
--
--  * log_property_price_change (2026-10-16): SECURITY DEFINER, trigger
--    trg_property_price_history sobre properties. La tabla no tiene NINGUNA
--    policy para anon (escritura solo authenticated/service_role) → anon
--    pierde EXECUTE; conservan authenticated, service_role y postgres.
--  * revoke_owner_tokens_on_deactivate (2026-10-30): SECURITY DEFINER,
--    trigger trg_owners_revoke_tokens_on_deactivate sobre owners (RLS UPDATE
--    super_admin-only) → mismo tratamiento.
--
-- En el mismo barrido, por uniformidad de la matriz de grants, los triggers
-- sociales tr_social_posts_updated_at / tr_social_accounts_updated_at
-- (no-SECDEF, no flaggeados por el advisor): sus tablas (social_posts,
-- social_accounts) tampoco tienen policies anon.
--
-- Lint function_search_path_mutable (2 WARN nuevos del modulo contenido):
-- los mismos 2 triggers sociales no tenian search_path fijado →
-- ALTER FUNCTION SET search_path = '' (cuerpos solo usan now() y NEW/OLD;
-- pg_catalog queda siempre implicito). Mismo patron que el hardening vigente.
--
-- Aditivo y reversible: solo REVOKE/GRANT/ALTER FUNCTION — no toca tablas
-- ni datos. Verificacion: has_function_privilege matrix (anon 0 en las 4) +
-- re-scan del advisor (anon-SECDEF 17 -> 15, search_path_mutable 2 -> 0).

REVOKE EXECUTE ON FUNCTION public.log_property_price_change() FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_property_price_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revoke_owner_tokens_on_deactivate() FROM anon;
REVOKE EXECUTE ON FUNCTION public.revoke_owner_tokens_on_deactivate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tr_social_posts_updated_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.tr_social_posts_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tr_social_accounts_updated_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.tr_social_accounts_updated_at() FROM PUBLIC;

ALTER FUNCTION public.tr_social_posts_updated_at() SET search_path = '';
ALTER FUNCTION public.tr_social_accounts_updated_at() SET search_path = '';
