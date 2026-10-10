# COTIZACIÓN COMPLETA — PLATAFORMA INMOBILIARIA BIENENHAUS

**Documento:** Valorización módulo por módulo (actualización octubre 2026)
**Fecha:** Octubre 2026 · **Validez:** 60 días
**Alcance:** Reposición completa de la plataforma a valor de mercado (sitio público + panel de 14 módulos + portal + integraciones + backend + calidad)
**Actualiza y amplía:** `COTIZACION_PLATAFORMA_BH.md` (septiembre 2026)

---

## 1. Resumen ejecutivo

| Ítem | Valor |
|---|---|
| **Valorización total de reposición** | **USD 32.100** |
| Esfuerzo estimado de reconstrucción | ~1.130 horas · 16–20 semanas con 1 senior + 1 semi |
| Métricas reales cotizadas | 67 tablas · 782 columnas · 100 funciones SQL · 58 triggers · 121 políticas RLS · 93 migraciones · 48 Edge Functions · 59 tests E2E · ~22.000 líneas de JS propio · ~8.300 líneas de HTML · 11 páginas públicas |
| Costo operativo de infraestructura | **USD 2–143/mes** (free tiers en el volumen actual) |
| Referencia | La cotización de septiembre (USD 14.800) cubrió el alcance hasta esa fecha con pricing de entrega; este documento agrega lo construido en octubre (encuesta, chat en automático, portal) y detalla módulo por módulo a valor de reposición de mercado |

**Metodología:** precio por módulo = horas estimadas de reconstrucción (diseño + desarrollo + pruebas + documentación) × tarifa senior full-stack Argentina 2026 (USD 28–35/h), redondeado. Cada módulo es contratable en forma independiente o por fases.

---

## 2. Parte A — Sitio público (USD 9.400 · ~321 h)

| # | Módulo | Qué incluye | Horas est. | Precio |
|---|---|---|---|---|
| A1 | **Landing institucional + catálogo** | Diseño premium responsive (identidad marca: teal/Playfair), hero con Cloudinary, catálogo con filtros server-side, orden, paginación, virtual scroller, galerías, SEO completo (meta, OG, JSON-LD, schema.org RealEstateAgent), Cloudflare Analytics, menú mobile, botón WA flotante | 90 h | **USD 2.700** |
| A2 | **Fichas públicas + sitemap automático** | Generador de fichas indexables por propiedad (25+ en producción), tarjetas OG para WhatsApp, `sitemap.xml` regenerado por CI cada 30 min, canonicals | 35 h | **USD 1.000** |
| A3 | **Captación de leads** | Formulario → leads con validación, anti-spam real (rate limiting, honeypot, dedup), pills de interés, rotación inteligente de teléfono/WA con tracking de origen | 18 h | **USD 500** |
| A4 | **Tasación pública (ACM)** | Herramienta autónoma de análisis comparativo de mercado: comparables manuales + extracción por URL, mapa Leaflet con geocoding, características, coeficientes con recálculo en vivo, gráficos Chart.js, sesión por postMessage | 45 h | **USD 1.300** |
| A5 | **Portal del Propietario** | Acceso por token sin login (revocable, expirable, sesión con chip de privacidad), propiedades con estadísticas, documentos, comisiones y liquidaciones, exclusividad con cuenta regresiva, historial de visitas, **sección "Opiniones de visitas" anónima con enmascarado de teléfonos**, impresión de reportes, tour de bienvenida, pull-to-refresh, auto-refresh | 70 h | **USD 2.000** |
| A6 | **Confirmación de visita + QR** | Página pública por token (confirmar/cancelar), check-in por QR en la propiedad, detalles con broker/propiedad | 25 h | **USD 750** |
| A7 | **Encuesta de Visita — HOJA DE VISITA** 🆕 | Página pública por token con las preguntas de la hoja en papel (7 puntuaciones, compraría, textos), **autoguardado real** (debounce + draft local + flush keepalive + offline), saludo personalizado, bloqueo post-envío; motorizado por 3 RPC `SECURITY DEFINER` con sanitización server-side y lock `FOR UPDATE` | 30 h | **USD 900** |
| A8 | **Legales + sistema de error** | Términos, privacidad, 403/404 con estética de marca, PWA assets, robots | 8 h | **USD 250** |

---

## 3. Parte B — Panel administrativo, 14 módulos (USD 16.250 · ~574 h)

| # | Módulo | Qué incluye | Horas est. | Precio |
|---|---|---|---|---|
| B1 | **Dashboard** | KPIs de negocio (volumen venta/alquiler, leads, visitas), gráficos, embudo, navegación histórica, acciones rápidas, búsqueda global Ctrl+K, badges en vivo (RPC), contador en favicon | 35 h | **USD 1.000** |
| B2 | **Propiedades** | ABM completo con validación Zod, borradores y soft-delete con papelera, imágenes Cloudinary con firma segura, portada, precios ARS generados, superficie, paginación server-side, publicación a portales, duplicado | 60 h | **USD 1.700** |
| B3 | **Leads & CRM** | Pipeline con estados canónicos y triggers de stage, scoring automático, tareas con prioridad auto y recordatorios, historial unificado, plantillas WhatsApp con normalización AR, export CSV, papelera, panel lateral con contacto rápido, **envío de encuesta + chips de estado + ver respuestas + re-encuesta**, oferta de encuesta al completar visita | 75 h | **USD 2.100** |
| B4 | **Agenda de Visitas** | Calendario mensual + tabla, drag&drop para reprogramar, check-in/check-out, export CSV/ICS, recordatorios automáticos por cron (24h/2h), recurrencias, **oferta de encuesta al registrar salida** | 50 h | **USD 1.400** |
| B5 | **Tasaciones (admin)** | Listado con estados, ACM embebido en iframe con sesión postMessage, link a owners | 15 h | **USD 450** |
| B6 | **Propietarios** | Expedientes con validación CUIT/CUIL, documentos con vencimiento/verificación, timeline, tareas con recordatorios, export CSV/PDF, link de portal con token | 40 h | **USD 1.150** |
| B7 | **Sitio Web (CMS)** | 11 sub-tabs (Hero, Catálogo, Servicios, Equipo, Stats, Proceso, Contacto, Formulario, Navbar, Footer, SEO) editando el landing sin código, con caché invalidable | 35 h | **USD 1.000** |
| B8 | **Portales & APIs (Mercado Libre)** | OAuth 2.0 completo con tokens encriptados AES-256-GCM, publicación/actualización/remoción con cola de reintentos y backoff, sync bidireccional por cron, webhook HMAC con dead-letter y log de rechazos, auto-reply por plantillas, importación inversa, panel de estado con guía de suscripción manual (ML retiró el registro por API) | 60 h | **USD 1.700** |
| B9 | **Agentes & Brokers + Comisiones** | Gestión de equipo, matrícula, porcentajes venta/alquiler, comisión automática al cierre (trigger), liquidaciones mensuales y pagos con PDF | 30 h | **USD 850** |
| B10 | **Chat Redes (Zernio)** | Inbox unificado IG/FB/WA con contexto lateral (propiedad/lead/visitas), crear lead y agendar visita desde el chat, asignación de broker por trigger, envío por proxy con manejo de errores Meta (ventana 24h, permisos revocados), **`zernio-sync`: sincronizador incremental cada 2 min con realtime — chat en automático sin depender del dashboard**, webhook HMAC listo para activar, diagnóstico de cuentas | 55 h | **USD 1.550** |
| B11 | **Ficha HTML** | Generador de fichas visuales 1:1 con autocompletado del CRM, drag&drop de fotos, export navigator.share/print/HTML autocontenido | 22 h | **USD 650** |
| B12 | **Usuarios & Permisos** | Multi-rol (super_admin/broker/agente), invitaciones por Edge Function, cambio de contraseña con verificación HIBP de filtraciones | 25 h | **USD 700** |
| B13 | **Configuración** | Identidad corporativa, contacto, redes, tipo de cambio, chips de estado de integraciones, sesión | 12 h | **USD 350** |
| B14 | **Centro de Supervisión** | Reglas configurables por pg_cron, alertas, detección de anomalías estadísticas/ML con baselines, risk scoring por usuario con factores explicables, auditoría con cadena de integridad, digest por email, API de consulta con rate limit, retención | 60 h | **USD 1.650** |

---

## 4. Parte C — Plataforma, seguridad y calidad (USD 6.450)

| # | Módulo | Qué incluye | Horas est. | Precio |
|---|---|---|---|---|
| C1 | **Base de datos** | 67 tablas con RLS, 782 columnas, 100 funciones (SECURITY DEFINER con `search_path` fijo y grants/revokes verificados), 58 triggers de negocio (stages, comisiones, códigos secuenciales), 121 políticas, 93 migraciones versionadas, vistas security_invoker, paginación server-side, índices parciales (re-encuesta) | 80 h | **USD 2.300** |
| C2 | **Backend Edge Functions** | 48 funciones en repo (~28 activas en producción): webhooks firmados (ML, Zernio), crones (reminders, syncs, liquidaciones, supervision), auth de usuarios, firma Cloudinary, proxy Zernio, zernio-sync, rate limiting sliding-window, CORS por allowlist, secrets solo server-side | 65 h | **USD 1.900** |
| C3 | **Seguridad y hardening** | CSP estricta por página (sin unsafe-inline, verificada por tests), RLS en todas las tablas, acceso público solo por tokens uuid v4 + RPC, sanitización server-side en todo endpoint público, XSS review, HMAC timing-safe, verificación HIBP, tokens ML cifrados | 45 h | **USD 1.300** |
| C4 | **QA, CI/CD y operación** | 59 tests E2E Playwright (smoke de las 6 páginas, CSP, regresión de delegación, flujos de módulos), `node --check` + CI en GitHub Actions con deploy por función y flags verify_jwt, cache busters automáticos, deploy estático sin build | 30 h | **USD 600** |
| C5 | **Documentación** | README de 1.150+ líneas (arquitectura, ER, flujos, ADRs, changelog), AGENTS.md operativo con gotchas reales, guías por módulo, guía de integraciones, informe de cierre del proyecto, esta cotización | 18 h | **USD 350** |

---

## 5. Totales

| Parte | Horas | USD |
|---|---|---|
| A — Sitio público (8 módulos) | ~321 h | 9.400 |
| B — Panel administrativo (14 módulos) | ~574 h | 16.250 |
| C — Plataforma, seguridad y calidad (5 módulos) | ~238 h | 6.450 |
| **TOTAL PROYECTO** | **~1.133 h** | **USD 32.100** |

> **Lectura honesta del total:** es el valor de *reposición* — reconstruir hoy todo esto desde cero a tarifa de mercado. Incluye el trabajo de investigación y debugging de integraciones reales (webhooks de ML sin firma documentada, registro retirado por API, tokens Meta que expiran, ventana 24h de Instagram) que no se ve en el LOC pero consume horas reales. La cotización previa (septiembre, USD 14.800) reflejaba el alcance de esa fecha con pricing de entrega; este documento agrega la encuesta, el chat en automático, la sección del portal, la re-organización documental y el detalle módulo por módulo.

---

## 6. Costos operativos mensuales (no incluidos)

| Servicio | Costo/mes | Uso |
|---|---|---|
| Supabase | USD 0–25 | DB, Auth, Edge Functions, Realtime, pg_cron |
| Cloudinary | USD 0–99 | Imágenes optimizadas |
| GitHub (repo + Actions) | USD 0 | Código, CI, deploys de funciones |
| Dominio + DNS | USD 2–4 | bienenhaus.com.ar |
| Brevo (email) | USD 0–15 | Recordatorios y digests |
| **TOTAL** | **USD ~2–143** | según volumen |

---

## 7. Condiciones

1. **Incluye:** diseño, desarrollo, integraciones, pruebas, despliegue y documentación. 30 días de corrección de defectos post-entrega.
2. **No incluye:** contenido comercial (fotos/textos/branding), carga masiva de inventario, soporte continuo (se cotiza aparte: **USD 400–600/mes** con SLA 24–48 h), nuevas funcionalidades.
3. **Contratación modular:** cada módulo de las partes A/B/C puede contratarse independientemente o por fases; los precios son proporcionales al bloque.
4. **Propiedad del código:** 100 % del cliente tras la entrega.
5. **Moneda y pago:** dólares estadounidenses; 40 % anticipo · 40 % hito · 20 % entrega.

---

*Documento generado a partir de las métricas reales del repositorio y la producción (octubre 2026). Evidencia de tamaño: 67 tablas, 93 migraciones, 48 Edge Functions, 59 tests automatizados, ~30.000 líneas de código propio entre JS, HTML, CSS y SQL.*
