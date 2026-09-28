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

## Supabase (proyecto único = producción)

- Proyecto `rnldqiwwzhjnurkguihu`. Migraciones vía MCP `supabase_apply_migration` (quedan en `supabase/migrations/`).
- RLS en las 37 tablas. Las tablas sin policies (`zernio_config`, `property_sequences`, `ml_oauth_states`, `rela_tokens`, `*_webhook_events`) son **intencionales**: solo `service_role`.
- Funciones `SECURITY DEFINER` de acceso público por token (`portal_get_portal_data`, `portal_validate_token`, `get_visit_by_token`, `update_visit_status_by_token`, `log_visit_public_action`, y `get_sidebar_badge_counts` para authenticated) **conservan** EXECUTE — no revocar. Las internas (cron/trigger) ya fueron revocadas a `anon`/`authenticated` (2026-09-28) — no re-grantear ni duplicar.
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
- Edge Functions ML desplegadas sin fuente en el repo (drift).
- Codegraph index disponible (`.codegraph/`, no versionado) — útil antes de editar.
