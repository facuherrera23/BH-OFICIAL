# 🔍 Auditoría Completa — BH-OFICIAL (Bienenhaus Propiedades)
**Checklist para llevar el proyecto a estado "100% listo para vender"**

- **Fecha de auditoría:** 2026-09-04
- **Alcance:** revisión estática completa del código fuente (`admin.html`, `admin-app.js` 9.872 líneas, `landing-app.js` 2.466 líneas, `index.html`, `portal-propietario.html`, `confirmar-visita.html`, `tasacion.html`, 52 migraciones SQL de Supabase, tests, CI/CD).
- **Metodología:** lectura de código, grep sistemático de patrones de riesgo, comparación de IDs HTML↔JS, comparación de enums Zod↔`<select>`, revisión de migraciones SQL, revisión de configuración de seguridad (CSP, RLS, secrets).
- **⚠️ No incluye:** ejecución en navegador real, acceso a la base de datos en producción, ni pruebas de las integraciones externas en vivo (Supabase Auth/RLS, Mercado Libre OAuth, Cloudinary, RELA, Zernio/WhatsApp). Ver sección final "Qué falta verificar en vivo".

---

## ⚠️ Aviso importante sobre la auditoría interna previa

El repo trae dos documentos de auditoría previos que **no son totalmente confiables**:

- [ ] **Descartar/rehacer** `docs/audit/ESTADO_DEL_SISTEMA_2026-09-04.md` — el archivo está **corrupto** (texto sin sentido, mezcla de idiomas rotos, no aporta información real). No se debe usar como referencia.
- [ ] **Revisar con desconfianza** `AUDITORIA_MODULOS.md` — varios ítems marcados como "✅ RESUELTO" no coinciden exactamente con el estado actual del código (ver P1-7 más abajo, donde el módulo corregido fue Propietarios y no Agentes como indica el título del ítem). No es un documento falso, pero tiene errores de precisión — **no asumir que todo lo marcado ✅ está realmente cerrado sin volver a verificarlo.**

---

## 🔴 CRÍTICO — Bloquean el lanzamiento / dañan la marca ante el cliente final

Estos son errores visibles **hoy mismo** en la web pública, no hipótesis.

- [ ] **Teléfono falso publicado como si fuera real.** `+54 11 0000-0000` aparece como contenido visible (no como placeholder de un `<input>`) en:
  - `index.html` línea 532 (bloque de contacto)
  - `index.html` línea 717 (footer)
  - `index.html` línea 36 (JSON-LD `schema.org`, campo `telephone`)
  - **Acción:** reemplazar por el número real de la inmobiliaria en las 3 ubicaciones (y en el CMS del admin si se editan desde ahí).

- [ ] **Inconsistencia de ciudad: "Córdoba" vs "Buenos Aires".** El negocio es de Buenos Aires (dominio `bienenhaus.com.ar`, sección "Servicios" de la propia landing), pero aparece "Córdoba" en:
  - `index.html` línea 18-19 (meta Twitter Card: título y descripción)
  - `index.html` línea 39 (JSON-LD `areaServed.name: "Cordoba"`)
  - `index.html` línea 142 y 149 (título y descripción del Hero)
  - `index.html` línea 669 (descripción del footer)
  - `admin.html` línea 2006 (placeholder del campo "Localidad" en el formulario de Propiedades: *"Córdoba Capital, Villa Carlos Paz..."*)
  - Todo indica que el proyecto partió de un template genérico armado para un cliente de Córdoba y nunca se terminó de adaptar a Bienenhaus. **Hay que revisar todo el sitio buscando más menciones de "Córdoba" antes de vender.**

- [ ] **Reseñas fabricadas (fake reviews) en el marcado `schema.org`.** `index.html` línea 43-47 declara `aggregateRating: { ratingValue: 4.9, reviewCount: 300 }` sin que existan esas reseñas en ningún lado del sitio. Esto es **contenido engañoso ante Google** (rich snippets falsos) y puede derivar en penalización manual de Search Console, además de ser cuestionable legal/éticamente frente al cliente que compre el sistema.
  - **Acción:** quitar el bloque `aggregateRating` hasta tener reseñas reales verificables (Google Business, etc.).

- [ ] **Meta descripción y JSON-LD rotos/incompletos.** Texto literal: *"Inmobiliaria . Departamentos, casas, ph y propiedades en venta y alquiler..."* — falta el nombre de la ciudad/frase completa (error de copy-paste), se repite igual en `<meta name="description">` y en el JSON-LD (`index.html` línea 7 y línea 34).

- [ ] **Bug de guardado en el CMS del Admin — campos duplicados con el mismo `id`.** En `admin.html` (sección "Footer" del CMS, líneas ~1113-1175), los campos **"Descripción"** (`id="cms_footer_description"`) y **"CUIT"** (`id="cms_footer_cuit"`) están duplicados literalmente dos veces en el HTML. El JS que guarda estos campos (`admin-app.js` líneas 3149, 3305) usa `document.querySelectorAll('.cms-field[data-key]')` y recorre **todos** los elementos con ese `data-key`; como hay dos, el segundo (vacío por defecto) puede pisar el valor del primero al guardar → **pérdida silenciosa de datos** en la descripción y el CUIT del footer.
  - **Acción:** eliminar los campos duplicados del HTML (dejar solo una instancia de cada uno).

- [ ] **Pipeline de despliegue con error documentado.** `CLOUDFLARE_SETUP.md` describe un error **401 Authentication error** activo en el deploy a Cloudflare Pages, causado por un token creado en la cuenta de Cloudflare incorrecta. **No se pudo verificar si esto ya se resolvió** (no hay acceso a GitHub Actions ni a Cloudflare desde esta auditoría).
  - **Acción:** correr manualmente el workflow `.github/workflows/deploy.yml` y confirmar que el deploy termina en verde antes de entregar el proyecto.

---

## 🟠 ALTO — Funcionalidad rota o incompleta (confirmado leyendo el código)

- [ ] **Paginación de Tasaciones no funciona — elementos HTML faltantes.** `admin-app.js` (función `loadTasaciones`, línea ~5939) busca `#tasacionesPageInfo`, `#tasacionesPagePrev`, `#tasacionesPageNext` y `#tasacionesPageSize`, pero **ninguno de esos IDs existe en `admin.html`**. El código tiene guardas (`if (pageInfo) ...`) que evitan que rompa, pero como consecuencia **no hay controles de paginación visibles**: si hay más de 25 tasaciones cargadas, las siguientes páginas son inalcanzables desde la interfaz.
  - **Acción:** agregar el HTML de paginación (info + botones prev/next + selector de tamaño de página) en la vista de Tasaciones.

- [ ] **Bug de validación en el formulario de Agentes/Brokers — estado "Vacaciones" rompe el guardado.** El `<select name="status">` del formulario de Agentes (`admin.html` línea ~2298) ofrece las opciones `Activo / Inactivo / Vacaciones`, pero el esquema de validación `AgentSchema` en `admin-app.js` (línea 224) solo acepta `z.enum(['activo', 'inactivo', 'licencia'])`. **Al elegir "Vacaciones" y guardar, la validación de Zod falla** y se muestra el toast *"Error: Validación fallida: status: Invalid enum value..."* — el broker no se puede guardar con ese estado.
  - **Acción:** decidir el nombre correcto (¿"licencia" o "vacaciones"?) y unificar el `<option>` del HTML con el `z.enum()` del schema.

- [ ] **Botón "Exportar CSV" de Anomalías no existe.** En el módulo de Supervisión, `admin-app.js` línea 7809 hace `on($('#supExportAnomaliesBtn'), 'click', exportAnomaliesCSV)`, pero **ese botón no está en `admin.html`**. La función de export queda inalcanzable desde la vista "Anomalías" de Supervisión.

- [ ] **Badge de mensajes no leídos del Chat (sidebar) no funciona.** `admin-app.js` línea 7261 actualiza `#sideBadgeChatRedes`, elemento que **no existe en `admin.html`**. El contador de conversaciones sin leer del ítem "Chat Redes" en el menú lateral nunca se muestra.

- [ ] **ID duplicado `supAlertsLoadMore` en el módulo Supervisión.** Hay **dos botones con el mismo `id="supAlertsLoadMore"`** en `admin.html`: uno ubicado (por error, parece copy-paste) junto a la toolbar de la vista "Resumen" (línea ~1852, con `style="display:none"`), y el que realmente corresponde a la vista "Alertas" (línea ~1868). Con IDs duplicados, `document.getElementById` / `$('#...')` siempre devuelve el primero — es probable que el botón "Cargar más" real de la pestaña Alertas nunca reciba el listener de clic.
  - **Acción:** eliminar el botón sobrante y dejar solo el de la vista Alertas.

- [ ] **CSP (Content-Security-Policy) más débil en el panel Admin que en la landing pública.** `admin.html` usa `script-src 'self' 'unsafe-inline' ...`, mientras que `index.html` usa un nonce (`'nonce-bienenhaus2024'`) que es más restrictivo. Es contraintuitivo: el panel que maneja datos sensibles de clientes (CRM, leads, propietarios, comisiones) tiene **menos protección contra XSS** que la landing pública.
  - Nota adicional: el nonce usado en `index.html` (`bienenhaus2024`) es un **valor fijo hardcodeado en el HTML fuente**, no generado dinámicamente por request. Al ser un sitio 100% estático (sin backend que renderice HTML por request), esto es una limitación arquitectónica más que un error puntual — pero hay que ser consciente de que **no ofrece protección real contra XSS** (cualquier script inyectado que conozca el nonce puede incluirlo). Si se quiere CSP robusta de verdad, se necesita un servidor/edge function que genere el nonce por request.

- [ ] **Esquema de base de datos incompleto en el control de versiones.** Las 52 migraciones en `supabase/migrations/` no incluyen el `CREATE TABLE` original de las tablas núcleo: `properties`, `leads`, `agents`, `owners`, `visits`, `profiles`. Solo hay `ALTER TABLE` posteriores. Esto significa que **el repo por sí solo no permite reconstruir la base de datos desde cero** — si el comprador necesita levantar un ambiente nuevo (staging, disaster recovery, otro cliente con el mismo producto), no podrá hacerlo únicamente con `supabase/migrations/`.
  - **Acción:** exportar un `schema.sql` completo (`pg_dump --schema-only` o `supabase db dump`) y agregarlo al repo como snapshot base, o reconstruir la migración inicial faltante.

- [ ] **Lógica ambigua para clasificar propiedades "en venta" vs "en alquiler" en los KPIs del Dashboard.** En `admin-app.js` (líneas 793-794 y duplicado en 9535-9536) se usa esta heurística:
  ```js
  const propsVenta = props.filter(p => p.status === 'venta' || (!p.status && (p.price_currency||'USD')==='USD'));
  const propsAlquiler = props.filter(p => p.status === 'alquiler' || p.price_currency === 'ARS');
  ```
  Si a una propiedad le falta el campo `status`, se la clasifica por la **moneda del precio** (USD → venta, ARS → alquiler). Esto es una suposición frágil: en Argentina hay ventas publicadas en pesos y alquileres en dólares, así que una propiedad mal cargada puede terminar contada en el KPI equivocado del Dashboard Ejecutivo. Además, la misma lógica está **duplicada en dos lugares del archivo** (violación de DRY — si se corrige en uno, hay que acordarse de corregir el otro).
  - **Acción:** asegurar que `status` sea obligatorio al crear/editar una propiedad (ya lo es en el form, pero conviene un `NOT NULL` a nivel DB) y eliminar el fallback por moneda.

---

## 🟡 MEDIO — Deuda técnica y mejoras de calidad

- [ ] **Cobertura de tests muy baja para el tamaño del proyecto.** Solo **16 casos de test** (`admin.spec.js`: 2, `landing.spec.js`: 4, `pages.spec.js`: 5, `security.spec.js`: 5, más 1 archivo de unit tests) cubren un admin de **9.872 líneas** con más de 15 módulos (Propiedades, Propietarios, Leads, Visitas, Agentes, Comisiones, Tasaciones, Chat/Zernio, Mercado Libre, RELA, CMS, Supervisión, Auditoría). No es realista llamar "probado" a un sistema de este tamaño con esta cobertura.
  - **Acción mínima antes de vender:** al menos un test E2E por módulo crítico (crear/editar/borrar Propiedad, Lead, Visita, Agente) más los flujos de negocio clave (lead → visita → cierre).

- [ ] **TODO pendiente sin resolver:** `admin-app.js` línea 6626 — *"TODO: podríamos backfill mensajes de conversaciones recientes"* (módulo Zernio/Chat).

- [ ] **`sitemap.xml` desactualizado.** Todas las entradas tienen `<lastmod>2025-01-01</lastmod>` fijo, sin actualizar nunca. Afecta levemente el SEO (Google usa esta fecha como señal de frescura).

- [ ] **`robots.txt` bloquea `/assets/js/` a los rastreadores.** Esto puede impedir que Googlebot ejecute correctamente el JavaScript que renderiza el listado de propiedades en la landing (que se carga dinámicamente vía `landing-app.js`), afectando cómo Google indexa el contenido dinámico.

- [ ] **Uso de `Array.prototype.toSorted()`** (`admin-app.js` línea 948) — método relativamente nuevo (ES2023). Confirmar que el navegador objetivo del cliente (y versiones de Safari/iOS antiguas si aplica) lo soporta, o reemplazar por `[...arr].sort()` para máxima compatibilidad.

- [ ] **Ítems de la auditoría previa (`AUDITORIA_MODULOS.md`) que quedaron explícitamente sin cerrar** y no se pudieron re-verificar en esta revisión (requieren acceso a la base de datos en producción):
  - P1-6 — Cache invalidation centralizada: refactor iniciado pero no completado (faltaba aplicar `mutate()` a properties, leads, agents, comisiones, visitas, tasaciones, owners).
  - P2-10 — Autocomplete de Ficha HTML puede usar caché de búsqueda obsoleta.
  - P2-11 — Filtros de Comisiones no invalidan caché al crear/editar agentes u owners.

---

## ✅ Cosas que están bien resueltas (verificado en el código actual)

Para que quede constancia de lo que **no** hace falta tocar:

- Sintaxis JS válida en todos los archivos (`node --check` sin errores).
- El KPI "Propiedades Activas" del Dashboard ya usa `is_published` + exclusión de `vendido`/`alquilado` correctamente (el bug viejo de comparar contra `'publicada'`, un valor que no existe, ya no está presente).
- Los enums de `status` de Propiedades, Visitas y `stage` de Leads coinciden exactamente entre el HTML (`<select>`) y el schema Zod — no hay mismatch salvo el de Agentes ya reportado arriba.
- No se encontraron credenciales `service_role` ni secretos de servidor expuestos en el código del cliente (solo la `anon key` de Supabase, que es pública por diseño).
- No hay archivos `.env` trackeados en el repo.
- No se encontró código con `eval()` ni `debugger` olvidado.
- Sin caracteres corruptos (mojibake) residuales en `admin.html` / `admin-app.js` / `landing-app.js` (los arreglos de encoding de commits previos funcionaron).
- Imágenes de `index.html` con atributo `alt` presente.

---

## 🔬 Qué NO se pudo verificar en esta auditoría (pendiente de pruebas en vivo)

Antes de decir "100% listo", hay que probar esto manualmente con acceso real al proyecto desplegado:

- [ ] Comportamiento real de las políticas **RLS de Supabase** en producción (esta auditoría solo revisó el SQL de las migraciones, no puede ejecutar consultas contra la base real).
- [ ] Flujo completo de **login/roles** (super_admin, broker) en el navegador.
- [ ] Integración con **Mercado Libre** (OAuth, publicación, sincronización) de punta a punta.
- [ ] Integración con **Cloudinary** (subida y transformación de imágenes).
- [ ] Integración con **RELA** y **Zernio/WhatsApp** (chat, webhooks).
- [ ] Diseño **responsive** en dispositivos móviles reales (esta auditoría fue solo de código, no visual).
- [ ] Accesibilidad con lector de pantalla y navegación por teclado.
- [ ] Performance (Lighthouse / Core Web Vitals) de la landing pública.
- [ ] Que el pipeline de CI/CD (`deploy.yml`) efectivamente publique sin el error 401 documentado en `CLOUDFLARE_SETUP.md`.
- [ ] Prueba de carga/estrés en tablas con muchos registros (paginación, búsqueda global, exportaciones CSV).

---

## 📋 Orden sugerido de trabajo

1. **Hoy mismo (antes de mostrarle el sitio a cualquier cliente):** teléfono falso, ciudad "Córdoba", reseñas fabricadas, meta description rota — son 30 minutos de trabajo y evitan una vergüenza pública o un problema de SEO/legal.
2. **Esta semana:** bug de guardado del CMS (footer duplicado), bug de "Vacaciones" en Agentes, verificar que el deploy de Cloudflare funcione.
3. **Antes de la entrega/venta:** paginación de Tasaciones, botones/badges rotos de Supervisión y Chat, exportar el schema completo de la base de datos, subir cobertura de tests de los módulos críticos.
4. **Post-venta / mejora continua:** unificar CSP entre admin y landing, terminar el refactor de cache invalidation (P1-6), actualizar sitemap.
