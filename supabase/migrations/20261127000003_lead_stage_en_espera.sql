-- ---------------------------------------------------------------------------
-- P1-6 (2026-11-27): ETAPA "EN ESPERA" — el lead espera la respuesta del
-- cliente y el sistema lo devuelve SOLO a la bandeja.
--
-- Diagnóstico: el embudo no tenía forma de "parar". Cuando el cliente decía
-- "lo pienso y te aviso", el lead se quedaba en la etapa activa con su
-- seguimiento vencido: la alerta `lead_followup_overdue` lo reclamaba todos
-- los días y el agente tenía que inventar un arrangement a mano. Medido el
-- 27/11: 6 seguimientos vencidos que en realidad eran "el cliente no
-- contesta todavía".
--
-- Decisiones:
--   · `en_espera` es NO TERMINAL (terminales siguen siendo sólo
--     `cerrado_ganado` y `cerrado_perdido`): el lead sigue vivo, no cuenta
--     como éxito y NO se borra. Los filtros `stage NOT IN (terminales)`
--     del proyecto siguen funcionando sin cambios.
--   · La fecha de regreso es `leads.next_followup_at`: cuando pasa, el lead
--     vuelve solo a "Mi bandeja" (vuelta automática) y el agente decide.
--   · `leads.stage_previo` guarda la etapa desde la que se colgó el lead
--     para poder reactivarlo SIN perder el hilo (volver a un "contactado"
--     genérico rompería el embudo y las métricas de conversión).
--   · `lead_tasks.status` admite 'en_espera': las tareas del lead colgado se
--     suspenden (no vencen, no avisan, no cuentan en el backlog) y vuelven a
--     'pendiente' al reactivar.
--
-- Aditiva: NO borra ni modifica filas de leads/tareas. Sólo ensancha el enum,
-- agrega una columna y ensancha un CHECK.
-- ---------------------------------------------------------------------------

-- 1) La etapa nueva del embudo.
--    Nota: en PostgreSQL 12+ el ADD VALUE se puede ejecutar dentro de una
--    transacción, pero el valor NO se puede USAR hasta el commit. Por eso
--    las funciones que escriben 'en_espera' viven en la migración SIGUIENTE
--    (20261127000004_lead_espera_rpc.sql).
ALTER TYPE public.lead_stage ADD VALUE IF NOT EXISTS 'en_espera';

-- 2) La etapa desde la que se colgó el lead (para reactivarlo).
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS stage_previo text;

COMMENT ON COLUMN public.leads.stage_previo IS
  'Etapa del lead antes de pasar a en_espera (para reactivarlo sin perder el hilo)';

-- 3) Las tareas se pueden suspender con el lead en espera.
--    Se ENSANCHA el CHECK (no se restringe): se re-validan 280 filas, es
--    instantáneo y no toca ningún dato.
ALTER TABLE public.lead_tasks DROP CONSTRAINT IF EXISTS lead_tasks_status_check;
ALTER TABLE public.lead_tasks ADD CONSTRAINT lead_tasks_status_check
  CHECK (status = ANY (ARRAY['pendiente', 'en_progreso', 'en_espera', 'completada', 'cancelada']));
