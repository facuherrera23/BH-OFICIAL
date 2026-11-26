-- ---------------------------------------------------------------------------
-- La Voz: los CONTADORES del panel de Portales usan el estado EFECTIVO
-- (2026-11-26, revisión crítica).
--
-- El problema: la RPC lavoz_portal_status() contaba por el `status` CRUDO de
-- la tabla, pero el panel muestra cada fila con el estado real
-- (lavozStatusEfectivo en admin-portales.js). Un aviso que un 'prepare' viejo
-- dejó en 'ready'/'failed' PERO que conserva link + fecha de publicación
-- (la prueba de que se publicó) se pintaba VERDE en la tabla pero contaba
-- como "listo para subir" en el contador: el panel se contradecía solo.
-- En producción (26/11/2026): contador "3 publicados / 5 listos para subir"
-- con 5 filas marcadas "Publicado" (DA-P0002 y DA-P0013).
--
-- La regla efectiva (idéntica a la del server expireVencidos + prepare, y a
-- la del front lavozStatusEfectivo / lavozEstadoDe):
--   · 'expired', o expires_at ya pasado sobre un aviso publicado o con link
--     → VENCIDO.
--   · 'published', o 'ready'/'failed' con link + fecha de publicación → PUBLICADO.
--   · si no, el estado guardado.
--
-- Aditiva: NO toca filas (sólo recalcula el agregado de la RPC). Los avisos
-- degradados los repara el próximo 'prepare' del server (misma regla).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.lavoz_portal_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_config public.lavoz_config%ROWTYPE;
  v_counts RECORD;
BEGIN
  SELECT * INTO v_config FROM public.lavoz_config WHERE id = TRUE;

  WITH eff AS (
    SELECT
      l.expires_at,
      CASE
        WHEN l.status = 'expired'
          OR (l.expires_at IS NOT NULL
              AND l.expires_at < now()
              AND (l.status = 'published' OR l.ad_url IS NOT NULL))
          THEN 'expired'
        WHEN l.status = 'published'
          OR (l.status IN ('ready', 'failed')
              AND l.ad_url IS NOT NULL
              AND l.published_at IS NOT NULL)
          THEN 'published'
        ELSE l.status
      END AS eff_status
    FROM public.lavoz_listings l
  )
  SELECT
    COUNT(*) FILTER (WHERE eff_status = 'published') AS published,
    COUNT(*) FILTER (WHERE eff_status = 'ready')     AS ready,
    COUNT(*) FILTER (WHERE eff_status = 'expired')   AS expired,
    COUNT(*) FILTER (WHERE eff_status = 'failed')    AS failed,
    COUNT(*) FILTER (WHERE eff_status = 'draft')     AS draft,
    COUNT(*) FILTER (
      WHERE eff_status = 'published'
        AND expires_at IS NOT NULL
        AND expires_at < now() + interval '7 days'
    ) AS expiring_soon,
    COUNT(*) AS total
  INTO v_counts
  FROM eff;

  RETURN jsonb_build_object(
    'dias_publicacion', v_config.dias_publicacion,
    'contacto', v_config.contacto,
    'listings', jsonb_build_object(
      'published', COALESCE(v_counts.published, 0),
      'ready', COALESCE(v_counts.ready, 0),
      'expired', COALESCE(v_counts.expired, 0),
      'failed', COALESCE(v_counts.failed, 0),
      'draft', COALESCE(v_counts.draft, 0),
      'expiring_soon', COALESCE(v_counts.expiring_soon, 0),
      'total', COALESCE(v_counts.total, 0)
    )
  );
END;
$$;

-- Mismos permisos que tenía (verificado en producción: anon ✗ / authenticated ✓ /
-- service_role ✓). CREATE OR REPLACE conserva el ACL, pero se re-afirma para
-- que la migración sea idempotente y explícita.
REVOKE ALL ON FUNCTION public.lavoz_portal_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lavoz_portal_status() TO authenticated, service_role;

COMMENT ON FUNCTION public.lavoz_portal_status() IS
  'Estado agregado de La Voz por estado EFECTIVO (misma regla que el panel y el server).';
