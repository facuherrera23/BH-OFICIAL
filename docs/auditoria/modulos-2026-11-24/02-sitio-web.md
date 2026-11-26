# Auditoría crítica de módulos — 02: Sitio Web (CMS y captación)

**Fecha:** 2026-11-24
**Alcance:** editor CMS del panel (`admin-cms.js`), consumidor público (`landing-app.js`), privacidad/captación (`wa-handoff.js`, `tracking.js`, `analytics.js`, `cookie-banner.js`), endpoints públicos (`contact-submit`, `track-event`), generador de fichas/hub (`scripts/generate-ficha.mjs`), CSP y datos reales de `site_content` / `app_settings`.
**Método:** lectura de código + consultas SQL **sólo lectura** a producción (`rnldqiwwzhjnurkguihu`) + revisión de los specs existentes. **No se modificó código, datos, permisos ni se desplegó nada.** Es el paso 2 de la auditoría pedida; no se avanza al siguiente módulo sin instrucción explícita.

---

## 1. Resumen ejecutivo

El frente público **sí está bien instrumentado** (medición first-party sin cookies, handoff de WhatsApp con consentimiento, GA/Clarity correctamente gateados, sanitizador de HTML rico estricto, CSP con el beacon de Cloudflare). La parte **rota es el editor CMS del panel**: escriba lo que escriba el usuario en Servicios, Proceso, Navbar, Formulario o Footer, **el sitio público no cambia**, porque el editor y el landing usan nombres de clave distintos para los mismos datos. Es el mismo tipo de bug que ya costó caro en este proyecto ("código escrito contra columnas/tablas imaginarias"), pero en JSONB en vez de SQL: silencioso, porque nadie lee `result.error` y no hay ni un test del editor.

Además, el botón **"Reinicio Global"** borra las 12 secciones reales de `site_content` sin copia previa y sin restaurar defaults en la DB. Es una pérdida de datos irreversible, en producción, con un `confirm()` nativo y un `prompt()` como única barrera.

| # | Severidad | Hallazgo | ¿Riesgo real? |
|---|-----------|----------|---------------|
| A | **P1** | Desconexión de esquema editor↔landing: el CMS guarda `servicios_items` / `proceso_pasos` / `navbar_items` / `form_options` / `footer_*`; el landing lee `items` / `steps` / `mobile_items` / `options` / `links`. **Cualquier edición de esas secciones no se refleja en el sitio.** | Sí, confirmado contra datos reales |
| B | **P1** | `globalResetCMS()` hace `DELETE` de **todas** las filas de `site_content` sin copia; `populateCMSFieldsWithDefaults()` sólo rellena inputs, no vuelve a insertar en DB | Sí, pérdida irreversible |
| C | **P2** | `hero_desc` existe en el editor y se guarda en `hero.description`, pero el landing **nunca lee** `c.description` en el case `hero` (usa `c.subtitle`) | Sí, campo muerto |
| D | **P2** | `cmsPopulateNested()` está declarada dos veces: la segunda gana y busca las claves equivocadas → las listas del editor aparecen **vacías** aunque haya datos | Sí, consecuencia de A |
| E | **P2** | `renderCatalogFilters()` y otros 5 helpers de render están definidos y **nunca se llaman**; los filtros del catálogo editables en el CMS no llegan al sitio | Sí, código muerto funcional |
| F | **P3** | `loadCMSContent()` con `.limit(50)` (hoy 12 filas) — truncamiento silencioso latente | No hoy, sí al crecer |
| G | **P3** | Guardados con `Promise.all` por sección: fallo parcial deja estados a medias (se auto-repara porque el dirty flag queda prendido) | Bajo |
| H | **P3** | `confirm()`/`prompt()` nativos, textos con `??`/`?` en vez de emoji (mojibake), `enableTracking()` muerto en el banner de cookies | Estético / consistencia |

**Ninguno de estos hallazgos fue corregido en este informe.**

---

## 2. Inventario verificado

### Código del editor (panel)
- `assets/js/admin-cms.js` — 37.132 bytes, 759 líneas. IIFE, helper vía `window.__BH`. Dos bloques: editor CMS (L9-513) y Configuración General (L543-759).
- `admin.html` — sección `tab-sitio-web` en L751; ~106 campos `cms-field`, contenedores `cmsServicesItems` (L974), `cmsProcessSteps` (L1051), `cmsNavbarItems` (L1206), etc. Ordén de carga: `admin-app.js?v=701` → `admin-usuarios.js?v=11` → `admin-cms.js?v=6` → `admin-portales.js?v=38` (L3608-3625).

### Código del sitio público
- `assets/js/landing-app.js` — 91.279 bytes, 2181 líneas. IIFE. `loadCMSContent()` (L1603) → `applySectionContent()` (L1748) → helpers de render (L2005+). Hay una **segunda familia** de helpers sin llamar en L840-1010.
- `assets/js/utils.js` — `sanitizeRichText()` (L92-99): escapa todo y re-habilita exactamente `<span class="highlight">`, `</span>` y `<br>`. **Seguro**, verificado.
- `assets/js/wa-handoff.js` (260 líneas), `tracking.js` (197), `analytics.js` (97), `cookie-banner.js` (84).
- `scripts/generate-ficha.mjs` (73.582 bytes, 1105 líneas) — fichas, hub `/propiedades.html`, sitemap, `canal-videos.json`, `property-videos.json`, CSP propia.
- `index.html` → `assets/js/config.js?v=386` (`SUPABASE_URL` sin slash final, OK).

### Endpoints públicos
- `supabase/functions/contact-submit/index.ts` — `kind: contact|newsletter|whatsapp`, rate limit 5/h por IP, honeypot `website`, dedup 60 días, SLA vía `ensureFirstContactTask`. En `NO_VERIFY` (lo llama el visitante).
- `supabase/functions/track-event/index.ts` — whitelist de **18** eventos (no 17), validación estricta de `page`/`property_code`/`session_id`, rate limit 60/min, `verify_jwt:false` en `NO_VERIFY`. Sin PII.

### Tests existentes
- `tests/landing.spec.js` (8 tests): catálogo, búsqueda, formulario presente, CSP, pills, H2, sección Nosotros. **Ninguno exercise el editor CMS ni un override de `site_content` sobre el HTML estático.**
- `tests/captacion-medicion.spec.js`, `tests/wa-handoff.spec.js`, `tests/seo-estatico.spec.js`, `tests/functions-deploy.spec.js`, `tests/lead-origins.spec.js`.
- `grep` por `servicios_items|proceso_pasos|cmsPopulateNested|cmsSaveBtn|globalResetCMS` en `tests/` → **0 coincidencias**. El editor CMS no tiene ni un guard.

---

## 3. Estado real de los datos (sólo lectura)

`site_content` tiene **12 filas** (ninguna llamada `nosotros`):

| section_key | bytes | updated_at |
|---|---|---|
| catalog | 389 | 2026-09-18 |
| contact | 1095 | 2026-10-11 |
| footer | 1178 | 2026-10-11 |
| form | 1410 | 2026-09-18 |
| hero | 1754 | 2026-09-18 |
| navbar | 1167 | 2026-09-18 |
| process | 1301 | 2026-08-29 |
| seo | 913 | 2026-09-18 |
| services | 1892 | 2026-09-18 |
| social | 284 | 2026-10-16 |
| stats | 867 | 2026-09-18 |
| team | 163 | 2026-08-29 |

Claves reales dentro del JSONB: `services.items`, `process.steps`, `navbar.items` + `navbar.mobile_items`, `form.options` + `form.fields`, `footer.links.{services,navigation}`, `catalog.{badge,title,highlight,cta_text,cta_url,filters,operations,prices,types}`.

Ejemplo real (`services.content->'items'->0`):
```json
{"id":"serv_1","icon":"fa-home","order":1,"title":"Venta de Propiedades",
 "enabled":true,"link_url":"#contacto","link_text":"Saber más",
 "description":"Estrategia de marketing digital, fotos profesionales y publicación en los principales portales…"}
```
Ejemplo real (`process.content->'steps'->0`): `id`, `icon`, `order`, `title`, `number:"01"`, `enabled:true`, `description`.

Policies de `site_content` (verificadas): SELECT público `true`; INSERT/UPDATE/DELETE sólo `super_admin`. `app_settings`: SELECT `true`, UPDATE sólo `super_admin`.

---

## 4. Hallazgos

### A. P1 — El editor escribe claves que el sitio no lee

**Evidencia — editor** (`admin-cms.js:87-96, 327-354`):

```js
const CMS_NESTED_SCHEMAS = {
  services_items: [... { key: 'desc' } ...],
  proceso_pasos:  [... { key: 'num' }, { key: 'desc' } ...],
  navbar_items: [...], navbar_mobile_items: [...],
  form_options: [...], form_fields: [...],
  footer_nav_links: [...], footer_service_links: [...],
  nosotros_valores: [...],
};
const nested = {
  servicios_items: cmsItemsPack('cmsServicesItems', ['icon','title','desc']),
  proceso_pasos:   cmsItemsPack('cmsProcessSteps', ['num','title','desc']),
  ...
};
for (const [k, items] of Object.entries(nested)) {
  if (!items.length) continue;
  updatesBySection[SECTION_TO[k]][k] = items;   // ← escribe content.servicios_items, etc.
}
```

**Evidencia — landing** (`landing-app.js:1784, 1831, 1860, 1923-1927, 1959-1964, 1991-1996`):

```js
if (c.items  && Array.isArray(c.items))  renderServicesItems(c.items);
if (c.steps  && Array.isArray(c.steps))  renderProcessSteps(c.steps);
if (c.items  && Array.isArray(c.items))  renderStatsItems(c.items);
if (c.nav_links && Array.isArray(c.nav_links))        renderFooterNavLinks(c.nav_links);
if (c.service_links && Array.isArray(c.service_links)) renderFooterServiceLinks(c.service_links);
if (c.mobile_items && Array.isArray(c.mobile_items)) renderNavbarItems(c.mobile_items,'mobile');
if (c.options && Array.isArray(c.options)) renderFormOptions(c.options);
if (c.fields && Array.isArray(c.fields))   renderFormFields(c.fields);
```

**Confirmado en producción:** `services.content` tiene `items`, **no** `servicios_items`; `process.content` tiene `steps`, **no** `proceso_pasos`; etc. El editor guarda en claves nuevas que el landing ignora → **el usuario ve "Guardado correctamente" y el sitio queda igual**.

Agrava el problema: `cmsItemsPack()` (L207-219) sólo recolecta las subclaves declaradas (`icon/title/desc`, `num/title/desc`). Al grabar un item nuevo se pierden `id`, `order`, `enabled`, `link_url`, `link_text` — campos que sí existen en los datos reales y que los render usan (`enabled`, `order`, `link_url`, `link_text`). Y el `if (!items.length) continue` (L350) hace **imposible vaciar una lista** desde el editor.

**Impacto:** las secciones Servicios, Proceso, Navbar, Formulario y Footer del CMS son decorativas. Sólo `nosotros_valores` coincide con el nombre real (aunque hoy no hay fila `nosotros`).

**Recomendación (no ejecutada):** unificar en un solo mapa canónico editor↔landing con las claves reales (`items`, `steps`, `mobile_items`, `options`, `fields`, `links.nav_links`, `links.service_links`) y los subcampos reales (`description`, `number`, `order`, `enabled`, `id`, `link_url`, `link_text`). Normalizar en ambos lados (editor escribe y lee el mismo esquema) y agregar un test behavioral: cargar `site_content` real en un harness, editar un item, guardar, verificar que el DOM del landing cambia. No migrar datos: las filas reales ya tienen el esquema correcto; hay que adaptar el editor a ellas, no al revés.

---

### B. P1 — "Reinicio Global" borra todo el CMS sin copia

**Evidencia** (`admin-cms.js:439-496`):

```js
const { error } = await window.supabaseClient
  .from('site_content')
  .delete()
  .neq('id', '00000000-0000-0000-0000-000000000000');
...
populateCMSFieldsWithDefaults();
```

`DEFAULT_CMS_CONTENT` (L411-437) **sólo rellena inputs del panel** (`populateCMSFieldsWithDefaults`, L498-508): no hace `insert` en `site_content`. Después del delete, la DB queda vacía y la landing cae al HTML estático; el panel muestra valores de fábrica que no están persistidos. No hay copia previa en tabla de archivo ni en `audit_log`, contra la doctrina del proyecto ("nada se borra sin copia"). Las 12 filas reales (algunas con contenido de 2026-08) desaparecen sin recuperación.

Agrava: la única barrera son `confirm()` / `confirm()` / `prompt()` nativos (L440, 448, 456) — el mismo patrón que el panel prohíbe en el módulo Contenido (`window.__BH.showConfirmDialog` / `showInputPrompt`). Los strings tienen mojibake (`'?? REINICIO GLOBAL DE CMS'`, `'? CMS reiniciado…'`).

**Impacto:** pérdida irreversible de todo el contenido editable del sitio, en producción, por un botón visible en el panel.

**Recomendación (no ejecutada):** antes del delete, copiar `site_content` completo a una tabla de archivo (o al menos a `audit_log` con el JSON) y **re-insertar** los defaults en DB; Ideal: reemplazar el botón por un flujo con `showConfirmDialog` + `showInputPrompt` y un guard de test que falle si aparece `.from('site_content').delete()` sin copia previa en el mismo handler.

---

### C. P2 — `hero_desc`: campo del editor que el sitio ignora

**Evidencia:**
- `admin-cms.js:38`: `hero_desc: { section: 'hero', path: 'description' }` → el guardado escribe `hero.description`.
- `admin.html:867`: `<textarea id="cms_hero_desc" class="cms-field" data-key="hero_desc">`.
- `landing-app.js:1753-1776`: el case `hero` usa `c.title`, `c.subtitle` (en `.hero-desc`), `c.eyebrow`, `c.bg_image_url`, `c.cta_*`, `c.video_*`. **Nunca lee `c.description`.**

El usuario edita "Descripción del hero", ve el toast de guardado, y el texto de la home no cambia. Es el mismo patrón de los bugs de columns imaginarias, pero dentro del JSONB.

**Recomendación:** o bien el landing aplica `c.description` a `.hero-desc` (y `c.subtitle` pasa a ser el legacy), o bien se elimina el campo del editor. Agregar guard estático que verifique que todo `path` del `CMS_FIELD_MAP` sea leído por `applySectionContent()`.

---

### D. P2 — `cmsPopulateNested()` declarada dos veces; la segunda gana

**Evidencia** (`admin-cms.js:99-130`): la primera versión usa un `SECTION_KEYS` estricto (`services_items → services`, etc.); la segunda —la efectiva en JS por hoisting de function declarations— itera **todas** las secciones buscando `sec.content[key]`. Como las claves reales son `items`/`steps`/`options`…, las listas del editor cargan **vacías** aunque la DB tenga 4 servicios y 5 pasos.

Es la contracara de A: el editor ni muestra lo que hay ni escribe donde se lee. Los botones "Agregar" (`cmsAddServiceBtn` etc., L221-260) usan subclaves `desc`/`num`, distintas de `description`/`number`, por lo que incluso los items nuevos saldrían sin texto en el sitio si la clave de sección se arreglara.

**Recomendación:** borrar la primera declaración (o la segunda, según qué comportamiento se quiera) y dejar **una sola** función con el mapa canónico del hallazgo A. Guard: `node --check` no detecta duplicados, hace falta un test que cuente declaraciones por nombre.

---

### E. P2 / P3 — Helpers de render huérfanos (catálogo y otros)

`grep` de llamadas en `landing-app.js` muestra que estas funciones están **definidas pero nunca invocadas**:

- `renderCatalogFilters()` (L975) — los `filters/operations/types/prices` de `catalog.content` (sí existen en DB) **no se aplican** a los `<select>` de búsqueda. El case `catalog` (L1967-1976) sólo aplica badge/título/CTA.
- `renderTrustBlock()` (L852), `renderFeatureBar()` (L862), `renderTeamMembers()` (L894), `renderStatsCTA()` (L932), `renderCommitment()` (L961), `renderMobileNavbarItems()` (L996).

Además hay **dos copias** de `renderServicesItems` (L880 y L2005), `renderProcessSteps` (L947 y L2020) y `renderStatsItems` (L918 y L2035); gana la segunda (L2005+), que es la consistente con el esquema real (`description`, `number`, `value_key`). Las primeras son código muerto con esquema distinto (`stat-value`/`stat-label` contra `stat-card-number`/`stat-card-title`). Es deuda técnica con riesgo: quien edite la primera copia creerá que cambió el sitio.

**Recomendación:** conectar `renderCatalogFilters(c.filters)` en el case `catalog`, borrar las 3 copias muertas y decidir si los otros 5 helpers se conectan o se eliminan.

---

### F. P3 — `.limit(50)` en la carga del CMS

`landing-app.js:1603-1618`:
```js
.from('site_content').select('section_key, content').limit(50);
```
Hoy hay 12 filas, así que no trunca. Es el mismo error de doctrina que el `.limit()` del Dashboard (AGENTS.md): en cuanto se agreguen secciones (por ejemplo `nosotros`, `zernio`, nuevas zonas) la carga se corta **en silencio**, sin error, y esas secciones nunca se aplican. `admin-cms.js:68-70` usa `.select('*')` sin límite, así que el editor y la landing pueden divergir.

**Recomendación:** sacar el `.limit(50)`. Si se quiere acotar, usar select explícito de columnas, nunca recorte de filas.

---

### G. P3 — Guardados parciales por `Promise.all`

Tanto `cmsSaveBtn` (`admin-cms.js:376-397`) como `cfgSaveBtn` (`:671-702`) hacen `Promise.all` sobre varias secciones. Si una falla (RLS, red), las demás ya se escribieron y el toast dice "Error al guardar" — el usuario cree que no se guardó nada. En el CMS el `_cmsDirtyFields` queda prendido, así que un reintento vuelve a escribir todo: se auto-repara. En CFG, `_cfgDirty` también queda prendido. Riesgo bajo, pero el feedback es engañoso.

**Recomendación:** reportar qué secciones se guardaron y cuáles fallaron, o hacer las escrituras secuenciales con rollback compensatorio (más complejo; probablemente no valga la pena para 12 filas).

---

### H. P3 — Detalles de higiene

- `cookie-banner.js:23-34` — `enableTracking()` busca `script[data-bh-tracking][type="text/plain"]`; **no existe ninguno** en el repo (`grep` 0 coincidencias). `analytics.js` ya inyecta GA/Clarity por consentimiento. Código muerto, sin consecuencia.
- `analytics.js:106` — `window.clarity('event', name)` descarta `params`; GA4 sí los recibe. Si se quiere consistencia, hay que mapear los params al formato de Clarity.
- `wa-handoff.js:272-273` — `e.preventDefault()` es incondicional aunque `openModal(a)` pueda retornar `false` (href vacío). En ese caso el link queda muerto. Caso raro.
- `admin-cms.js:440-452, 489, 532` — mojibake en los strings (`??`, `?`, `Cloudinary ?`). No rompe nada, pero se ve en la UI.
- `app_settings.preferences` guarda `{ usd_rate }` reemplazando el objeto completo (`admin-cms.js:697-701`): si en el futuro `preferences` tiene otras claves, se pierden. Hoy sólo tiene `usd_rate`.

---

## 5. Lo que se verificó y **no** es hallazgo

- **Privacidad de la medición:** `tracking.js` no escribe cookies; `session_id` va en `sessionStorage`; `referrer` se recorta a origen+ruta; en localhost no se manda nada salvo el flag explícito; opt-out con `localStorage.bh_track_optout`. `track-event` valida whitelist de 18 eventos, `page`, `property_code` (regex estricta `^[A-Z]{2}-P[0-9]{4}$`) y `session_id` (UUID). No hay PII en `page_events`.
- **`sanitizeRichText()`:** escapa `&` y `<`/`>` antes de re-habilitar tres secuencias exactas. No hay vector de XSS por el CMS en títulos/descripciones.
- **GA4/Clarity:** cargan **sólo** con `localStorage.bh_cookie_consent === 'all'` (`analytics.js:16-50`). Cumple el gate de la AAIP. Cloudflare Insights es anónimo y va aparte (beacon verificado en todas las páginas).
- **Handoff de WhatsApp:** el chat se abre **antes** del POST (popup blocker), el botón "Prefiero no dejar mis datos" no frena la conversión, `wa_click` se trackea una sola vez por link, `contact-submit` exige `consent:true` y teléfono ≥8 dígitos. Correcto.
- **Globals del panel:** `canManageUsers()` (usado en `admin-cms.js:565`) **sí existe** como global: `admin-usuarios.js:754` define `window.canManageUsers` con un getter que devuelve la función. `ml_connected`/`ml_configured` y `currentUser`/`currentProfile` también son accessors en `admin-app.js` (L5166-5202). No hay `ReferenceError`. Descartado.
- **RLS:** `site_content` y `app_settings` tienen SELECT público (necesario para la landing) y escritura restringida a `super_admin`. Correcto.
- **CSP:** la home, las fichas y el hub incluyen `'self'` en `connect-src` (beacon `/cdn-cgi/rum`) y `static.cloudflareinsights.com` en `script-src`/`connect-src`. Correcto según los guards existentes.

---

## 6. Cierre y siguiente paso

El módulo de **captación y medición** está en buen estado; el **editor CMS** tiene dos fallos P1 que justifican corrección antes de seguir: (A) la desconexión de esquema que hace inútiles cinco secciones del editor, y (B) el borrado sin copia del "Reinicio Global". Ninguno fue tocado en esta pasada.

Quedo a la espera de instrucción del usuario para avanzar al módulo 03 o para corregir estos hallazgos.
