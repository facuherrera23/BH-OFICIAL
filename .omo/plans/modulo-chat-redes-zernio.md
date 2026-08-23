# PLAN — Módulo Chat de Redes Sociales vía API Zernio
**Proyecto**: BH-OFICIAL · Categoría panel: Red & Difusión · **Estado**: PROPUESTA — sin código tocado
**Fecha**: 2026-08-23 · Basado en investigación de docs.zernio.com (webhooks, inbox, multi-tenant, pricing)

---

## 0. Resumen ejecutivo

Inbox unificado dentro del panel admin para **leer y responder mensajes directos (DMs)** de las redes sociales de Bienenhaus, potenciado por la API de [Zernio](https://zernio.com) (API unificada de social media, Barcelona 2025). Arquitectura **webhook-first**: un Edge Function recibe los eventos en tiempo real, los persiste en nuevas tablas de Supabase con verificación criptográfica y deduplicación, y el panel se actualiza instantáneo vía Realtime. Las respuestas salen por un segundo Edge Function que custodia la API key (nunca llega al browser).

**Plataformas DM soportadas por Zernio**: Instagram, Facebook Messenger, WhatsApp, Telegram, X/Twitter, Bluesky, Reddit, Slack.
**Recomendación v1**: Instagram + Facebook Messenger + WhatsApp (el trío Meta es donde llegan las consultas inmobiliarias; WhatsApp es crítico en Argentina).

---

## 1. Hallazgos de la investigación (fuente de verdad)

### 1.1 Qué es Zernio
- API REST unificada (`https://zernio.com/api/v1`) para publicar, agendar y **comunicar** (inbox de DMs/comentarios/reviews) en ~16 plataformas.
- **Auth**: una sola API key como Bearer token. Sin developer app ni app review por plataforma — Zernio maneja los OAuth internamente desde su dashboard.
- Startup pequeña (Barcelona, fundada 2025) — riesgo proveedor bajo-moderado, mitigable porque el modelo de datos es propio.

### 1.2 Endpoints que usaremos (verificados en docs)

| Endpoint | Uso |
|---|---|
| `GET /v1/accounts` | Listar cuentas conectadas (id, platform, username) para poblar filtros y mapping |
| `GET /v1/inbox/conversations?accountId=X` | Lista de conversaciones agregadas (paginación por cursor opaco) |
| `GET /v1/inbox/conversations/{conversationId}/messages` | Mensajes del hilo (`sortOrder=asc/desc`, cursor) |
| `POST /v1/inbox/conversations/{conversationId}/messages` | **Enviar respuesta** — body mínimo `{ accountId, message }`; soporta texto, `attachmentUrl`, quickReplies, buttons, templates |
| `POST /v1/inbox/conversations/{conversationId}/read` | Marcar leído (blue ticks WhatsApp) |
| Upload media (API-key auth) | Sube archivo → URL pública temporal (máx ~15MB, autodelete) para adjuntos |

Spec completo disponible como OpenAPI 3.1: `https://docs.zernio.com/api/openapi` — validar shapes exactos durante implementación.

### 1.3 Webhooks (núcleo del diseño)
- Suscripción vía **Create webhook settings** (API o dashboard).
- **Firma**: header `X-Zernio-Signature` = hex minúsculas de `HMAC-SHA256(rawBody, ZERNIO_WEBHOOK_SECRET)`. Rechazar todo lo no firmado o inválido.
- **Idempotencia**: entrega *at-least-once*. Dedupear por `payload.id` (UUID, también header `X-Zernio-Event-Id`) contra índice único.
- **SLA de ack**: responder `2xx` en <5s; procesamiento pesado async. 7 reintentos con backoff exponencial (10s→24h cap) → dead-letter queue visible en su dashboard.
- **Eventos a suscribir (v1)**: `conversation.started`, `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed`, `account.connected`, `account.disconnected`. Opcional fase 2: `comment.received`, `reaction.received`.
- Evento de prueba: `webhook.test` (disparable desde su dashboard para validar el endpoint).

### 1.4 Reglas de plataforma que condicionan el diseño
- **Meta replay**: al conectar Instagram/Facebook, Zernio replaya ~500 mensajes previos por conversación **sin disparar webhooks** → obligatorio backfill por polling post-conexión (repetir la pasada ~1h después).
- **WhatsApp ventana 24h**: fuera de la ventana solo se puede enviar template aprobado (lo cobra Meta directamente). V1: mostrar aviso en la UI cuando el último mensaje entrante >24h.
- **HTTP response ≠ entrega**: el POST de envío devuelve "aceptado"; el estado real llega por `message.sent` / `message.failed` (solo WhatsApp emite failed).
- **Rate limits**: tier referencial 600 req/min por key; ante `429` respetar header `Retry-After`.
- **X/Twitter**: chats cifrados invisibles; costos API passthrough — fuera de alcance v1.

### 1.5 Costos (pricing oficial)
| Escenario | Cuentas | Costo/mes |
|---|---|---|
| Solo Instagram + Facebook | 2 | **$0** (free tier, sin tarjeta) |
| Instagram + Facebook + WhatsApp | 3 | **$6** (tercera cuenta entra al tramo $6) |
| + Telegram u otra | 4+ | $6/cuenta adicional |

Mensajería (DMs) y webhooks incluidos en todas las cuentas. Sin seats ni planes.

### 1.6 Precedentes aprovechables en ESTE repo
- Módulo ML ya resolvió: webhook externo firmado + tabla dedup (`ml_webhook_secret`, `ml_webhook_dedup`), cron de sync (`ml_sync_cron`), DLQ.
- `enable_realtime` + shadow tables de agents → patrón Realtime→panel probado.
- Guard `super_admin` + `canManageUsers()` recién implementados en Configuración.

---

## 2. Arquitectura propuesta

```
                        ┌──────────────────────────────┐
                        │  ZERNIO                      │
                        │  (OAuth IG/FB/WA desde SU    │
                        │   dashboard — cero dev)      │
                        └──────┬───────────────┬───────┘
              eventos push     │               │  llamadas salientes
              (webhook firmado)│               │  (Bearer API key)
                               ▼               ▲
        ┌──────────────────────┴───────┐   ┌───┴────────────────────────┐
        │ EDGE FUNCTION zernio-webhook │   │ EDGE FUNCTION zernio-proxy │
        │ verify_jwt = FALSE           │   │ verify_jwt = TRUE          │
        │ · HMAC-SHA256 raw body       │   │ · JWT usuario + rol        │
        │   vs ZERNIO_WEBHOOK_SECRET   │   │   super_admin (RLS check)  │
        │ · dedupe por payload.id      │   │ · custodia ZERNIO_API_KEY  │
        │   (tabla eventos, UNIQUE)    │   │   (Supabase secret)        │
        │ · upsert conversaciones/     │   │ · POST messages/read       │
        │   mensajes                   │   │ · registra msg out 'sent'  │
        │ · responde 200 <5s           │   │ · Retry-After en 429       │
        └──────────────┬───────────────┘   └───▲────────────────────────┘
                       │ INSERT/UPDATE         │ fetch POST
                       ▼                       │
        ┌──────────────────────────────────────┴─────────────┐
        │ SUPABASE Postgres                                   │
        │ zernio_accounts · zernio_conversations ·            │
        │ zernio_messages · zernio_webhook_events (dedup)     │
        │ RLS: SELECT/UPDATE super_admin · INSERT service_role│
        └──────────────────────┬──────────────────────────────┘
                               │ Realtime (INSERT/UPDATE)
                               ▼
        ┌─────────────────────────────────────────────────────┐
        │ PANEL ADMIN — tab "Chat Redes" (bajo Red & Difusión)│
        │ Lista conversaciones ⇄ hilo de chat + composer      │
        └─────────────────────────────────────────────────────┘
```

Principios (tomados de la guía multi-tenant de Zernio, adaptados a nuestro stack):
1. **Los webhooks escriben la DB; el API solo envía y backfillea.** Cero polling en caliente.
2. La UI lee SOLO nuestra base (nunca llama a Zernio directo) → latencia mínima, historial propio, funciona aunque Zernio tenga degradación parcial (`meta.accountsFailed`).
3. Secretos solo server-side: `ZERNIO_API_KEY` y `ZERNIO_WEBHOOK_SECRET` viven como Supabase Secrets de las Edge Functions.
4. Dedup estricta por `payload.id`; estados finales de entrega confían SOLO en webhooks.

---

## 3. Modelo de datos (DDL propuesto)

```sql
-- Espejo de cuentas conectadas (se puebla vía account.connected/disconnected + sync manual)
create table if not exists public.zernio_accounts (
  zernio_account_id text primary key,          -- id de cuenta en Zernio
  platform         text not null check (platform in ('instagram','facebook','whatsapp','telegram','twitter','bluesky','reddit','slack')),
  username         text,
  status           text not null default 'connected' check (status in ('connected','disconnected')),
  last_synced_at   timestamptz default now(),
  created_at       timestamptz default now()
);

-- Conversaciones (hilos)
create table if not exists public.zernio_conversations (
  zernio_conversation_id text primary key,
  zernio_account_id      text not null references public.zernio_accounts(zernio_account_id) on delete cascade,
  contact_name           text,
  contact_handle         text,                  -- username/teléfono según plataforma
  platform               text not null,
  last_message_at        timestamptz,
  last_message_preview   text,
  unread_count           integer not null default 0,
  status                 text not null default 'open' check (status in ('open','archived')),
  updated_at             timestamptz default now(),
  created_at             timestamptz default now()
);
create index on public.zernio_conversations (status, last_message_at desc);

-- Mensajes
create table if not exists public.zernio_messages (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       text not null references public.zernio_conversations(zernio_conversation_id) on delete cascade,
  direction             text not null check (direction in ('in','out')),
  platform_message_id   text,                   -- wamid / ig message id…
  body                  text,
  attachment            jsonb,                  -- {type,url,name}
  status                text not null default 'received'
                        check (status in ('received','sent','delivered','read','failed')),
  error                 jsonb,                  -- {code,title,message} de message.failed
  sent_by               uuid references public.profiles(id),  -- quién respondió desde el panel
  zernio_event_id       text unique,            -- dedupe at-least-once (nullable para sends locales)
  occurred_at           timestamptz not null default now(),
  created_at            timestamptz default now()
);
create index on public.zernio_messages (conversation_id, occurred_at);

-- Dedup global de eventos webhook (insert-first, skip si conflicto)
create table if not exists public.zernio_webhook_events (
  id         text primary key,                  -- payload.id (UUID Zernio)
  event      text not null,
  received_at timestamptz default now()
);

-- RLS en las 4 tablas
alter table public.zernio_accounts        enable row level security;
alter table public.zernio_conversations   enable row level security;
alter table public.zernio_messages        enable row level security;
alter table public.zernio_webhook_events  enable row level security;

-- SELECT/UPDATE solo super_admin (mismo criterio que app_settings)
-- INSERT solo service_role (los Edge Functions usan la service role key internamente)
-- → políticas: zernio_{t}_select / _update con EXISTS profiles super_admin;
--   INSERT sin policy pública = denegado a anon/authenticated (solo service_role bypassa RLS).
```

Además: agregar las 3 tablas de lectura del panel a la publicación Realtime de Supabase (patrón `enable_realtime`).

---

## 4. Edge Functions (especificación funcional + pseudocódigo)

### 4.1 `zernio-webhook` — receptor de eventos (verify_jwt: false)

```
POST https://<ref>.functions.supabase.co/zernio-webhook
Headers: X-Zernio-Signature, X-Zernio-Event-Id
Body: evento JSON de Zernio
```

Pseudocódigo Deno:
```
rawBody = await req.text()                                  // NUNCA parsear antes de firmar
sig = req.headers.get('X-Zernio-Signature')
expected = hex(HMAC_SHA256(rawBody, Deno.env.get('ZERNIO_WEBHOOK_SECRET')))
if (!timingSafeEqual(sig, expected)) return 400             // rechazar sin firma o mismatch

event = JSON.parse(rawBody)
try {
  await db.insert('zernio_webhook_events', { id: event.id, event: event.event })  // UNIQUE dedupe
} catch (conflict) { return Response.json({ok:true}) }      // duplicado → ack silencioso

switch (event.event):
  'conversation.started' → upsert zernio_conversations (desde event.conversation)
  'message.received'     → upsert conversación si falta; insert mensaje direction='in'
                           status='received'; unread_count++ ; preview/last_message_at refresh
  'message.sent'         → marcar nuestro mensaje out status='sent' (match por platform_message_id)
  'message.delivered'    → status='delivered'
  'message.read'         → status='read'
  'message.failed'       → status='failed', guardar event.error jsonb
  'account.connected' /
  'account.disconnected' → upsert/status en zernio_accounts
  'webhook.test'         → log únicamente
return Response.json({ ok:true })                            // siempre 200 rápido (<5s)
```
Notas: el heavy-lifting ya está hecho al momento del ack (2 inserts) — cumple el SLA de 5s sin worker extra.

### 4.2 `zernio-proxy` — envíos autenticados (verify_jwt: true)

Acciones (según `action` en el body): `send_message`, `mark_read`, `list_accounts`, `backfill_conversations`, `backfill_messages`.

```
usuario = JWT → profiles.role DEBE ser 'super_admin' (si no → 403)
switch action:
  send_message(conversationId, text):
     conv = SELECT cuenta/plataforma desde zernio_conversations
     si plataforma whatsapp Y last inbound > 24h → devolver aviso window_closed (UI muestra aviso de template)
     POST /v1/inbox/conversations/{id}/messages {accountId, message}
     si 429 → respetar Retry-After, 1 reintento
     insert zernio_messages direction='out' status='sent' sent_by=user, guardando ids devueltos
  mark_read(convId): POST .../read  + UPDATE unread_count=0 local
  list_accounts(): GET /v1/accounts → upsert espejo zernio_accounts (reconcilia plataformas/nombres)
  backfill_*(): paginar GET /v1/inbox/conversations (+messages asc) e insertar lo que falte
                (ON CONFLICT por natural key conversación+occurred_at+hash) — cubre replay Meta
```
La API key JAMÁS sale de esta función: `Deno.env.get('ZERNIO_API_KEY')`.

Secretos a registrar: `supabase secrets set ZERNIO_API_KEY=… ZERNIO_WEBHOOK_SECRET=…`

---

## 5. UI del panel — tab "Chat Redes"

Ubicación: categoría **Red & Difusión** (`admin.html` línea ~275), tercer ítem tras "Portales & APIs".
Nav: `<div class="nav-item" data-tab="tab-chat-redes">` con icono `fa-comments` y badge dinámico de no-leídos.

Layout dos columnas (colapsa a master-detail en mobile):

```
┌───────────────────────────┬──────────────────────────────────────────┐
│ FILTROS: [Todas▾][IG/FB/WA]│  HILO                                    │
│ 🔍 buscar contacto         │  ┌────────────────────────────────────┐ │
├───────────────────────────┤  │ (in)  Hola, tienen la casa de Paler…│ │
│ ● Maria Gómez      IG  (2) │  │ (out) ¡Hola María! Sí, ¿te paso    │ │
│   "tienen la casa d…" 10:42│  │       info? ✓✓                     │ │
│ ● Juan Pérez      WA      │  │ (in)  Dale 🙏                      │ │
│   "Dale 🙏"            9:15│  └────────────────────────────────────┘ │
│ ⚠ cuenta desconectada chip │  [composer: textarea | enviar ➤]        │
└───────────────────────────┴──────────────────────────────────────────┘
```

Comportamientos clave:
- Orden conversaciones: `last_message_at DESC`, badge `unread_count`, filtro por plataforma y búsqueda por nombre/handle.
- Al abrir hilo: scroll bottom, `mark_read` vía proxy, suscripción Realtime filtra `conversation_id` (mensajes nuevos aparecen solos).
- Burbujas out con ticks: ✓ enviado, ✓✓ entregado/leído, ⚠ rojo failed + tooltip error + botón reintentar.
- Composer: Enter envía / Shift+Enter salto de línea; botón deshabilitado mientras `pending`; aviso permanente si WhatsApp >24h ("requiere plantilla aprobada — responder desde WhatsApp Business").
- Chip superior por cuenta: `conectada` verde / `desconectada` rojo con hint de reconexión (se reconecta desde dashboard Zernio).
- Botón "Sincronizar ahora": llama `list_accounts` + `backfill_conversations` del proxy (cubre replay Meta y reconciliación).
- Accesibilidad/perf: esc() en TODO sink innerHTML, virtualización no necesaria (paginación 20 por página con botón cargar más).

CSS nuevo en `admin.css` con cache buster bump; JS nuevo como sección numerada propia en `admin-app.js` (convención del archivo).

---

## 6. Plan de fases (checklist ejecutable)

**F0 — Prerequisitos externos (acción del USUARIO, bloqueante)**
- [ ] Crear cuenta en https://zernio.com/signup (free, sin tarjeta).
- [ ] Conectar las cuentas sociales desde el dashboard Zernio (Instagram/Facebook requieren login como la cuenta profesional; WhatsApp requiere número business).
- [ ] Obtener API key (dashboard → settings) y crear webhook settings con secret (o dejar que F2 lo registre por API).
- [ ] Decidir plataformas (ver §7 Decisiones) — determina costo.

**F1 — DB (migraciones)**
- [ ] Migración única `zernio_chat_tables`: 4 tablas + índices + checks + RLS/policies (§3).
- [ ] Agregar tablas a publicación Realtime.
- [ ] Verificación: advisors limpios; policies visibles en pg_policies.

**F2 — Edge Function zernio-webhook**
- [ ] Crear función (deno.json si aplica), deploy con `--no-verify-jwt`.
- [ ] Secrets: ZERNIO_WEBHOOK_SECRET.
- [ ] Registrar URL en Zernio (dashboard o Create webhook settings) suscribiendo los 8 eventos de §1.3.
- [ ] QA: botón Test webhook de Zernio → fila en zernio_webhook_events; firma inválida → 400.

**F3 — Edge Function zernio-proxy**
- [ ] Deploy con JWT; secrets ZERNIO_API_KEY.
- [ ] Implementar acciones §4.2 con manejo 429/Retry-After y errores tipados.
- [ ] QA: llamada con anon → 401/403; con super_admin → lista cuentas real.

**F4 — Backfill y reconciliación**
- [ ] Ejecutar `backfill_conversations/messages` inicial tras conectar cuentas.
- [ ] Repetir pasada a +1h (replay Meta llega tarde y sin webhooks).
- [ ] (Opcional, fase posterior) pg_cron diario de reconciliación — precedentes ml_sync_cron.

**F5 — Frontend**
- [ ] admin.html: nav-item + sección/tab completa del inbox (placeholders temporales si el HTML es largo — patrón CFG_TAB_PARTx).
- [ ] admin-app.js: sección numerada nueva (carga, Realtime, composer, ticks, filtros, sincronizar).
- [ ] admin.css: estilos inbox + bump cache busters (admin-app v22, admin.css v20).
- [ ] Guard: solo super_admin ve el tab operativo (mismo patrón cfgGuard).

**F6 — QA integral**
- [ ] E2E Playwright: mensaje real entrante aparece <5s; respuesta sale y tick sube a ✓✓; unread baja; filtro/búsqueda OK; desconexión de cuenta muestra chip.
- [ ] node --check ×1, npx react-doctor@latest esperado 100/100.
- [ ] Limpieza de datos de prueba y reporte final.

Estimación total: **1 sesión de trabajo** una vez F0 esté resuelto (F0 es lo único que depende de ti).

---

## 7. Decisiones abiertas (bloqueantes antes de codear)

1. **Alcance de plataformas v1** → recomiendo **Instagram + Facebook + WhatsApp ($6/mes)**. Alternativa gratis: solo IG+FB ($0). ¿Confirmas las 3?
2. **¿Quién crea la cuenta Zernio y conecta las redes?** Necesita acceso a las credenciales sociales de Bienenhaus. Puedo dejarte pasos exactos cuando lleguemos a F0.
3. **¿Comentarios públicos y reviews en el inbox?** El evento `comment.received` está disponible; recomiendo DMs-only en v1 y comentarios en fase 2 (menor riesgo, UI más simple).
4. **Auto-respuesta IA** — Zernio ofrece MCP server para agentes. Fuera de alcance v1; queda como evolución natural (bot que pre-responde horarios/zonas con los datos del CMS).

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Proveedor joven (2025, equipo chico) | Datos y UI son propios; migrar = re-apuntar webhook/proxy. Sin lock-in de esquema. |
| Replay Meta tardío genera huecos aparentes | Backfill doble (F4) + botón Sincronizar ahora |
| Rate limit compartido por key | Solo 2 usuarios super_admin hoy; proxy serializa y respeta Retry-After |
| Ventana 24h WhatsApp bloquea respuesta | Aviso UI explícito; templates quedan para fase 2 |
| Webhook caído >51h → DLQ | Botón Sincronizar ahora reconstruye estado por polling |
