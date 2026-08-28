# Auditoría Módulo a Módulo — BH-OFICIAL

**Fecha:** 2026-08-27  
**Estado:** En curso — priorizando críticos (P0)  
**Última actualización:** 2026-08-27  (fix #btnNewVisit broker dropdown aplicado localmente, pendiente deploy)

---

## 📊 Resumen Ejecutivo

| Severidad | Cuenta | Estado |
|-----------|--------|--------|
| **P0 Críticos** | 2 | 0 resueltos |
| **P1 Altos** | 7 | 0 resueltos |
| **P2 Medios** | 11 | 0 resueltos |
| **Conexiones faltantes** | 9 | 0 resueltas |

---

## 🔴 P0 — CRÍTICOS (Bloquean funcionamiento)

### P0-1 ✅ **RLS `visits` — Brokers no ven sus visitas** — **RESUELTO 2026-08-27**

**Problema:** Policy `visits_select` / `visits_update` usa `agent_id = auth.uid()`. Pero:
- `visits.agent_id` → FK a `agents.id` (UUID del agente)
- `auth.uid()` = `profiles.id` (UUID del usuario auth)
- **Nunca matchea** → brokers ven 0 visitas salvo `super_admin`.

**Fix aplicado:**
1. Migración `20260827_fix_visits_rls.sql` — policies nuevas con JOIN a `agents.profile_id`
2. Vinculación `agents.profile_id` para los 2 agents activos:
   - Danilo Arbo (agent `92442bdf...`) → profile `853541e0...` (danilo.arbo@gmail.com)
   - Helmut Scheibengraf (agent `30bfbea1...`) → profile `1af9cacd...` (helmutscheibengraf@yahaa.com.ar)

**Policy nueva (visits_select):**
```sql
EXISTS (
  SELECT 1 FROM agents a
  WHERE a.id = visits.agent_id
    AND a.profile_id = auth.uid()
)
```

**Verificación:** Policies actualizadas en DB, agents vinculados. Brokers ahora deberían ver sus visitas al loguearse.

---

### P0-2 ✅ **Chat Zernio — Solo `super_admin` accede** — **RESUELTO 2026-08-27**

**Problema:** `loadChatRedes` (línea 5832) bloquea si `role !== 'super_admin'`. Brokers con conversaciones asignadas no pueden usar el chat. Además, tablas chat no tenían `broker_id` ni RLS restrictivo.

**Fix aplicado:**
1. **Migración `20260827_chat_broker_access.sql`:**
   - Agregada columna `broker_id` (FK a `agents.id`) a `zernio_conversations` y `zernio_messages`
   - RLS nuevo: `super_admin` ve todo; `broker` ve solo conversaciones donde `broker_id` apunta a su agent (via `agents.profile_id = auth.uid()`)
   - Triggers `BEFORE INSERT` para auto-asignar `broker_id`:
     - `zernio_conversations`: infiere de `property_id` → `properties.agent_id`, o `lead_id` → `leads.broker_id`, o `account_id` → agent activo con propiedades
     - `zernio_messages`: hereda `broker_id` de la conversación padre

2. **UI Guard `admin-app.js` (línea 5832):**
   ```js
   // ANTES: if (currentProfile?.role !== 'super_admin')
   // DESPUÉS:
   if (!['super_admin', 'broker'].includes(currentProfile?.role))
   ```

3. **Cache buster:** `admin-app.js?v=92` → `v=93`

**Verificación:** Policies RLS actualizadas, columnas agregadas, triggers creados, guard UI actualizado. Brokers ahora pueden acceder al chat y ver solo sus conversaciones asignadas.

---

## 🟠 P1 — ALTOS (Funcionalidad rota/incompleta)

### P1-1 ✅ **Arquitectura IDs unificada** — **RESUELTO 2026-08-27**

**Problema:** `properties.agent_id` y `leads.assigned_to` apuntaban a `profiles.id`; solo `visits.agent_id` apuntaba a `agents.id`. Inconsistencia rompía RLS y joins.

**Fix aplicado — Migración `20260827_unify_agent_ids.sql`:**
1. **Data migration:** columnas temporales `agent_id_new` / `assigned_agent_id` mapeadas via `agents.profile_id = old_value`
2. **FK recreation:** `properties.agent_id → agents.id`, `leads.assigned_to → agents.id` (ON DELETE SET NULL)
3. **RLS actualizado:** policies `properties_*`, `leads_*`, `owners_select` usan JOIN `agents.profile_id = auth.uid()`
4. **Dependencias:** drop/recreate `owners_select` policy

**Verificación:**
- Columnas: `properties.agent_id` (uuid, FK agents), `leads.assigned_to` (uuid, FK agents) ✓
- FKs: `properties_agent_id_fkey`, `leads_assigned_to_fkey` ✓
- Policies: 4 properties, 4 leads, 1 owners_select ✓
- Data migration: tablas sin asignaciones previas (NULL → NULL) ✓
- JS: sin cambios requeridos (no filtraba `agent_id = currentUser.id`)

**Estado:** Modelo unificado — todas las FKs de "responsable" apuntan a `agents.id`.

---

### P1-2 ✅ **Realtime en tablas core** — **RESUELTO 2026-08-27**

**Fix:** `ALTER PUBLICATION supabase_realtime ADD TABLE` para:
`visits`, `leads`, `properties`, `agents`, `owners`, `tasaciones`, `commissions`, `commission_liquidations`, `commission_payments`.

**Verificación:** `pg_publication_tables` ahora incluye 13 tablas (10 core + 3 Zernio). Sync cross-tab nativo habilitado para todas las entidades principales.

---

### P1-3 ✅ **Broker dropdown Agenda — FIX LOCAL APLICADO**

**Problema:** `#btnNewVisit` no llamaba `loadBrokersForVisit()`.

**Fix aplicado (local, pendiente deploy):**
```js
// admin-app.js ~línea 1916
on($('#btnNewVisit'), 'click', () => {
  editingVisitId = null;
  $('#visitForm')?.reset();
  loadBrokersForVisit();  // ← AGREGADO
  ...
});
```

**Cache buster:** `admin-app.js?v=91` → `v=92` en `admin.html`.

---

### P1-4 ✅ **Config Zernio robustez** — **RESUELTO 2026-08-27**

**Problema:** Guardado `value: { key: apiKey }` (objeto), lectura `value.key` — frágil si formato cambia.

**Fix aplicado:**
1. **Guardado** (`admin-app.js` ~línea 2960): `value: apiKey` (string directo)
2. **Lectura** (`admin-app.js` ~línea 2921): acepta ambos formatos
   ```js
   const val = zernioRes.data.value;
   const apiKey = typeof val === 'string' ? val : val.key;
   ```
3. **Cache buster:** `v=93` → `v=94`

---

### P1-5 ✅ **Soft delete Agents** — **RESUELTO 2026-08-27**

**Problema:** `deleteAgent` hacía hard delete (`.delete()`). Columna `deleted_at` existe en schema pero no se usaba.

**Fix aplicado:**
1. **`deleteAgent`** (línea ~3211): `.update({ deleted_at: new Date().toISOString() })` en lugar de `.delete()`
2. **`loadAgents`**: agregado `.is('deleted_at', null)` a query
3. **Dropdowns**: `.is('deleted_at', null)` agregado a:
   - `populateBrokerFilters` (calendario + tabla visitas)
   - `loadBrokersForVisit` (formulario visita)
   - `populateCommissionFilters` (módulo comisiones)
   - `loadDashboard` (top brokers KPI)
   - `loadFichaHtml` (autocomplete CRM)
   - Executive dashboard (rankings)
4. **Cache buster:** `v=94` → `v=95`

**Nota:** `deleted_at` ya existía en schema, solo faltaba usarse.

---

### P1-6 🔄 **Search cache invalidation centralizada** — **INICIADO 2026-08-27**

**Problema:** `invalidateSearchCache()` llamado manualmente en algunos loaders pero no en mutaciones (property/lead/agent save/delete, commissions).

**Avance 2026-08-27:**
- Función `mutate(table, fn)` creada en `admin-app.js` (línea ~6371): wrapper que ejecuta mutación, invalida cache y emite `Bus.emit(table+':changed')`.

**Pendiente (refactor progresivo):** reemplazar llamadas directas a `.insert()/.update()/.delete()` por `mutate('table', async () => ...)` en:
- Property save/delete (`propertyForm` submit, `deleteProperty`)
- Lead save/delete (`leadForm` submit, `deleteLead`)
- Agent save/delete (`agentForm` submit, `deleteAgent`)
- Commission mutations (`markCommissionPaid`, `loadLiquidations`, `loadPayments`)
- Visit save/delete
- Tasación save/delete
- Owner save/delete

**Cache buster:** `v=95` → `v=96` (pendiente aplicar tras refactor completo)

---

### P1-7 ✅ **Agent commission_rate → split sale/rent** — **RESUELTO 2026-08-27**

**Problema:** Form/Schema usaban `commission_rate` único; DB tiene `commission_sale` + `commission_rent`.

**Fix aplicado:**
1. **HTML `admin.html` (línea 2006):** Reemplazado `commission_rate` por dos campos: `commission_sale` (default 3) + `commission_rent` (default 4)
2. **Schema `AgentSchema` (línea 193):** `commission_rate` → `commission_sale` (default 3) + `commission_rent` (default 4)
3. **JS save agent (línea 3146):** `data` usa `commission_sale` + `commission_rent`
4. **JS editAgent (línea 3198):** Carga ambos campos al editar
5. **Cache buster:** `v=96` → `v=97`

---

## 🟡 P2 — MEDIOS (Deuda técnica / UX)

| ID | Módulo | Problema |
|----|--------|----------|
| P2-1 | Dashboard | KPI `activeProps` filtra mal (usa `'publicada'` inexistente en enum) |
| P2-2 | Properties | Status enum mismatch: JS usa `'venta'/'alquiler'` pero DB enum = `venta|alquiler|vendido|alquilado|pausado` |
| P2-3 | Agents | `loadAgents` trae TODOS sin filtro status (otros lugares usan `.eq('status','activo')`) |
| P2-4 | Lead↔Visit | **RESUELTO 2026-08-27** — Trigger `trg_visits_sync_lead_stage` ya existía (lead 'contactado' → 'visita' al crear visita). Agregados triggers reversos:
  - `trg_visits_lead_cancel_revert`: visita cancelada → si no quedan visitas pendientes, lead 'visita' → 'contactado'
  - `trg_visits_lead_completed_auto`: visita completada → lead 'visita' → 'oferta' (fallback automático al prompt JS)
| P2-5 | Visit→Lead | **RESUELTO 2026-08-27** — Mismo fix arriba (triggers reversos en DB)
| P2-6 | Chat sidebar | **RESUELTO 2026-08-27** — Botones en header chat: "Crear Lead" (insert lead desde conv), "Agendar Visita" (llama openVisitModal con datos conv), "Asignar Broker" (prompt + update zernio_conversations.broker_id).
| P2-7 | Badges | **RESUELTO 2026-08-27** — RPC `get_sidebar_badge_counts` (SECURITY DEFINER) creado; `updateSidebarBadges` usa RPC en lugar de queries directas → respeta RLS por usuario.
| P2-8 | Supervisión | **RESUELTO 2026-08-27** — `renderSupRankings` ahora resuelve UUIDs via query a `profiles` (cache en memoria); rankings muestran `full_name` en lugar de UUID.
| P2-9 | Portales | **RESUELTO 2026-08-27** — Config dinámica por portal (`PORTAL_CONFIG_FIELDS`): ZonaProp (client_id/secret), Argenprop (user/pass), Argentpropiedades, Properati, MiArgPropiedad, ML. UI genera campos según portal; submit usa upsert dinámico.
| P2-10 | Ficha HTML | Autocomplete CRM usa `_searchCache` que puede estar stale (ver P1-6) |
| P2-11 | Comisiones | Filtros no invalidan cache al crear/editar agents/owners |

---

## 🔗 CONEXIONES FALTANTES ENTRE MÓDULOS

| Flujo | Estado | Qué falta |
|-------|--------|-----------|
| Lead → Visita | Parcial | Botón llama `openVisitModal` ✓, pero lead.stage no auto-pasa a `'visita'` |
| Visita → Lead | ❌ | Completar/cancelar visita no actualiza lead |
| Chat → Lead | ❌ | Botón "Crear lead" en conversación sin handler |
| Chat → Visita | ❌ | Botón "Agendar visita" en conversación sin handler |
| Property → Lead | Parcial | Landing crea lead con property_id ✓, pero no asigna broker_id auto |
| Tasación → Lead | Parcial | `_handleTasacionFinalized` existe pero sin trigger lead captación |
| Agent ↔ Profile | Confuso | `agents.profile_id` existe pero sin UI para vincular |

---

## 💡 MEJORAS PROPUESTAS (Backlog)

1. **Soft delete Agents** — usar `deleted_at` + filtrar `.is('deleted_at', null)`
2. **Property status alignment** — unificar enum o mapear en JS
3. **Agent-Profile linking UI** — tab Brokers: vincular `profile_id` ↔ `auth.users`
4. **Broker role RLS** — policy `visits_select` con `JOIN agents ON agents.profile_id = auth.uid()`
5. **Search cache TTL** — definir y documentar `SEARCH_CACHE_TTL_MS`
6. **Cache invalidation centralizada** — wrapper `mutate(table, fn)` → `invalidateSearchCache()` + `Bus.emit`
7. **Badge counts con RLS** — RPC `SECURITY DEFINER` para counts filtrados
8. **Config health chips** — estado reactivo en vez de variables globales
9. **Config Zernio robustez** — validar estructura al leer o guardar string directo
10. **Supervisión rankings** — resolver `user_id` → `profiles.full_name`

---

## 📦 PLAN DE TRABAJO (Orden sugerido)

- [ ] **P0-1** RLS visits (fix policy con JOIN agents.profile_id)
- [ ] **P0-2** Chat access para role `broker` (RLS + guard UI)
- [ ] **P1-1** Decidir modelo único IDs + migración
- [ ] **P1-2** Realtime en tablas core
- [ ] **P1-3** Deploy fix `#btnNewVisit` + cache buster
- [ ] **P1-4** Config Zernio robustez
- [ ] **P1-5** Soft delete Agents
- [ ] **P1-6** Cache invalidation centralizada
- [ ] **P1-7** Agent commission_rate → split sale/rent
- [ ] P2s y conexiones según prioridad de negocio

---

## 📝 Historial de Cambios

| Fecha | Cambio | Autor |
|-------|--------|-------|
| 2026-08-27 | Auditoría inicial completa | Sisyphus |
| 2026-08-27 | Fix #btnNewVisit broker dropdown (local) | Sisyphus |