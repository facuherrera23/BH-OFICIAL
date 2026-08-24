# Análisis Exhaustivo de Errores y Bugs — BIENENHAUS PROPIEDADES

**Fecha:** 2026-08-23 (verificado en código, línea por línea)
**Alcance:** admin-app.js, landing-app.js, tasacion.html, admin.html, index.html, supabase edge functions, CSS, utils
**Total original:** 127 issues · **Fijados:** ~95 · **Pendientes:** ~32 (Medio) + 8 Bajo intencionales

---

## Resumen por Severidad

| Severidad | Original | Fijados | Pendientes |
|-----------|----------|---------|------------|
| **Crítico** | 8 | 8 | **0** |
| **Alto** | 23 | 23 | **0** |
| **Medio** | 48 | ~32 | ~16 |
| **Bajo** | 48 | ~40 | ~8 (intencionales) |

> Los 5 items que figuraban como "ALTO pendientes" (timeout mlApiCall, searchCache TTL,
> mlBtnHtml/configPanelHtml comillas, ML_FUNCTIONS_BASE guard) fueron verificados en el
> código y **ya están resueltos**. La versión anterior de este doc los listaba por error.

---

## VERIFICADOS FIJADOS — Crítico (8/8)

| Issue | Evidencia en código |
|-------|---------------------|
| Join Supabase inválido `leads!inner` | `.select('*, leads(id, full_name, stage)')` sin `!inner` |
| `renderCalendar(calVisitsCache)` argumento ignorado | Firma acepta parámetro con default al cache global |
| `async` event listener en `heroBgFile` | Función regular + IIFE interna async |
| Nominatim sin rate limiting ni cache (`tasacion.html`) | Cache en memoria + throttle 1.1s |
| `leads.toSorted()` ES2023 (dashboard y agentes) | `[...arr].sort(...)` |
| `cmsData = {}` antes de declaración `let` | Asignación previa eliminada |
| Double query + double FormData en `saveVisit` | Consolidado a una query/una carga |
| Sintaxis rota IIFE (panel quedaba en loading) | `node --check` OK · panel funcional |

---

## VERIFICADOS FIJADOS — Alto (23/23)

### admin-app.js

| Issue | Evidencia |
|-------|-----------|
| `mlApiCall` timeout hardcoded | `ML_API_TIMEOUT_MS = 15000` + AbortController + `clearTimeout` (`admin-app.js:2780-2809`) |
| `_searchCache` sin TTL ni invalidación | `SEARCH_CACHE_TTL_MS = 5min`, `_searchCacheExpiresAt`, `invalidateSearchCache()` con 7 callers (`admin-app.js:3884-3912`) |
| `mlBtnHtml` comillas anidadas rotas | Template literal correcto (`admin-app.js:2639-2643`) |
| `configPanelHtml` comillas problemáticas | Template literal correcto (`admin-app.js:2647-2660`) |
| `ML_FUNCTIONS_BASE` puede ser undefined | IIFE con throw temprano si falta `BH_CONFIG.SUPABASE_URL` (`admin-app.js:2774-2778`) |
| `mlDisconnect` limpieza incompleta | Limpia `ml_user`, `ml_listings`, `ml_connected`, `ml_configured` |
| `mlPublishProperty` sin validación | Fotos>=3, desc>100 chars, zone, price_usd, broker_id |
| `mlConfigGet`/`mlConfigSave` session null | Guard `!session \|\| !session.access_token` (`admin-app.js:2976`) |
| `_pendingSendTempId` sin cleanup | Reset en `loadChatRedes` + `closeModal` |
| `setupRealtime` canales duplicados | Unsubscribe previo + null check |
| `markRead` llama `getSession()` dos veces | Consolidado a una llamada |

### landing-app.js

| Issue | Evidencia |
|-------|-----------|
| Fail-closed sin UI de error | Banner visible + botón recargar (`landing-app.js:305`) |

### supabase/functions/_shared/ml.ts

| Issue | Evidencia |
|-------|-----------|
| Cache credentials sin invalidación | `cachedCredentials` + `CREDENTIALS_TTL_MS=30s` + `invalidateMlCredentialsCache()` exportada |
| CAS race condition en refresh token | Refresh serializado |
| `fileName` undefined | Fallback aplicado |
| `callbackUrl` sin validación HTTPS | Validación agregada |
| Fetch sin timeout | `fetchWithTimeout()` helper con AbortController (`_shared/ml.ts:17-29`) |

### supabase/functions/zernio-proxy

| Issue | Evidencia |
|-------|-----------|
| 429 retry sin límite | Retry acotado con máximo configurado |
| Plataformas hardcodeadas | `PLATFORMS_CONFIG` lee env `ZERNIO_VALID_PLATFORMS` con default (`index.ts:215-218`) |
| Upsert duplica con id autogenerado | `upsert(..., { onConflict: 'zernio_account_id' })` (`index.ts:247`) |

---

## PENDIENTES — Medio (~16)

### admin-app.js

| Issue | Línea aprox. |
|-------|--------------|
| Dos queries separadas para `oldStatus`/`oldLeadId` en cambio de stage | 1319 |
| `thead.querySelector` puede devolver null | 1042 |
| `tbody.innerHTML` sin mensaje cuando no hay datos | 2227 |
| `formatPrice` definido después de uso (hoisting ok, pero confuso) | 568 |
| `l.property_id` puede ser null en render de leads | 874 |

### landing-app.js

| Issue | Línea aprox. |
|-------|--------------|
| `dataset.type` fallback undefined | 459 |
| `safeUrl` permite `mailto:`/`tel:` dentro de iframe de video | 591 |
| Newsletter envía `full_name: ''` vacío | 794 |

### tasacion.html

| Issue | Línea aprox. |
|-------|--------------|
| `extractFromUrl` depende de `api.allorigins.win` (proxy tercero) | 853 |
| `renderAnalisisComparativo` destruye/recrea Chart.js cada render | 1166 |
| `acChartInstance.destroy()` sin null check / Chart global asumido | 1166 |
| `photoDataUrl` global mutable | 1254 |
| `buildPropiedadQuery` concatena sin sanitizar | 1293 |
| `leafletMapInstance` global mutable | 1347 |
| `init()` async llamada sin await | 1446/1485 |

### Edge functions

| Issue | Archivo |
|-------|---------|
| `attachment: unknown` tipo any en upsert mensajes | zernio-proxy:320 |
| `atob` falla con base64 URL-safe | _shared/crypto.ts:9 |
| Salt fijo `'bienenhaus-ml'` para derivación | _shared/crypto.ts:33 |

---

## BAJO — RESUELTOS (sesión 2026-08-23/24)

- ✅ **Mojibake `index.html`** — doble-encoding cp1252 (~101 reemplazos: `Ã¡`→á, `â€"`→—, `â˜…`→★, etc.). Verificado en DOM vía Playwright: título, metas SEO y textos visibles correctos. Backup: `index.html.bak-mojibake`
- ✅ **Favicon 404** — `favicon.ico` copiado a raíz (`/favicon.ico` → 200 OK)
- ✅ **Checkboxes estilo viejo** (`admin.html`) — `exclusive` y `no_email` convertidos a `.pf-toggle` (mismo patrón que formulario de propiedades; render verificado: píldora 56×32px). El checkbox nativo del login se mantiene (intencional)
- ✅ **`onclick="this.select()"` inline** — removido; reemplazado por `addEventListener` en `admin-app.js`
- ✅ **`preferred_contact` valor `telefono` → `phone`** — normalizado (0 filas en `owners`, cambio seguro)
- ✅ **17 `console.log('[BH]…')` de debug** eliminados de `admin-app.js`
- ✅ **`full_name: ''` en newsletter** — ahora `'Suscriptor Newsletter'` (valor semántico en `leads`)
- ✅ **Banner de error con `innerHTML` + `onclick` inline** — reescrito con DOM APIs (`landing-app.js`, detectado por react-doctor)
- ✅ **`aria-expanded` mobile menu** — ya estaba implementado (entrada obsoleta del doc anterior)

## PENDIENTES — Bajo restantes (~8, postergados/intencionales)

- ⏸️ **Refactors de helpers**: consolidar `debounce`/`formatRelativeTime`/`formatPrice` en `utils.js` — divergencias INTENCIONALES documentadas (admin muestra `-` vs landing `Consultar precio`; formato compacto chat vs verbose notificaciones)
- ⏸️ **Extraer closure inline `matches`** (`admin-app.js:4158`) — 1 línea, no justifica el churn
- ⏸️ **Tests unitarios** para `recalcAll`/`coefCondicionesFor`/`getAccessToken` — requiere infraestructura de tests (proyecto separado)
- ⏸️ **Migración gradual TS** — proyecto de infraestructura, fuera del alcance de bug-fixing

---

## Archivos con más issues (estado actual)

| Archivo | Pendientes |
|---------|------------|
| `tasacion.html` | ~8 (medios) |
| `admin-app.js` | ~5 medios + bajos |
| `landing-app.js` | ~3 medios + bajos |
| `supabase/functions/` | ~3 medios + bajos |
| `index.html` / `admin.html` | bajos |

---

## Métricas

| Métrica | Valor |
|---------|-------|
| Progreso total | ~75% (95/127) |
| Críticos pendientes | **0** |
| Altos pendientes | **0** |
| Medios pendientes | ~16 |
| Verificación sintaxis | `node --check admin-app.js` OK · `node --check landing-app.js` OK |
| react-doctor | 100/100 |

---

*Actualizado: 2026-08-23/24 — sesión de reparación de ítems Bajo (mojibake, favicon, toggles,
console.logs, consistencia DB). QA: Playwright DOM+visual, consola sin errores, react-doctor 100/100.*
