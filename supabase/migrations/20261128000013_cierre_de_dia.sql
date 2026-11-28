-- ============================================
-- 20261128000013 — Cierre de día: las 4 colas en una sola lectura
-- ============================================
-- Hallazgos reales (28/11/2026, sólo lectura en producción):
--   · 29 tareas vencidas (todas con recordatorio enviado, 0 resueltas);
--   · 4 leads nuevos sin ninguna actividad y 5 leads sin agente;
--   · 10 encuestas activas, 0 finalizadas y 0 respondidas, la más vieja
--     del 9/10. Cada cola vivía en un panel distinto: el agente tenía que
--     abrir 4 pantallas para decidir qué hacer.
--
-- Esta RPC NO escribe: junta las 4 colas con el mismo alcance por rol de
-- `mi_dia` (super_admin/broker ven todo; agente, lo suyo + lo sin dueño) y
-- con el contexto de propiedad (título, precio y link de la ficha) para que
-- la plantilla de primer contacto no necesite otra query. Las acciones
-- siguen siendo las del CRM: WhatsApp, agenda, tarea, encuesta y cierre
-- con motivo.
--
-- ⚠️ Cero INSERT/UPDATE/DELETE: el agente decide y escribe por fila.
-- ⚠️ Funciones nuevas: search_path vacío + REVOKE explícito (también a
--    authenticated, porque ALTER DEFAULT PRIVILEGES le da EXECUTE al crear).
-- ============================================

CREATE OR REPLACE FUNCTION public.cierre_de_dia(
  p_user_id uuid DEFAULT NULL,
  p_solo_propio boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := COALESCE(p_user_id, auth.uid());
  v_role text;
  v_agent uuid;
  v_agente text;
  v_todos boolean;
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'sin sesion');
  END IF;

  SELECT p.role::text INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  SELECT a.id, a.full_name INTO v_agent, v_agente
    FROM public.agents a
   WHERE a.profile_id = v_uid AND a.status = 'activo' AND a.deleted_at IS NULL
   ORDER BY a.created_at
   LIMIT 1;
  v_todos := (NOT COALESCE(p_solo_propio, false)) AND v_role IN ('super_admin', 'broker');

  WITH base AS (
    SELECT l.id AS lead_id,
           l.full_name AS nombre,
           COALESCE(NULLIF(l.whatsapp, ''), l.phone) AS telefono,
           l.stage, l.created_at, l.last_contacted_at, l.assigned_to,
           pr.id AS property_id, pr.title AS prop, pr.property_code,
           pr.price_usd, pr.price_currency,
           CASE WHEN pr.property_code IS NOT NULL
                THEN 'https://bienenhaus.com.ar/fichas/' || pr.property_code || '.html'
                ELSE '' END AS link,
           (v_todos OR l.assigned_to = v_agent
            OR (NOT COALESCE(p_solo_propio, false) AND l.assigned_to IS NULL)) AS en_scope
      FROM public.leads l
      LEFT JOIN LATERAL (
        SELECT p.id, p.title, p.property_code, p.price_usd, p.price_currency
          FROM public.properties p
         WHERE p.id = COALESCE(
                 l.property_id,
                 (SELECT lp.property_id FROM public.lead_properties lp
                   WHERE lp.lead_id = l.id ORDER BY lp.created_at LIMIT 1)
               )
           AND p.deleted_at IS NULL
         LIMIT 1
      ) pr ON true
     WHERE l.deleted_at IS NULL
  ),
  tareas_q AS (
    SELECT t.id AS tarea_id, t.title, t.due_at,
           t.assigned_to AS tarea_agent, b.*
      FROM public.lead_tasks t
      JOIN base b ON b.lead_id = t.lead_id
     WHERE t.status IN ('pendiente', 'en_progreso')
       AND t.due_at < now()
       AND b.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
       AND b.en_scope
       AND (v_todos OR COALESCE(t.assigned_to, b.assigned_to) = v_agent
            OR (NOT COALESCE(p_solo_propio, false) AND t.assigned_to IS NULL AND b.assigned_to IS NULL))
  ),
  contacto_q AS (
    SELECT b.* FROM base b
     WHERE b.last_contacted_at IS NULL
       AND b.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
       AND b.created_at < now() - interval '48 hours'
       AND b.en_scope
  ),
  encuestas_q AS (
    SELECT vs.id AS survey_id, vs.token, vs.created_at AS survey_created_at,
           EXISTS (SELECT 1 FROM public.lead_activities la
                    WHERE la.lead_id = vs.lead_id
                      AND la.title = 'Encuesta de visita enviada'
                      AND la.created_at >= vs.created_at) AS enviada,
           b.*
      FROM public.visit_surveys vs
      JOIN base b ON b.lead_id = vs.lead_id
     WHERE vs.finalized = false
       AND vs.archived_at IS NULL
       AND vs.submitted_at IS NULL
       AND b.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
       AND vs.created_at < now() - interval '48 hours'
       AND b.en_scope
  ),
  sin_agente_q AS (
    SELECT b.* FROM base b
     WHERE b.assigned_to IS NULL
       AND b.stage::text NOT IN ('cerrado_ganado', 'cerrado_perdido', 'en_espera')
       AND (v_todos OR NOT COALESCE(p_solo_propio, false))
  )
  SELECT jsonb_build_object(
    'ok', true,
    'agente', v_agente,
    'tareas', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'tipo', 'tarea', 'tarea_id', x.tarea_id, 'lead_id', x.lead_id,
               'nombre', x.nombre, 'telefono', x.telefono,
               'titulo', x.title, 'prop', x.prop,
               'precio_usd', x.price_usd, 'precio_currency', x.price_currency, 'link', x.link,
               'vencimiento', to_char(x.due_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY'),
               'dias', (now()::date - (x.due_at at time zone 'America/Argentina/Buenos_Aires')::date),
               'escalada', x.due_at < now() - interval '7 days'
             ) ORDER BY x.due_at), '[]'::jsonb)
        FROM (SELECT * FROM tareas_q ORDER BY due_at ASC LIMIT 20) x
    ),
    'sin_contacto', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'tipo', 'sin_contacto', 'lead_id', x.lead_id,
               'nombre', x.nombre, 'telefono', x.telefono,
               'stage', x.stage, 'prop', x.prop,
               'precio_usd', x.price_usd, 'precio_currency', x.price_currency, 'link', x.link,
               'titulo', 'Sin contactar',
               'detalle', 'Entró el ' || to_char(x.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
                          || ' · ' || ((now()::date - x.created_at::date)::text) || ' días sin contacto'
             ) ORDER BY x.created_at), '[]'::jsonb)
        FROM (SELECT * FROM contacto_q ORDER BY created_at ASC LIMIT 20) x
    ),
    'encuestas', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'tipo', 'encuesta', 'lead_id', x.lead_id, 'survey_id', x.survey_id,
               'property_id', x.property_id, 'token', x.token::text,
               'nombre', x.nombre, 'telefono', x.telefono,
               'titulo', COALESCE(x.prop, 'Encuesta de visita'),
               'prop', x.prop,
               'precio_usd', x.price_usd, 'precio_currency', x.price_currency, 'link', x.link,
               'enviada', x.enviada,
               'detalle', 'Pendiente desde el '
                          || to_char(x.survey_created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
             ) ORDER BY x.survey_created_at), '[]'::jsonb)
        FROM (SELECT * FROM encuestas_q ORDER BY survey_created_at ASC LIMIT 20) x
    ),
    'sin_agente', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'tipo', 'sin_agente', 'lead_id', x.lead_id,
               'nombre', x.nombre, 'telefono', x.telefono,
               'stage', x.stage, 'prop', x.prop,
               'precio_usd', x.price_usd, 'precio_currency', x.price_currency, 'link', x.link,
               'titulo', 'Sin agente',
               'detalle', 'Entró el ' || to_char(x.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
             ) ORDER BY x.created_at), '[]'::jsonb)
        FROM (SELECT * FROM sin_agente_q ORDER BY created_at ASC LIMIT 20) x
    ),
    'conteos', jsonb_build_object(
      'tareas', (SELECT count(*) FROM tareas_q),
      'sin_contacto', (SELECT count(*) FROM contacto_q),
      'encuestas', (SELECT count(*) FROM encuestas_q),
      'sin_agente', (SELECT count(*) FROM sin_agente_q)
    )
  ) INTO v_res;

  RETURN v_res;
END;
$function$;

REVOKE ALL ON FUNCTION public.cierre_de_dia(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cierre_de_dia(uuid, boolean) TO authenticated, service_role;
