-- ============================================
-- 20261128000007 — mi_dia_agenda: quitar EXECUTE a authenticated
-- ============================================
-- La migración 20261128000006 copió el contrato de `mi_dia` (que SÍ se llama
-- desde el CRM con la sesión del agente). `mi_dia_agenda` sólo la invoca la edge
-- function `agent-daily-digest` con service_role y p_user_id explícito: nadie
-- desde el navegador la necesita. Mantener el GRANT a authenticated agregaba
-- una función SECURITY DEFINER más al advisor (`authenticated_security_definer_
-- function_executable`) sin ningún consumidor. Regla del proyecto: toda función
-- SECURITY DEFINER nueva se revoca explícitamente a PUBLIC/anon/authenticated
-- (default privileges de Supabase vuelve a dar EXECUTE a authenticated al
-- crearla) y se le da EXECUTE sólo a su invocador real.
-- No cambia la firma ni la lógica: reversible con un GRANT si mañana se decide
-- mostrar la agenda en el panel.
-- ============================================

REVOKE ALL ON FUNCTION public.mi_dia_agenda(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mi_dia_agenda(uuid, integer) TO service_role;
