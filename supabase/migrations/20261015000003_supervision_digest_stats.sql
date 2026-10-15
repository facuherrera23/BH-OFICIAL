-- KPIs del digest de supervisión (fix P2, auditoría 2026-10-15).
--
-- Problemas de la versión anterior (supervision-digest/fetchDigestData):
--   1. Traía audit_log con select("*") sin paginación: PostgREST capa en 1000
--      filas -> actionsTotal mostraba 1000 (real de la semana: ~18k).
--   2. Filtraba por a.severity / a.metadata?.sensitive: audit_log NO tiene
--      columna severity (usa status: success|error + error_code) -> los KPIs
--      "Exitosas"/"Fallidas" daban siempre 0.
--   3. El sample de 1000 filas oldest-first hacía uniqueUsers: 0.
--
-- Fix: una RPC que agrega TODO server-side (exacto, sin caps) y devuelve jsonb.
-- El día de corte usa America/Argentina/Buenos_Aires (los dueños leen en ART;
-- la versión vieja usaba el día UTC del runtime de Deno).
--
-- Privilegios (disciplina del hardening P1 del 2026-10-15): solo service_role
-- (la llama la Edge Function supervision-digest con la service key) y el owner
-- postgres. REVOKE a PUBLIC/anon/authenticated.

CREATE OR REPLACE FUNCTION public.supervision_digest_stats(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
SELECT jsonb_build_object(
  'kpis', jsonb_build_object(
    'actionsTotal', (SELECT count(*) FROM public.audit_log a WHERE a.created_at >= p_from AND a.created_at < p_to),
    'actionsToday', (SELECT count(*) FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
        AND (a.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
          = (p_to AT TIME ZONE 'America/Argentina/Buenos_Aires')::date),
    'uniqueUsers', (SELECT count(DISTINCT a.user_id) FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to AND a.user_id IS NOT NULL),
    'successCount', (SELECT count(*) FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to AND a.status = 'success'),
    'errorCount', (SELECT count(*) FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
        AND (a.status = 'error' OR a.error_code IS NOT NULL)),
    'sensitiveCount', (SELECT count(*) FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
        AND a.metadata ->> 'sensitive' = 'true'),
    'exportsCount', (SELECT count(*) FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
        AND (a.action = 'export' OR a.action LIKE '%export%')),
    'bulkOpsCount', (SELECT count(*) FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
        AND (a.action LIKE '%bulk%' OR a.metadata ->> 'bulk' = 'true')),
    'openAlerts', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to AND s.status = 'open'),
    'criticalAlerts', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to AND s.severity = 'critical'),
    'highAlerts', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to AND s.severity = 'high'),
    'unassignedAlerts', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to AND s.status = 'open' AND s.assigned_to IS NULL)
  ),
  'byUser', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id, 'count', t.cnt, 'errors', t.errs, 'sensitive', t.sens
    ) ORDER BY t.cnt DESC), '[]'::jsonb)
    FROM (
      SELECT COALESCE(a.user_id::text, 'sistema') AS user_id,
             count(*) AS cnt,
             count(*) FILTER (WHERE a.status = 'error' OR a.error_code IS NOT NULL) AS errs,
             count(*) FILTER (WHERE a.metadata ->> 'sensitive' = 'true') AS sens
      FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    ) t
  ),
  'byModule', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', t.module, 'count', t.cnt, 'errors', t.errs
    ) ORDER BY t.cnt DESC), '[]'::jsonb)
    FROM (
      SELECT COALESCE(NULLIF(a.module, ''), 'general') AS module,
             count(*) AS cnt,
             count(*) FILTER (WHERE a.status = 'error' OR a.error_code IS NOT NULL) AS errs
      FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    ) t
  ),
  'errorsByUser', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id, 'count', t.cnt
    ) ORDER BY t.cnt DESC), '[]'::jsonb)
    FROM (
      SELECT COALESCE(a.user_id::text, 'sistema') AS user_id, count(*) AS cnt
      FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
        AND (a.status = 'error' OR a.error_code IS NOT NULL)
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    ) t
  ),
  'sensitiveByUser', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id, 'count', t.cnt
    ) ORDER BY t.cnt DESC), '[]'::jsonb)
    FROM (
      SELECT COALESCE(a.user_id::text, 'sistema') AS user_id, count(*) AS cnt
      FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to
        AND a.metadata ->> 'sensitive' = 'true'
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    ) t
  ),
  'alerts', jsonb_build_object(
    'open', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to AND s.status = 'open'),
    'critical', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to AND s.severity = 'critical'),
    'high', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to AND s.severity = 'high'),
    'unassigned', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to AND s.status = 'open' AND s.assigned_to IS NULL),
    'bySeverity', (
      SELECT COALESCE(jsonb_object_agg(sv.severity, sv.n), '{}'::jsonb)
      FROM (SELECT s2.severity, count(*) AS n FROM public.supervision_alerts s2
            WHERE s2.created_at >= p_from AND s2.created_at < p_to GROUP BY 1) sv
    ),
    'byModule', (
      SELECT COALESCE(jsonb_object_agg(sv.m, sv.n), '{}'::jsonb)
      FROM (SELECT COALESCE(NULLIF(s2.module, ''), 'system') AS m, count(*) AS n
            FROM public.supervision_alerts s2
            WHERE s2.created_at >= p_from AND s2.created_at < p_to GROUP BY 1) sv
    ),
    'unassignedCritical', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'title', COALESCE(s.title, s.alert_type),
        'severity', s.severity,
        'module', s.module,
        'user', COALESCE(s.user_id::text, '—'),
        'created_at', s.created_at
      ) ORDER BY s.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT * FROM public.supervision_alerts s2
        WHERE s2.created_at >= p_from AND s2.created_at < p_to
          AND s2.status = 'open' AND s2.assigned_to IS NULL
          AND s2.severity IN ('critical', 'high')
        ORDER BY s2.created_at DESC
        LIMIT 10
      ) s
    )
  ),
  'dailyActivity', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'date', to_char(d.day, 'YYYY-MM-DD'),
      'total', (SELECT count(*) FROM public.audit_log a
        WHERE (a.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = d.day::date),
      'errors', (SELECT count(*) FROM public.audit_log a
        WHERE (a.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = d.day::date
          AND (a.status = 'error' OR a.error_code IS NOT NULL)),
      'alerts', (SELECT count(*) FROM public.supervision_alerts s
        WHERE (s.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = d.day::date)
    ) ORDER BY d.day), '[]'::jsonb)
    FROM generate_series(
      (((p_to AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 6))::timestamp,
      ((p_to AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::timestamp,
      interval '1 day'
    ) AS d(day)
  ),
  'meta', jsonb_build_object(
    'totalAuditEvents', (SELECT count(*) FROM public.audit_log a
      WHERE a.created_at >= p_from AND a.created_at < p_to),
    'totalAlerts', (SELECT count(*) FROM public.supervision_alerts s
      WHERE s.created_at >= p_from AND s.created_at < p_to)
  )
);
$$;

REVOKE EXECUTE ON FUNCTION public.supervision_digest_stats(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supervision_digest_stats(timestamptz, timestamptz) TO service_role;
