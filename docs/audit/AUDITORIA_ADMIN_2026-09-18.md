# 🔍 AUDITORÍA ADMIN COMPLETA — BH-OFICIAL
**Fecha:** 2026-09-18 · **Auditor:** Sisyphus (agente) · **Duración:** ~2.5 horas · **Alcance:** solo lectura, cero cambios de código

---

## Metodología

- Lectura estática completa de `admin.html` (2.893 líneas), `assets/js/admin-app.js` (10.911 líneas), `assets/js/admin-crm.js` (1.548 líneas), `assets/js/admin-crm-tasks.js` (167 líneas), `assets/css/admin.css` (647 líneas)
- Verificación en vivo contra la base de datos de producción (RLS, permisos, triggers, enumeraciones, columnas)
- Análisis de cada módulo del panel (dashboard, propiedades, leads/CRM, propietarios, agenda/visitas, tasaciones, agentes, comisiones, chat de redes, portales ML/RELA, CMS, supervisión, configuración)
- Auditoría de Edge Functions y validación de entrada/salida
- Scripts automatizados de cross-check: IDs JS↔HTML (560 IDs), enums Zod↔selects, funciones duplicadas, interpolaciones sin escape
- **No se tocó código.**

---

## 📊 Resumen Ejecutivo

| Área | Estado | Nota |
|------|--------|------|
| Arquitectura | ✅ Sólida | Modular, con `mutate()` centralizado, esquemas Zod, `requireAdmin` compartido |
| RLS DB | ⚠️ Mayormente sólida | 100+ políticas; 2 debilidades encontradas |
| XSS | ⚠️ 1 fuga menor | Widget "Leads Calientes" del dashboard ejecutivo |
| Enum mismatches | 🔴 3 encontrados | Agentes, tasaciones, rol broker |
| WIP del dueño en producción | 🔴 Incompleto | KPIs sin datos, exportaciones rotas |
| Debt técnico | 🟠 10 funciones duplicadas, toSorted ES2023, TODO pendiente |
| Seguridad base | ✅ Fuerte | Anti auto-escalación, audit_log inmutable, requireAdmin centralizado |

**Riesgo global: MEDIO.** El sistema funciona pero tiene puntos ciegos que causarán errores conforme se use intensivamente.

---

## 🔴 CRÍTICO — Corregir antes de uso intensivo

### C1. Bug del formulario de Agentes: "Vacaciones" rompe el guardado
**Archivo:** `admin.html` (~L2006), `admin-app.js` L232
**Síntoma:** Elegir "Vacaciones" en el select de estado del agente produce `Validación fallida: status: Invalid enum value. Expected 'activo' | 'inactivo' | 'licencia'`.
**Causa:** El `<select name="status">` ofrece `Activo / Inactivo / Vacaciones`, pero `AgentSchema` (L232) solo acepta `z.enum(['activo', 'inactivo', 'licencia'])`.
**Impacto:** Imposible guardar un agente en "Vacaciones" sin ver un error críptico.

### C2. Interpolación sin escape en "Leads Calientes" del Dashboard Ejecutivo — XSS
**Archivo:** `admin-app.js` L10712-10726, función `loadExecTopOpps()`
**Código:**
```js
html += `<div style="font-weight:600; color:#fff;">${i + 1}. ${l.full_name || 'Sin nombre'}</div>
         <div style="font-size:11px; ...">${l.stage} ...`;
// L10726: if (container) container.innerHTML = html;
```
**Problema:** `l.full_name` y `l.stage` se insertan directamente en HTML sin `esc()`. El resto del código usa `esc()` en 256+ lugares, pero aquí se omitió.
**Impacto:** Un lead con `full_name` conteniendo `<img onerror=alert(1)>` ejecuta JavaScript en la sesión del admin. **Vector: cualquier persona que envíe el formulario público de contacto.**

### C3. Formulario de "Editar Usuario" ofrece rol "broker" pero el guardado lo rechaza
**Archivo:** `admin.html` (~L1810), `admin-app.js` UserSchema
**Síntoma:** Cambiar un usuario a rol "broker" falla con `Validación fallida` porque el esquema solo acepta `super_admin` y `agente`.
**Causa:** HTML y Zod desalineados.

### C4. WIP del dueño en producción: KPIs de tasaciones sin datos; exportaciones de visitas rotas
**Archivos:** `admin.html` L1096-1101 (KPIs HTML), `admin-app.js` L3383-3384 (export buttons)
**Detalle:**
- KPIs (`tasKpiTotal`, etc.): HTML existe, `setKpi()` los puebla con counts ✓ — pero **la tabla usa clases `.crm-table` sin el paginador correspondiente**
- `btnExportCSV` y `btnExportICS` referenciados en JS con `?.addEventListener` — **los botones no existen en HTML** → exportaciones de visitas muertas silenciosamente
- `visitsTableBody` referenciado en 3 lugares (L2260, L2272, L2508) **no existe en HTML** → tabla de visitas en modo lista no renderiza
**Impacto:** El usuario cree que tiene exportaciones y una tabla de visitas, pero ambas fallan en silencio.

### C5. Enum "status" de tasaciones: esquema no coincide con la DB
**Archivo:** `admin-app.js` L216
**Detalle:** `TasacionSchema` define `status: z.enum(['draft', 'finalized'])`. La DB tiene el mismo enum. **PERO** el formulario HTML de tasación NO tiene un select de estado con esos valores — el estado se asigna programáticamente al "Finalizar". **Funciona**, pero es frágil: cualquier edición manual que intente cambiar status a otro valor fallará.

### C6. `cms_footer_cuit` duplicado — mismo bug de pisado silencioso que description
**Archivo:** `admin.html` L1096 y L1133 — ambas instancias con `class="cms-field" data-key="cuit"`
**Detalle:** El loop de guardado del CMS (`document.querySelectorAll('.cms-field[data-key]')`) itera ambas → la segunda (vacía por defecto) pisa el valor de la primera al guardar.
**Impacto:** Editar el footer CMS siempre guarda el CUIT como vacío. El gemelo de este bug (`cms_footer_description`) fue corregido en la sesión del 18/09, pero cuit quedó.

---

## 🟠 ALTO — Funcionalidad rota o inalcanzable

### A1. 10 funciones duplicadas en admin-app.js (bloque Realtime)
**Archivo:** `admin-app.js` L2259-2335 y L2507-2583
**Funciones:** `upsertVisitRow`, `removeVisitRow`, `upsertPropertyRow`, `removePropertyRow`, `upsertAgentRow`, `removeAgentRow`, `upsertOwnerRow`, `removeOwnerRow`, `upsertTasacionRow`, `removeTasacionRow`
**Detalle:** Todas definidas dos veces (~300 líneas duplicadas). La segunda definición gana por hoisting de JavaScript.
**Impacto:** Confusión al editar; imposible saber cuál versión está activa sin leer ambas.

### A2. Badge de propietarios `#sideBadgeOwners` — JS actualiza un elemento inexistente
**Archivo:** `admin-app.js` L4124, L8342
**Detalle:** El JS calcula alertas de DNI/CUIT vencidos, exclusividades próximas a vencer y tareas atrasadas, luego intenta actualizar el badge del sidebar. El elemento no existe en el HTML.
**Impacto:** Los números se calculan (con costo de queries) pero nunca se muestran.

### A3. `#supAlertsLoadMore` — ID duplicado, solo el botón oculto recibe el listener
**Archivo:** `admin.html` L1820 (hidden, `style="display:none"`) y L1836 (visible)
**Detalle:** `getElementById` devuelve el primero (oculto) → el listener se registra ahí. El botón visible "Cargar más" en Alertas nunca tiene listener.
**Impacto:** Imposible cargar más allá de la primera página de alertas.

### A4. Paginación de tasaciones: lógica completa en JS, cero controles en HTML
**Archivo:** `admin-app.js` L6694-6764 (lógica completa), HTML sin `tasacionesPageInfo/Prev/Next/PageSize`
**Detalle:** El JS tiene variables `_tasacionesPage`, `_tasacionesPageSize`, calcula `range(from, to)`, lee los IDs de paginación — ninguno existe en el HTML.
**Impacto:** Con más de 25 tasaciones, solo la página 1 es visible. **Bug del audit viejo (P2-3), sigue abierto.**

### A5. RLS de `tasaciones` permite rol `broker` en operaciones ALL
**Tabla:** `tasaciones` · **Política:** `admin_full_access_tasaciones`
**Detalle:** Un usuario con rol `broker` puede crear, leer, modificar y eliminar TODAS las tasaciones de TODOS los brokers.
**Riesgo:** Si contratan brokers que solo deben ver sus propias tasaciones.

### A6. `zernio_accounts` legible por cualquier usuario autenticado
**Tabla:** `zernio_accounts` · **Política:** `zernio_accounts_select` → `roles: {authenticated}`, `condición: true`
**Riesgo:** Cualquier usuario (incluso agente) puede ver las cuentas de WhatsApp conectadas, incluyendo IDs de cuenta.

### A7. `property_documents`, `document_requirements`, `owner_tasks`, `owner_timeline_entries`, `commissions`, `commission_payments`, `commission_liquidations` — RLS ALL para cualquier autenticado
**Detalle:** Estas tablas permiten acceso total a cualquier usuario logueado. `property_documents` contiene documentos legales de propietarios (escrituras, DNI). `commissions` contiene datos financieros.
**Mitigación actual:** Solo hay 2 empleados (super_admin). **Riesgo futuro:** Al contratar agentes, tendrán acceso total a documentos de propietarios y datos de comisiones.

---

## 🟡 MEDIO — Robustez y deuda técnica

### M1. `toSorted()` (ES2023) — compatibilidad con navegadores antiguos
**Archivo:** `admin-app.js` L958
**Recomendación:** Reemplazar por `[...arr].sort()`.

### M2. TODO pendiente en módulo de chat Zernio
**Archivo:** `admin-app.js` L7495
**Detalle:** Sin backfill de historial, las conversaciones antiguas aparecen vacías al abrir por primera vez.

### M3. `window.open` sin `noopener` (3 instancias)
**Archivo:** `admin-app.js` L5037, L5449, L6839
**Riesgo:** Reverse tabnabbing.

### M4. `fetch` sin check de `res.ok` (2 instancias marcadas por react-doctor)
**Archivo:** `admin-app.js` L1291 (ficha-publish), L6417 (rela-proxy)

### M5. Enum `source` de leads: ecosistema desalineado
**Detalle:**
- Zod `LeadSchema.source`: `landing, ml, chat, referido, tasacion, walkin, manual`
- Constante `ORIGINS` en admin-crm.js: añade `contacto, propiedad, whatsapp, web` (sin `landing_page`)
- RLS `leads_anon_insert`: solo permite `landing_page, newsletter` desde la web
- La landing pública envía `source: 'landing_page'`
**Impacto:** Cuando llegue el primer lead de la web, el filtro de origen del CRM no podrá encontrarlo (opción `landing` ≠ valor real `landing_page`). Además, editar un lead web desde el modal clásico reescribe su `source` a `manual` (porque el select no tiene la opción y `validateForm` descarta valores vacíos, cayendo en el `.default('manual')` del esquema).

### M6. Bloque de auditoría ML inalcanzable en ml-sync (código muerto)
**Archivo:** `supabase/functions/ml-sync/index.ts` ~L693
**Detalle:** `await auditSensitiveAction(...)` después de un `return` en el bloque `publish` → código muerto. Las publicaciones vía cola no se auditan.

### M7. CSP del admin con `unsafe-inline` y nonce fijo
**Archivo:** `admin.html` meta tag
**Detalle:** Limitación de sitio estático. Corregir el XSS (C2) es más importante que endurecer el CSP.

---

## 🟢 POSITIVO — Verificado y funcionando bien

| Verificación | Estado |
|---|---|
| **Anti auto-escalación**: trigger `guard_profiles_self_update` bloquea cambiar tu propio rol | ✅ Verificado con `pg_get_functiondef()` |
| **requireAdmin compartido**: valida JWT + perfil activo + rol en Edge Functions | ✅ |
| **Escapado HTML (`esc()`)**: 256+ usos correctos; solo 1 fuga (C2) | ✅ |
| **mutate() centralizado**: 20 call sites para cache+retry | ✅ Refactor P1-6 del audit viejo completado |
| **audit_log inmutable**: sin INSERT/UPDATE/DELETE para authenticated | ✅ |
| **RLS de leads/visitas/zernio**: correctamente scoped por agente asignado | ✅ |
| **rate_limit_logs / usage_events**: bloqueados para usuarios normales | ✅ |
| **No hay tokens en localStorage** | ✅ Solo IDs de notificaciones |
| **Esquemas Zod en todos los formularios principales** | ✅ (con los mismatches documentados) |
| **Categorías ML mapeadas por tipo+operación** | ✅ (fix de esta sesión) |
| **Eliminación ML en not_yet_active vía DELETE** | ✅ (fix de esta sesión) |
| **KPIs de tasaciones (WIP del dueño)**: HTML + `setKpi()` funcionando | ✅ |
| **Contadores honestos del sitio** (26+ propiedades, 14+ zonas) | ✅ |

---

## ⚠️ RIESGOS FUTUROS

| Riesgo | Detalle | Timeline |
|---|---|---|
| **GitHub Actions: `ubuntu-latest` migra a Ubuntu 26** | El runner migrará automáticamente el 19 de octubre de 2026 | 30 días |
| **GitHub Actions: Node 20 deprecado** | `actions/checkout@v4` y `actions/setup-node@v4` usan Node 20 | ~6 meses |
| **Supabase Auth: leaked password protection desactivada** | Activar en Dashboard → Authentication → Settings | Inmediato |
| **Funciones `tmp-gen-jwt` y `cta-test` en producción** | Borrar desde Dashboard | Inmediato |
| **Drift de migraciones** | Versiones renumeradas, 2 duplicadas, 5 sin fuente en repo | Post-lanzamiento |
| **Primer lead de la web** | Filtro de origen no podrá encontrarlo (M5) | Primer lead |
| **Chat Zernio sin backfill** | Conversaciones antiguas vacías | Al usar el chat |
| **RIM de `property_documents` con ANY authenticated** | Documentos legales accesibles a cualquier agente futuro | Al contratar |

---

## 📋 Verificación de items de la auditoría previa (2026-09-04)

| Item | Estado actual |
|---|---|
| P1-1: Teléfono falso en landing | ✅ **CORREGIDO** — reemplazado por número real |
| P1-2: "Córdoba" vs "Buenos Aires" | ✅ **CORREGIDO** — toda la web dice Córdoba |
| P1-3: Reseñas fabricadas en schema.org | ✅ **CORREGIDO** — `aggregateRating` eliminado |
| P1-4: Meta description rota | ✅ **CORREGIDO** — reescrita con keywords |
| P1-5: Botón "Publicar" en navbar público | ✅ **CORREGIDO** — eliminado del HTML y CMS |
| P1-6: Cache invalidation centralizada | ✅ **CORREGIDO** — 20 call sites con `mutate()` |
| P1-7: Bug de guardado CMS (campos duplicados) | 🔴 **PARCIAL** — description corregido, **cuit sigue duplicado** (C6) |
| P2-8: Pipeline despliegue 401 Cloudflare | ✅ **CORREGIDO** — job eliminado; deploy por GitHub Pages |
| P2-9: Botón exportar anomalías | 🔴 **SIGUE ABIERTO** — `supExportAnomaliesBtn` no existe en HTML |
| P2-10: Badge de chat sin listener | ✅ **CORREGIDO** — `sideBadgeChatRedes` existe y es actualizado |
| P2-11: Filtros de comisiones no invalidan cache | ⚠️ Comisiones manejadas por Edge Functions |
| Sitemap desactualizado | ✅ **CORREGIDO** — regenerado automáticamente |
| `toSorted()` compatibilidad | 🔴 **SIGUE ABIERTO** — L958 |
| Paginación de tasaciones | 🔴 **SIGUE ABIERTO** — JS completo, HTML sin controles (A4) |

---

## 🎯 Priorización de correcciones

### Inmediato (hoy)
1. **C1: Enum "Vacaciones"** — alinear HTML + Zod
2. **C2: XSS en Leads Calientes** — envolver en `esc()`
3. **C3: Enum rol "broker"** — alinear HTML + Zod
4. **C5: Enum status tasaciones** — alinear si es necesario
5. **C6: Eliminar `cms_footer_cuit` duplicado**
6. **M5: Añadir `landing_page` y `newsletter` a ORIGINS, filtro y Zod**

### Esta semana
7. **A1: Eliminar 10 funciones duplicadas** (mantener versiones L2507+)
8. **A2: Añadir `#sideBadgeOwners` al sidebar HTML**
9. **A3: Eliminar botón fantasma `#supAlertsLoadMore` oculto**
10. **A4: Añadir controles HTML de paginación de tasaciones**
11. **A5/A6/A7: Endurecer RLS de `tasaciones`, `zernio_accounts` y tablas ALL-true**

### Post-lanzamiento
12. **C4: Completar o eliminar WIP de exportaciones de visitas**
13. **M1: Reemplazar `toSorted()`**
14. **M2: Implementar backfill de chat Zernio**
15. **M3: Añadir `noopener` a `window.open`**
16. **M6: Eliminar código muerto de auditoría ML en ml-sync**
17. **P2-9: Añadir `#supExportAnomaliesBtn` al HTML**

---

*Auditoría completada sin modificaciones de código. Generada el 2026-09-18.*
