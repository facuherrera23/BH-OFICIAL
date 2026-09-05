-- CRM Leads revamp — parte 1/2: extiende el enum lead_stage con los estados
-- del nuevo pipeline. ADD VALUE no puede usarse dentro de la misma transacción
-- que luego USA esos valores, por eso esto va solo en una migración aparte.
ALTER TYPE lead_stage ADD VALUE IF NOT EXISTS 'calificado';
ALTER TYPE lead_stage ADD VALUE IF NOT EXISTS 'visita_agendada';
ALTER TYPE lead_stage ADD VALUE IF NOT EXISTS 'visita_realizada';
ALTER TYPE lead_stage ADD VALUE IF NOT EXISTS 'negociacion';
ALTER TYPE lead_stage ADD VALUE IF NOT EXISTS 'cerrado_ganado';
ALTER TYPE lead_stage ADD VALUE IF NOT EXISTS 'cerrado_perdido';
ALTER TYPE lead_stage ADD VALUE IF NOT EXISTS 'propietario';
