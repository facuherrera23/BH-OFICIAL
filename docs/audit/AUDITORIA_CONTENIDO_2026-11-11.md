# Auditoría del módulo CONTENIDO — 2026-11-11

**Alcance:** YouTube · Instagram · Facebook · TikTok — funcionalidad de publicación + captación de leads.
**Estado al cierre:** publicación en producción para los 4 canales (TikTok v4 deployada en CI run 42961065295 ✓). Captación de leads: **YouTube en producción desde 2026-10-30; Facebook/Instagram infraestructura nueva lista** (queda conectar la app de Meta — pasos del dueño al final). **TikTok sin API de comentarios: limitación de la plataforma, documentada.**

---

## 1. Estado por canal

### YouTube — 100% funcional en producción
- **Publicación:** OAuth completo (scope `force-ssl`: editar/borrar/programar/miniaturas), subida resumable directa del navegador a Google, programación (`publishAt`), cola con persistencia local + `app_settings`.
- **Studio:** inventario, KPIs, edición, miniaturas, playlists, semáforo de salud, analytics (scope propio `yt-analytics.readonly`), reportes, sincronización canal↔CRM (idempotente), categorías.
- **Comentarios + leads:** bandeja con contador de "nuevos", responder/like/moderar (exigen `force-ssl`), y **Crear lead** con `consent_at`, dedup 60 días, timeline y SLA de primer contacto. Corrección de esta auditoría: el lead se creaba con origen `youtube_comment` (fuera de las listas del panel) → ahora `youtube` (0 filas históricas en producción con el valor viejo, verificado por SQL).
- **Página pública** `/canal.html` generada por CI desde `social_posts` (solo videos `public` reales).
- **Deuda menor (no bloquea):** las conexiones hechas antes del scope de analytics piden reconexión para reportes (el banner del Studio lo dice); el HUD de cuota es estimación local, no cuota real de Google.

### Instagram — publicación lista; falta la app de Meta (dueño)
- **Implementado:** switcher en Crear, form completo (cuenta → propiedad → media por URL Cloudinary o subida de PC con reescala → caption 2200 + CTA → publicar), contenedor IG + poll de status (4s, ~5 min), permalink, historial, delete real, bucket temporal con cleanup SIEMPRE.
- **Lo que falta es 100% del lado del dueño:** crear la app de Meta (productos Instagram Graph API + Facebook Login), pegar las 2 redirect URIs, pasar App ID/Secret por canal seguro, y conectar la cuenta IG Business desde Cuentas. Guía: `docs/integrations/CONECTAR_INSTAGRAM_FACEBOOK.md`.

### Facebook — publicación lista; misma app de Meta pendiente (dueño)
- **Implementado:** tercera pestaña del switcher, foto SINCRÓNICA (`POST /{page-id}/photos`), video con multipart directo del server + poll de status en las 3 fases reales de FB, `friendlyGraphError`, token de página sin vencimiento, OAuth conecta TODAS las páginas admin con desconexión de sobrantes.
- **Falta (dueño):** la MISMA app de Meta de Instagram + conectar una página de Facebook donde el owner sea admin. Sin app no hay publicación ni webhook.

### TikTok — v4 deployada en producción (commit `ade6f82`); falta la app (dueño)
- **Implementado (server + OAuth + panel + tests):** foto solo `PULL_FROM_URL` con transform Cloudinary embebido (límite 1080p), video `FILE_UPLOAD` 1 chunk ≤50MB con PUT directo al `upload_url` firmado, refresh token ROTATIVO con CAS + relectura grácil, poll `status/fetch` con `PUBLISH_COMPLETE`→FINISHED, permalink best-effort respetando el typo real de TikTok (`publicaly_available_post_id`), sin delete (la API no lo ofrece — el post se borra desde la app de TikTok), form "Solo yo" hasta auditar la app.
- **Falta (dueño):** app en developers.tiktok.com (Login Kit + Content Posting API con Direct Post), redirect URI, credenciales por canal seguro; **dominio verificado solo si van a publicar FOTOS** (Cloudinary no es verificable → opciones A/B/C en la guía); auditoría para posts públicos. Guía: `docs/integrations/CONECTAR_TIKTOK.md`.
- **Leads:** TikTok NO expone comentarios por API (Content Posting API es solo publishing; la Research API requiere aprobación y no cubre apps productivas). Los leads de TikTok llegan por el CTA de WhatsApp del caption → se cargan a mano con origen `tiktok` (ya existe en las listas del panel).

---

## 2. Captación de leads desde los 4 canales (arquitectura)

| Canal | Cómo entra el lead | Origen | Estado |
|---|---|---|---|
| YouTube | Bandeja del Studio → botón "Crear lead" (server `social-youtube-comments`) | `youtube` | ✅ Producción |
| Facebook | Webhook Meta (field `feed`) + sync Graph API → bandeja "Consultas" → botón "Crear lead" | `facebook` | 🟡 Infra lista, falta app de Meta |
| Instagram | Webhook Meta (field `comments`) + sync Graph API → bandeja "Consultas" → botón "Crear lead" | `instagram` | 🟡 Infra lista, falta app de Meta |
| TikTok | Sin API de comentarios → CTA WhatsApp del caption → alta manual | `tiktok` | 🟡 Limitación de la plataforma |

**Decisiones de diseño (por qué):**
- **Lead admin-initiated, no automático**: los comentarios sociales son chatter, no consultas formales como ML — el botón "Crear lead" pone `consent_at` (la persona pidió info públicamente) y evita llenar el CRM de spam. Es el mismo criterio vigente de YouTube.
- **El webhook NUNCA escribe en `leads`**: solo deja el comentario en `social_comments` (tabla nueva, migración `20261111000001`, RLS: lectura para el panel, escritura SOLO service_role).
- **Doble vía de captación** (mismo criterio de red de seguridad que `ml-vis-sweep`): el webhook trae lo NUEVO en tiempo real; el botón **Sincronizar** trae los comentarios de los posts publicados de los últimos 45 días directo del Graph API (cubre lo que Meta no entregó o lo anterior al webhook).
- **Idempotencia**: `social_comments.external_id` es UNIQUE — Meta re-entrega webhooks y el sync re-pasa comentarios: el claim evita duplicados.
- **Match post↔comentario**: IG matchea por `media.id == external_post_id` (el CRM guarda ese id al publicar); FB guarda el id de foto/video y el webhook trae `post_id "PAGEID_MEDIAID"` → igualdad o match por sufijo `_MEDIAID`. Si no hay match, el comentario igual entra a la bandeja (sin propiedad vinculada) y el lead se puede crear igual.
- **Dedup de persona**: mismo criterio que `contact-submit`/ML — email o últimos 8 dígitos de teléfono extraídos del TEXTO del comentario (Meta nunca los da), ventana 60 días; si ya existe, la consulta va al timeline del lead existente y se reconfirma el SLA.
- **SLA de primer contacto** (`_shared/firstContact.ts`): el lead nace con tarea "Primer contacto" y `next_followup_at`.

**Componentes nuevos:**
- `supabase/migrations/20261111000001_social_comments.sql` — tabla + índices + RLS.
- `supabase/functions/social-webhook-meta/` — GET verification (`hub.challenge` en texto plano, verify token guardado en `app_settings`) + POST con firma `X-Hub-Signature-256` (HMAC-SHA256 del App Secret, comparación timing-safe). `verify_jwt OFF` (en NO_VERIFY del CI: Meta no manda JWT — la autenticación real es la firma).
- `supabase/functions/social-comments/` — actions `list / sync / subscribe / webhook_info / create_lead / dismiss` (requireAdmin, verify_jwt ON, rate limit 30/min).
- `assets/js/social-inbox.js` + tab **Consultas** del módulo (sub-tab 5°) — bandeja con filtro por plataforma, caja de conexión con callback URL + verify token copiables, botón "Suscribir cuentas", notas de YouTube (va al Studio) y TikTok (limitación).
- OAuth de Facebook pide ahora `pages_manage_metadata` (necesario para `subscribed_apps`; cuentas conectadas antes hay que reconectarlas).

---

## 3. Hallazgos y correcciones de esta auditoría

1. **Drift de origen** (`youtube_comment`): `comment_lead` insertaba un origen que no existía en las 4 listas del admin. 0 filas en producción → se corrigió a `youtube` en el server. Guard: `tests/contenido-social-leads.spec.js`.
2. **Origen `gvamax` sin etiqueta**: 1 lead real en producción mostraba la clave cruda. Agregado a las 4 listas con label "Gvamax (import)".
3. **`social_posts`/`social_accounts` sin migración en el repo**: las tablas existen en producción pero ningún `.sql` las crea (se crearon fuera de migraciones). Riesgo: un proyecto nuevo desde cero no las tendría. No se regenera por riesgo de drift con producción — quedará registrado para cuando toque tocarlas. Verificado el schema real vía MCP antes de diseñar `social_comments` (FKs a `social_posts(id)`, `properties(id)`, `leads(id)`, `social_accounts(id)`).
4. **`external_post_id` sin UNIQUE** en `social_posts` (dedup por búsqueda previa — decisión ya documentada del sync de YouTube): los claims nuevos NO dependen de eso (la tabla nueva tiene su propio unique).
5. **Scope OAuth de FB incompleto** para webhooks: faltaba `pages_manage_metadata` → agregado.

---

## 4. Pendientes del dueño (checklist consolidado)

**Para habilitar Instagram + Facebook (+ sus leads):**
- [ ] Crear la app de Meta con los productos/permisos de la guía (§5 de `CONECTAR_INSTAGRAM_FACEBOOK.md`)
- [ ] Pegar las 2 redirect URIs exactas
- [ ] Pasar App ID + App Secret por canal seguro
- [ ] Webhook: Callback URL + Verify token del tab Consultas (§14 de la guía) → objetos **Page** (field `feed`) e **Instagram** (field `comments`)
- [ ] Conectar IG Business + la página de FB desde Cuentas → piloto 1 post en cada red
- [ ] Botón **Suscribir cuentas** del tab Consultas en verde

**Para habilitar TikTok:**
- [ ] App en developers.tiktok.com (Login Kit + Content Posting API / Direct Post) + redirect URI
- [ ] Credenciales por canal seguro
- [ ] (Solo si van a publicar fotos) dominio verificado — opciones en la guía
- [ ] Auditoría de TikTok si se quieren posts PÚBLICOS (sin auditar: solo "Solo yo")

**Opcional YouTube:** reconectar la cuenta para habilitar analytics (scope nuevo desde 2026-10-30).

---

## 5. Verificación

- Suite completa: **549 passed / 3 skipped** (ronda 1: 529; ronda 2 sumó los 9 guards nuevos de `tests/contenido-social-leads.spec.js` + el spec behavioral `tests/contenido-consultas.spec.js` — 9 tests con harness que corren el módulo real).
- `deno check` verde en las 7 funciones tocadas (`social-comments`, `social-webhook-meta`, `social-facebook`, `social-instagram`, `social-tiktok`, `social-auth-facebook`, `social-auth-instagram`).
- `npm run bump` aplicado (admin.html: admin-crm v104, admin-app v632, admin-contenido v24 + `social-inbox.js` v3).

---

## Addendum — Ronda 2 de la bandeja Consultas (2026-11-11, mismo día)

Paridad completa con la bandeja de YouTube. Nada de esto rompe producción: el webhook sigue dormido hasta que el dueño configure la app de Meta.

**Nuevas acciones del server (`social-comments`):**
- `reply` — responde el comentario desde el Graph API: FB `POST /{id}/comments`, IG `POST /{id}/replies`. El token sale del `account_id` de la fila vía `getSocialAccessToken` (page token FB / user token IG). Marca `metadata.replied_at` (chip "Respondido" en la fila) + audit `fb_comment_reply` / `ig_comment_reply`.
- `moderate` — `delete` = `DELETE /{id}` (ambas redes) → la fila pasa a `dismissed` + `metadata.moderated='deleted'`; `hide`/`unhide` = `POST /{id}?is_hidden=` (FB) / `?hide=` (IG). Audit `fb_comment_moderate` / `ig_comment_moderate`.
- `webhook_info` devuelve ahora `accounts[]` de `social_accounts` → chips de conexión en la caja del webhook del panel.

**Cliente (`social-inbox.js` v3):** filtro por estado (nuevos / con lead / descartados) combinado con el de plataforma, replybox inline, moderación con `window.__BH.showConfirmDialog` (confirm() nativo prohibido), botón **Abrir lead** en filas con `lead_id` → `window.BH_CRM.open()`, realtime y badge (abajo). Toasts vía `window.__BH.showToast` (no es global).

**Self-noise:** los replies PROPIOS (hechos con la cuenta que publicó) no ensucian la triage — `sync` los salta (`from.id == external_id` de la cuenta, contador `self_skipped` visible en el toast) y el webhook los inserta como `status='dismissed'` + `metadata.self=true` (`isSelfComment` consulta `social_accounts` del post). `social_comments.status` es TEXT sin CHECK (default `'new'`) → el insert explícito del webhook es seguro.

**Observabilidad del webhook:** errores de insert ≠ duplicado quedan en `audit_log` (`action='meta_webhook_error'`, `error_code`, `user_id` NULL válido — verificado por SQL; envuelto en try/catch para no tumbar la entrega de Meta). Sin esto, un fallo de PostgREST invisibilizaba comentarios sin rastro (clase de bug de ml-webhook pre-`logRejectedPayload`).

**Realtime + badge:** canal PROPIO `bh-social-inbox` en `social-inbox.js` (verificado: `social_comments` NO está en `setupCoreRealtime` de admin-app.js — sus 13 tablas son de CRM). UN `.on()` con `event:'INSERT'` → refresca la bandeja si está visible + badge con head-count `status='new'` en el botón del sub-tab (sin count → oculto; el badge solo existe cuando `#contenidoSubTabs` está montado).

**Scopes OAuth nuevos:** `pages_manage_engagement` (FB) + `instagram_manage_comments` (IG). Las cuentas conectadas ANTES hay que reconectarlas para estas acciones; los flujos de publicación siguen con la conexión vieja (el gate es por acción).

**Higiene `social-temp`:** los 3 servers de publicación (fb_/ig_/tt_) limpian huérfanos propios >24h en cada `upload_temp` (máx 20, best-effort, prefijo propio para no pisar flujos en vuelo) — si el browser muere entre upload y cleanup el archivo quedaba eterno en el bucket puente.

**Guards:** `tests/contenido-social-leads.spec.js` extendido (16 estáticos) + `tests/contenido-consultas.spec.js` (9 behavioral: filtros, crear lead + `BH_CRM.open`, reply, moderación confirmada/cancelada, badge, realtime simulando INSERT, sync con self_skipped).

---

## Addendum 3 — Hallazgos post-deploy (2026-11-11, auditoría de la cadena de deploy)

Trabajo posterior al deploy de la Ronda 2 (commit `bee92e2`, CI success 06:04): smoke del perímetro y revisión completa del pipeline CI↔producción. Cuatro hallazgos, tres cerrados en el mismo lote.

### H1 — Drift repo↔producción del flag verify_jwt en `notify-new-lead` ✅ CORREGIDO

- **Síntoma por evidencia**: `POST /functions/v1/notify-new-lead` sin auth respondía **400 de la función** (no 401 del gateway) → en producción `verify_jwt` estaba **OFF**, mientras `deploy.yml` la deployaría ON. La cadena de emails de leads está VIVA (alertas `crm_email_broken` del 5-10/10 cuando faltaba la key; BREVO configurado el 12/10 y desde entonces envía sin rastro) — el flag OFF provenía de un deploy manual anterior que el CI nunca tocó.
- **Causa raíz — semántica del CLI**: `supabase functions deploy` SIN `--no-verify-jwt` **NO resetea** un flag ya existente (el repo decía ON y producción conservó el OFF durante 5 corridas CI); funciones NUEVAS sin flag nacen con verify_jwt ON. `NO_VERIFY` de `deploy.yml` es la única fuente de verdad del flag.
- **Riesgo real si no se arregla**: el trigger `notify_new_lead()` llama via pg_net con **solo Content-Type** (sin JWT ni secret) → el próximo deploy con flag ON habría matado los emails de lead nuevo con 401 silencioso (la petición muere en el gateway, nada en logs).
- **Fix**: `"notify-new-lead"` en `NO_VERIFY` + comentario de bloque con la explicación. Exposición unauth aceptada (valida `lead_id` UUID + re-lee el lead con service_role; precedente `ml-questions-sweep`). El próximo CI re-deploya con `--no-verify-jwt` explícito — **sin cambio de comportamiento** (producción ya corre OFF).

### H2 — Sin guard global del deploy ✅ CERRADO

Ningún guard impedía la clase de incidente `EXCLUDED_FUNCTIONS` (contact-submit skipeado 38 días). Nuevo **`tests/functions-deploy.spec.js`** (6 tests, estático fs, 0 red): (1) nada excluido sin motivo documentado (`ALLOWED_EXCLUDED` = solo `convert-image`), (2) exclusiones sin zombie, (3) `NO_VERIFY` sin nombres zombie/typos, (4) **toda función llamada sin JWT (24 entradas: 11 crons+trigger, 2 pre-login, 4 webhooks, 7 callbacks OAuth — verificadas contra el dump de `cron.job` y simulaciones en producción) ⊆ `NO_VERIFY`**, (5) el mapa sin referencias a funciones borradas, (6) sanity del loop >50 deployables. **Trampa aplicada**: el array NO lleva comentarios inline con `)` (el regex `/NO_VERIFY=\(([^)]*)\)/` corta ahí — falso positivo real en la primera corrida).

### H3 — Gap de reproducibilidad del schema, cuantificado ⚠️ DOCUMENTADO (no resuelto)

**26 de las 72** tablas de producción tienen `create table` en las 121 migraciones del repo. Las ~25 core (`leads`, `properties`, `visits`, `agents`, `owners`, `profiles`, `tasaciones`, `site_*`, `ml_listings`, `ml_oauth_states`, `ml_orders/payments/questions/shipments`, `ml_auto_reply_*`, `ml_sync_queue_failed_archive`, `property_images/sequences`, `qr_checkins`, `portal_settings`, `app_settings`, `social_posts`, `social_accounts`…) se crearon por dashboard antes de la disciplina de migraciones — ningún `create table` de las migraciones las menciona. Consecuencia: un proyecto fresco NO es reproducible con el repo solo, y una migración de `social_posts`/`social_accounts` (hallazgo 3 original) fallaría en replay por FKs a core sin migración. Se registra con números; **no** se genera DDL sin OK del dueño.

### H4 — Función huérfana `visits-reminders` ⚠️ PENDIENTE de borrado manual

La función existe deployada con verify_jwt ON y **0 llamadores** (el cron `visits-reminders` llama a `visits-process-reminders`). README la documentaba mal. Mismo patrón que tmp-gen-jwt/cta-test: limpieza del dashboard por el dueño (verificar antes que nadie la use).

### Smoke del perímetro (producción, post-deploy `bee92e2`)

`social-comments`/`social-facebook`/`social-instagram`/`social-tiktok` POST sin auth → **401** · webhook Meta GET con verify token inválido → **403** · POST sin firma → **401** · `ml-sync-import` (verify_jwt ON, llamador = panel con JWT) → **401** · `contact-submit` (NO_VERIFY) → **400** de la función. Todo como se diseñó.

### Otros estados verificados

- **20 crons activos** (10 HTTP con target ⊆ `NO_VERIFY` y headers correctos; 10 SQL internos) — README actualizado de 17 a 20 (faltaban `ml-vis-sweep-every-30-min`, `ml-webhook-events-purge-daily`, `exclusive-expiry-alert-daily`).
- `ml-questions-sweep`: su cron NO envía secret y la función no lo exige (abierto por diseño, rate-limited) — consistente, no bug. `ml-sync-import`: verify_jwt ON correcto (dual JWT/secret, llamador = panel). `cloudinary-sign`: OFF + valida JWT dentro de la función (patrón válido; README stale corregido).

### H5 — Scan función por función repo↔producción (2026-11-11, mismo día) ✅ CORREGIDO

Contraste completo con `list_edge_functions` (65 en producción vs 64 deployables del repo — la diferencia exacta son los zombies `tmp-gen-jwt`/`cta-test`; `convert-image` excluida en CI y ausente en producción, consistente):

- **`ics-feed` — el único drift de la clase "rompe en silencio" que quedaba**: producción OFF (requisito — la suscripción de calendario externa con `?token=<agents.ics_token>` no puede mandar JWT) y el repo NO lo documentaba en `NO_VERIFY` → una re-creación manual (MCP defaults verify_jwt=true) o un cambio de semántica del CLI (`setup-cli` usa "latest") apagaba la agenda de todos los brokers con 401 al refrescar la suscripción. Fix: en `NO_VERIFY` + entrada en `CALLED_WITHOUT_JWT` + README corregido (decía ON).
- **`ml-disconnect`, `manage-users`, `supervision-api`, `zernio-proxy`** — producción OFF y todos validan JWT/rol DENTRO de la función (`requireAdmin`/`getUser`/`requireSuperAdmin`/`requireStaff`): el flag del gateway es irrelevante para sus llamadores. Drift benigno; solo docs stale corregidas (README decía ON en 3 de ellas; AGENTS.md decía ON para supervision-api y repetía la línea vencida de BREVO no-configurada).
- **`visits-reminders`** — huérfana con flag OFF en producción y sin entrada en `NO_VERIFY`: irrelevante (0 llamadores, borrado pendiente); NO se agrega a `NO_VERIFY` para no cimentar un zombie.
- **Lección**: el CI nunca gira el flag existente (semántica CLI), así que este drift solo explota en re-creaciones manuales o cambios de CLI — exactamente como notify-new-lead. El guard + `list_edge_functions` son la dupla de verificación periódica.
- **Drift de CÓDIGO desplegado (tercera clase, verificación metodológica)**: `get_edge_function` devuelve el contenido real desplegado por archivo + checksum `ezbr_sha256` — permite contrastar contra el repo. Spot-check 2026-11-11: `ics-feed` (sin imports de `_shared`, comparable byte a byte) → **idéntico** al repo; `contact-submit` (bundleado: los `_shared` van inlined en el entrypoint desplegado `functions/contact-submit/index.ts`) → contiene todas las huellas recientes (FIX LEGAL `consent_at` 23/10, SLA de primer contacto 02/11, atribución UTM). Método para el futuro: byte-compare en funciones standalone, huellas en funciones bundleadas (el bundling impide el byte-compare directo). El CI redeploya TODO en cada push, así que el drift de código solo aparece con hotfixes manuales vía MCP — si eso pasa, el re-scan de esta sección lo detecta.

### H6 — Re-scan de seguridad post-módulo: funciones nuevas re-heredan EXECUTE público ✅ CORREGIDO (2026-11-11, mismo día)

El hardening del 2026-10-15 arregló las funciones **existentes** pero no tiene red de redes para funciones nuevas: toda `CREATE ... FUNCTION` hereda el grant default `EXECUTE TO PUBLIC`. El re-scan del advisor (security + performance) tras el módulo de contenido:

- **`anon_security_definer_function_executable` 15 → 17**: exactamente 2 funciones nacidas después del hardening — `log_property_price_change` (migración `20261016000003`, trigger sobre `properties`) y `revoke_owner_tokens_on_deactivate` (`20261030000001`, trigger sobre `owners`). Ambas tablas authenticated-only (0 policies anon) → revocar anon es seguro. Fix: migración `20261111000002_hardening_post_20261015` (aditiva, solo REVOKE/GRANT/ALTER FUNCTION) + revokes por uniformidad en los triggers sociales `tr_social_posts_updated_at`/`tr_social_accounts_updated_at` (no-SECDEF, no flaggeados). Verificado: matriz de grants (anon/PUBLIC fuera, authenticated+postgres+service_role intactos) y advisor 17 → 15 = baseline exacto (13 RPC por token + `compute_lead_score`/`notify_new_lead`).
- **`function_search_path_mutable` 2 → 0**: los 2 triggers sociales no tenían `search_path` fijado → `ALTER FUNCTION SET search_path = ''` (cuerpos solo usan `now()`). Smoke: tabla temporal + trigger + UPDATE → `updated_at` poblado (0 filas sin valor) bajo la nueva search_path.
- **`rls_enabled_no_policy` = 4 (INFO, intencional)**: `ml_oauth_states`, `ml_sync_queue_failed_archive` (sin PK — es tabla de archivo), `rela_tokens`, `zernio_webhook_events`. ACLARACIÓN: `zernio_config`/`property_sequences`/`ml_webhook_events` YA tienen policies (`zernio_config` gated a `key='api_key'` + `super_admin` — el `sync_secret` sigue inaccesible para authenticated; AGENTS.md quedó corregido, decía "sin policies").
- **`extension_in_public` (2 WARN, ACEPTADO)**: `pg_net` y `pg_trgm` instalados en `public`. Moverlos rompería los 20 crons (referencias `net.http_*` cualificadas) y los índices trigram futuros — riesgo alto, ganancia cero. Documentado como riesgo aceptado.
- **`auth_leaked_password_protection` (1 WARN)**: sigue OFF — activación manual del dueño en Dashboard → Auth (ya estaba en Pendientes).
- **Postura RLS**: 72/72 tablas con RLS ON (re-verificación completa).

### H7 — Advisor de performance: hallazgos cuantificados, sin aplicar (roadmap)

Snapshot 2026-11-11 (lectura, no se tocó nada): `auth_rls_initplan` **89** WARN (quals RLS con `auth.uid()` no envueltos en `(SELECT ...)` — costo por fila en cada query con RLS), `multiple_permissive_policies` **38** WARN sobre 10 tablas (`ml_listings`, `notification_preferences`, `broker_blocks`, `ml_auto_reply_templates`, `ml_connection`, `ml_sync_dead_letter`, `portal_settings`, `property_images`, `site_settings`, `user_sessions`), `unindexed_foreign_keys` 32 INFO, `unused_index` 89 INFO, `no_primary_key` 1 (la tabla de archivo). Es un lote aparte: reescribir 89 quals y consolidar 38 policies es una refactorización con riesgo real que exige revisión policy por policy y verificación contra cada rol — NO hacerlo en masa sin OK del dueño y un plan por tabla (prioridad sugerida: tablas con alto volumen de lecturas — `leads`, `properties`, `audit_log` — primero).
