-- ============================================
-- 20261128000011 — Backfill GUIADO de motivos de pérdida
-- ============================================
-- 35 de 87 leads cerrado_perdido de los últimos 90 días no tenían
-- `lost_reason` (28/11/2026). Los de los últimos 7 días ya se completan con
-- el modal nuevo: el hueco es HISTÓRICO.
--
-- Esta RPC es SÓLO LECTURA. Devuelve los candidatos con un motivo SUGERIDO
-- inferido del último evento del timeline (no del pasado remoto) y el texto
-- que lo justifica, para que el agente CONFIRME antes de escribir. Nunca
-- escribe: la UI usa `BH_CRM.setLostReason` (misma función del modal, que
-- deja nota en `lead_activities`). El backfill jamás es automático.
-- ============================================

CREATE OR REPLACE FUNCTION public.crm_motivos_pendientes(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_leads jsonb;
  v_total integer;
BEGIN
  SELECT count(*) INTO v_total
    FROM public.leads l
   WHERE l.stage::text = 'cerrado_perdido'
     AND l.lost_reason IS NULL
     AND l.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'lead_id', x.id::text,
           'nombre', COALESCE(x.full_name, 'Lead sin nombre'),
           'fecha', x.cerrado,
           'sugerido', x.sugerido,
           'label', CASE x.sugerido
             WHEN 'presupuesto' THEN 'Presupuesto'
             WHEN 'ubicacion' THEN 'Ubicación'
             WHEN 'encontro_otra' THEN 'Encontró otra'
             WHEN 'no_responde' THEN 'No responde'
             WHEN 'financiamiento' THEN 'Financiamiento'
             WHEN 'timing' THEN 'Timing'
             WHEN 'perdio_interes' THEN 'Perdió interés'
             WHEN 'sin_propiedad' THEN 'Sin propiedad adecuada'
             WHEN 'duplicado' THEN 'Duplicado'
             ELSE 'Otro' END,
           'indicio', COALESCE(left(x.indicio, 180), 'Sin eventos en el historial')
         ) ORDER BY x.cerrado DESC NULLS LAST), '[]'::jsonb)
    INTO v_leads
    FROM (
      SELECT l.id, l.full_name, l.updated_at AS cerrado,
             a.title AS ultimo_titulo, a.description AS indicio,
             CASE
               WHEN a.description ILIKE '%no responde%' OR a.description ILIKE '%sin respuesta%'
                 OR a.description ILIKE '%no contesta%' OR a.description ILIKE '%nunca respondi%'
                 OR a.title ILIKE '%no responde%' THEN 'no_responde'
               WHEN a.description ILIKE '%presupuesto%' OR a.description ILIKE '%caro%'
                 OR a.description ILIKE '%precio%' OR a.description ILIKE '%económ%'
                 OR a.description ILIKE '%econom%' THEN 'presupuesto'
               WHEN a.description ILIKE '%financiac%' OR a.description ILIKE '%crédito%'
                 OR a.description ILIKE '%credito%' OR a.description ILIKE '%hipotec%' THEN 'financiamiento'
               WHEN a.description ILIKE '%ubicación%' OR a.description ILIKE '%ubicacion%'
                 OR a.description ILIKE '%zona%' OR a.description ILIKE '%barrio%' THEN 'ubicacion'
               WHEN a.description ILIKE '%otra propiedad%' OR a.description ILIKE '%encontró otra%'
                 OR a.description ILIKE '%encontro otra%' OR a.description ILIKE '%otra inmobiliaria%' THEN 'encontro_otra'
               WHEN a.description ILIKE '%duplicad%' THEN 'duplicado'
               WHEN a.description ILIKE '%sin propiedad%' OR a.description ILIKE '%no hay propiedad%'
                 OR a.description ILIKE '%no encontr%'
                 OR a.description ILIKE '%no teníamos%' OR a.description ILIKE '%no teniamos%' THEN 'sin_propiedad'
               WHEN a.description ILIKE '%timing%' OR a.description ILIKE '%más adelante%'
                 OR a.description ILIKE '%mas adelante%' OR a.description ILIKE '%después%'
                 OR a.description ILIKE '%despues%' OR a.description ILIKE '%esperar%' THEN 'timing'
               WHEN a.description ILIKE '%perdió interés%' OR a.description ILIKE '%perdio interes%'
                 OR a.description ILIKE '%ya no le interesa%' OR a.description ILIKE '%desinteres%' THEN 'perdio_interes'
               ELSE 'otro'
             END AS sugerido
        FROM public.leads l
        LEFT JOIN LATERAL (
          SELECT la.title, la.description
            FROM public.lead_activities la
           WHERE la.lead_id = l.id
           ORDER BY la.created_at DESC
           LIMIT 1
        ) a ON true
       WHERE l.stage::text = 'cerrado_perdido'
         AND l.lost_reason IS NULL
         AND l.deleted_at IS NULL
       ORDER BY l.updated_at DESC NULLS LAST
       LIMIT GREATEST(COALESCE(p_limit, 50), 1)
    ) x;

  RETURN jsonb_build_object('ok', true, 'total', v_total, 'leads', v_leads);
END;
$function$;

REVOKE ALL ON FUNCTION public.crm_motivos_pendientes(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_motivos_pendientes(integer) TO authenticated, service_role;
