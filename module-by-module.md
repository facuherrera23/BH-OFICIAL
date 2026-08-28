Inventario Completo — Cada Módulo del Panel Admin
1. DASHBOARD (tab-dashboard)
Qué tiene:
- 4 KPIs principales (propiedades activas, leads nuevos, visitas pendientes, facturación YTD)
- Listado de leads calientes (stages contacto/visita/oferta)
- Ranking de brokers por ventas YTD
- Alertas de supervisión recientes
- Filtros por mes y broker
Qué le falta para una inmobiliaria real:
- Gráfico de ventas por mes (solo tiene KPI numérico, no visual)
- Pipeline funnel visual (leads nuevo→cerrado)
- Mapa de propiedades por zona
- Tasa de conversión lead→venta
- Tiempo promedio de venta por zona
- Comparativa vs mes anterior (tendencia ↑↓)
- Visitas del día / agenda del día
- Notificaciones de vencimientos (contratos exclusividad, matrículas brokers)
- Widgets configurables (drag-drop de cards)
Relaciones: Consume datos de propiedades, leads, visitas, brokers, supervisión. Es el "resumen ejecutivo" que debería leer de todos los módulos.
2. PROPIEDADES (tab-propiedades) — CORE DEL NEGOCIO
Qué tiene:
- CRUD completo (crear, editar, eliminar con soft-delete)
- Tabla paginada con código secuencial (BH-0001), thumbnail, título, ubicación, precio, estado, badges (publicada/borrador/destacada/retasada/oportunidad)
- Modal de edición con: título, descripción, tipo (casa/departamento/terreno/local/oficina/galpón/quinta/otro), operación (venta/alquiler), zona, dirección, superficie, ambientes, dormitorios, baños, garage, precio USD/ARS, moneda
- Imágenes: carga vía Cloudinary, reordenamiento, eliminar individual
- Filtros por estado/operación
- Publicación a ML (validación previa: 3+ fotos, 100+ chars descripción, zona, precio, broker)
- Sync ML (actualizar, quitar de ML)
- Importar desde ML
- Badge de estado ML (En ML / Pausado)
- Zod validation (PropertySchema)
- Paginación con controls (anterior/siguiente/page size)
Qué le falta:
- Owner vinculado: El schema tiene owner_id pero el formulario de propiedad NO muestra selector de propietario. Un broker necesita saber de quién es cada propiedad.
- Visitas de la propiedad: No hay pestaña "Próximas visitas" dentro de la ficha de propiedad.
- Lead asociado: No hay lista de leads interesados en esa propiedad específica.
- Historial de cambios: ¿Quién cambió el precio? ¿Cuándo se publicó? Un audit trail básico.
- Comparables / tasación inline: Ver tasaciones relacionadas sin ir al módulo Tasaciones.
- Contacto del propietario: Datos del dueño accesibles directo desde la propiedad.
- Notas internas del broker: Campo privado que solo ve el broker asignado.
- Documentación: Contratos de exclusividad, plazos, comisiones pactadas.
- Multi-imagen carrusel en la tabla: Solo muestra 1 thumbnail. Los 5 fotos serían un hover preview.
- Búsqueda por texto: Solo filtros, no hay search box en propiedades.
- Ordenamiento: Solo created_at descendente. Falta ordenar por precio, zona, superficie.
- Duplicar propiedad: Copiar una existente como borrador (muy útil cuando hay propiedades similares).
- Cambios de precio: Cuando cambia el precio, ¿se actualiza automáticamente en ML? (sync status).
- Geolocalización: Campos lat/lng existen en schema pero no se editan en el formulario.
Relaciones: → Owner (propietario dueño), → Agent (broker asignado), → Leads (interesados), → Visits (agendadas), → Tasaciones (valoraciones), → ML Listings (publicaciones externas), → CMS (featured se muestra en landing).
3. CRM LEADS (tab-crm)
Qué tiene:
- Pipeline Kanban visual: nuevo → contactado → visita → oferta → cerrado/perdido
- Contadores por stage
- Cada lead muestra: nombre, tipo preferido, zona preferida, presupuesto USD
- Botón "Agendar visita" rápido desde la tarjeta (si no tiene visita futura)
- CRUD: crear, editar, eliminar
- Formulario con: nombre, email, teléfono, whatsapp, etapa, tipo/zona preferida, presupuesto, notas, tags
- Lead vinculado a propiedad y broker
- Source (landing/ml/chat/referido/tasacion/walkin/manual)
- Visitas asociadas se muestran en el modal de edición
- Zod validation (LeadSchema)
- Exportación CSV
- Badge de visitas pendientes por lead
Qué le falta:
- Scoring automático: El campo score existe (0-100) pero NO se calcula. Debería basarse en: completitud del perfil, interacción reciente, presupuesto vs precio promedio, zona matching.
- Tags visuales: El campo tags existe pero el formulario no permite agregar/editar tags con UI (solo el array se guarda).
- Drag & drop entre columns: El Kanban es visual pero no tiene drag-drop para mover leads entre stages.
- Filtros en el pipeline: Filtrar por broker, por source, por rango de fechas, por zona.
- Historial de actividad del lead: Timeline de: llamadas, emails enviados, visitas, notas. Cada interacción debería registrarse.
- Temperatura visual: El color del card debería cambiar según score (frío/templado/caliente).
- Lead duplicado detection: Si ingresa un lead con mismo teléfono o email, alertar.
- Comunicaciones: Registrar llamadas salientes, emails, WhatsApp. Botón "Registrar interacción".
- Métricas de conversión: ¿Cuántos leads pasan de nuevo a cerrado? ¿Cuánto tiempo tarda cada etapa?
- Lead scoring automático calculado: basado en: source (ML > landing > referido), completitud datos, días sin contacto, presupuesto match con propiedades disponibles.
- Filtros avanzados: Por rango de fechas creación, por último contacto, por score.
- Nota:_singleton_lead: El schema tiene next_action_at y next_action_note — campos para "próxima acción" que el formulario no expone.
Relaciones: → Property (propiedad de interés), → Agent (broker asignado), → Visits (visitas agendadas), → Conversations (chat asociado), → Properties (matching de propiedades por zona/precio).
4. AGENDA / VISITAS (tab-agenda)
Qué tiene:
- Calendario mensual navegable (prev/next/today)
- Toggle calendar/table view
- Eventos en el calendario con hora, nombre cliente, lead vinculado
- Click en día → filtra tabla a ese día
- "+3 más" si hay más de 3 eventos por día
- Filtro por estado (pendiente/confirmada/completada/cancelada)
- Tabla: fecha, cliente, lead CRM, propiedad, estado, vinculado, acciones
- CRUD visitas con: fecha, cliente, teléfono, email, notas, estado
- Lead selector dinámico en modal (muestra leads en stage contactado/visita)
- Auto-rellenar nombre/teléfono del lead seleccionado
- Check-in / check-out (campos en schema)
- Confirmation token para confirmación por email/link
Qué le falta:
- Drag & drop en calendario: Mover una visita de día arrastrándola. El README lo menciona pero no está implementado en el código.
- Recordatorios: El schema tiene confirmation_token pero no hay lógica de envío automático (24h antes, 1h antes).
- Vista semanal/diaria: Solo mensual. Un broker necesita ver "qué tengo mañana".
- Mapa de la propiedad: Al agendar, mostrar dónde queda la propiedad (lat/lng).
- Confirmación por WhatsApp: Enviar recordatorio vía WhatsApp en vez de solo email.
- Check-in/out real: Los campos existen pero el UI no tiene botón "Marcar llegada" / "Marcar salida".
- Duración estimada: El campo duration_minutes existe pero no se calcula ni se muestra.
- Conflictos de horario: Alertar si el broker ya tiene una visita en ese horario.
- Propiedad vinculada: El selector de propiedad en el formulario de visita es implícito (del lead). Debería permitir seleccionar propiedad directamente.
- Filtro por broker: ¿Quién tiene visitas hoy? Un admin debería ver por broker.
- Estadísticas de visitas: Cuántas completadas vs canceladas, tasa de conversión visita→oferta.
Relaciones: → Lead (CRM), → Property (propiedad visitada), → Agent (broker que visita), → Notifications (recordatorios).
5. BROKERS / ASESORES (tab-brokers)
Qué tiene:
- CRUD completo: nombre, email, teléfono, matrícula, vencimiento matrícula, foto (Cloudinary), comisión venta/alquiler, comisiones split (JSONB), horarios (JSONB), permisos (JSONB), estado (activo/inactivo/vacaciones)
- Tabla con badges de estado
- Zod validation (AgentSchema)
Qué le falta:
- Selector de usuario auth: Vincular broker con usuario del sistema (user_id). Actualmente el campo existe pero no hay UI para asignarlo.
- Dashboard del broker: Vista "Mis propiedades", "Mis leads", "Mis visitas" filtrada por el broker actual.
- Métricas individuales: Ventas del mes, leads activos, tasa de conversión, ranking vs otros brokers.
- Comisiones calculadas: Dado el precio de venta y el % de comisión, calcular cuánto gana cada broker.
- Horarios visuales: Los horarios están en JSONB pero no hay UI para configurarlos (calendar-like).
- Permisos granulares: El campo permissions es JSONB pero el formulario es un checkbox básico.
- Foto de perfil: La subida funciona pero no hay preview en la tabla.
- Historial de actividad: Cuántas propiedades vendió, cuántos leads cerró.
- Documentación: Matrícula, seguro, certificaciones.
- Disponibilidad: Estado "vacaciones" existe pero no hay calendario de disponibilidad.
Relaciones: → Properties (asignadas), → Leads (asignados), → Visits (asignados), → Commissions (cálculos), → Chat (asignación de conversaciones).
6. PROPIETARIOS (tab-propietarios)
Qué tiene:
- CRUD: nombre, DNI/CUIT, email, teléfono, dirección, contacto preferido, banco, CBU/CVU, alias CBU, exclusivo (boolean), notas
- KPIs: total, valor total propiedades exclusivas, contratos por vencer
- Zod validation (OwnerSchema)
- Búsqueda por texto en la tabla
Qué le falta:
- Propiedades del propietario: Lista de propiedades que posee (una propiedad puede tener owner_id).
- Contratos de exclusividad: Fechas de inicio/fin, tipo de contrato, comisión pactada.
- Documentación: DNI, escrituras, poder, constancia AFIP. El schema tiene documents JSONB pero no hay UI para cargarlos.
- Historial de comunicación: Timeline de llamadas, emails, visitas.
- Tasaciones del propietario: Ver tasaciones de sus propiedades.
- Estado de cuentas: ¿Se le pagó la comisión? ¿Cuándo fue el último pago?
- Portal propietario: Link mágico para que el dueño vea su propiedad, visitas programadas, estado de venta. (Mencionado en roadmap como futuro).
- Múltiples propietarios por propiedad: Hoy es 1:1. En realidad, una propiedad puede tener 2+ dueños (part indivisa).
- Notas cronológicas: Timeline de notas, no solo un campo de texto.
Relaciones: → Properties (propietario de), → Tasaciones (tasaciones de sus propiedades), → Leads (si el propietario es también lead), → Portal Propietario (futuro).
7. TASACIONES (tab-tasaciones)
Qué tiene:
- Lista paginada con título, estado (borrador/finalizada), fecha
- Abrir tasación en iframe (tasacion.html)
- Eliminar tasación
- Backfill de sesión vía postMessage (seguro)
- Zod validation (TasacionSchema)
- Schema: type (venta/alquiler/hipotecario/judicial), status, data JSONB, valuation_usd, report_url, expires_at
Qué le falta:
- Crear tasación desde el panel: Solo se puede abrir una existente en el iframe. No hay botón "Nueva tasación" que cree el registro en DB.
- Propietario vinculado: El schema tiene owner_id pero no hay selector en el UI.
- Broker vinculado: El schema tiene broker_id pero no hay selector en el UI.
- Propiedad vinculada: El schema tiene property_id pero no hay selector en el UI.
- Comparables inline: Ver las propiedades comparables dentro de la tabla, sin abrir iframe.
- Valoración resumen: Mostrar valuation_usd en la tabla (hoy solo muestra título y fecha).
- Exportar a PDF: El schema tiene report_url pero no hay botón "Generar PDF" visible.
- Historial de tasaciones de una propiedad: Ver todas las tasaciones de un inmueble.
- Vencimiento: Si expires_at pasó, mostrar "Vencida" en rojo.
- RPC de cálculo: La DB tiene calculate_valuation() pero no se invoca desde el panel.
Relaciones: → Property (propiedad tasada), → Owner (propietario que solicita), → Agent (broker que realiza), → Lead (si genera un lead de captación).
8. PORTALES / MERCADO LIBRE (tab-portales)
Qué tiene:
- Cards visuales por portal: Mercado Libre, ZonaProp, Argenprop, InmueblesCL
- Toggle activar/desactivar portal
- ML: OAuth 2.0 flow (popup), verificar estado, desconectar
- Publicar propiedad individual a ML
- Actualizar listing en ML
- Quitar de ML
- Importar desde ML
- Auto-reply config
- Dead-letter queue visible
- Configurar credenciales APP_ID/SECRET_KEY
- Sync de precios/estados
Qué le falta:
- Publicación masiva: Publicar todas las "publicadas" de golpe (el README lo menciona pero el código solo tiene individual).
- Sync automático: Cron job de sync en frontend (cada 5 min). Solo funciona si el admin tiene la pestaña abierta.
- Status de sync: Última vez que se sincronizó, cuántas propiedades actualizadas.
- Configuración por portal: ML tiene campos específicos (categoría, condición, etc.). ZonaProp y Argenprop no tienen configuración real todavía.
- Métricas: Clics, visitas, consultas por listing.
- Preguntas/respuestas: Ver preguntas de ML dentro del panel (el webhook las trae pero no hay UI).
- Configuración auto-reply: Templates por tipo de pregunta.
- Webhook management: Verificar que los webhooks están llegando.
- Errores ML: Ver el dead-letter queue con errores detallados.
- Preview antes de publicar: Ver cómo se verá el listing en ML antes de publicar.
Relaciones: → Properties (publicadas), → Leads (que llegan de ML), → Chat (preguntas de ML → zernio), → Edge Functions (ml-sync, ml-webhook).
9. CMS (tab-cms)
Qué tiene:
- 11 sub-tabs internos: Hero, Catálogo, Servicios, Equipo, Stats, Proceso, Contacto, Formulario, Navbar, Footer, SEO
- CAM_FIELD_MAP que mapea campos HTML a DB (hero_line1 → hero.title, etc.)
- Guardado por secciones (merge profundo)
- Preview de hero background
- Zod validation parcial
Qué le falta:
- Preview live: No hay preview en tiempo real. Cambiás el texto y recién se ve en el landing.
- Edición WYSIWYG: Todo es inputs de texto. No hay rich text para descripciones largas.
- Gestión de imágenes: Subir imágenes para servicios, equipo, etc. Hoy solo el hero tiene bg_image_url.
- i18n management: El CMS soporta locales (es/en/pt) pero no hay UI para cambiar idioma.
- Versiones: El schema tiene version pero no hay historial de versiones.
- Publicar/despublicar por sección: No hay toggle por sección, es todo o nada.
- Tokens dinámicos: {{usd_rate}}, {{whatsapp}} se resuelven en el landing pero el CMS no muestra que existen.
Relaciones: → Landing (renderiza el contenido), → Configuración (comparte datos de contacto/social).
10. USUARIOS (tab-usuarios)
Qué tiene:
- Tabla con: nombre, email, rol, estado (activo/inactivo), fecha creación
- Cambiar rol (super_admin/admin/broker/agente) vía dropdown
- Activar/desactivar usuario
- Crear usuario vía Edge Function manage-users (genera contraseña temporal)
- Editar usuario (nombre, email)
- Cambiar contraseña propia
- Aceptación de invitación (define contraseña)
- Guard por rol: no puedes cambiarte el rol a ti mismo
- Zod validation
Qué le falta:
- Asignar broker_id: Un usuario con rol "broker" debería poder vincularse a un registro en agents. No hay UI para esto.
- 2FA / MFA: No hay autenticación de dos factores.
- Logs de auditoría: ¿Quién creó/modify/desactivó cada usuario?
- Última conexión: ¿Cuándo se logueó por última vez?
- Sesiones activas: Ver cuántas sesiones abiertas tiene un usuario.
- Restricción de IP: Solo acceder desde ciertas IPs (para seguridad).
- Permisos granulares: Los 4 roles son básicos. No hay permiso "solo puede ver propiedades" o "no puede eliminar leads".
Relaciones: → Agent (broker vinculado), → Profile (datos), → Supervisión (anomalías del usuario), → Audit Log (acciones).
11. CONFIGURACIÓN (tab-configuracion)
Qué tiene:
- 6 secciones: Identidad Corporativa, Contacto Digital, Redes Sociales, Preferencias (USD rate), Sistema e Integraciones, Sesión Activa
- Guardado con merge profundo
- Chips de estado: Supabase, Cloudinary, Brevo, ML, Zernio
- Validación de USD rate antes de guardar
- Info de sesión actual
Qué le falta:
- Feature flags: El schema tiene app_settings.features (chat_enabled, tasaciones_enabled, owner_portal_enabled) pero no hay UI para activar/desactivar módulos.
- Branding: Logo, colores, tipografía. Hoy es hardcodeado en CSS.
- Backup/restore: Exportar/importar configuración.
- Notificaciones email: Configurar templates de emails (bienvenida, recordatorio visita, etc.).
- Rate limiting: Configurar límites de API.
- Mantenimiento: Botón "modo mantenimiento" para el landing.
Relaciones: → Todos los módulos (consume config centralizada), → Landing (usa hero/social/contact), → Edge Functions (usa secrets).
12. CHAT ZERNIO (tab-chat-redes)
Qué tiene:
- Unified inbox: WhatsApp, Instagram, Facebook, Web
- Lista de conversaciones con: nombre contacto, plataforma, preview último mensaje, tiempo relativo, badge no leídos
- Filtro por plataforma
- Búsqueda en conversaciones
- Panel de mensajes: burbujas con dirección, ticks (✓/✓✓), timestamps
- Composer: textarea con Enter para enviar
- Botón "Marcar como leído"
- Sidebar contextual: info del contacto, lead vinculado, visitas, propiedad
- Acciones 1-click: crear lead, agendar visita, ver propiedad, asignar broker
- Realtime (Supabase) para mensajes nuevos
- Badge en sidebar del chat
- _chatListenersBound flag (evita duplicar listeners)
- DOM APIs para renderizar (no innerHTML)
- Map para O(1) lookup de accounts
Qué le falta:
- API key de Zernio: Está bloqueado sin credenciales. Todo el código está listo pero sin Activar.
- Bot/IA: Auto-respuestas inteligentes.
- Templates de respuesta rápida: Respuestas predefinidas ("Hola, gracias por contactarnos").
- Transferencia entre brokers: Reasignar conversación.
- Archivos multimedia: Enviar/recibir fotos, documentos.
- Emoji picker: No hay selector de emojis.
- Typing indicator: "Está escribiendo..."
- Online/offline status: ¿Está disponible el broker?
- Métricas: Tiempo promedio de respuesta, conversaciones atendidas/día.
- Chat widget para el landing: El landing tiene WhatsApp flotante pero no chat web integrado.
- Cierre automático: Cerrar conversaciones inactivas después de X días.
Relaciones: → Leads (crear lead desde chat), → Properties (consultas por propiedad), → Visits (agendar desde chat), → Agents (asignar broker), → Portal (preguntas de ML → chat).
13. FICHA HTML (tab-ficha-html)
Qué tiene:
- Shell two-col: formulario + preview 1:1
- Autocompletar desde CRM (debounce 250ms)
- Drag & drop fotos
- Footer rotativo (4 mensajes)
- 3 exportaciones: compartir texto (navigator.share), PDF (window.print), HTML autocontenido
- Responsive: 1200px side-by-side, 1024px stacked, 680px mobile
Qué le falta:
- Temas múltiples: Solo tiene 1 tema oscuro. Debería haber 2-3 templates.
- Logo del broker: No permite personalizar el logo en la ficha.
- Colores personalizables: Los colores están hardcodeados.
- QR code: Generar QR que lleve a la ficha online.
- URL permanente: Publicar la ficha como página web (no solo descargar HTML).
- Analytics: Rastrear quién abrió la ficha.
Relaciones: → Property (datos de la propiedad), → Agent (broker que comparte), → Cloudinary (fotos).
14. SUPERVISIÓN (tab-supervision)
Qué tiene:
- 2 sub-vistas: Anomalías y Alertas
- Anomalías: tabla paginada con severidad, regla, usuario, módulo, descripción, evidencia, fecha, asignado, estado
- Acciones: reconocer, resolver, descartar, reabrir
- Alertas: similar pero con asignación a usuario (dropdown), notas
- Detalle modal con z-score, percentil, valor observado vs esperado
- Filtro por fecha
- Timezone selector (AR/UTC)
- Cursor-based pagination
Qué le falta:
- Dashboard de supervisión: Gráfico de anomalías en el tiempo.
- Filtros por severidad/módulo: Solo filtro por fecha.
- Exportar reporte: CSV/PDF de anomalías.
- Notificaciones: Alertar al admin cuando hay anomalía crítica.
- Reglas configurables: Definir qué es "anómalo" desde el panel.
- Audit log viewer: Ver el log de auditoría completo.
Relaciones: → Users (quién generó la anomalía), → Modules (de qué módulo viene), → Notifications (alertar).
15. BÚSQUEDA GLOBAL (Ctrl+K)
Qué tiene:
- Carga 8 tablas en paralelo (properties, leads, agents, owners, visits, tasaciones, profiles, conversations)
- Cache de 5 min
- Resalta coincidencias con <mark>
- Navegación por teclado (↑↓)
- Click resultado → navega al módulo
Qué le falta:
- Lazy loading: Carga todo al init. Debería cargar al abrir Ctrl+K.
- Filtros por módulo: "Solo buscar en propiedades".
- Búsqueda fuzzy: Solo substring exacto. No tolera typos.
- Resultados recientes: "Últimas propiedades que viste".
16. LANDING PAGE (index.html + landing-app.js)
Qué tiene:
- Hero con CMS background, título, subtítulo, eyebrow
- Catálogo dinámico con filtros server-side (tipo, zona, precio, dormitorios)
- Paginación + orden
- Tarjetas de propiedad con fotos Cloudinary
- Sección servicios, equipo, proceso, stats
- Contacto con formulario (Brevo)
- WhatsApp flotante
- Footer dinámico (CMS)
- i18n (ES/EN/PT)
- SEO: meta tags, Open Graph, schema.org, sitemap, robots.txt
- Scroll animations (IntersectionObserver)
- Parallax effect
- Preloader
- Responsive mobile-first
Qué le falta:
- Mapa interactivo: Ver propiedades en mapa (leaflet/mapbox).
- Favoritos: Guardar propiedades favoritas (localStorage).
- Comparar propiedades: Seleccionar 2-3 y ver lado a lado.
- Alertas de nuevas propiedades: "Avísame cuando haya una propiedad así en esta zona".
- Chat widget: Solo WhatsApp flotante. No hay chat web.
- Calculadora de cuotas: Simulador hipotecario.
- Virtual tour: Soporte para tours virtuales (Matterport, etc.).
Mapa de Relaciones entre Módulos
                    ┌─────────────┐
                    │  DASHBOARD  │ ← lee todo
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼────┐      ┌─────▼─────┐     ┌─────▼─────┐
   │PROPIEDAD│◄────►│    CRM    │◄───►│  AGENDA   │
   │  (CORE) │      │   LEADS   │     │  VISITAS  │
   └────┬────┘      └─────┬─────┘     └─────┬─────┘
        │                  │                  │
   ┌────▼────┐      ┌─────▼─────┐     ┌─────▼─────┐
   │  OWNER  │      │   CHAT    │     │  BROKER   │
   │PROPIET. │      │  ZERNIO   │     │  AGENTES  │
   └────┬────┘      └───────────┘     └───────────┘
        │
   ┌────▼────┐      ┌───────────┐     ┌───────────┐
   │TASACION │      │  PORTAL   │     │    CMS    │
   │         │      │ ML/ZONA   │     │  LANDING  │
   └─────────┘      └───────────┘     └───────────┘
                           │
                    ┌──────▼──────┐
                    │   USUARIOS  │
                    │     CMS     │
                    └─────────────┘
Prioridad para completar cada módulo
#	Módulo	Prioridad	Esfuerzo	Impacto negocio
1	Propiedades — Owner vinculado	🔴 P0	Bajo	Alto — no saber de quién es la propiedad es un problema real
2	CRM — Scoring automático	🔴 P0	Medio	Alto — priorizar leads manualmente es lento
3	Agenda — Vista semanal/diaria	🟡 P1	Medio	Alto — los brokers piensan por día, no por mes
4	Agenda — Recordatorios WhatsApp	🟡 P1	Alto	Alto — reduce inasistencias
5	Propiedades — Historial de cambios	🟡 P1	Medio	Medio — trazabilidad
6	CRM — Drag & drop Kanban	🟡 P1	Medio	Medio — UX del pipeline
7	Brokers — Metrics individuales	🟡 P1	Medio	Medio — performance del equipo
8	Tasaciones — Crear desde panel	🟡 P1	Medio	Medio — flujo incompleto
9	Portales — Publicación masiva	🟡 P1	Bajo	Medio — productividad
10	Owner — Documentos adjuntos	🟢 P2	Medio	Bajo — importante pero no urgente
11	Dashboard — Gráficos visuales	🟢 P2	Medio	Bajo — presentable pero no crítico
12	Landing — Mapa interactivo	🟢 P2	Alto	Bajo — feature premium
¿Querés que arranque con alguno de estos módulos en particular? Mi recomendación sería empezar por el P0: Propiedades + Owner vinculado porque es la base de todo lo demás — sin saber de quién es cada propiedad, los otros módulos están incompletos.