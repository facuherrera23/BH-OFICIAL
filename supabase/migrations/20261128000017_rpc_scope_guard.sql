-- ============================================
-- 20261128000017 — Las RPC de "mi día" no pueden suplantar perfil
-- ============================================
-- Hallazgo de auditoría (28/11/2026, sólo lectura): cierre_de_dia,
-- mi_dia y mi_dia_agenda son SECURITY DEFINER y aceptan p_user_id.
-- El body hacía `COALESCE(p_user_id, auth.uid())`, así que cualquier
-- authenticated podía pasar el UUID de OTRA persona y leer su agenda,
-- tareas y leads. Los llamadores legítimos son:
--   · el panel (NO manda p_user_id → usa auth.uid());
--   · agent-daily-digest (service_role → SÍ manda p_user_id).
-- El guard distingue esos dos casos y no toca los grants existentes.
--
-- Se reescribe el body desde pg_get_functiondef para no duplicar ~600
-- líneas de SQL en la migración. Es idempotente (marcador BH-SCOPE-GUARD)
-- y falla en voz alta si la firma del proyecto cambia.
-- ============================================

DO $mig$
DECLARE
  v_fn text;
  v_def text;
  v_marker text := '-- BH-SCOPE-GUARD';
  v_guard text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['cierre_de_dia', 'mi_dia', 'mi_dia_agenda'] LOOP
    SELECT pg_get_functiondef(p.oid)
      INTO v_def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'Función public.% no encontrada', v_fn;
    END IF;
    IF strpos(v_def, v_marker) > 0 THEN
      CONTINUE; -- ya aplicado (re-ejecución segura)
    END IF;
    IF strpos(v_def, 'v_uid uuid := COALESCE(p_user_id, auth.uid());') = 0 THEN
      RAISE EXCEPTION 'Firma inesperada en public.%: no se aplicó el guard de alcance', v_fn;
    END IF;
    IF strpos(v_def, E'\nBEGIN\n') = 0 THEN
      RAISE EXCEPTION 'Cuerpo inesperado en public.%: no se encontró el BEGIN outer', v_fn;
    END IF;

    v_guard :=
      '  ' || v_marker || E'\n' ||
      '  IF p_user_id IS NOT NULL AND p_user_id <> auth.uid()' ||
      ' AND COALESCE(NULLIF(current_setting(''request.jwt.claim.role'', true), ''''),' ||
      ' NULLIF(current_setting(''request.jwt.claims'', true)::jsonb->>''role'', ''''),' ||
      ' '''') <> ''service_role'' THEN' || E'\n' ||
      '    RAISE EXCEPTION ''No podés consultar el día de otro perfil'' USING ERRCODE = ''42501'';' || E'\n' ||
      '  END IF;' || E'\n';

    v_def := replace(v_def, E'\nBEGIN\n', E'\nBEGIN\n' || v_guard);
    EXECUTE v_def;
  END LOOP;
END
$mig$;

-- Verificación explícita de los tres bodies (sola lectura; no cambia ACLs).
DO $mig$
DECLARE
  v_fn text;
  v_src text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['cierre_de_dia', 'mi_dia', 'mi_dia_agenda'] LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF v_src IS NULL OR strpos(v_src, '-- BH-SCOPE-GUARD') = 0 THEN
      RAISE EXCEPTION 'Guard de alcance ausente en public.%', v_fn;
    END IF;
  END LOOP;
END
$mig$;
