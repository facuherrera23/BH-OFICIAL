-- ---------------------------------------------------------------------------
-- CONVERSIÓN POR ORIGEN (2026-11-26).
--
-- Hoy la conversión por origen sólo existe en el digest semanal de
-- supervisión: el equipo no la ve sin esperar al lunes. Medido (26/11/2026):
-- RELA 29 leads/21 vivos vs ML 46/10 vs GVAmax 33/2 — saber dónde poner el
-- esfuerzo no debería requerir un email.
--
-- RPC conversion_por_origen(p_dias): por origen, leads totales/vivos/
-- perdidos/ganados + tasa de supervivencia dentro de la ventana.
--   · Clamp de días: [1, 365] con el orden CORRECTO
--     (GREATEST(LEAST(x, 365), 1)) — la inversa era el bug de bh_web_metrics
--     que ignoraba el parámetro y devolvía siempre 90 días.
--   · El FROM del agregado NO filtra por stage: los contadores van con
--     FILTER (la regla derivada del bug de bh_web_metrics v1, donde los
--     contadores de WhatsApp/forms daban siempre 0).
-- Lectura para authenticated (la RLS de leads ya permite ver todo el CRM).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.conversion_por_origen(p_dias integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_dias integer;
  v_filas jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;
  v_dias := GREATEST(LEAST(COALESCE(p_dias, 90), 365), 1);

  WITH base AS (
    SELECT COALESCE(NULLIF(l.source, ''), 'sin origen') AS source, l.stage, l.created_at
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND l.created_at >= now() - make_interval(days => v_dias)
  ),
  por_origen AS (
    SELECT source,
           count(*) AS n,
           count(*) FILTER (WHERE stage NOT IN ('cerrado_ganado', 'cerrado_perdido')) AS vivos,
           count(*) FILTER (WHERE stage = 'cerrado_perdido') AS perdidos,
           count(*) FILTER (WHERE stage = 'cerrado_ganado') AS ganados,
           min(created_at)::date AS primero,
           max(created_at)::date AS ultimo
      FROM base
     GROUP BY source
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'source', s.source, 'total', s.n, 'vivos', s.vivos,
           'perdidos', s.perdidos, 'ganados', s.ganados,
           'tasa', CASE WHEN s.n > 0 THEN round(100.0 * s.vivos / s.n, 1) ELSE 0 END,
           'primero', s.primero, 'ultimo', s.ultimo
         ) ORDER BY s.n DESC), '[]'::jsonb)
    INTO v_filas
    FROM por_origen s;

  RETURN jsonb_build_object(
    'dias', v_dias,
    'filas', v_filas,
    'generado', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.conversion_por_origen(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.conversion_por_origen(integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.conversion_por_origen(integer) IS
  'Conversión por origen dentro de la ventana (totales, vivos, perdidos, ganados, tasa) — el tablero que antes vivía sólo en el digest semanal.';
