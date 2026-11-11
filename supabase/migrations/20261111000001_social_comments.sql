-- ============================================================
-- social_comments (2026-11-11) — captación de leads desde redes.
--
-- Comentarios de Facebook/Instagram (la MISMA app de Meta) llegados:
--   · en tiempo real por el webhook social-webhook-meta
--     (GET verification con hub.challenge + POST firmado con
--     X-Hub-Signature-256 = HMAC-SHA256 del app secret),
--   · o importados con la action `sync` de social-comments
--     (GET /{post-id}/comments y /{media-id}/comments del Graph API).
--
-- Los comentarios de YouTube NO se duplican acá: viven en la bandeja
-- del Studio (social-youtube-comments → comment_lead). TikTok no
-- expone comentarios por API (Content Posting API es solo publishing)
-- → limitación documentada en docs/integrations/CONECTAR_TIKTOK.md.
--
-- NUNCA se crea un lead automático desde el webhook (patrón YT:
-- admin-initiated desde la bandeja, con consent_at — los comentarios
-- sociales son chatter, no consultas formales como ML).
-- ============================================================

create table if not exists public.social_comments (
  id uuid primary key default gen_random_uuid(),
  -- 'facebook' | 'instagram' (TEXT sin CHECK: agregar plataforma nueva
  -- no debe exigir migración — misma decisión que leads.source).
  platform text not null,
  -- Id del comentario EN la plataforma. UNIQUE: es el claim de
  -- idempotencia — Meta re-entrega webhooks y el sync re-pasa los
  -- mismos comentarios: INSERT ... ON CONFLICT DO NOTHING.
  external_id text not null,
  -- Post comentado (FK a social_posts si lo matcheamos; nullable:
  -- un comentario sobre un post que el CRM no tiene registro igual
  -- se guarda — la bandeja puede crear el lead igual).
  social_post_id uuid references public.social_posts(id) on delete set null,
  external_post_id text,
  -- Propiedad vinculada (la hereda del post). Nullable.
  property_id uuid references public.properties(id) on delete set null,
  account_id uuid references public.social_accounts(id) on delete set null,
  -- FB trae from:{id,name}; IG trae from:{id,username} — email y
  -- teléfono NUNCA vienen: solo lo que la persona escribió en el texto.
  author_name text,
  author_handle text,
  body text,
  -- Respuesta a otro comentario (parent_id del webhook).
  parent_external_id text,
  permalink text,
  like_count integer not null default 0,
  -- new | lead | dismissed (TEXT sin CHECK, misma decisión).
  status text not null default 'new',
  lead_id uuid references public.leads(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  commented_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotencia (INSERT ... onConflict external_id, ignoreDuplicates).
create unique index if not exists social_comments_external_id_key
  on public.social_comments (external_id);

-- Listado de la bandeja: filtrar por plataforma, ordenar por fecha.
create index if not exists idx_social_comments_platform_time
  on public.social_comments (platform, commented_at desc nulls last);
create index if not exists idx_social_comments_status
  on public.social_comments (status);
create index if not exists idx_social_comments_property
  on public.social_comments (property_id) where property_id is not null;

alter table public.social_comments enable row level security;

-- Lectura para el panel (bandeja de Consultas del módulo CONTENIDO).
-- Escritura (INSERT/UPDATE/DELETE) SOLO service_role: el webhook y la
-- edge function social-comments escriben con la service key — sin
-- policies de escritura, el cliente no puede tocar la tabla
-- (mismo patrón que lavoz_listings).
drop policy if exists "social_comments_read_authenticated" on public.social_comments;
create policy "social_comments_read_authenticated"
  on public.social_comments for select
  to authenticated
  using (true);
