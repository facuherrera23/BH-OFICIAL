# BASELINE — Security Remediation Sprint (2026-08-22)

> Registro inmutable del estado ANTES de las modificaciones de este sprint.
> Regla aplicada: EVIDENCIA > SUPOSICIONES. Todo verificado por ejecución/contenido real.

## 1. Topología del repositorio (verificada)

| Ítem | Evidencia |
|---|---|
| Git repo raíz | `C:\...\Landing Page\BH-OFICIAL` (`git rev-parse --show-toplevel`) |
| Directorio de trabajo | `BH-OFICIAL-main- semi funcional\BH-OFICIAL-main` — **UNTRACKED** en el repo (`?? ../` en git status) |
| Commits totales | 13 (`b2e9cab` → `cfd9dc6`, HEAD = `cfd9dc6`) |
| Commits reclamados por el prompt (`066c8ee`, `00aa81d`, `a4d68a1`, `422180e`, `8c4d46e`) | **NO EXISTEN** en `git log --all` (búsqueda con Select-String: 0 resultados) |
| Docs de auditoría previa | `Landing Page\INVENTORY_AND_PLAN.md` + `Landing Page\RELEASE_CANDIDATE_AUDIT_REPORT.md` (un nivel arriba del repo) |
| Copia paralela | Repo raíz tiene su propia copia trackeada de index/admin/assets (MÁS VIEJA: mtimes 2026-08-20 vs 2026-08-21) + monorepo TS `/landing` NO deployado |

**Decisión de fuente de verdad:** el directorio actual (`semi funcional/BH-OFICIAL-main`). Razones:
1. mtimes más nuevos en TODOS los archivos (21:06 del 21-08 vs 20-09 del 20-08)
2. Única copia con `tasacion.html` presente
3. Tamaños coinciden con lo auditado (admin-app.js ~93KB, tasacion.html ~72KB)

## 2. Toolchain

| Componente | Versión / Estado |
|---|---|
| Node | v24.18.0 |
| npm | 11.16.0 |
| package.json | **NO EXISTE** en la app vanilla (0 en todo el árbol) |
| Scripts npm | N/A |
| Lint | N/A (sin config) |
| Typecheck | N/A (JS vanilla sin tipos) |
| Build | N/A (sitio estático sin build step) |
| Tests | **0 tests** (sin framework) |
| CI/CD | **AUSENTE** (no existe `.github/` en el repo) |
| PWA | manifest.json ❌ · service worker ❌ · solo `assets/images/pwa-512x512.png` huérfano |

## 3. Checks baseline ejecutados

```
node --check assets/js/admin-app.js     PASS
node --check assets/js/landing-app.js   PASS
node --check assets/js/config.js        PASS
node --check assets/js/supabase-client.js PASS
node --check assets/js/cloudinary.js    PASS
```

Lint/typecheck/build/tests/E2E: **N/A** (infraestructura no existía al baseline).

## 4. Estado de seguridad — fixes previos VERIFICADOS POR CONTENIDO

Aunque los commits reclamados no existen, las correcciones SÍ están presentes en esta copia:

| Fix | Verificación | Evidencia |
|---|---|---|
| P0 sintaxis | ✅ PASS | `node --check` x5 archivos |
| P0 `_submitting*` duplicados | ✅ RESUELTO | 1 declaración c/u: L16/L17/L18 (+Lead L731, +Visit L864) |
| P0 `urlParams` duplicado | ✅ RESUELTO | Solo L692 en tasacion.html |
| P1-001 auth fail-open | ✅ FAIL-CLOSED | admin-app.js L88-93: `currentProfile=null` + toast + `signOut()` a 2s |
| P1-002 postMessage | ⚠️ PARCIAL | Whitelist `ALLOWED_ORIGINS` en tasacion.html L673+ y `targetOrigin` explícito en admin-app.js L1850; **PERO** tasacion.html L658 aún envía `{type:'tasaciones-back'}` con `targetOrigin='*'` |

## 5. Superficie XSS (baseline)

Conteo de líneas con sinks peligrosos:

| Archivo | innerHTML | setAttribute | eval/new Function/document.write/setTimeout-str | esc() disponible |
|---|---|---|---|---|
| index.html | 0 | 0 | 0 | ❌ |
| admin.html | 1 | 0 | 0 | ❌ (via admin-app.js) |
| tasacion.html | 13 | 0 | 0 | ❌ |
| landing-app.js | 12 | 3 | 0 | ❌ **(0 usos)** |
| admin-app.js | 49 | — | 0 | ✅ def L20, 30 usos |

Vectores críticos identificados en inspección inicial:
- landing-app.js L332/L436: datos Supabase interpolados sin escape
- admin-app.js L446-447: `ml_listing_id` (**fuente externa Mercado Libre**) dentro de onclick JS-context
- admin-app.js L1489: `ml_nickname` (externo ML) sin escape
- admin-app.js L1900: doble contexto roto (`esc()` + `replace(/'/g)` se neutralizan → payload con `'` rompe string JS en atributo)
- Campos status/stage sin escapar: L361, L381, L443-444

## 6. Rate limiting (baseline)

- App vanilla: **SIN rate limiting** (0 matches en todos los archivos).
- Monorepo `/landing/supabase/functions/_shared/rate-limit.ts`: **FAIL-OPEN confirmado** — L66-70: en error DB hace `return { allowed: true, remaining: config.requests }`.

## 7. CSP (baseline)

Ausente en las 3 páginas. Recursos reales descubiertos:

| Categoría | Dominios |
|---|---|
| script-src | self, cdn.jsdelivr.net (supabase-js@2, chart.js@4.4.0), unpkg.com (leaflet@1.9.4 solo tasacion) |
| style-src | self, fonts.googleapis.com, cdnjs.cloudflare.com (Font Awesome 6.5.1 con integrity en index), inline `<style>`/style="" masivos |
| font-src | fonts.gstatic.com, cdnjs.cloudflare.com (webfonts FA) |
| img-src | self, data: (favicon admin), res.cloudinary.com, images.unsplash.com, {s}.tile.openstreetmap.org |
| connect-src | rnldqiwwzhjnurkguihu.supabase.co (https+wss), api.cloudinary.com, nominatim.openstreetmap.org |
| frame-src | self (iframe tasaciones en admin) |
| Inline handlers | admin.html: 4 onclick · tasacion.html: 2 onclick (+ dinámicos creados por JS en admin-app.js/tasacion.html) |

## 8. Score ANTES (según auditoría previa del usuario)

| Categoría | Score |
|---|---|
| Funcionalidad Core | 90/100 |
| Seguridad P0/P1 | 95/100 |
| Seguridad Gaps | 45/100 |
| Testing | 20/100 |
| Accesibilidad/UX | 55/100 |
| DevOps/Producción | 40/100 |
| **TOTAL ponderado** | **72/100** |

## 9. Fixes aplicados en este sprint (2026-08-22)

Infra nueva:
- **`assets/js/utils.js`** — `BHUtils`: `esc`, `escAttr`, `safeUrl` (bloquea `javascript:`/`data:`), `safeImageUrl`, `safeCssUrl`. Smoke test PASS. Export CommonJS para tests futuros.
- Cableado `<script src="assets/js/utils.js?v=1">` ANTES de config.js en index.html (L742), admin.html (L1035), tasacion.html (L16).

**landing-app.js** (12 innerHTML + 3 setAttribute → 0 sinks sin proteger):
- Fail-closed: si `BHUtils` no está, el IIFE no renderiza.
- renderProperties/renderTeam/injectVideoIframe/contacto/footer/hero/stats: todo dato dinámico por `esc/escAttr/safeImageUrl/safeUrl/safeCssUrl`; hrefs tel:/mailto: con escAttr.

**tasacion.html:**
- `ALLOWED_ORIGINS` += propio origen; envío `tasaciones-back` con `targetOrigin=window.location.origin` (ya no `'*'`).
- onclick removeComparable → delegación data-remove-id; onerror de logos → listeners JS con fallback SVG/hide.
- bindPopup/chips escapados vía `_bhEsc` (wrapper fail-closed de BHUtils). Sin handlers inline residuales.

**admin-app.js** (16 ediciones, node --check PASS):
- ML: badge status, `ml_listing_id`, `ml_nickname` — externos ML ya no van a onclick/HTML crudo; botones ML → `data-*` + delegación en #propertiesTableBody.
- Doble contexto roto L1900 eliminado: botones tasaciones → `data-open-tasacion`/`data-del-tasacion` + delegación en #tasacionesTableBody.
- postMessage token iframe: targetOrigin `SUPABASE_URL` → `window.location.origin` (bug funcional: el token nunca llegaba al iframe).
- Texto escapado: v.status x2, l.stage, p.status, roleLabels, cbu slice, thumb/preview/photo_url URLs, hidden input value.
- Búsqueda global y preview-remove: handlers inline migrados a clases + delegación (hover preservado via mouseover/mouseout).
- Restantes `onclick='...id'` usan solo UUIDs de columnas uuid de Postgres (safe-by-construction) o constantes PORTALS internas.

Verificación final: `node --check` PASS x3 JS · grep residual: 0 handlers inline peligrosos · utils cableado en las 3 páginas.

Follow-ups recomendados (no bloqueantes): CSP meta (requiere refactor de inline styles/scripts masivos), rate limiting server-side, monorepo /landing fail-open.
