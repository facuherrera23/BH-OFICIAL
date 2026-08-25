-- ============================================================
-- BIENENHAUS - Integración evaluate_supervision_rules → supervision-notify
-- ============================================================

-- La función evaluate_supervision_rules() existe en migración 008.
-- La extendemos para invocar Edge Function supervision-notify
-- al crear alertas critical/high (fire-and-forget via pg_net).

-- Requiere extensión pg_net (ya habilitada en Supabase)
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Función auxiliar: HTTP POST a Edge Function
CREATE OR REPLACE FUNCTION notify_supervision_alert(
    p_alert_id uuid,
    p_trigger text DEFAULT 'created'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_url text;
    v_headers jsonb;
    v_body jsonb;
    v_response http_response;
BEGIN
    -- URL de la Edge Function (usa SUPABASE_URL env var)
    v_url := current_setting('app.settings.supabase_url', true) || '/functions/v1/supervision-notify';
    v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    );
    v_body := jsonb_build_object('alert_id', p_alert_id, 'trigger', p_trigger);

    -- Fire-and-forget: no bloquear si falla
    BEGIN
        v_response := http_post(v_url, v_headers, v_body);
        -- Log éxito/fallo en audit_log para trazabilidad
        PERFORM insert_audit_log(
            p_user_id := NULL,
            p_action := 'supervision_notify_sent',
            p_module := 'supervision',
            p_status := CASE WHEN v_response.status_code BETWEEN 200 AND 299 THEN 'success' ELSE 'error' END,
            p_metadata := jsonb_build_object(
                'alert_id', p_alert_id,
                'trigger', p_trigger,
                'http_status', v_response.status_code,
                'response_body', v_response.content
            )
        );
    EXCEPTION WHEN others THEN
        -- No romper el motor de reglas si la notificación falla
        PERFORM insert_audit_log(
            p_user_id := NULL,
            p_action := 'supervision_notify_failed',
            p_module := 'supervision',
            p_status := 'error',
            p_metadata := jsonb_build_object(
                'alert_id', p_alert_id,
                'trigger', p_trigger,
                'error', SQLERRM
            )
        );
    END;
END;
$$;

REVOKE ALL ON FUNCTION notify_supervision_alert(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notify_supervision_alert(uuid, text) TO service_role;

-- ============================================================
-- Actualizar evaluate_supervision_rules() para notificar
-- ============================================================
-- Reemplazamos la función completa (idempotente)

CREATE OR REPLACE FUNCTION evaluate_supervision_rules()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rule RECORD;
    v_hit RECORD;
    v_recent_alert uuid;
    v_window interval;
    v_threshold numeric;
    v_filter jsonb;
    v_changed_field text;
    v_new_alert_id uuid;
BEGIN
    FOR v_rule IN SELECT * FROM supervision_rules WHERE enabled LOOP
        v_window := COALESCE(v_rule.condition->>'window', '1 hour')::interval;
        v_threshold := COALESCE((v_rule.condition->>'threshold')::numeric, 0);
        v_filter := v_rule.condition->'filter';

        -- Reglas basadas en changed_fields
        IF v_filter ? 'contains' THEN
            v_changed_field := v_filter->>'contains';
            FOR v_hit IN
                SELECT user_id, count(*) AS c
                FROM audit_log
                WHERE created_at > now() - v_window
                  AND (v_rule.module IS NULL OR module = v_rule.module)
                  AND (v_rule.action IS NULL OR action = v_rule.action)
                  AND changed_fields @> ARRAY[v_changed_field]
                  AND user_id IS NOT NULL
                GROUP BY user_id
                HAVING count(*) > v_threshold
            LOOP
                SELECT id INTO v_recent_alert FROM supervision_alerts
                WHERE alert_type = v_rule.name AND user_id = v_hit.user_id
                  AND created_at > now() - (v_rule.cooldown_minutes || ' minutes')::interval
                  AND status IN ('open', 'assigned', 'investigating', 'acknowledged');

                IF v_recent_alert IS NULL THEN
                    INSERT INTO supervision_alerts (user_id, module, severity, alert_type, title, description, evidence)
                    VALUES (
                        v_hit.user_id,
                        COALESCE(v_rule.module, 'system'),
                        v_rule.severity,
                        v_rule.name,
                        v_rule.name,
                        v_rule.description,
                        jsonb_build_object('count', v_hit.c, 'threshold', v_threshold, 'window', v_rule.condition->>'window', 'field', v_changed_field)
                    )
                    RETURNING id INTO v_new_alert_id;

                    -- NOTIFICAR si critical/high
                    IF v_rule.severity IN ('critical', 'high') THEN
                        PERFORM notify_supervision_alert(v_new_alert_id, 'created');
                    END IF;
                END IF;
            END LOOP;
        ELSE
            -- Reglas basadas en conteo simple
            FOR v_hit IN
                SELECT user_id, count(*) AS c
                FROM audit_log
                WHERE created_at > now() - v_window
                  AND (v_rule.module IS NULL OR module = v_rule.module)
                  AND (v_rule.action IS NULL OR action = v_rule.action)
                  AND user_id IS NOT NULL
                GROUP BY user_id
                HAVING count(*) > v_threshold
            LOOP
                SELECT id INTO v_recent_alert FROM supervision_alerts
                WHERE alert_type = v_rule.name AND user_id = v_hit.user_id
                  AND created_at > now() - (v_rule.cooldown_minutes || ' minutes')::interval
                  AND status IN ('open', 'assigned', 'investigating', 'acknowledged');

                IF v_recent_alert IS NULL THEN
                    INSERT INTO supervision_alerts (user_id, module, severity, alert_type, title, description, evidence)
                    VALUES (
                        v_hit.user_id,
                        COALESCE(v_rule.module, 'system'),
                        v_rule.severity,
                        v_rule.name,
                        v_rule.name,
                        v_rule.description,
                        jsonb_build_object('count', v_hit.c, 'threshold', v_threshold, 'window', v_rule.condition->>'window')
                    )
                    RETURNING id INTO v_new_alert_id;

                    -- NOTIFICAR si critical/high
                    IF v_rule.severity IN ('critical', 'high') THEN
                        PERFORM notify_supervision_alert(v_new_alert_id, 'created');
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION evaluate_supervision_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluate_supervision_rules() TO service_role;

-- ============================================================
-- Config settings para Edge Function URLs (setear en app_settings)
-- ============================================================
-- INSERT INTO app_settings (key, value) VALUES
-- ('integrations', '{
--   "supabase_url": "https://rnldqiwwzhjnurkguihu.supabase.co",
--   "service_role_key": "eyJ...",
--   "brevo_api_key": "xkeysib-...",
--   "brevo_sender_email": "noreply@bienenhaus.com.ar",
--   "slack_webhook_url": "https://hooks.slack.com/services/...",
--   "teams_webhook_url": "https://outlook.office.com/webhook/...",
--   "supervision_notify_emails": ["admin@bienenhaus.com.ar"]
-- }')
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;