-- Propietario "desactivado" (owners.status)
--
-- PROBLEMA: un propietario que vendió su única propiedad y con el que ya no
-- tenemos contacto no puede quedar "activo" en el padrón (genera alertas de
-- exclusividad y de DNI/CUIT, cuenta en los KPIs, recibe recordatorios de
-- tareas por WhatsApp y mails de renovación), pero tampoco se lo puede
-- eliminar: se pierde el historial de sus datos y de la propiedad vendida, y
-- existe la chance real de que vuelva a vender con nosotros.
--
-- SOLUCION: estado comercial explicito en owners.status.
--   'activo'   -> esta en cartera (comportamiento actual, default).
--   'inactivo' -> no hay contacto (vendio/no posee mas), pero se conserva
--                 TODO: propiedades (incluida la vendida), documentos,
--                 comisiones, tasaciones, notas y timeline.
--
-- IMPORTANTE: esta migracion es ADITIVA. No modifica ni borra ninguna fila
-- existente (todas quedan en 'activo', que es el comportamiento de hoy).
-- No toca deleted_at: la baja logica (papelera) sigue siendo otro canal.
--
-- Cuando se marca 'inactivo':
--   - se revoca el token del portal del propietario (mismo criterio que la
--     baja logica: trg_owners_revoke_tokens).
--   - el portal deja de validar ese token (defensa en depth).
--   - el badge del sidebar y las alertas cuentan solo propietarios activos.

-- ============================================================================
-- 1. Columnas de estado
-- ============================================================================
ALTER TABLE public.owners
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'activo',
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;

ALTER TABLE public.owners
  DROP CONSTRAINT IF EXISTS owners_status_check;
ALTER TABLE public.owners
  ADD CONSTRAINT owners_status_check CHECK (status IN ('activo','inactivo'));

COMMENT ON COLUMN public.owners.status IS
  'Estado comercial del propietario: activo (esta en cartera) / inactivo (vendio o no hay contacto, pero se conserva todo su historial y sus propiedades).';
COMMENT ON COLUMN public.owners.status_reason IS
  'Motivo por el que el propietario se marco inactivo (ej: vendio ML-1234, no posee otras propiedades).';
COMMENT ON COLUMN public.owners.status_changed_at IS
  'Fecha del ultimo cambio de status del propietario.';

-- Filtro de la vista de propietarios (activos / inactivos) + badge del sidebar.
CREATE INDEX IF NOT EXISTS idx_owners_status_active
  ON public.owners (status)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- 2. Trigger: desactivar => revocar el token del portal
--    (espejo exacto de revoke_owner_tokens_on_delete, que ya existe para la
--     baja logica: mismo criterio, misma tabla, mismo efecto)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.revoke_owner_tokens_on_deactivate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if new.status = 'inactivo' and old.status is distinct from 'inactivo' then
    update public.owner_portal_tokens
       set revoked_at = now()
     where owner_id = new.id
       and revoked_at is null;
  end if;
  return new;
end;
$function$;

DROP TRIGGER IF EXISTS trg_owners_revoke_tokens_on_deactivate ON public.owners;
CREATE TRIGGER trg_owners_revoke_tokens_on_deactivate
  AFTER UPDATE OF status ON public.owners
  FOR EACH ROW EXECUTE FUNCTION public.revoke_owner_tokens_on_deactivate();

-- ============================================================================
-- 3. Portal: un propietario inactivo no puede entrar con su token
--    (aunque el trigger ya lo revoca, el portal no depende del trigger)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.portal_validate_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v jsonb;
  v_scopes text[];
  v_expires timestamptz;
  v_revoked timestamptz;
  v_owner_deleted timestamptz;
  v_owner_status text;
begin
  select jsonb_build_object(
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
         ), t.scopes, t.expires_at, t.revoked_at, o.deleted_at, o.status
    into v, v_scopes, v_expires, v_revoked, v_owner_deleted, v_owner_status
    from public.owner_portal_tokens t
    join public.owners o on o.id = t.owner_id
   where t.token = p_token
   limit 1;

  if not found then return null; end if;
  if v_revoked is not null then return null; end if;
  if v_owner_deleted is not null then return null; end if;
  if v_owner_status = 'inactivo' then return null; end if;
  if v_expires is not null and v_expires < now() then return null; end if;

  return jsonb_build_object(
    'scopes', coalesce(v_scopes, '{}'::text[]),
    'expires_at', v_expires,
    'owners', v
  );
end;
$function$;

-- ============================================================================
-- 4. Badge del sidebar: solo propietarios activos y solo tareas de activos
--    (copia del cuerpo de la v3 en produccion, con los dos ajustes)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_sidebar_badge_counts(p_user_id uuid DEFAULT NULL::uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
declare
  v_props integer; v_leads integer; v_visits integer; v_owners integer; v_tasaciones integer;
  v_owner_tasks_overdue integer; v_lead_tasks_overdue integer;
  v_owner_tasks_soon integer; v_lead_tasks_soon integer;
  v_tasks_overdue_total integer;
  v_chat_unread_total integer; v_chat_unread_conversations integer;
  v_props_stale integer;
  v_ml_failed_24h integer; v_ml_last_event_at timestamptz;
  v_visits_today integer;
  v_leads_new_24h integer;
begin
  select count(*) into v_props from public.properties where is_published = true;
  select count(*) into v_leads from public.leads where deleted_at is null and stage not in ('cerrado_ganado', 'cerrado_perdido');
  select count(*) into v_visits from public.visits where status = 'pendiente';
  select count(*) into v_owners from public.owners where deleted_at is null and status = 'activo';
  select count(*) into v_tasaciones from public.tasaciones;
  select count(*) into v_owner_tasks_overdue
    from public.owner_tasks t
    join public.owners o on o.id = t.owner_id
   where t.status in ('pendiente', 'en_progreso') and t.due_date < now()
     and o.deleted_at is null and o.status = 'activo';
  select count(*) into v_owner_tasks_soon
    from public.owner_tasks t
    join public.owners o on o.id = t.owner_id
   where t.status in ('pendiente', 'en_progreso') and t.due_date >= now() and t.due_date <= now() + interval '24 hours'
     and o.deleted_at is null and o.status = 'activo';
  select count(*) into v_lead_tasks_overdue from public.lead_tasks where status in ('pendiente', 'en_progreso') and due_at < now();
  select count(*) into v_lead_tasks_soon from public.lead_tasks where status in ('pendiente', 'en_progreso') and due_at >= now() and due_at <= now() + interval '24 hours';
  v_tasks_overdue_total := coalesce(v_lead_tasks_overdue, 0) + coalesce(v_owner_tasks_overdue, 0);

  select count(*) into v_leads_new_24h from public.leads where deleted_at is null and created_at > now() - interval '24 hours';

  select coalesce(sum(unread_count), 0), count(*) filter (where unread_count > 0)
    into v_chat_unread_total, v_chat_unread_conversations
    from public.zernio_conversations;

  select count(*) into v_props_stale from public.properties p
    where p.is_published = true and p.deleted_at is null
      and coalesce(
        (select max(v.visit_date) from public.visits v where v.property_id = p.id),
        p.created_at
      ) < case
        when exists (select 1 from public.visits v2 where v2.property_id = p.id) then now() - interval '60 days'
        else now() - interval '30 days'
      end;

  select count(*) into v_ml_failed_24h from public.ml_webhook_events where status = 'failed' and received_at > now() - interval '24 hours';
  select max(received_at) into v_ml_last_event_at from public.ml_webhook_events;

  select count(*) into v_visits_today from public.visits
    where status = 'pendiente' and visit_date::date = (now() at time zone 'America/Argentina/Buenos_Aires')::date;

  return json_build_object(
    'properties', v_props,
    'leads', v_leads,
    'visits', v_visits,
    'owners', v_owners,
    'tasaciones', v_tasaciones,
    'owner_tasks_overdue', v_owner_tasks_overdue,
    'owner_tasks_soon', v_owner_tasks_soon,
    'lead_tasks_overdue', v_lead_tasks_overdue,
    'lead_tasks_soon', v_lead_tasks_soon,
    'tasks_overdue_total', v_tasks_overdue_total,
    'leads_new_24h', v_leads_new_24h,
    'chat_unread_total', v_chat_unread_total,
    'chat_unread_conversations', v_chat_unread_conversations,
    'properties_stale', v_props_stale,
    'ml_failed_24h', v_ml_failed_24h,
    'ml_last_event_at', v_ml_last_event_at,
    'visits_today', v_visits_today
  );
end;
$function$;
