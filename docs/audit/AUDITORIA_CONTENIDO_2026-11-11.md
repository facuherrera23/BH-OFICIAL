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

- Suite completa: **529 passed / 3 skipped** (agregados: `tests/contenido-social-leads.spec.js` 7 guards nuevos + orígenes actualizados en `tests/lead-origins.spec.js` + conteos de sub-tabs en `tests/contenido-ui.spec.js`).
- `deno check` verde en las 4 funciones tocadas (`social-comments`, `social-webhook-meta`, `social-youtube-comments`, `social-auth-facebook`).
- `npm run bump` aplicado (admin.html: admin-crm v104, admin-app v632, admin-contenido v24 + `social-inbox.js` v1).
