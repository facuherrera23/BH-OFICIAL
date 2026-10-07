# AGENTS.md — Cheat-sheet operativo para agentes

Sistema CRM inmobiliario **en producción real** (bienenhaus.com.ar) con datos de clientes. El `README.md` documenta arquitectura, módulos, DB y flujos en profundidad — leerlo antes de cambios grandes. Este archivo es solo lo que ya causó bugs o no se puede inferir de los archivos.

## Reglas duras

- **Producción con datos reales**: nunca DELETE/TRUNCATE/DROP ni migraciones destructivas sin backup y aprobación explícita. No hay staging.
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
- El registro de tópicos **solo ocurre en el OAuth** o con el botón 🔔 del panel (Portales → ML → action `register_webhooks` de `ml-oauth`). Si "las consultas de ML no llegan al CRM": primera sospecha = tópicos sin registrar; verificar los chips del panel (`ml-portal-status?webhooks=1` consulta el estado real a la API de ML).
- `ml-webhook` responde 200 **inmediato** y procesa en background con `EdgeRuntime.waitUntil`: ML desactiva los tópicos ("fall back") si el callback no responde en ~500ms, y reintenta 5 veces en 1 hora.
- Estados de `ml_questions` en **minúsculas** (`unanswered`/`answered`); `ml_listings` usa `ml_status`/`last_sync` (usar `status`/`last_synced_at` rompía el estado del panel en silencio).

## Supabase (proyecto único = producción)

- Proyecto `rnldqiwwzhjnurkguihu`. Migraciones vía MCP `supabase_apply_migration` (quedan en `supabase/migrations/`).
- RLS en las 37 tablas. Las tablas sin policies (`zernio_config`, `property_sequences`, `ml_oauth_states`, `rela_tokens`, `*_webhook_events`) son **intencionales**: solo `service_role`.
- Funciones `SECURITY DEFINER` de acceso público por token (`portal_get_portal_data`, `portal_validate_token`, `get_visit_by_token`, `update_visit_status_by_token`, `log_visit_public_action`, y `get_sidebar_badge_counts` para authenticated) **conservan** EXECUTE — no revocar.
- **No revocar EXECUTE a `authenticated` en funciones usadas por cadenas de trigger/DEFAULT** (ej: `generate_property_code`, `set_property_code`, triggers de visits/leads). Incidente real 2026-09-28: una revoca masiva rompió el alta de propiedades ("permission denied for function generate_property_code") y hubo que revertirla. Hardening vigente y seguro: REVOKE a `PUBLIC` en las 10 funciones internas de CRM + GRANT explícito a `service_role` + `search_path` fijado.
- Tras cualquier migración de permisos: verificar con `has_function_privilege` **la lista completa** de funciones tocadas × (anon, authenticated, service_role) — no un subconjunto.
- Edge Functions: desplegar vía MCP; webhooks y cron con `verify_jwt` OFF, el resto ON.
- Free tier: 5 GB egress/mes, ~60 conexiones.

## `tasaciones.data` (gotcha de peso)

JSONB con fotos base64 embebidas. Las tasaciones nuevas comprimen client-side (`resizeImageToDataUrl` en `tasacion-page.js`: fachada 1600px, comparables 1400px, JPEG q≈0.82); las viejas pueden pesar MB. El listado admin **no** selecciona `data` a propósito — no re-agregar. `valuation_usd` se calcula al guardar; el fallback que recalcula desde `data` si es NULL existe por seguridad — no borrar.

## Imágenes y performance

- Cloudinary cloud `jpyigjrh`; hero del landing = URL Cloudinary con fallback local `assets/images/hero-bg.webp`. Preferir `f_auto,q_auto` de Cloudinary antes que Unsplash.
- Realtime hace full-refresh por cambio (`setupCoreRealtime`) — evitar N+1 en renders de listados grandes.

## Pendientes conocidos

- **Leaked Password Protection** (Supabase Auth): activación manual en Dashboard → Auth. Avisar al dueño si sigue off.
- **ML**: cerrar publicaciones huérfanas DA-P0019/21/22/03 en el panel de Mercado Libre antes de republicar; "Importar desde ML" **duplica propiedades** — no usar para esas.
- Edge Functions: el CI deploya TODAS desde el repo en cada push a `main` (`.github/workflows/deploy.yml`, con flags verify_jwt por función); deploy manual vía MCP solo para hotfixes urgentes.
- **Borrar del dashboard las funciones de debug `tmp-gen-jwt` (P0: genera magic-links sin auth) y `cta-test`** — leftovers de /tmp con verify_jwt OFF.
- Codegraph index disponible (`.codegraph/`, no versionado) — útil antes de editar.
