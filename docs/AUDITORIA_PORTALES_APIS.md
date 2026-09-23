# AUDITORÍA PROFUNDA — Módulo Portales & APIs
**Fecha:** 2026-09-23 · **Alcance:** tab Portales (admin-app.js), ml-* y rela-* edge functions, tablas `portal_settings`, `ml_*`, `rela_*`, `ml_sync_*`, crons asociados.

Estado tras las rondas ya aplicadas: funciona y es usable, pero hay problemas estructurales (deuda técnica y de seguridad) que conviene atacar antes de agregar features. El detalle está abajo con prioridades.

---

## A. Seguridad (crítico primero)

**A1. Secrets en texto plano en `portal_settings`.**
`api_key`/`api_secret` se guardan en claro y la UI los prefill (`openPortalConfig` pinta el valor en el input password). RLS staff-only mitiga lectura casual, pero sigue siendo pirable por un super_admin comprometido. → Cifrar con pgcrypto o dejarlos solo vía edge function y nunca exponerlos al cliente (el modal debería escribir sin leer — "guardado, click para reestablecer").

**A2. `rela_config` es legible por cualquier autenticado.**
Policy `rela_config_read ... USING (true)`. No guarda el secret ML, pero expone datos operativos de la inmobiliaria (código, contacto, URLs internas del plan). Ajustar a lectura staff.

**A3. `ml_sync_history` y `ml_sync_queue` con policy `USING (true)` para autenticados.**
Cualquier rol (incluido agente) lee toda la historia y la cola de sync: contiene errores de ML que mencionan IDs, montos y estados. Restringir a staff.

**A4. `ml-webhook` no valida identidad de ML.**
El endpoint es público (correcto para webhooks), pero no comparte firma HMAC en este nivel (está en ml-webhook/index.ts; vale verificar que aplica a todas las acciones, no solo a `items`). Un bot externo puede inyectar un "order" falso si falta la firma en post-question. → Confirmar que la firma se valida para todos los topics antes de procesar.

---

## B. Deuda técnica que ya muerde

**B5. Portales "fantasma" en las cards (ZonaProp, Argenprop, Argentpropiedades, Properati, MiArgPropiedad).**
El toggle y el form de config escriben en `portal_settings` pero **no hay edge functions** para esos portales. Activarlos prende una luz verde sin efecto — el usuario cree que se publica y no pasa nada. Acciones posibles:
1. Ocultarlos hasta implementar (más honesto).
2. Etiquetarlos como "próximamente" (candado UI).
3. Implementar al menos uno (Properati/ZonaProp duplica la cobertura de RELA).
Recomiendo 2 por ahora.

**B6. "Sincronizar Todo" solo refresca la UI.**
El nombre promete sync real; actualmente solo refresh del estado. O lo renombramos "Actualizar estado" o dispara los sync reales (ml-sync-import + rela reconcile/secuencias).

**B7. Historial de sync limitado a ML.**
`loadSyncHistory` solo lee `ml_sync_history`. RELA tiene eventos propios (`rela_webhook_events`, audit log) que no aparecen en la tabla. Unificar vista con join/union y columna Portal verdadera (hoy siempre dice "Mercado Libre").

**B8. Doble fuente de credenciales ML.**
`portal_settings` guarda `api_key`/`api_secret` y `ml-config` (edge fn) guarda lo mismo para MLOAuth. Dos lugares para el mismo dato → divergencia posible. Unificar en `ml_config` o en una sola tabla con `pgcrypto`.

**B9. RELA panel sin gating claro en UI de configuración.**
El form del modal RELA usa `update` directo contra `rela_config` con RLS solo verificando super_admin, pero el modal se puede abrir desde cualquier rol… la UI no lo bloquea hasta el click de guardar (ya se cerró en última ronda) — solo verificar que el cierre cubre todos los puntos de entrada (atajo de consola etc.).

**B10. El estado de ML se obtiene por TTL + por evento, dos caminos distintos.**
Hay que consolidar a una sola función `refreshMlState()` que actualice badge + tarjetas + historial en un solo lugar; lo que hay ahora son múltiples puntos de parche de estado en el código.

---

## C. Funcionalidad faltante (impacto de negocio)

**C11. No hay preguntas de Mercado Libre en el módulo.**
Existe `ml_questions` en DB y `ml-answer-question` como edge fn pero no hay UI para revisarlas/responderlas. Alta prioridad: las preguntas de ML sin respuesta = anuncios muertos.

**C12. No hay órdenes ML en el panel.**
`ml_orders` y `ml_payments` existen pero son ciegas para el staff. Vista mínima (lista + detalle con link al portal) es suficiente por ahora.

**C13. Métricas ML sin dashboard.**
`ml-metrics` existe, y hay visitas/ventas pero la tarjeta ML solo muestra conteo de activos. Falta: visitas últimos 7/30d, conversion (visitas→preguntas→ventas), distribución por anuncio.

**C14. Sync queue sin visibilidad para el usuario.**
`ml_sync_queue` existe y corre vía cron cada 5 min, pero si algo falla el usuario solo lo ve como "Falló" al vuelo. Falta una vista de cola: qué está programado, qué está en retry, qué está en dead letter. Idealmente en la misma tabla de historial o como drawer.

**C15. Importar desde ML devuelve un solo número.**
El usuario no sabe qué se importó, qué falló y por qué. Devolver resumen por fila (propiedad → estado) y refrescar listado al terminar.

**C16. Sin notificación de vencimiento de token ML.**
Los tokens ML vencen (cada 6 meses). No hay alerta activa — debería guardar `expires_at` y disparar un toast/email antes de que llegue y caiga toda la publicación.

**C17. RELA: callbacks sin integración al CRM.**
`rela_webhook_events` crea leads cuando llega un contacto pero no hay vista; y el badge `Callbacks: Sin configurar` no lleva a ningún accionable (cómo activarlos, qué URL usar).

**C18. Multi-foto publish no está optimizado.**
`ml-publish` funciona, pero no hay indicador de progreso por foto (ML a veces tarda). Conviene subir en paralelo con un toast de "2/5 fotos subidas".

**C19. Sin prueba de conectividad por portal.**
Cada card debería tener un botón "Probar" que llame al edge fn correspondiente y devuelva OK / error claro ( tiempo de respuesta, código). Hoy solo ML tiene esto vía `portal-status`.

**C20. No hay undo después de desconectar ML.**
El flujo tira confirmación pero si lo hizo por error, no puede reactivar sin re-oauthear. Añadir un graceful "desconectado, click para reactivar" dentro de las próximas 24 horas (todavía tengo el guard "loguear antes de desconectar" → falta confirmar con resumen de qué se pierde).

---

## D. Calidad de código (menor)

**D21. Funciones ML con lógica repetida.**
`mlApiCall` y `relaApiCall` son un duplicado de un solo tipo (token + AbortController + 15s + parse). Pueden factorizarse en un helper común. No urgente pero alto leverage.

**D22. Modal RELA mezcla serialización y validación.**
`parseJsonField` corre tres veces secuenciales. Con Zod se limpia mucho; pero ojo, esto requiere meter Zod en el edge también. Postergable si no hay errores.

**D23. El tab Portales lee properties solo para contar publicados.**
Innecesario: la card de ML no usa ese número. Cachear conteo en los settings para no llamar a la table.

**D24. Card de ML con token expirado no enseña el "hasta cuándo".**
Guardar y mostrar expiración estimada en la tarjeta de ML (usa ml_connection.expires_in).

**D25. Falta test E2E del módulo.**
Los tests existentes (agenda, propietarios, CRM, etc.) no tocan Portales. Añadir `tests/portales.spec.js` con: render de cards, toggling efectivo, ACL bloquea toggle si no-superadmin, sync history muestra filas, RELA panel siempre visible con CORS OK.

---

## Prioridad sugerida (si fuéramos a implementar)

| Prioridad | Items | Impacto |
|---|---|---|
| P0 | A1 (cifrar secrets), D25 (tests), A3 (history/queue), B6 (sync real) | Seguridad y no roturas |
| P1 | C11 (preguntas ML), C16 (token expira), C14 (queue UI) | Negocio |
| P2 | B7 (historial unificado), B5 (portales fantasma), C12 (órdenes), A4 (webhook firma) | Integridad de datos |
| P3 | Resto | Polishing |

## Recomendación de ejecución

Si me das luz verde, ataco **P0 + P1 + A4** (9 items) en esta misma rama sin pushear y quedás con el módulo al punto de poder delegarlo a un empleado. Después podemos fasear ordenes/métricas en otro sprint (2–3 días).
