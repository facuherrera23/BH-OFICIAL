-- ---------------------------------------------------------------------------
-- La Voz: el contador "Vencen en 7 días" usa la MISMA regla que el ícono
-- (2026-11-26, revisión crítica).
--
-- El ícono de Propiedades marca ÁMBAR cuando el aviso vence en ≤ 7 días
-- (ceil((vence - ahora)/día) <= 7  ⟺  vence <= ahora + 7 días) y el README
-- documenta la regla como "≤ 7 días". La RPC usaba `< now() + 7 días`: un
-- aviso que vencía EXACTAMENTE a los 7 días no se contaba, y el panel
-- mostraba "Vencen en 7 días: 0" mientras el ícone de esa propiedad estaba
-- en ámbar. Cambio de un carácter para que los dos digan lo mismo.
--
-- Aditiva: sólo recalcula el agregado de la RPC. No toca filas.
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
        AND expires_at <= now() + interval '7 days'
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

REVOKE ALL ON FUNCTION public.lavoz_portal_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lavoz_portal_status() TO authenticated, service_role;

COMMENT ON FUNCTION public.lavoz_portal_status() IS
  'Estado agregado de La Voz por estado EFECTIVO (misma regla que el panel, el ícono y el server).';
