-- =====================================================================
-- 20260902000001_remediation_p0_rls_rpc
-- R-1 del plan de remediación (REMEDIATION_PLAN.md)
--   R1.1 [F-02] Revocar EXECUTE anon/authenticated/PUBLIC a las 4
--               funciones SECURITY DEFINER (ml_claim_jobs, ml_enqueue,
--               ml_enqueue_batch, trigger_commission_on_property_closed).
--               Queda EXECUTE SOLO para service_role (edge functions usan
--               service_role_key; admin-app.js no las llama por RPC).
--   R1.2 [F-03] owner_portal_tokens: reemplazar policy
--               "owner_portal_tokens_auth" (ALL authenticated USING true)
--               por policy super_admin (is_super_admin). Crear RPC
--               portal_validate_token (SECURITY DEFINER, search_path='')
--               para validación anónima por token (portal-propietario.html).
--   R1.3 [F-04] visits: dropear policies anónimas por confirmation_token,
--               REVOKE SELECT/UPDATE FROM anon, y crear RPCs
--               get_visit_by_token / update_visit_status_by_token
--               (SECURITY DEFINER, search_path='') para confirmar-visita.html.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- R1.1 [F-02] Funciones SECURITY DEFINER ejecutables por anon/PUBLIC
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ml_claim_jobs(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ml_enqueue(uuid, ml_sync_operation, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ml_enqueue_batch(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_commission_on_property_closed() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ml_claim_jobs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_enqueue(uuid, ml_sync_operation, text, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ml_enqueue_batch(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_commission_on_property_closed() TO service_role;

-- ---------------------------------------------------------------------
-- R1.2 [F-03] owner_portal_tokens
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS owner_portal_tokens_auth ON public.owner_portal_tokens;

CREATE POLICY owner_portal_tokens_super_admin_all ON public.owner_portal_tokens
  FOR ALL
  TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

-- RPC de validación de token para portal-propietario.html (cliente anon).
-- SECURITY DEFINER con search_path='' (hardening F-12). SOLO devuelve los
-- datos del owner cuyo token coincide (no expone otros tokens).
CREATE OR REPLACE FUNCTION public.portal_validate_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner jsonb;
  v_scopes text[];
  v_expires timestamptz;
BEGIN
  SELECT jsonb_build_object(
           'id', o.id,
           'full_name', o.full_name,
           'email', o.email,
           'phone', o.phone,
           'dni_cuit', o.dni_cuit,
           'address', o.address,
           'preferred_contact', o.preferred_contact,
           'bank_name', o.bank_name,
           'cbu_cvu', o.cbu_cvu,
           'alias_cbu', o.alias_cbu,
           'exclusive', o.exclusive,
           'exclusive_start', o.exclusive_start,
           'exclusive_end', o.exclusive_end,
           'documents', o.documents
         ), t.scopes, t.expires_at
    INTO v_owner, v_scopes, v_expires
    FROM public.owner_portal_tokens t
    JOIN public.owners o ON o.id = t.owner_id
   WHERE t.token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_expires IS NOT NULL AND v_expires < now() THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'scopes', COALESCE(v_scopes, '{}'::text[]),
    'expires_at', v_expires,
    'owners', v_owner
  );
END;
$$;

REVOKE ALL ON FUNCTION public.portal_validate_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_validate_token(text) TO anon;

-- ---------------------------------------------------------------------
-- R1.3 [F-04] visits: sin acceso anónimo directo; acceso por RPC + token
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS visits_anon_select_by_token ON public.visits;
DROP POLICY IF EXISTS visits_anon_update_by_token ON public.visits;

REVOKE SELECT, UPDATE ON public.visits FROM anon;

-- Lectura pública de una visita válida por token (confirmar-visita.html)
CREATE OR REPLACE FUNCTION public.get_visit_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_client_name text;
  v_client_phone text;
  v_visit_date timestamptz;
  v_duration_minutes integer;
  v_notes text;
  v_status public.visit_status;
  v_agent_name text;
BEGIN
  SELECT v.id, v.client_name, v.client_phone, v.visit_date, v.duration_minutes,
         v.notes, v.status, a.full_name
    INTO v_id, v_client_name, v_client_phone, v_visit_date,
         v_duration_minutes, v_notes, v_status, v_agent_name
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
    'agents', jsonb_build_object('full_name', v_agent_name)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_visit_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visit_by_token(text) TO anon;

-- Actualización de estado por token (confirmar/cancelar), solo desde 'pendiente'
CREATE OR REPLACE FUNCTION public.update_visit_status_by_token(p_token text, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_status public.visit_status;
  v_updated integer := 0;
BEGIN
  IF lower(p_action) = 'confirmar' THEN
    v_new_status := 'confirmada'::public.visit_status;
  ELSIF lower(p_action) = 'cancelar' THEN
    v_new_status := 'cancelada'::public.visit_status;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'accion no valida');
  END IF;

  UPDATE public.visits v
     SET status = v_new_status,
         updated_at = now(),
         confirmed_at = CASE WHEN lower(p_action) = 'confirmar' THEN now() ELSE v.confirmed_at END,
         cancel_reason = CASE WHEN lower(p_action) = 'cancelar' THEN 'Cancelado por el cliente' ELSE v.cancel_reason END
   WHERE v.confirmation_token = p_token
     AND v.status = 'pendiente'::public.visit_status;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'visita no encontrada o no pendiente');
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', v_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.update_visit_status_by_token(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_visit_status_by_token(text, text) TO anon;

COMMIT;