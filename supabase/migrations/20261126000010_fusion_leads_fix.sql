-- ---------------------------------------------------------------------------
-- FUSIÓN DE LEADS — fix (2026-11-26, detectado verificando en vivo):
-- leads_duplicados() tenía un ORDER BY exterior sobre columnas no agregadas
-- junto al jsonb_agg → error 42803 en runtime para CUALQUIER llamada
-- autenticada (no se detectó al crear la función: plpgsql valida el SQL
-- recién al ejecutarla). El orden del array va DENTRO del jsonb_agg y el
-- LIMIT 50 pasa a un subquery.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.leads_duplicados()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_grupos jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;
  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  IF v_role NOT IN ('super_admin', 'broker') THEN
    RETURN jsonb_build_object('error', 'solo super_admin o broker');
  END IF;

  WITH base AS (
    SELECT l.id, l.full_name, l.stage, l.source, l.created_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono, l.email,
           'email'::text AS tipo,
           lower(regexp_replace(l.email, '[^a-zA-Z0-9]', '', 'g')) AS k
      FROM public.leads l
     WHERE l.deleted_at IS NULL AND l.email IS NOT NULL AND l.email <> ''
    UNION ALL
    SELECT l.id, l.full_name, l.stage, l.source, l.created_at,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono, l.email,
           'tel'::text AS tipo,
           right(regexp_replace(COALESCE(l.whatsapp, l.phone, ''), '[^0-9]', '', 'g'), 8) AS k
      FROM public.leads l
     WHERE l.deleted_at IS NULL
       AND COALESCE(l.whatsapp, l.phone, '') <> ''
       AND length(regexp_replace(COALESCE(l.whatsapp, l.phone, ''), '[^0-9]', '', 'g')) >= 8
  ),
  grupos AS (
    SELECT tipo, k, count(*) AS n, min(created_at) AS primero
      FROM base
     WHERE k IS NOT NULL AND k <> ''
     GROUP BY tipo, k
    HAVING count(*) > 1
  ),
  top AS (
    SELECT tipo, k, n, primero
      FROM grupos
     ORDER BY n DESC, primero ASC
     LIMIT 50
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tipo', g.tipo,
           'clave', g.k,
           'n', g.n,
           'miembros', (
             SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'lead_id', b.id, 'nombre', b.full_name, 'stage', b.stage,
                      'source', b.source, 'created_at', b.created_at,
                      'telefono', b.telefono, 'email', b.email
                    ) ORDER BY b.created_at ASC), '[]'::jsonb)
               FROM base b
              WHERE b.tipo = g.tipo AND b.k = g.k
           )
         ) ORDER BY g.n DESC, g.primero ASC), '[]'::jsonb)
    INTO v_grupos
    FROM top g;

  RETURN jsonb_build_object('grupos', v_grupos, 'n_grupos', COALESCE(jsonb_array_length(v_grupos), 0));
END;
$$;

REVOKE ALL ON FUNCTION public.leads_duplicados() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leads_duplicados() TO authenticated, service_role;
