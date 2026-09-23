# AUDITORÍA CRÍTICA — Usuarios & Permisos + Configuración

**Fecha:** 2026-09-23 · **Base:** `assets/js/admin-app.js`, edge functions (`manage-users`, `zernio-proxy`), policies en Supabase.

---

## Usuarios & Permisos — 25 puntos

### Seguridad
1. **Validación de email en alta de usuarios** — no se chequea formato en el cliente; un typo (`a@b`) genera invitación inválida.
2. **Comparación de email case-sensitive y con espacios** — al editar, si escribís `" Leandro@Mail.com "` se guarda así; hay que normalizar a `lowercase+trim` antes de comparar contra `profiles`.
3. **Sin bloqueo de dominio permitido** — cualquier email de cualquier dominio puede ser invitado (puede ser un alias comprometedor).
4. **Sin rate limit en invitaciones** — podés abrir/cerrar el modal y armar spam de emails sin límites.
5. **Sin log propio de cambios de rol** — si se le da/quita super_admin, queda en `audit_log` pero no se muestra en la UI; hay que crear vista de historial de seguridad por usuario.
6. **Contraseña temporal se muestra en claro una sola vez** sin botón de "copiar" — re-paste en chat sin querer.
7. **No hay "revocar sesiones"** — si un usuario comprometido sigue logueado, no hay forma de forzar cierre de sesión desde el panel (necesita logouts forzados o expiry corta).
8. **is_active=false no revoca el token** — el JWT sigue vivo hasta expiry; hay que refrescar profiles post desactivación.
9. **No hay confirmación de contraseña al crear usuario directo** — si escribís mal el temp se persistió.
10. **No hay validación de unicidad de email en el cliente** — la inserción falla con error genérico de Supabase, sin XPath exacto.

### UX / Funcionalidad
11. **El toggle de Activar/Desactivar no pregunta "¿qué pasa con sus leads?** — no solo desactivás el acceso; las leads asignadas quedan huérfanas sin humano assigned_to.
12. **El botón "Editar" desaparece si sos agente** para ver tu propio perfil — que sea "Mi cuenta" siempre visible.
13. **La grilla no muestra "Último acceso"** (last_sign_in_at de auth.users) — no sabés quién está activo de verdad.
14. **No se puede asignar un broker/agente a una propiedad o lead desde el editor de usuario** — tenés que ir al módulo, editar, guardar y volver.
15. **Falta una vista "mis actividades"** del usuario propio (sus cambios recientes en otros módulos).
16. **No hay avatar inicial con iniciales** si no hay foto — queda el placeholder genérico.
17. **El rol se cambia desde el select sin confirmación excepto para super_admin** — podés pasar de broker a agente sin darte cuenta y romperse la cascada.
18. **No hay "ver como" (impersonar)** — un admin debería poder ver exactamente lo que ve un agente (para soporte), ley de propiedad sobre datos.
19. **No se puede re-enviar una invitación** — si el mail se perdió, tenés que borrar y volverlo a crear.
20. **No hay bloqueo de edición mientras se guarda** — doble click dispara dos mutate.

### Negocio / coherencia CRM
21. **Si un usuario se desactiva, sus leads quedan asignados pero no reasignan** — hay que lanzar a "sin asignar" o pedir "reasignar a broker X".
22. **No hay KPI de actividad del broker** (visitas hoy, contactos en estas últimas 48h) — se ve en el CMS de modulos, no dentro de Usuarios.
23. **Sin contacto rápido desde el panel** — desde la ficha de usuario no hay botón WhatsApp o llamar.
24. **Los filtros de roles (品 solo por rol) — hay que refinar por estado, fecha de ingreso, actividad.
25. **Exportar lista de usuarios a CSV** no está disponible (necesario para auditoría externa / RRHH).

---

## Configuración — 25 puntos

### UX / Diseño
1. **El tab Configuración depende de `getAuthedClient`** — si la sesión se corta, se queda colgado sin feedback (toast no avisa).
2. **No hay botón "Deshacer cambios en esta sesión"** — te perdés qué editaste.
3. **Las secciones Config/CMS están separadas** (contacto/footer/social acá, el resto allá) — confunde. Consolidar o renombrar.
4. **El placeholder del `usd_rate` no advierte formato** (permite "abc23" y falla en guardar).
5. **El toggle de Zernio API Key muestra/oculta pero no marca "cambiado"** — no responde al `showToast`.
6. **"Probar conexión" no muestra latencia ni detalle del check** (solo OK/error global).
7. **No hay timestamp relativo del último probe** (test ok hace 12s vs hace 2h).

### Validación / datos
8. **`usd_rate` es manual — no hay actualización automática** con una API de cotización, ni aviso si pasan más de 7 días.
9. **No hay validación de formato de CBU/CBU para comisiones** ni convertibilidad de moneda en el módulo.
10. **Las ediciones a `site_content` en config no validan estructura** — si un campo es JSON anidado queda corrupto.
11. **No hay control de retenciones manuales** (IIBB, ganancias) — no se valida contra un valor piso/techo razonable (ej: >0%).
12. **No se puede pre-cargar o importar un ESP JSON de configuración** (migración de dados).
13. **La política RLS de `app_settings` permite `INSERT` a cualquiera autenticado** — un usuario malicioso pisa `preferences`. Mover a staff-only.

### Integraciones
14. **El webhook de Zernio no se levanta con botón" (y tampoco el webhook de ML).** hay que copiar URL manual — complejo sin guía inline en el admin.
15. **Falta una vista de rotación de teléfono** — el landing usa dos líneas rotativas y eso no está declarado acá.
16. **ReIF** no tiene una UI de persistencia para `OWNER_PORTAL_TOKEN` (revocar / re-generar).
17. **No hay modo sandbox vs producción portable** para testear pagos/datos que pueda cambiar sin tocar producción.

### Persistencia / resiliencia
18. **Guardar está un poco roto entre secciones** — si pisás valores de un tab y cambiás a otro sin guardar, perdes lo que tenías. Bubble up o snapshot.
19. **No hay versionado de cambios** (content_history).
20. **El módulo no te avisa si una configuración crítica está rota** (p.ej. SMTP vacío, Cloudinary sin API keys).
21. **No hay buscador dentro de las configuraciones largas** (para footers / FAQs grandes).

### UI / estilo
22. **La fuente en inputs tipo "readonly" grises extraña** — no hay distinción visual de "bloqueado por rol".
23. **No hay soporte multi-idioma** ni modo oscuro toggle persistido (keys no persisten entre sesiones).
24. **El nombre del sistema y logo no son configurables** — están hardcodeados en el HTML.
25. **El horario de la semana es libre-text** — debería ser días de checkbox + horario rango validado, no strings libres.

---

## Siguiente paso
Recomiendo implementar primero: U1, U5, U11, U17 (permisos y roles), C5, C13, C17, C18 (config resistente). Después se profundizan los dos módulos con tests E2E.
