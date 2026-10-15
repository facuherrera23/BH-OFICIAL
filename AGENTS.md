# AGENTS.md — Cheat-sheet operativo para agentes

Sistema CRM inmobiliario **en producción real** (bienenhaus.com.ar) con datos de clientes. El `README.md` documenta arquitectura, módulos, DB y flujos en profundidad — leerlo antes de cambios grandes. Este archivo es solo lo que ya causó bugs o no se puede inferir de los archivos.

## Reglas duras

- **Producción con datos reales**: nunca DELETE/TRUNCATE/DROP ni migraciones destructivas sin backup y aprobación explícita. No hay staging.
- **⚠️ PowerShell corrompe UTF-8 — regla dura de encoding**: NUNCA usar `Get-Content`/`Set-Content`/`Out-File` de PowerShell 5.1 para leer o escribir archivos con acentos/emoji (HTML, JS, CSS, MD, SQL). PS 5.1 lee UTF-8 como CP1252 y al re-escribir hornea doble-encoding (mojibake "DÃ³lares") — incidente real 2026-10-12: dos resoluciones de conflicto de rebase con Get-Content+Set-Content corrompieron TODO admin.html (342 textos) y llegó a producción. Para leer: usar el tool Read. Para escribir/transformar archivos: `node` con `fs.readFileSync(path,'utf8')`/`writeFileSync(path, data,'utf8')` (ver `scripts/recover-admin-html.mjs`). Para resolver conflictos de rebase con contenido no-ASCII: node script, jamás PowerShell.
- **Directiva del dueño: no usar subagentes** — trabajar directo con herramientas.
- Todo comando git lleva prefijo `$env:GIT_MASTER='1';` (PowerShell, hook del equipo): `$env:GIT_MASTER='1'; git status`.
- Commits en español, minúsculas, formato `modulo: mensaje` (ej: `perf: hero cloudinary, fotos comprimidas`). Antes de push: `git pull --rebase`; si rechaza, rebase — jamás force.
- NO stagear untracked ajenos al trabajo: `gvamax-export/`, `HOJA DE VISITA.pdf`, `meta.txt`, `scripts/scan-refs.ps1`.

## Flujo de cambios (no hay build step)

1. Editar JS/CSS/HTML.
2. `npm run bump` — sube los `?v=N` de los assets con cambios (git diff vs HEAD) en todos los HTML del root. Sin esto, producción sirve una mezcla de versiones vieja/nueva → bugs fantasma. Commitear los HTML junto con los assets.
3. `node --check assets/js/<cada-js-editado>.js` — es el único "typecheck" que existe.
4. `npm test` — Playwright en modo lectura contra producción; los de admin requieren `BH_TEST_ADMIN_EMAIL`/`BH_TEST_ADMIN_PASSWORD`.
5. Commit + push a `main` → Cloudflare Pages deploya solo (build vacío, output `/`).
6. Local: `python -m http.server 8791`.

## Scope de helpers (caída real ya ocurrida)

- `logError` **no** es global: se define en `admin-app.js` y se expone en `window.__BH`. Los módulos `admin-*.js` lo destrukturaron al inicio — **excepto `admin-crm.js`** (usar `window.__BH.logError(...)`) y **`admin-supervision.js`** (convención propia: `console.error('[sup] ...', err)`).
- Globals: `window.supabaseClient`, `window.BHUtils` (`esc`, `escAttr`, `safeUrl`, `safeImageUrl`), `window.BH_Cloudinary`, `window.adminApp`, `window.__BH`.
- `esc()`/`escAttr()` SIEMPRE antes de `innerHTML`; cero `onclick` inline (la CSP no tiene unsafe-inline).

## CSP por página (caída real ya ocurrida)

Cada HTML tiene su meta CSP propia. Al agregar cualquier recurso externo (API, tiles, imágenes, fonts) hay que actualizar `connect-src`/`img-src` en **cada página afectada**. Caso real: el mapa Leaflet de tasaciones quedó mudo porque faltaban Nominatim (`connect-src`) y tiles OSM (`img-src`).

## ML / Mercado Libre (gotchas de peso)

- Las notificaciones de tópicos de ML **no vienen firmadas** (no hay header documentado): la barrera real del webhook es el binding (`application_id` + `user_id` de `ml_connection`) + el re-fetch del recurso con el token del vendedor. `ML_WEBHOOK_SECRET` se pasa como `auth_token` al registrar los tópicos y solo verificaría un hipotético `x-meli-signature` con HMAC del body — nunca contra el secreto en plano (bug real 2026-10-07: mataba toda notificación).
- La suscripción de notificaciones **se configura en el gestor de aplicaciones de ML** (applications.mercadolibre.com.ar → editar la app → callback URL + tópicos): **ML retiró el registro por API** (`POST/GET /users/{id}/topics/{topic}` responde 404 — por eso el OAuth del 8/9/2026 nunca registró nada y falló en silencio). Callback URL: `${SUPABASE_URL}/functions/v1/ml-webhook`; tópicos para inmuebles: **VIS Leads** (subtópicos Question/WhatsApp/Call/Visit request/etc.). Los tópicos questions/items NO traen consultas de inmuebles. Si "las consultas de ML no llegan al CRM": verificar eso primero; el panel (Portales → ML) muestra la guía cuando el endpoint da 'gone'.
- Las consultas/contactos de **inmuebles** llegan con tópico `vis_leads` y resource `/vis/leads/{uuid}` (NO questions): el webhook los procesa en `handleVisLeads` (fetch `/vis/leads/{id}` → lead en CRM). El texto de una pregunta se pide aparte con `external_id` → `/questions/{id}`. Dedup de doble notificación: índice único `leads.ml_lead_id` + check `ml_questions.lead_id` (compartido con el flujo clásico). Parseo del webhook **tolerante** (schema sin enum de tópicos, números coerce) + `logRejectedPayload` guarda en `ml_webhook_events` lo que falle validación: NUNCA rechazar sin rastro (bug real 2026-10-07: 6 notificaciones se perdieron con 400 y no se veían en ningún lado). Backfill/listado de contactos: `GET /vis/users/{user_id}/leads/buyers?include_guest=true&date_from=...` y panel `ml-portal-status?leads=1&days=N&import=1` (re-inyecta cada lead como notificación al webhook).
- **CLAIM atómico entre topics + dedup por identidad** (2026-10-13): la misma consulta llega en paralelo por `questions` y `vis_leads` (external_id = question_id) y antes duplicaba el lead. Hoy ambos flujos hacen INSERT al ledger `ml_questions` como claim (UNIQUE `question_id`); quien pierde (23505) NO actúa por su cuenta — si tiene identidad, consolida en el lead del ganador. Además la vía `questions` **nunca crea leads** (en inmuebles ML anonimiza identidad — el dueño no quiere filas vacías en el CRM): claima el ledger, responde con la plantilla y nada más. Los leads se crean solo desde `vis_leads` CON identidad (nombre o email/teléfono/whatsapp), y si la misma persona toca otra publicación el evento se mergea al lead existente con `mergeMlEventIntoLead` (rellena campos vacíos. vincula la propiedad extra en `lead_properties`, deja traza "Evento ML vinculado: <id>" para que las notificaciones de estado de ese contacto también casen) — nunca sobre etapas terminales. Sacar el gate de identidad o la claim revienta todo de nuevo.
- En pg_cron con `net.http_post`, la URL va **hardcodeada**: `current_setting('app.settings.supabase_url', true)` devuelve NULL en este proyecto (bug real 2026-10-08: el cron `ml-questions-sweep` falló todas las corridas con "null value in column url" hasta reprogramarlo con URL literal). Patrón correcto: ver `visits-reminders`/`ml-sync-every-5-min`/`zernio-sync-every-2-min` en `cron.job`.
- **Suscripción ≠ lectura**: tener VIS Leads habilitado como tópico SOLO hace que ML dispare el webhook; el detalle (`GET /vis/leads/{id}`) y el listado devuelven **403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`** hasta que ML otorgue acceso de lectura de leads de inmuebles a la app. No se habilita desde el panel de aplicaciones: el empleador lo pide a soporte/integraciones de ML (app `6473600664555938`, usuario `2038586793`). Señal: eventos `failed` con "HTTP 403" en ml_webhook_events (las notificaciones quedan registradas y se re-importan cuando se habilite — no se pierden).
- `ml-webhook` responde 200 **inmediato** y procesa en background con `EdgeRuntime.waitUntil`: ML desactiva los tópicos ("fall back") si el callback no responde en ~500ms, y reintenta 5 veces en 1 hora.
- Estados de `ml_questions` en **minúsculas** (`unanswered`/`answered`); `ml_listings` usa `ml_status`/`last_sync` (usar `status`/`last_synced_at` rompía el estado del panel en silencio).

## Supabase (proyecto único = producción)

- Proyecto `rnldqiwwzhjnurkguihu`. Migraciones vía MCP `supabase_apply_migration` (quedan en `supabase/migrations/`).
- RLS en las **63 tablas** (100 % de cobertura, verificado 2026-10-15 contra producción). Las tablas sin policies (`zernio_config`, `property_sequences`, `ml_oauth_states`, `rela_tokens`, `*_webhook_events`) son **intencionales**: solo `service_role`.
- Funciones `SECURITY DEFINER` de acceso público por token (`portal_get_portal_data`, `portal_validate_token`, `get_visit_by_token`, `update_visit_status_by_token`, `log_visit_public_action`, y `get_sidebar_badge_counts` para authenticated) **conservan** EXECUTE — no revocar.
- **No revocar EXECUTE a `authenticated` en funciones usadas por cadenas de trigger/DEFAULT** (ej: `generate_property_code`, `set_property_code`, triggers de visits/leads). Incidente real 2026-09-28: una revoca masiva rompió el alta de propiedades ("permission denied for function generate_property_code") y hubo que revertirla. Hardening vigente y seguro: REVOKE a `PUBLIC` en las 10 funciones internas de CRM + GRANT explícito a `service_role` + `search_path` fijado.
- Tras cualquier migración de permisos: verificar con `has_function_privilege` **la lista completa** de funciones tocadas × (anon, authenticated, service_role) — no un subconjunto.
- Edge Functions: desplegar vía MCP; webhooks y cron con `verify_jwt` OFF, el resto ON.
- Free tier: 5 GB egress/mes, ~60 conexiones.

## `tasaciones.data` (gotcha de peso)

- **Moneda por destino** (fix 2026-10-12): `f_destino = 'Alquiler'` → todo el pipeline va en **$ (ARS mensual)** y persiste en `valuation_ars` con `type='alquiler'`; `Venta` → **U$S** y persiste en `valuation_usd`. El símbolo sale de `currencySymbol()` en `tasacion-page.js` — nunca hardcodear 'U$S' en displays de tasaciones. El listado admin (`buildTasacionRowHtml`) lee la columna según `type` y solo convierte a pesos en las de venta.
- JSONB con fotos base64 embebidas. Las tasaciones nuevas comprimen client-side (`resizeImageToDataUrl` en `tasacion-page.js`: fachada 1600px, comparables 1400px, JPEG q≈0.82); las viejas pueden pesar MB. El listado admin **no** selecciona `data` a propósito — no re-agregar. `valuation_usd` se calcula al guardar; el fallback que recalcula desde `data` si es NULL existe por seguridad — no borrar.

## Encuesta de visita / `visit_surveys` (gotchas)

- **Set de preguntas v3** (2026-10-12): sliders = `ubicacion`, `superficie`, `distribucion`, `conservacion` (label "Estado Conservación"), `general`; `compraria` solo Sí/No. La RPC `survey_submit_by_token` valida esas keys con **replace full-set** — si se agregan/cambian sliders, actualizar el ARRAY de la RPC + `SCORES` en encuesta-page.js + los labels del portal (`SV_LABELS`) y del CRM (`LBL`) a la vez. Los displays mantienen las keys viejas (`tamano`/`calidad`/`precio`) para que respuestas anteriores se sigan viendo.
- 1 encuesta **activa** por (lead, propiedad): el UNIQUE es **parcial** (`WHERE archived_at IS NULL`). "Reiniciar" = `archived_at=now()` (policy UPDATE restringida al agente del lead o super_admin); la archivada sigue visible para el dueño en el portal.
- El visitante escribe **solo** vía `survey_submit_by_token` (SECURITY DEFINER con `FOR UPDATE` — no sacarlo: evita nota duplicada en `lead_activities` ante submits concurrentes). Nunca agregar UPDATE/DELETE de filas desde el cliente.
- La nota "Encuesta de visita recibida" en el historial del lead la inserta la **función SQL** al finalizar — no el frontend.
- El portal enmascara teléfonos (7+ dígitos) en los textos libres (`renderEncuestas` en portal-propietario-page.js) — pedido de privacidad del dueño, no "arreglar".
- `sendSurveyForProperty` se exporta como `window.BH_CRM.sendSurvey` — la Agenda la usa para la oferta de encuesta post-check-out; cambiar la firma rompe la Agenda.
- Recordatorio automático: `survey_pending_reminders()` (cron `survey-reminders-daily`, 12:00 ART) crea una tarea `contact`/`whatsapp` al agente si la encuesta lleva 48h sin responder. Dedup por lead: mientras haya una tarea "Encuesta sin responder—" activa, no se duplica.
- Backups automáticos: `backup-snapshot` (Edge Function, cron `backup-snapshot-daily` 04:00 ART) → bucket privado `backups` en Storage, retención 30 días. Secret compartido con zernio-sync en `zernio_config(key='sync_secret')`. Ambas funciones están en `NO_VERIFY` del CI.

## Fichas HTML (pipeline)

- **Único camino de generación**: `scripts/generate-ficha.mjs` vía CI (`ficha-generate.yml`: cron cada 30 min + `repository_dispatch: generar-ficha`). Commitea `fichas/` + `sitemap.xml` a main con `[skip ci-pages]` y Cloudflare las sirve. No hay otro generador.
- **Reconciliación**: cada corrida completa borra las fichas de propiedades despublicadas (antes quedaban zombie, accesibles e indexadas con datos viejos). Dos guards: si la DB devuelve 0 publicadas aborta sin escribir/borrar (anti-wipe), y con `ONLY_CODE` no reconcilia (el set sería de una sola ficha).
- **`ficha-publish` es un stub 410** (deprecado 2026-10-11): duplicaba la generación hacia el bucket Storage `fichas` con un template inferior que ningún consumidor usaba — no reactivar. El redirector legado `/ficha?code=X` sigue vivo apuntando a la estática.
- Al agregar recursos externos al template de ficha: actualizar la **CSP** de `generate-ficha.mjs` (cada ficha lleva la suya) y regenerar.
- El botón "Compartir por WhatsApp" de Propiedades arma el link con `?de=<agente>&tel=<tel>` del usuario logueado (`sharePropertyWhatsApp`) — la ficha muestra ese contacto y el CTA apunta a su número.

## Centro de Supervisión (gotchas)

- **Motor de reglas** (`evaluate_supervision_rules`, cron cada 5 min): soporta `filter.contains` (changed_fields) y `filter.equals` con **whitelist de campos** (`status`, `table_name` — CASE en la función). Un `filter.equals` con campo desconocido NO filtra (no rompe): al agregar un campo nuevo, extender el CASE. Bug original: `equals` no existía y `repeated_errors_detection` disparaba falsos positivos ante actividad normal (51 dismissados 2026-10-12).
- **Purga**: `purge_supervision_alerts` usa `COALESCE(resolved_at, dismissed_at, created_at)` — la tabla NO tiene `updated_at`. El bug original (columna inexistente) rompía el cron diario y, por rollback de `purge_supervision_all()`, tampoco purgaba `audit_log`.
- **UI**: `admin-supervision-panel.js` es solo un shim de entrada (gate super_admin + delegación a `window.adminSupervision`); la UI real vive en `admin-supervision.js` (Equipo/Feed/Errores/Alertas). El panel viejo de ~90KB fue retirado — no re-agregar código ahí. El gate de rol está en el shim porque la UI nueva no lo valida (RLS protege los datos).
- **Notificaciones (estado actual, Fase 2 2026-10-12)**: el canal elegido es el **digest semanal** (cron `supervision-digest-weekly`, lunes 11:00 UTC = 08:00 ART) a la casilla compartida de los dueños `bienenhaus.propiedades@gmail.com` (`app_settings.integrations.supervision_digest_recipients`). `supervision-notify` (el disparo SQL moría con URL NULL — histórico: `supervision_notify_failed` 2026-08-29), `supervision-notifications` (prefs sin filas ni consumidor) y `supervision-ml-anomaly` (el cron SQL hace el trabajo) quedaron como **stubs 410**. `supervision-api` queda como API externa documentada (verify_jwt ON + rate limit). ⚠️ **BREVO_API_KEY no está configurada** (secret de Supabase) — sin ella el digest y las otras 5 funciones de email (notify-new-lead, visits-reminders, cron_exclusivity_renewals, trigger_commission_on_close, owner-tasks-reminder) no envían nada.
- La regla `role_change_detection` quedó **deshabilitada** (2026-10-12): duplicaba exactamente a `privilege_escalation_attempt` (misma condición, ambos disparaban por cada cambio de rol). La crítica es la que queda activa.
- Alertas que NO vienen de `supervision_rules`: `lead_followup_overdue` las genera `crm_queue_followup_alerts()` (cron crm-followup-alerts) y `crm_email_broken` las genera `notify-new-lead`.

## Chat Redes / Zernio (gotchas)

- La entrada opera por **`zernio-sync`** (Edge Function, cron `zernio-sync-every-2-min`): pull incremental de Zernio, solo conversaciones con `updatedTime` nuevo → INSERTs disparan el realtime del panel. Auth: header `x-sync-secret` contra `zernio_config(key='sync_secret')`.
- `zernio-sync` está en la lista `NO_VERIFY` de `.github/workflows/deploy.yml` — si se agrega una función cron nueva sin meterla ahí, el CI la deploya con verify_jwt ON y el cron muere en silencio (401).
- El webhook push (`zernio-webhook`) está construido y defendido (HMAC timing-safe, dedup por event id) pero **Zernio no tiene API para registrarlo** — solo el dashboard del dueño (ver `docs/integrations/CONECTAR_ZERNIO_CHAT.md` §4). Mientras tanto, el pull lo cubre con ≤2 min de latencia.
- `zernio-proxy` exige **staff** (super_admin: todo; **broker**: `send_message`/`typing`/`mark_read` solo en conversaciones donde su `broker_id` es el dueño — la key de Zernio solo la usan funciones server-side).

## Imágenes y performance

- Cloudinary cloud `jpyigjrh`; hero del landing = URL Cloudinary con fallback local `assets/images/hero-bg.webp`. Preferir `f_auto,q_auto` de Cloudinary antes que Unsplash.
- Realtime hace full-refresh por cambio (`setupCoreRealtime`) — evitar N+1 en renders de listados grandes.

## Pendientes conocidos

> Auditoría completa 2026-10-15 en `docs/audit/AUDITORIA_COMPLETA_2026-10-15.md` (score 79/100, roadmap priorizado).

- **P1 — 11 funciones internas `SECURITY DEFINER` con EXECUTE a `anon`** (hallazgo de auditoría 2026-10-15): `backup_build_snapshot`, `compute_lead_score`, `crm_flag_overdue_visits`, `crm_flag_stale_leads`, `crm_queue_followup_alerts`, `leads_followup_on_contact`, `leads_recalc_followup_on_task`, `purge_rate_limit_logs`, `revoke_owner_tokens_on_delete`, `survey_pending_reminders`, `zernio_increment_unread` — creadas DESPUÉS del hardening 2026-09-28 y nunca revocadas. No exponen datos pero cualquiera puede dispararlas vía RPC. Fix: REVOKE a anon/authenticated + GRANT a `service_role`, verificando con `has_function_privilege` la lista completa y sin tocar las de cadenas de trigger (lección del incidente 2026-09-28).
- **P1 — Migración faltante de la publicación realtime**: `lead_properties`, `lead_tasks`, `lead_activities`, `owner_tasks` se agregaron a `supabase_realtime` directo vía MCP (2026-10-14) sin archivo en `supabase/migrations/` — un rebuild desde cero quedaría incompleto. Crear la migración equivalente.
- **qr-visita.html: botón "Imprimir cartel" bloqueado por su propia CSP** (`onclick` inline con `script-src 'self'`): migrar a `data-*` + listener cuando se toque el archivo.
- ~~**BREVO_API_KEY faltante**~~ → **RESUELTO 2026-10-12**: el secret está configurado y verificado end-to-end (primer `supervision_digest_sent` exitoso con messageId). Cuenta Brevo: Facundo (OsissDev) con `bienenhaus.propiedades@gmail.com` como sender activo. El digest semanal (lunes 08:00 ART) llega a la casilla compartida de los dueños. Si se rompe: verificar que el secret siga seteado y que la cuenta no tenga restricción de IPs activada (las Edge Functions salen con IPs dinámicas — la restricción de IPs de Brevo debe quedar desactivada).
- **KPIs del digest con queries flojas** (detectado 2026-10-12): `actionsTotal: 1000` (límite PostgREST sin paginación), `uniqueUsers: 0`, `successCount: 0` — el email llega pero con números incompletos. Fix pendiente en `supervision-digest/fetchDigestData`.
- **Leaked Password Protection** (Supabase Auth): activación manual en Dashboard → Auth. Avisar al dueño si sigue off.
- **ML**: cerrar publicaciones huérfanas DA-P0019/21/22/03 en el panel de Mercado Libre antes de republicar; "Importar desde ML" **duplica propiedades** — no usar para esas.
- Edge Functions: el CI deploya TODAS desde el repo en cada push a `main` (`.github/workflows/deploy.yml`, con flags verify_jwt por función); deploy manual vía MCP solo para hotfixes urgentes.
- **Borrar del dashboard las funciones de debug `tmp-gen-jwt` (P0: genera magic-links sin auth) y `cta-test`** — leftovers de /tmp con verify_jwt OFF.
- **Vaciar/borrar del dashboard el bucket Storage `fichas`** (Supabase Studio → Storage): quedó deprecado con 29 fichas stale del viejo flujo `ficha-publish`; el SQL directo está bloqueado por `storage.protect_delete` y el stub impide nuevas escrituras, así que es limpieza manual estética.
- Codegraph index disponible (`.codegraph/`, no versionado) — útil antes de editar.
