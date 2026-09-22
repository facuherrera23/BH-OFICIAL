# COTIZACIÓN TÉCNICA — PLATAFORMA INMOBILIARIA BH

**Documento:** Cotización por módulos
**Fecha:** Septiembre 2026
**Alcance:** Plataforma web completa para inmobiliaria (sitio público + panel administrativo + integraciones de terceros)
**Validez de la cotización:** 60 días

---

## 1. RESUMEN EJECUTIVO

Plataforma de nivel producto SaaS para inmobiliaria: sitio institucional con SEO técnico avanzado, panel administrativo con CRM completo, integración nativa con Mercado Libre y portales inmobiliarios, y automatización de marketing operativo.

| Ítem | Valor |
|---|---|
| **Precio total del proyecto** | **USD 14.800** |
| Plazo estimado de construcción | 10–12 semanas |
| Costo operativo mensual (infraestructura) | USD 0–130/mes (según volumen) |
| Moneda | Dólares estadounidenses |
| Condiciones sugeridas | 40% anticipo · 40% hito intermedio · 20% entrega |

---

## 2. DESGLOSE POR MÓDULOS

### MÓDULO 1 — Sitio público institucional y SEO
**Precio: USD 2.200**

Incluye:
- Landing responsive de alto nivel estético (diseño premium, animaciones, preloader).
- Catálogo de propiedades con paginación, filtros y búsqueda.
- Fichas públicas indexables por propiedad (title/meta/canonical automáticos, JSON-LD para Google, tarjetas OG optimizadas para compartir en WhatsApp/redes).
- Generación automática de fichas y `sitemap.xml` cada 30 minutos vía CI.
- Integración Google Search Console + Google Business Profile.
- Formulario de contacto con anti-spam real (rate limiting, honeypot, deduplicación).
- Rotación inteligente de teléfono/WhatsApp por visitante (tracking de origen de leads).
- Páginas legales (privacidad/términos), política de cookies.
- Analítica (Cloudflare Web Analytics).

### MÓDULO 2 — Panel administrativo y CRM
**Precio: USD 5.600**

Incluye:
- Autenticación multi-rol (super_admin / broker / agente) con gestión de usuarios e invitaciones.
- **Propiedades:** ABM completo, carga de imágenes (Cloudinary con firma de seguridad), selección de portada, publicación a portales, estado y visibilidad.
- **Leads/CRM:** pipeline comercial con estados, scoring automático de leads, asignación de leads a agentes, papelera con recuperación, plantillas de WhatsApp, seguimiento de actividades, exportación CSV, paginación y ordenamiento server-side.
- **Agenda/Visitas:** calendario completo, recordatorios automáticos por cron, confirmación de visitas por token (página pública), check-in por QR.
- **Propietarios:** ficha con validación CUIT/CUIL, checklist, papelera, portal del propietario con token revocable.
- **Tasaciones:** herramienta de análisis comparativo de mercado (ACM).
- **Agentes:** gestión de equipo, comisiones automáticas al cierre de venta.
- **Dashboard:** KPIs de negocio (leads, ventas, embudo, zonas, conversiones), navegación histórica.
- **CMS del sitio:** edición de textos e imágenes de la landing sin tocar código.
- **Chat multicanal** (Zernio/Instagram/WhatsApp) integrado al CRM.
- **Centro de Supervisión:** monitoreo visual de la salud del sistema.

### MÓDULO 3 — Integración Mercado Libre
**Precio: USD 3.400**

Incluye:
- OAuth completo de Mercado Libre (mensajería segura, refresh de tokens, tokens encriptados en DB).
- Publicación/actualización/remoción de anuncios desde el panel (con manejo de errores de la API de ML y cola de reintentos con backoff).
- Webhook de eventos con verificación de firma HMAC.
- Sincronización bidireccional (importar publicaciones existentes, métricas de visitas/ventas/preguntas).
- Respuesta de preguntas de ML desde el panel.
- Detección automática de leads provenientes de ML.

### MÓDULO 4 — Integración portales inmobiliarios (RELA/ZonaProp)
**Precio: USD 1.400**

Incluye:
- Proxy de API con rate limiting.
- Callbacks/webhooks de sincronización.
- Preparado para producción (pendiente solo credenciales del portal).

### MÓDULO 5 — Seguridad, base de datos y backend
**Precio: USD 1.100**

Incluye:
- ~30 Edge Functions (Deno) con CORS restringido por allowlist, rate limiting general, y políticas RLS sobre PostgreSQL.
- Triggers, RPCs seguras y reglas de negocio en base de datos.
- Verificación de contraseñas filtradas (HIBP k-anonymity).
- Políticas de contraseñas y gestión de sesiones.
- Headers de seguridad (CSP) en todas las páginas.

### MÓDULO 6 — Calidad, tests y despliegue continuo
**Precio: USD 1.100**

Incluye:
- Suite E2E automatizada (Playwright, 60+ casos: flujos de admin, CRM, formularios públicos, SEO, seguridad).
- Linting y validación de sintaxis en CI.
- Pipeline GitHub Actions: lint → tests → deploy automático.
- Estructura de caché controlada (busters automáticos por versión).
- Documentación técnica (README completo + guías operativas).

---

## 3. COSTOS OPERATIVOS (NO INCLUIDOS EN EL PRECIO DEL PROYECTO)

| Servicio | Costo mensual estimado | Uso |
|---|---|---|
| Supabase (backend completo) | USD 0 – 25 | DB, Auth, Edge Functions, Realtime |
| Cloudinary (imágenes) | USD 0 – 99 | Hosting y optimización de fotos |
| GitHub (código + hosting + CI) | USD 0 | Repositorio, Pages, Actions |
| Dominio + DNS | USD 2–4/mes | bienenhaus.com.ar |
| Email transaccional (Brevo/Resend) | USD 0 – 15 | Notificaciones |
| **TOTAL** | **USD ~2 – 143/mes** | según volumen real |

---

## 4. CONDICIONES Y NOTAS

1. **Qué incluye el precio:** diseño, desarrollo, integración, pruebas, deployment y documentación. 30 días de corrección de defectos post-entrega.
2. **Qué NO incluye:** creación de contenido (fotos, textos comerciales, branding), carga masiva del inventario inicial, soporte continuo (se cotiza por separado), mejoras o nuevas funcionalidades.
3. **Mantenimiento sugerido (opcional):** USD 400–600/mes — monitoreo, correcciones menores, actualizaciones de dependencias, backups verificados, soporte con SLA de 24–48 hs.
4. **Propiedad del código:** totalmente del cliente sobre la entrega final.
5. **Método de pago:** transferencia bancaria o USD. Precios expresados en dólares estadounidenses.

---

*Documento generado a partir del alcance real implementado en la plataforma BH. Cada módulo puede contratarse de forma independiente o por fases.*
