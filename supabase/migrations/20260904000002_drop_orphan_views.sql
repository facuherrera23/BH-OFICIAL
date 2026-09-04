-- ============================================================
-- DROP: views huérfanas del paquete 20260824 (supervision)
-- ============================================================
-- Estas 4 vistas son SECURITY DEFINER, sin search_path fijo, viven en el
-- schema public y NO tienen consumidor en el código (verificado: grep
-- del repositorio entero y la Edge Function supervision-api NO las lee).
--
-- Son el "nivel ERROR" que ve el Security Advisor. Decisión: DROP VIEW
-- porque re-create es ridículo para una vista sin carne asyield sola via
-- no desuso. Si en el futuro se quiere reintroducir, se re-writeen como
-- SECURITY INVOKER · "security_barrier_view" directo re caso.

DROP VIEW IF EXISTS public.daily_module_activity;
DROP VIEW IF EXISTS public.open_alerts_by_user;
DROP VIEW IF EXISTS public.my_assigned_alerts;
DROP VIEW IF EXISTS public.daily_user_activity;
