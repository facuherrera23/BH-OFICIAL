# Agenda (Calendario Unificado)

> Documento de diseño e implementación del módulo **Agenda** del panel admin.
> Reemplaza a la pestaña "Agenda de Visitas" (tabla + calendario de visitas).

---

## 1. Objetivo

Unificar en **un solo calendario** todo lo que exige acción o registro en el CRM,
cubriendo **Leads** y **Propietarios**, con:

- **Tres vistas**: Mes, Semana y Día.
- **Colores por tipo de evento** (visitas, llamadas, notas, tareas, emails,
  seguimientos, alertas, comisiones, documentos, contactos).
- **Filtros combinables**: estado, tipo y broker.
- Acción por click que abre el registro correspondiente en el CRM.

La tabla de visitas en grid y las exportaciones `.ics`/`.csv` **se eliminan**
(decisión tomada: "solo calendario").

---

## 2. Fuentes de datos

El calendario unificado consolida 6 fuentes en un modelo de evento común
(`calEventsCache`). Todas las queries usan el cliente autenticado de Supabase
(`getAuthedClient()`), con joins a los nombres de leads/propietarios para el
subtítulo.

| Fuente | Columna de fecha | Tipo de evento | Subtítulo | Acción al click |
|---|---|---|---|---|
| `visits` | `visit_date` | `visita` | lead + propiedad | `editVisit(id)` |
| `lead_tasks` | `due_at` | `tarea` | lead | `editLead(lead_id)` |
| `lead_activities` | `created_at` | según `activity_type` | lead | `editLead(lead_id)` |
| `leads` (`next_followup_at` no nulo) | `next_followup_at` | `followup` | lead (stage) | `editLead(id)` |
| `owner_tasks` | `due_date` | según `type` | propietario + agente | `editOwner(owner_id)` |
| `owner_timeline_entries` | `created_at` | según `type` | propietario | `editOwner(owner_id)` |

### 2.1 Mapeo de `activity_type` → tipo de evento (lead_activities)

| activity_type | Tipo de evento |
|---|---|
| `call` | `llamada` |
| `note` | `nota` |
| `email` | `email` |
| `visit` | `visita` |
| `followup` | `followup` |
| `status_change` | `cambio` |
| `task` | `tarea` |

### 2.2 Mapeo de `type` → tipo de evento (owner_tasks / owner_timeline_entries)

| type | Tipo de evento |
|---|---|
| `note` | `nota` |
| `alert` | `alerta` |
| `commission` | `comision` |
| `document` | `documento` |
| `contact` | `contacto` |

---

## 3. Modelo de evento unificado

```js
{
  key: 'visit-<id>' | 'lead-task-<id>' | 'activity-<id>' | 'followup-<leadId>' | 'owner-task-<id>' | 'timeline-<id>',
  type: 'visita' | 'llamada' | 'nota' | 'email' | 'followup' | 'tarea' | 'cambio' | 'alerta' | 'comision' | 'documento' | 'contacto',
  source: 'visits' | 'lead_tasks' | 'lead_activities' | 'leads' | 'owner_tasks' | 'owner_timeline',
  entity: 'lead' | 'owner' | 'visit',
  date: Date,
  title: string,        // texto principal del evento
  subtitle: string,     // quién (lead / propietario)
  status: string,       // status del registro origen (cuando aplica)
  brokerId: string,     // agent_id / assigned_to (para filtro broker)
  onClick: 'window.adminApp.editX(...)',
  leadId: uuid | null,
  ownerId: uuid | null,
}
```

---

## 4. Colores por tipo

Paleta coherente con el tema oscuro del panel (fondo rgba + texto del mismo tono).

| Tipo | Clase | Fondo / texto |
|---|---|---|
| visita | `.cal-event.ev-visita` | `rgba(16,185,129,.14)` / `#34d399` |
| llamada | `.cal-event.ev-llamada` | `rgba(59,130,246,.14)` / `#60a5fa` |
| nota | `.cal-event.ev-nota` | `rgba(245,158,11,.14)` / `#fbbf24` |
| email | `.cal-event.ev-email` | `rgba(6,182,212,.14)` / `#22d3ee` |
| followup | `.cal-event.ev-followup` | `rgba(249,115,22,.14)` / `#fb923c` |
| tarea | `.cal-event.ev-tarea` | `rgba(139,92,246,.14)` / `#a78bfa` |
| cambio | `.cal-event.ev-cambio` | `rgba(148,163,184,.14)` / `#94a3b8` |
| alerta | `.cal-event.ev-alerta` | `rgba(239,68,68,.14)` / `#f87171` |
| comision | `.cal-event.ev-comision` | `rgba(16,185,129,.18)` / `#6ee7b7` |
| documento | `.cal-event.ev-documento` | `rgba(99,102,241,.14)` / `#818cf8` |
| contacto | `.cal-event.ev-contacto` | `rgba(236,72,153,.14)` / `#f472b6` |

Las clases por estado de visita existentes (`.pendiente`, `.confirmada`, …) se
conservan en CSS pero la agenda las usa como complemento: el chip muestra el
color del **tipo** y, si el evento tiene estado, lo indica con un punto de
status al inicio.

---

## 5. Vistas

`calViewMode`: `'month' | 'week' | 'day'` (antes `'table' | 'calendar'`).

- **Mes**: grid de 7 columnas (Dom–Sáb) y 6 filas. Hasta 3 chips por día;
  `+N más` **salta a la vista día** de esa fecha (reemplaza el bug de
  `filterVisitsByDate` que no estaba definida).
- **Semana**: 7 columnas con todas las celdas del rango lunes-domingo
  (configurable por el mismo `calCurrentDate`), cada celda lista sus eventos.
- **Día**: columna única con todos los eventos del día ordenados por hora.

Navegación `prev`/`next`/`hoy` según la vista activa:
- mes → suma/resta 1 mes
- semana → suma/resta 7 días
- día → suma/resta 1 día

---

## 6. Filtros

| Filtro | Elemento | Lógica |
|---|---|---|
| Estado | `#calStatusFilter` | Coincidencia exacta con `event.status` (solo aplica a eventos con status) |
| Tipo | `#calTypeFilter` (nuevo) | Coincidencia con `event.type` |
| Broker | `#calBrokerFilter` | Coincidencia con `event.brokerId` |

Se rellena el selector de brokers con `agents` activos
(`populateBrokerFilters()`, ya existente).

---

## 7. Cambios por archivo

### `admin.html`

- Nav: "Agenda de Visitas" → **"Agenda"** (item `tab-agenda`).
- Panel: título "Agenda de Visitas — Vista Global" → **"Agenda"**; subtítulo
  actualizado.
- Se elimina el bloque `#visitsTableView` (tabla + paginación + filtro de
  brokers de tabla) y los botones de exportación `.ics`/`.csv`.
- El toggle `viewCalendarBtn` / `viewTableBtn` se reemplaza por un **switcher de
  vista** (Mes / Semana / Día).
- Se agregan: filtro por tipo (`#calTypeFilter`) y **leyenda de colores**.

### `assets/js/admin-app.js`

- `titles['tab-agenda']`: → `'Agenda'`.
- `loaders['tab-agenda']`: `loadVisits` → **`loadAgenda`**.
- Nueva `loadAgenda()`: 6 queries en paralelo (`Promise.all`), normaliza y
  puebla `calEventsCache`, luego `renderCalendar()`.
- `renderCalendar()`: despacha a `renderCalendarMonth/Week/Day` según
  `calViewMode`.
- Se elimina código muerto de tabla: `updateViewToggle()`, listeners de
  `viewCalendarBtn`/`viewTableBtn`, paginación (`_visitsPage*`), filtro de
  tabla `visitsBrokerFilter` y su listener; el render de tabla dentro de
  `loadVisits` original.
- `loadVisits()` original se convierte en un alias delgado que delega en
  `loadAgenda()` (los call-sites de refresco tras alta/baja de visita quedan
  intactos) **o** se renombran los call-sites. **Decisión final**: se renombra
  la función a `loadAgenda()` y se actualizan todos los call-sites.
- El `+N más` abandona `filterVisitsByDate` (no definida) y llama a
  `goToDayView(dateStr)`.
- Índice de búsqueda: la entrada `Agenda` ya existía y se mantiene.

### `assets/css/admin.css`

- `#viewCalendarBtn.active` / `#viewTableBtn.active` → reglas del switcher
  `.cal-view-btn.active`.
- Nuevas vistas: `.calendar-week-grid`, `.cal-week-header`, `.cal-week-day`,
  `.calendar-day-view`, `.cal-day-event-item`.
- Colores por tipo: `.cal-event.ev-*`.
- Leyenda: `.calendar-legend` (ya existente) + chips `.badge-dot.ev-*`.

---

## 8. Flujo de datos

```
getAuthedClient()
  └─ Promise.all([visits, lead_tasks, lead_activities, leads(followup), owner_tasks, owner_timeline])
        └─ normalizar() → calEventsCache[] (eventos unificados)
              └─ renderCalendar()
                    ├─ aplicar filtros (status / tipo / broker)
                    ├─ mes   → renderCalendarMonth()
                    ├─ semana → renderCalendarWeek()
                    └─ día   → renderCalendarDay()
```

Refresco: al entrar a la pestaña (`loaders['tab-agenda']`), al crear/editar una
visita, al borrarla, al registrar llegada/salida, y al cambiar el filtro de
broker el calendario se re-renderiza en frío sobre `calEventsCache`.

---

## 9. Non-goals / alcance

- **Fuera de alcance**: las vistas por hora (hour-grid) en la vista día;
  se implementa lista vertical ordenada por hora.
- **Fuera de alcance**: drag & drop para re-agendar.
- **Fuera de alcance**: crear/editar eventos directamente desde la agendación;
  la acción abre el registro en el CRM.
- Actualmente **solo `agente`/`broker`/`super_admin` activos** usan el panel;
  no hay condicionales de rol dentro de la Agenda.

---

## 10. Decisiones

1. **Solo calendario**: se eliminan la tabla de visitas y las exportaciones.
2. **Modelo unificado en memoria**: un solo `calEventsCache` para todas las
   vistas y filtros (sin refetch por vista).
3. **Color por tipo, no por estado**: pedido explícito ("según la tarea tengan
   un color: visitas, llamadas, notas, etc.").
4. **`+N más` → vista día** para esa fecha (solución al broken link).
5. **Documentado en este archivo**.