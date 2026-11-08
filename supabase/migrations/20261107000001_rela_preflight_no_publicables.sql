-- ============================================================
-- 20261107000001 — RELA: "bloqueado" ≠ "no publicable"
-- ============================================================
-- MOTIVO (2026-11-07): `rela_portal_status()` contaba como BLOCKED todas las
-- filas de rela_listings. De las 18 filas BLOCKED, 13 eran propiedades ya
-- VENDIDAS: no son bloqueos (nunca se van a publicar), son propiedades que
-- quedan fuera de la cola. El panel mostraba "18 bloqueados" cuando el
-- problema real eran 5 avisos (3 zonas sin mapear en RELA).
--
-- AHORA:
--   blocked         → avisos de propiedades que SIGUEN siendo publicables
--                      (venta/alquiler) pero a las que les falta algo.
--   not_publishable → avisos de propiedades vendidas/alquiladas/pausadas:
--                      quedan fuera de la cola, no son un error.
--
-- La función es idempotente (CREATE OR REPLACE) y no cambia los permisos.
-- ============================================================

CREATE OR REPLACE FUNCTION public.rela_portal_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config public.rela_config%ROWTYPE;
  v_counts RECORD;
BEGIN
  SELECT * INTO v_config FROM public.rela_config WHERE id = TRUE;

  SELECT
    COUNT(*) FILTER (WHERE l.status = 'PUBLISHED') AS published,
    COUNT(*) FILTER (WHERE l.status IN ('PENDING', 'UPDATE_PENDING')) AS pending,
    COUNT(*) FILTER (WHERE l.status = 'ERROR') AS errors,
    /* Sólo cuentan como bloqueo las propiedades que todavía se publican. */
    COUNT(*) FILTER (
      WHERE l.status = 'BLOCKED'
        AND p.status IN ('venta', 'alquiler')
    ) AS blocked,
    /* Las vendidas/pausadas no son bloqueos: quedan fuera de la cola. */
    COUNT(*) FILTER (
      WHERE l.status = 'BLOCKED'
        AND (p.status IS NULL OR p.status NOT IN ('venta', 'alquiler'))
    ) AS not_publishable,
    COUNT(*) FILTER (WHERE l.status = 'UNPUBLISHED') AS unpublished,
    COUNT(l.id) AS total
  INTO v_counts
  FROM public.rela_listings l
  LEFT JOIN public.properties p ON p.id = l.property_id;

  RETURN jsonb_build_object(
    'environment', v_config.environment,
    'base_url', v_config.base_url,
    'codigo_inmobiliaria', v_config.codigo_inmobiliaria,
    'dry_run', v_config.dry_run,
    'callbacks_enabled', v_config.callbacks_enabled,
    'last_auth_at', v_config.last_auth_at,
    'last_sync_at', v_config.last_sync_at,
    'last_error', v_config.last_error,
    'listings', jsonb_build_object(
      'published', COALESCE(v_counts.published, 0),
      'pending', COALESCE(v_counts.pending, 0),
      'errors', COALESCE(v_counts.errors, 0),
      'blocked', COALESCE(v_counts.blocked, 0),
      'not_publishable', COALESCE(v_counts.not_publishable, 0),
      'unpublished', COALESCE(v_counts.unpublished, 0),
      'total', COALESCE(v_counts.total, 0)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rela_portal_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rela_portal_status() TO authenticated;
