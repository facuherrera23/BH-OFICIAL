# SUPER_ADMIN_SUPERVISION.md

## Centro de Supervisión - Documentación Técnica

**Proyecto:** Bienenhaus Propiedades  
**Repositorio:** BH-OFICIAL  
**Fecha:** 2026-08-24  
**Versión:** 1.0

---

## 1. Resumen Ejecutivo

El Centro de Supervisión (`tab-supervision`) es un módulo exclusivo para `super_admin` que proporciona visibilidad completa del uso operativo del sistema por parte de empleados. Permite detectar errores, anomalías, acciones sensibles y patrones de uso sin ser una herramienta de vigilancia invasiva.

**Principio fundamental:** Auditoría ≠ Vigilancia. Solo se registran metadatos operativos relevantes. No se almacenan contraseñas, tokens, API keys, contenido de chats ni datos personales innecesarios.

---

## 2. Arquitectura

### 2.1 Capas de Seguridad (Defense in Depth)

| Capa | Implementación |
|------|----------------|
| **Frontend** | `if (profile.role !== 'super_admin') hideSupervision()` |
| **Backend (Edge Function)** | `requireSuperAdmin()` valida `profiles.role = 'super_admin'` |
| **Base de Datos (RLS)** | Políticas `is_super_admin(auth.uid())` en todas las tablas de supervisión |

### 2.2 Flujo de Datos

```
[Eventos UI / Edge Functions / Triggers DB]
         ↓
[audit_log / usage_events / supervision_alerts] (Append-only)
         ↓
[supervision-api Edge Function] → [RLS: solo super_admin]
         ↓
[Frontend: tab-supervision] ← [Realtime subscriptions]
```

### 2.3 Tablas Principales

| Tabla | Propósito | Retención |
|-------|-----------|-----------|
| `audit_log` | Cambios persistentes (CRUD, acciones sensibles) | 12 meses |
| `usage_events` | Métricas de uso (exports, navegación, bulk ops) | 6 meses |
| `supervision_alerts` | Alertas generadas por reglas | 12 meses |
| `supervision_rules` | Reglas configurables de detección | Permanente |

---

## 3. Vistas del Centro de Supervisión

### 3.1 Resumen (`summary`)
KPIs del día: usuarios activos, acciones totales, acciones sensibles, errores, alertas abiertas, alertas críticas. Actividad reciente y alertas recientes.

### 3.2 Actividad en Vivo (`activity`)
Timeline en tiempo real (últimos 100 eventos) con filtros por usuario, módulo, acción, entidad, estado.

### 3.3 Usuarios (`users`)
Tabla agregada por empleado: acciones totales, errores, acciones sensibles, exportaciones, alertas. Comparativas vs promedio equipo/rol/periodo anterior. Click abre modal detalle.

### 3.4 Módulos (`modules`)
Mapa de uso por módulo: acciones totales, usuarios únicos, errores, exportaciones, eliminaciones.

### 3.5 Alertas (`alerts`)
Lista con severidad, tipo, usuario, módulo, título, fecha, estado. Acciones: Ver evidencia, Reconocer, Resolver, Descartar. Cada acción sobre alerta se audita.

### 3.6 Auditoría Avanzada (`audit`)
Tabla unificada de `audit_log` + `supervision_alerts` ordenada por fecha. Click abre modal detalle con before/after, campos modificados, metadata, IP, Request ID.

### 3.7 Reglas (`rules`)
CRUD de `supervision_rules`: nombre, módulo, acción, condición JSON, severidad, cooldown, habilitado. Solo super_admin.

---

## 4. Sistema de Reglas y Alertas

### 4.1 Reglas por Defecto (18 reglas)

| Regla | Módulo | Acción | Umbral | Ventana | Severidad |
|-------|--------|--------|--------|---------|-----------|
| `bulk_export_detection` | Todos | export | 30 | 1h | medium |
| `critical_bulk_export_detection` | Todos | export | 100 | 1h | high |
| `bulk_delete_detection` | Todos | delete | 10 | 10min | high |
| `bulk_publish_ml_detection` | portales | publish | 20 | 1h | medium |
| `bulk_price_change_detection` | properties | update | 15 | 1h | medium |
| `role_change_detection` | users | update_sensitive | 1 | 1h | high |
| `user_deactivation_detection` | users | update_sensitive | 1 | 1h | high |
| `privilege_escalation_attempt` | users | update_sensitive | 1 | 1h | critical |
| `repeated_errors_detection` | Todos | — | 5 | 15min | medium |
| `critical_edge_function_errors` | Edge | error | 3 | 15min | high |
| `sensitive_config_change` | config | update | 1 | 1h | high |
| `permission_denied_threshold` | Todos | 403/401 | 10 | 1h | medium |
| `rate_limit_exceeded_threshold` | Todos | 429 | 5 | 1h | medium |
| `bulk_crm_operations` | crm | bulk_operation | 20 | 1h | medium |
| `bulk_ficha_html_export` | ficha_html | export | 50 | 1h | medium |
| `off_hours_activity` | Todos | — | 20 | 1h (22-06) | low (disabled) |
| `suspicious_sequence_user_create_role_export` | users | sequence | — | 30min | high |

### 4.2 Evaluación Automática
- **pg_cron job:** `evaluate_supervision_rules()` cada 5 minutos (`*/5 * * * *`)
- **Cooldown:** Evita alertas duplicadas por regla/usuario
- **Evidencia:** JSON con conteo, umbral, ventana, regla disparada

### 4.3 Estados de Alerta
- `open` → `acknowledged` → `resolved` / `dismissed`
- Cada transición se audita en `audit_log`

---

## 5. Modelo de Datos

### 5.1 audit_log
```sql
id, user_id, role_snapshot, broker_id, action, module, table_name,
record_id, entity_type, entity_id, entity_label,
old_data, new_data, changed_fields, metadata,
status, error_code, ip, user_agent, session_id, request_id, created_at
```
- `old_data` / `new_data`: JSON sanitizado (campos sensibles redactados automáticamente)
- `metadata`: `{ request_id, session_id, duration_ms, trigger: true, operation: 'INSERT|UPDATE|DELETE' }`

### 5.2 usage_events
```sql
id, user_id, role_snapshot, broker_id, module, event_type, action,
entity_type, entity_id, metadata, status, duration_ms,
session_id, request_id, created_at
```
`event_type`: `tool_usage`, `navigation`, `api_call`, `export`, `bulk_operation`

### 5.3 supervision_alerts
```sql
id, user_id, module, severity, alert_type, title, description,
evidence, status, acknowledged_by, acknowledged_at,
resolved_by, resolved_at, dismissed_by, dismissed_at, created_at
```
`severity`: `info`, `low`, `medium`, `high`, `critical`

### 5.4 supervision_rules
```sql
id, name, description, module, action, event_type, condition,
severity, enabled, cooldown_minutes, created_by, created_at, updated_at
```
`condition`: JSON `{ metric, operator, threshold, window, group_by, filter }`

---

## 6. Sanitización de Datos Sensibles

Lista negra automática (recursiva en JSON):
```
password, password_hash, api_key, access_token, refresh_token,
client_secret, secret, encryption_key, authorization, cookie,
session_token, jwt, bearer, private_key, service_role_key,
anon_key, signing_secret, webhook_secret, ml_client_secret,
ml_access_token, ml_refresh_token, zernio_api_key, brevo_api_key,
cloudinary_api_secret, crypto_secret, smtp_password
```
Función: `sanitize_audit_payload()` (DB) / `sanitizeAuditPayload()` (Edge)

---

## 7. API - supervision-api Edge Function

**Base URL:** `https://<project>.supabase.co/functions/v1/supervision-api`

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/summary` | GET | KPIs + actividad reciente + alertas recientes |
| `/live` | GET | Timeline actividad en vivo (params: limit, modules) |
| `/audit` | GET | Auditoría paginada (filtros: user, module, action, entity, status, dates) |
| `/usage` | GET | Eventos de uso paginados |
| `/alerts` | GET | Alertas paginadas (filtros: user, module, severity, type, status, dates) |
| `/rules` | GET/POST/PATCH/DELETE | CRUD reglas |
| `/detail` | GET | Detalle evento (params: event_id, type=audit\|alert) |
| `/user` | GET | Detalle usuario (params: user_id, days) |
| `/modules` | GET | Stats por módulo (params: days) |
| `/export` | GET/POST | Export CSV (params: type=audit\|usage\|alerts, format) |
| `/alert-action` | POST | Acciones sobre alerta (acknowledge, resolve, dismiss) |

**Autenticación:** Bearer token, validación `profiles.role = 'super_admin'`
**Rate limit:** 60 req/min por IP

---

## 7. Frontend - Componentes

### 7.1 Tab ID
`tab-supervision` (solo visible si `profile.role === 'super_admin'`)

### 7.2 Sub-vistas (7)
| ID | Componente |
|------|------------|
| `supvViewSummaryContent` | KPIs + actividad + alertas |
| `supvViewActivityContent` | Timeline tiempo real |
| `supvViewUsersContent` | Tabla usuarios + click → modal detalle |
| `supvViewModulesContent` | Grid módulos |
| `supvViewAlertsContent` | Tabla alertas + acciones |
| `supvViewAuditContent` | Tabla unificada audit+alertas |
| `supvViewRulesContent` | CRUD reglas |

### 7.3 Realtime
Suscripciones a:
- `audit_log` INSERT → actualiza actividad viva + KPIs
- `supervision_alerts` INSERT/UPDATE → recarga vistas + toast

### 7.4 Exportación
Botones en header: Audit CSV, Uso CSV, Alertas CSV. La exportación se audita.

---

## 8. Integración con Módulos Existentes

### 8.1 Triggers de Auditoría Automática
Tablas auditadas: `properties`, `leads`, `visits`, `agents`, `owners`, `tasaciones`, `ml_listings`, `site_content`, `profiles`, `app_settings`, `zernio_conversations`, `zernio_messages`, `zernio_accounts`, `ml_sync_queue`, `ml_sync_history`, `portal_settings`

Trigger genérico: `audit_trigger_fn()` → `insert_audit_log()`

### 8.2 Trigger Especial `profiles`
`profiles_audit_trigger_fn()` detecta cambios en `role`, `is_active`, `email` → `action: 'update_sensitive'`

### 8.3 Edge Functions Instrumentadas
Todas las funciones admin usan `withAudit()` middleware o helpers `auditEvent()`, `usageEvent()`, `trackToolUsage()`, `trackExport()`, `auditBulkOperation()`, `auditError()`.

### 8.4 Navegación Contextual
- Tab Usuarios → botón "Ver actividad" → `tab-supervision?user_id=`
- Ficha Propiedad/Lead/Tasación/Visita → "Ver historial" → auditoría filtrada por entidad

---

## 9. Consultas Útiles

### 9.1 Vistas Materializadas
```sql
daily_user_activity    -- Agregados diarios por usuario
daily_module_activity  -- Agregados diarios por módulo
daily_action_counts    -- Conteos por acción/día
daily_alert_counts     -- Conteos alertas por día
open_alerts_by_user    -- Alertas abiertas por usuario/severidad
alerts_by_module       -- Alertas por módulo/severidad/estado
```

### 9.2 Consultas de Seguridad
```sql
-- Verificar RLS
SELECT * FROM audit_log; -- Solo super_admin

-- Usuarios con más alertas críticas
SELECT user_id, COUNT(*) FROM supervision_alerts 
WHERE severity = 'critical' AND status = 'open' GROUP BY user_id;

-- Top exportadores
SELECT user_id, COUNT(*) FROM audit_log 
WHERE action = 'export' AND created_at > now() - interval '24h' 
GROUP BY user_id ORDER BY COUNT(*) DESC;
```

---

## 10. Despliegue y Mantenimiento

### 10.1 Migraciones (Orden)
1. `20260824000001_audit_system_foundation.sql` - Tablas, funciones, triggers, RLS
2. `20260824000002_supervision_rules_defaults.sql` - Reglas por defecto, vistas, pg_cron
3. `20260824000003_pg_cron_supervision_rules.sql` - Job pg_cron

### 10.2 Edge Functions
```bash
supabase functions deploy supervision-api
```

### 10.3 Verificación Post-Deploy
```bash
# Sintaxis
node --check assets/js/admin-app.js
node --check assets/js/landing-app.js

# Calidad
npx react-doctor@latest --verbose

# Migraciones
supabase migration list

# pg_cron job activo
SELECT * FROM cron.job WHERE jobname = 'evaluate-supervision-rules';
```

---

## 11. Troubleshooting

| Problema | Causa | Solución |
|----------|-------|----------|
| Tab no visible | Usuario no es super_admin | Verificar `profiles.role` |
| 403 en API | Token expirado / rol incorrecto | Re-login / verificar perfil |
| Alertas no disparan | pg_cron no activo | `SELECT cron.schedule(...)` |
| Export falla | Token inválido | Re-login |
| Realtime no actualiza | Canal no suscrito | Verificar consola / Realtime habilitado |

---

## 12. Roadmap Futuro

- [ ] Scoring de riesgo (`risk_signal_score`) explicable
- [ ] Cadena de integridad (`previous_hash`, `event_hash`)
- [ ] Portal de auditoría para auditores externos
- [ ] Notificaciones push/email para alertas critical
- [ ] ML-based anomaly detection (fase 2)
- [ ] Retención configurable por tabla

---

## 13. Contacto

**Equipo:** Bienenhaus Propiedades  
**Repo:** https://github.com/facuherrera23/BH-OFICIAL  
**Supabase:** rnldqiwwzhjnurkguihu

---

*Documento generado automáticamente - Actualizar con cada release*