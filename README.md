# BIENENHAUS PROPIEDADES

Landing page pública + panel administrativo (CRM) para inmobiliaria premium de Buenos Aires.
Sin framework ni build step: Vanilla JS sobre **Supabase** (PostgreSQL + Auth + RLS + Edge Functions), imágenes vía **Cloudinary** y publicación a portales con **Mercado Libre**.

---

## Índice

1. [URLs](#urls)
2. [Stack](#stack)
3. [Estructura del proyecto](#estructura-del-proyecto)
4. [Puesta en marcha local](#puesta-en-marcha-local)
5. [Configuración frontend](#configuración-frontend)
6. [Base de datos](#base-de-datos)
7. [Seguridad](#seguridad)
8. [Panel administrativo](#panel-administrativo)
9. [Módulo Configuración (nuevo)](#módulo-configuración-nuevo)
10. [Landing pública](#landing-pública)
11. [Mercado Libre](#mercado-libre)
12. [Edge Functions](#edge-functions)
13. [Deploy](#deploy)
14. [Convenciones de desarrollo](#convenciones-de-desarrollo)
15. [QA / Verificación](#qa--verificación)
16. [Notas técnicas y deudas conocidas](#notas-técnicas-y-deudas-conocidas)

---

## URLs

| Entorno | URL |
|---|---|
| Landing | https://bienenhaus.com.ar |
| Panel admin | https://bienenhaus.com.ar/admin |
| Proyecto Supabase | `rnldqiwwzhjnurkguihu` |
| Repo | https://github.com/facuherrera23/BH-OFICIAL |

Las tasaciones (ACM) se abren vía `iframe` dentro del panel admin (`tasacion.html`).

## Stack

- **Frontend**: Vanilla JS (ES Modules), CSS custom properties, Font Awesome 6.5.1
- **Backend**: Supabase — PostgreSQL + Auth (GoTrue email/contraseña) + Row Level Security + Realtime + Edge Functions (Deno)
- **Imágenes**: Cloudinary (compresión automática a WebP, firma server-side)
- **Portales**: Mercado Libre (OAuth 2.0, sync, webhooks, auto-reply)
- **Email**: Brevo SMTP (límite 30 envíos/hora)
- **Deploy**: Cloudflare Pages (estático)

## Estructura del proyecto

```
BH-OFICIAL/
├── index.html                  # Landing page pública
├── admin.html                  # Panel administrativo (SPA por tabs)
├── tasacion.html               # Réplica TAI para tasaciones (iframe autenticado)
├── plan.md                     # Doc interno: plan CRM ↔ Agenda bidireccional
├── CNAME                       # Dominio custom (Cloudflare Pages)
├── robots.txt / sitemap.xml / .nojekyll
├── assets/
│   ├── css/
│   │   ├── landing.css         # Design system del landing
│   │   └── admin.css           # Estilos del panel (calendario incluido)
│   ├── js/
│   │   ├── config.js           # window.BH_CONFIG (Supabase URL + anon key)
│   │   ├── supabase-client.js  # Init cliente Supabase + fallback CDN
│   │   ├── utils.js            # Helpers compartidos
│   │   ├── cloudinary.js       # Upload helper con compresión WebP
│   │   ├── landing-app.js      # Landing: catálogo, filtros, CMS, contacto
│   │   └── admin-app.js        # Admin: auth, CRUD, dashboard, CRM, portales…
│   ├── images/                 # favicon.ico, hero-bg.webp, pwa-512x512.png
│   └── img/                    # logo-bh.png
└── supabase/
    ├── functions/              # Edge Functions (ver sección propia)
    └── .temp/                  # Tooling CLI local — NO versionar
```

Carpetas de tooling que **nunca** se commitean: `.codegraph/`, `.omo/`, `.playwright-mcp/`, `supabase/.temp/`.

## Puesta en marcha local

```bash
# 1. Clonar e ingresar
git clone https://github.com/facuherrera23/BH-OFICIAL.git
cd BH-OFICIAL

# 2. Servir estáticamente (cualquier server sirve; este es el usado en QA)
python -m http.server 8788

# 3. Abrir
#    Landing: http://localhost:8788/index.html
#    Admin:   http://localhost:8788/admin.html
```

No hay build step ni dependencias npm de runtime. El JS se edita directo y se invalida caché con **cache busters** (`?v=N`) en los `<link>`/`<script>` de `index.html` y `admin.html`.

> Los usuarios se crean desde el propio panel (tab **Usuarios**) o vía Auth de Supabase; el rol se asigna en `profiles.role`.

## Configuración frontend

Todo vive en `assets/js/config.js`:

```js
window.BH_CONFIG = {
  SUPABASE_URL: 'https://<project-ref>.supabase.co',
  SUPABASE_ANON_KEY: '<anon-key>'   // clave pública por diseño: la seguridad la da RLS
};
```

La presencia de `window.BH_Cloudinary` habilita el chip de estado de Cloudinary en el panel.

## Base de datos

Esquema verificado en producción (todas las tablas con **RLS activada**):

| Tabla | Filas | Descripción |
|---|---:|---|
| `properties` | 3 | Propiedades publicadas (código secuencial vía `property_sequences`, drafts, soft-delete, video_url, orden RPC) |
| `property_sequences` | 2 | Secuencias de códigos de propiedad (RLS restringida, solo service_role) |
| `agents` | 2 | Asesores/brokers (matrícula, fotos en Storage, comisiones, horarios, permisos) |
| `owners` | 0 | Propietarios y expedientes/contratos |
| `leads` | 0 | Consultas y prospectos del pipeline CRM (tags, scoring, origen) |
| `visits` | 0 | Visitas agendadas (estados: pendiente/confirmada/completada/cancelada, calendario) |
| `tasaciones` | 0 | ACM / tasaciones (datos JSONB, RPCs de valoración) |
| `site_content` | 8 | Contenido por sección del landing: `hero`, `services`, `team`, `process`, `stats`, `contact`, `footer`, `social` |
| `portal_settings` | 6 | CMS en vivo del landing (hero, servicios, stats, testimonios) + versiones/i18n |
| `app_settings` | 1 | Ajustes globales key/value JSONB — hoy: `preferences.usd_rate` |
| `profiles` | 3 | Perfiles de usuario vinculados a `auth.users` (campo `role`) |
| `ml_listings` | 1 | Publicaciones en Mercado Libre (sync, webhooks dedup, dead-letter queue) |

Complementos en DB: `audit_log`, newsletter, chat interno + asistente IA, rate limiting, papelera con retención.

### Roles

El permiso se resuelve con `profiles.role`. Hoy todos los usuarios activos son **`super_admin`** (acceso total). Las escrituras sensibles (p. ej. `site_content`, `app_settings`) exigen rol `super_admin` en sus políticas RLS; un trigger (`guard_profiles_self_update`) impide auto-elevación de rol.

## Seguridad

Capas aplicadas y verificadas:

- **RLS en las 12 tablas**. Lectura pública solo donde corresponde (`properties`, `agents`, `site_content` en SELECT); escritura solo autenticados, y operaciones sensibles restringidas a `super_admin`.
- **Hardening de funciones** (migraciones 20260823): `search_path` fijo en triggers/functions, `EXECUTE` revocado al público con grants explícitos a `postgres`/`service_role`, definer restringido.
- **XSS**: helper `esc()` en todo sink `innerHTML`; sin `let` mutables en sinks (regla react-doctor).
- **Auth**: validación de sesión en `tasacion.html` (postMessage), cambio de contraseña vía RPC seguro, hardening de gestión de usuarios.
- **Infra**: rate limiting en endpoints públicos, webhook ML firmado + deduplicación, audit log de escrituras, detección de caída de CDN (Supabase / Font Awesome).

## Panel administrativo

`admin.html` organiza los módulos en tabs (búsqueda global con `Ctrl+K`):

| Módulo | Funcionalidad |
|---|---|
| **Dashboard** | KPIs, gráfico de ventas, zonas, leads calientes, ranking de brokers |
| **Propiedades** | CRUD completo, drafts, reordenamiento, soft-delete, publicación individual/masiva a ML, sincronización de precios/estados |
| **CRM Leads** | Pipeline Kanban `nuevo → contactado → visita → oferta → cerrado/perdido`, tags y scoring, export CSV, agendado directo de visitas (bidireccional con Agenda) |
| **Agenda / Visitas** | Vista calendario mensual con navegación y filtro por estado + lista clásica |
| **Brokers** | Gestión de asesores: matrícula, fotos (Storage), comisiones, horarios, permisos |
| **Propietarios** | Expedientes y contratos |
| **Tasaciones** | ACM completo (réplica TAI en iframe autenticado) + tabla `tasaciones` con RPCs de valoración |
| **Portales / ML** | Conexión OAuth de cuenta Mercado Libre, configuración ZonaProp/Argenprop/ML/InmueblesCL, sync, auto-reply, dead-letter queue |
| **CMS** | Editor en vivo del sitio: hero, servicios, stats, testimonios (con versiones e i18n) |
| **Usuarios** | Alta/edición de usuarios, roles, cambio de contraseña (propia y de terceros) vía Edge Function segura |
| **Configuración** | Ajustes generales, redes sociales, preferencias, estado de integraciones y sesión (detalle abajo) |

## Módulo Configuración (nuevo)

Tab `tab-configuracion` del panel — recién implementado y verificado E2E:

- **Identidad Corporativa**: razón social, matrícula, watermark, CUIT → `site_content.footer`.
- **Contacto Digital**: WhatsApp, email, teléfono, dirección, horario → `site_content.contact`.
- **Redes Sociales**: Instagram, Facebook, LinkedIn, YouTube → `site_content.social` (fila creada on-demand).
- **Preferencias**: cotización USD de referencia → `app_settings.preferences.usd_rate` (upsert idempotente).
- **Sistema e Integraciones**: chips de estado — Supabase (conectado), Cloudinary (detectado por `window.BH_Cloudinary`), Brevo SMTP (30 envíos/hora), Mercado Libre (lee credenciales del módulo ML).
- **Sesión Activa**: usuario + rol + botón de cierre de sesión global.

Semántica de guardado (probada contra producción):

1. Validación del USD **antes** de escribir (un valor inválido no deja escrituras parciales).
2. Guardado por merge `{...(existing.content), ...newFields}` → preserva claves que el form no edita (ej. `map_embed`, `copyright`).
3. Update si la fila existe, INSERT si no (crea `social` automáticamente).
4. Upsert de `preferences` con `onConflict: 'key'`.
5. Guard por rol: sin `super_admin` los campos se deshabilitan y se muestra aviso.

Efecto en el landing: los íconos sociales leen `site_content.social`; **URL vacía ⇒ ícono oculto**, URL cargada ⇒ link con `https://`, `target="_blank"` y `rel="noopener noreferrer"`.

## Landing pública

Secciones consumidas por `landing-app.js` (`applySectionContent`) desde `site_content`: `hero`, `services`, `team`, `process`, `stats`, `contact`, `footer`, `social`. Además:

- Catálogo dinámico con filtros server-side (Supabase).
- WhatsApp flotante + formulario de contacto (Brevo).
- SEO: meta tags, Open Graph, `schema.org/RealEstateAgent`, sitemap y robots.
- Responsive mobile-first, imágenes Cloudinary (WebP automático).

## Mercado Libre

Flujo completo gestionado desde el panel: conexión OAuth 2.0 de cuenta → publicación individual o masiva de propiedades → sincronización (cron + robustez + batch) → auto-reply a preguntas/órdenes → despublicación. Incluye webhook entrante firmado con deduplicación y dead-letter queue. Estado de conexión visible en Configuración y en el módulo ML.

## Edge Functions

En el repo (`supabase/functions/`):

| Función | Propósito |
|---|---|
| `_shared` | Helpers compartidos entre funciones |
| `cloudinary-sign` | Firma server-side de uploads a Cloudinary |
| `manage-users` | Creación/edición de usuarios con privilegios elevados |
| `ml-sync` | Sincronización con la API de Mercado Libre |

Adicionalmente el proyecto Supabase hospeda las funciones del flujo ML (auth/callback/API) referenciadas desde el módulo Portales.

## Deploy

- Hosting estático en **Cloudflare Pages** apuntando a la raíz del repo (`CNAME` → bienenhaus.com.ar).
- Sin build: lo que hay en el repo es lo que se publica.
- Al modificar JS/CSS, **subir el cache buster** correspondiente (`landing-app.js?v=N`, `admin-app.js?v=N`, `admin.css?v=N`) — es el mecanismo de invalidación vigente.
- Cambios de DB se aplican como migraciones de Supabase (histórico: serie `0001–0067` legacy + reset limpio `20260820*` + incrementales hasta `app_settings_table`).

## Convenciones de desarrollo

- Commits en español con formato `feat(módulo): descripción` / `fix(módulo): …`.
- Sin frameworks ni bundler: cambios directos en los archivos servidos.
- Idioma de la UI: español.
- Sanitizar **siempre** con `esc()` antes de `innerHTML`.
- No commitear: `.codegraph/`, `.omo/`, `.playwright-mcp/`, `supabase/.temp/`.

## QA / Verificación

Checklist aplicado en el último release (módulo Configuración):

- [x] `node --check` sobre `admin-app.js` y `landing-app.js`
- [x] `npx react-doctor@latest` → **Score 100/100**
- [x] E2E con Playwright contra producción: render de tab, guard por rol, población de campos vs DB, rechazo de USD inválido sin escrituras parciales, round-trip idempotente de guardado, íconos sociales ocultos con URLs vacías, consola sin errores funcionales
- [x] Limpieza de artefactos de prueba (usuario temporal eliminado)

## Notas técnicas y deudas conocidas

- **Favicon 404**: no existe `favicon.ico` en la raíz (está en `assets/images/`); agregar link `<link rel="icon">` o copiarlo a la raíz.
- **Encoding legado**: `admin.html` mezcla encodings históricos; los navegadores lo renderizan bien pero las consolas PowerShell pueden mostrar mojibake al leerlo. No re-guardar con herramientas que normalicen encoding sin verificar.
- **Footer sin YouTube**: la sección footer del landing nunca tuvo anchor de YouTube (solo el bloque de contacto); el código lo maneja sin error.
- **`usd_rate` aún sin consumo**: la preferencia se almacena y valida, pero el render de propiedades todavía no la utiliza (hook previsto).
- **Supabase Advisor pendientes** (aceptados/documentados): INFO `rls_enabled_no_policy` en `property_sequences` (intencional, solo service_role), extensión `pg_net` en `public`, y activar manualmente *Leaked Password Protection* desde el dashboard de Auth.

---

*Mantenedor: facuherrera23 · Última actualización de este documento: 2026-08-23.*
