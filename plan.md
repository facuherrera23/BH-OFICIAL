# Plan de Integración: CRM ↔ Agenda de Visitas (Bidireccional)

## Estado Actual
- **Leads (Kanban)**: Pipeline `nuevo → contactado → visita → oferta → cerrado/perdido`
- **Visitas (Tabla)**: Lista con fecha, estado (`pendiente/confirmada/completada/cancelada`)
- **Relación DB**: `visits.lead_id` (FK nullable a `leads.id`) ya existe pero no se aprovecha en UI

---

## Objetivo
**Integración 100% bidireccional**: cualquier acción en un lado se refleja en el otro automáticamente.

---

## Flujos Bidireccionales Requeridos

| Origen | Acción | Efecto en el otro lado |
|--------|--------|------------------------|
| **CRM** | Lead en "contactado" → click "📅 Agendar visita" → crea visita | Lead pasa a etapa **"visita"** |
| **Agenda** | Crear visita con `lead_id` (lead en "contactado") | Lead pasa automáticamente a **"visita"** |
| **Agenda** | Editar visita → asignar `lead_id` (era NULL) | Lead pasa a **"visita"** |
| **Agenda** | Marcar visita **"completada"** | Prompt: "¿Mover lead a **Oferta**?" → Sí → lead = "oferta" |
| **CRM** | Click en lead con visita → ver visitas asociadas (próximas + historial) |
| **Agenda** | Click en lead de una visita → abre CRM en ese lead |

---

## Fase 1 – Core (3-4h)

### 1.1 Base de Datos (SQL)
- Validar FK `visits.lead_id → leads.id` (ya existe)
- **Trigger `trg_visits_bidireccional`** (AFTER INSERT/UPDATE ON visits):
  - Si `NEW.lead_id` IS NOT NULL y `OLD.lead_id` IS DISTINCT FROM `NEW.lead_id`:
    - Obtener stage actual del lead
    - Si stage = 'contactado' → UPDATE leads SET stage = 'visita', updated_at = NOW()
- **Trigger `trg_visit_completada`** (AFTER UPDATE ON visits):
  - Si `NEW.status = 'completada'` y `OLD.status != 'completada'` y `NEW.lead_id` IS NOT NULL:
    - Obtener stage del lead
    - Si stage = 'visita' → **NO auto-cambiar** (ver decisión abajo), solo registrar log
    - La UI hará el prompt "¿Mover a Oferta?"

### 1.2 Frontend CRM (leads)
- `loadCRM()`: traer visits relacionadas por `lead_id` (próximas + últimas)
- `renderLeadCard()`:
  - Si `stage === 'visita'` y no tiene visita futura → botón **"📅 Agendar visita"**
  - Badge "📅 Visita: DD/MM" si tiene visita futura
  - Panel lateral (editLead): sección "Visitas asociadas" con link a Agenda
- **Botón "📅 Agendar visita"** en lead card (stage = "contactado" o "visita"):
  - Abre `openVisitModal()` pre-llenado:
    - `lead_id` = lead.id
    - `client_name` = lead.full_name
    - `client_phone` = lead.phone || lead.whatsapp
    - `property_id` = lead.property_id
    - `visit_date` = mañana 10:00 (default)

### 1.3 Frontend Agenda (visits)
- `loadVisits()`: JOIN `leads` para traer `full_name` + link a CRM
- `renderVisitRow()`: columna **Lead** con nombre + link a CRM
- `editVisit()`:
  - Si `lead_id` existe → muestra datos del lead + botón "🔗 Ver en CRM"
  - Si se asigna `lead_id` (era NULL) → al guardar, trigger DB actualiza lead a "visita"

### 1.4 Modal Visita (`visitModal`) – Mejoras
- Campo `lead_id` (select buscador de leads en stage "contactado"/"visita" sin visita futura)
- Pre-llenado automático al venir desde CRM
- Validación: si `lead_id` seleccionado → `property_id` y cliente se pre-llenan del lead

---

## Fase 2 – Unificación (2h)

### 2.1 CRM – Panel lateral Lead
- Sección "Visitas" en `editLead()`:
  - Próxima visita: fecha + estado + botón "Ver en Agenda"
  - Historial: últimas 5 visitas (fecha, estado, notas)

### 2.2 Prompt "Completada → Oferta"
- En `editVisit()` al cambiar status a "completada":
  - Si `lead_id` existe y lead.stage = 'visita':
    - `confirm("¿Mover lead a Oferta?")` → Sí → `UPDATE leads SET stage='oferta'`

### 2.3 Auto-stage en Agenda
- Trigger ya maneja INSERT/UPDATE con `lead_id` → stage "visita"
- En `loadVisits()`: si visita tiene `lead_id` y lead.stage = 'contactado' → badge "⚠️ Sin sincronizar" (no debería pasar por trigger)

---

## Fase 3 – Calendario Visual (Opcional, ~2h)
- Vista mensual en pestaña Agenda (`tab-agenda`)
- Librería ligera: `vanilla-calendar` o grid CSS nativo
- Click en día → filtra visitas de ese día
- Click en visita → `editVisit(id)`

---

## Decisiones Pendientes (Confirmar antes de codear)

| # | Decisión | Recomendación |
|---|----------|---------------|
| 1 | **Visita completada → Oferta**: ¿Auto-silencioso o **prompt confirmación**? | **Prompt** ("¿Mover lead a Oferta?") |
| 2 | **Crear visita en Agenda sin lead** (`lead_id` NULL): ¿Permitido? | **Sí** (visita espontánea), no toca CRM |
| 3 | **Editar visita y asignar lead_id** (era NULL): ¿Disparar stage "visita"? | **Sí** (trigger lo maneja) |
| 4 | **Lead sin propiedad**: ¿Permitir agendar visita si `property_id` es NULL? | **Sí** con warning visual "⚠️ Sin propiedad asignada" |
| 5 | **Calendario visual**: ¿Fase 1 o Fase 3? | **Fase 3** (tabla actual funciona bien) |

---

## Criterios de Aceptación (Definition of Done)

1. ✅ Lead "contactado" → "📅 Agendar visita" → modal pre-llenado → guardar → lead.stage = "visita"
2. ✅ Agenda: crear visita con `lead_id` (lead en "contactado") → lead.stage = "visita" (trigger)
3. ✅ Agenda: editar visita, asignar `lead_id` → lead.stage = "visita" (trigger)
4. ✅ Agenda: click en lead de visita → abre CRM en ese lead
5. ✅ CRM: lead card muestra próxima visita + botón "Ver en Agenda"
6. ✅ Visita "completada" → prompt → lead.stage = "oferta"
7. ✅ Sin errores consola, `react-doctor` 100/100, `node --check` OK

---

## Archivos a Modificar (Estimado)

| Archivo | Cambios |
|---------|---------|
| `supabase/migrations/XXXX_integracion_crm_visitas.sql` | Triggers bidireccionales |
| `assets/js/admin-app.js` | `loadCRM`, `loadVisits`, `editLead`, `editVisit`, `openVisitModal`, botones bidireccionales |
| `admin.html` | Mejoras en `visitModal` (selector de lead, pre-llenado) |

---

## Próximos Pasos

1. **Confirmar decisiones pendientes** (4 puntos arriba)
2. **Ejecutar migración SQL** (triggers)
3. **Implementar Fase 1** (Core)
4. **Validar bidireccionalidad completa** (tests manuales + Playwright)
4. **Fase 2** (unificación + prompt oferta)
5. **Commit + push** → `react-doctor` 100/100

---

¿Confirmás las 4 decisiones pendientes y arranco con Fase 1?