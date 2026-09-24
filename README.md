

# ðŸ  BIENENHAUS PROPIEDADES

**Landing pÃºblica + CRM inmobiliario completo para una inmobiliaria premium de Buenos Aires**

![Vanilla JS](https://img.shields.io/badge/Frontend-Vanilla%20JS-F7DF1E?logo=javascript&logoColor=black)
![Supabase](https://img.shields.io/badge/Backend-Supabase-3ECF8E?logo=supabase&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/DB-PostgreSQL%20%2B%20RLS-4169E1?logo=postgresql&logoColor=white)
![Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020?logo=cloudflare&logoColor=white)
![Playwright](https://img.shields.io/badge/E2E-Playwright-2EAD33?logo=playwright&logoColor=white)
![Build](https://img.shields.io/badge/build%20step-none-lightgrey)

ðŸŒ **Sitio:** https://bienenhaus.com.ar

</div>

---

## ðŸ“‘ Ãndice

1. [DescripciÃ³n y alcance](#-descripciÃ³n-y-alcance)
2. [Funcionalidades del sistema](#-funcionalidades-del-sistema)
3. [Stack tecnolÃ³gico](#-stack-tecnolÃ³gico)
4. [Arquitectura](#-arquitectura)
5. [PÃ¡ginas y URLs](#-pÃ¡ginas-y-urls)
6. [Estructura del proyecto](#-estructura-del-proyecto)
7. [InstalaciÃ³n y puesta en marcha](#-instalaciÃ³n-y-puesta-en-marcha)
8. [Base de datos](#-base-de-datos)
9. [Roles y permisos](#-roles-y-permisos)
10. [Seguridad](#-seguridad)
11. [Panel administrativo (14 mÃ³dulos)](#-panel-administrativo-14-mÃ³dulos)
12. [Landing pÃºblica](#-landing-pÃºblica)
13. [Portal del Propietario](#-portal-del-propietario)
14. [ConfirmaciÃ³n de visitas](#-confirmaciÃ³n-de-visitas)
15. [Tasaciones (ACM)](#-tasaciones-acm)
16. [Comisiones y liquidaciones](#-comisiones-y-liquidaciones)
17. [IntegraciÃ³n Mercado Libre](#-integraciÃ³n-mercado-libre)
18. [Chat omnicanal (Zernio)](#-chat-omnicanal-zernio)
19. [Centro de SupervisiÃ³n](#-centro-de-supervisiÃ³n)
20. [Edge Functions](#-edge-functions)
21. [Migraciones](#-migraciones)
22. [Flujos end-to-end](#-flujos-end-to-end)
23. [Patrones tÃ©cnicos](#-patrones-tÃ©cnicos)
24. [Deploy](#-deploy)
25. [Testing y CI](#-testing-y-ci)
26. [Convenciones de desarrollo](#-convenciones-de-desarrollo)
27. [Deudas tÃ©cnicas y roadmap](#-deudas-tÃ©cnicas-y-roadmap)
28. [ADRs](#-adrs-architecture-decision-records)
29. [DocumentaciÃ³n complementaria](#-documentaciÃ³n-complementaria)
30. [Changelog](#-changelog)

---

## ðŸ“Œ DescripciÃ³n y alcance

**BIENENHAUS PROPIEDADES** es un sistema web integral para una inmobiliaria. Combina en un solo repositorio:

| Componente | DescripciÃ³n |
|---|---|
| **Landing pÃºblica** | Sitio comercial con catÃ¡logo dinÃ¡mico de propiedades, servicios, equipo, proceso, estadÃ­sticas y formulario de contacto que genera leads. |
| **Panel administrativo / CRM** | SPA de 14 mÃ³dulos para gestionar propiedades, leads, visitas, propietarios, agentes, tasaciones, comisiones, portales, chat y supervisiÃ³n. |
| **Portal del Propietario** | Acceso por token (sin login) donde el dueÃ±o ve sus propiedades, documentos, comisiones y liquidaciones. |
| **ConfirmaciÃ³n de visita** | PÃ¡gina pÃºblica por token para que el cliente confirme o cancele una visita. |
| **Herramienta de tasaciÃ³n (ACM)** | AnÃ¡lisis Comparativo de Mercado con comparables, mapa, coeficientes y grÃ¡ficos. |
| **Integraciones** | Mercado Libre (publicaciÃ³n y sync), Zernio (WhatsApp/Instagram/Facebook/Web), Cloudinary (imÃ¡genes), Brevo (emails). |

### Alcance funcional

- âœ… GestiÃ³n completa del ciclo comercial: **captaciÃ³n â†’ tasaciÃ³n â†’ publicaciÃ³n â†’ lead â†’ visita â†’ cierre â†’ comisiÃ³n**.
- âœ… Multi-rol (`super_admin`, `broker`, `agente`) con seguridad a nivel de fila (RLS).
- âœ… CMS integrado: el contenido del landing se edita desde el panel sin tocar cÃ³digo.
- âœ… PublicaciÃ³n y sincronizaciÃ³n bidireccional con Mercado Libre.
- âœ… Inbox unificado de mensajerÃ­a (WhatsApp, Instagram, Facebook, Web).
- âœ… AuditorÃ­a, detecciÃ³n de anomalÃ­as y scoring de riesgo por usuario.
- âœ… Sin build step: se despliega como sitio estÃ¡tico.

### Fuera de alcance (actual)

- âŒ EnvÃ­o saliente de mensajes por Zernio (pendiente de API key real; la recepciÃ³n sÃ­ funciona).
- âŒ Notificaciones push reales (Web Push/VAPID, requiere Service Worker).
- âŒ Uso del `usd_rate` en las tarjetas del catÃ¡logo del landing.

---

## âš™ï¸ Funcionalidades del sistema

### ðŸŒ PÃºblico (sin login)
- CatÃ¡logo dinÃ¡mico con filtros server-side (tipo, zona, precio, dormitorios), orden, paginaciÃ³n y *virtual scroller*.
- GalerÃ­a de imÃ¡genes por propiedad.
- Formulario de contacto â†’ inserta un `lead` (origen `landing_page` / `newsletter`).
- BotÃ³n flotante de WhatsApp.
- SEO: meta tags, Open Graph, `schema.org/RealEstateAgent`, `sitemap.xml`, `robots.txt`.
- Confirmar / cancelar visita por token.
- Portal del propietario por token.

### ðŸ” AdministraciÃ³n
| Ãrea | Funciones |
|---|---|
| **Dashboard** | KPIs (volumen venta USD, volumen alquiler ARS, propiedades activas, leads, visitas), grÃ¡ficos y acciones rÃ¡pidas. |
| **Propiedades** | CRUD, borradores, reordenamiento, soft-delete, publicaciÃ³n a ML, paginaciÃ³n server-side, validaciÃ³n Zod, precios ARS/USD, superficie cubierta/terreno. |
| **Leads & CRM** | Pipeline Kanban, tags, scoring, exportaciÃ³n CSV, agendado directo de visitas. |
| **Agenda** | Calendario mensual + tabla, check-in/check-out, export CSV/ICS, recordatorios. |
| **Tasaciones** | ACM embebido en iframe + listado de tasaciones. |
| **Propietarios** | Expedientes, documentos con vencimiento/verificaciÃ³n, timeline, export CSV/PDF, link de portal. |
| **Sitio Web (CMS)** | 11 sub-tabs: Hero, CatÃ¡logo, Servicios, Equipo, Stats, Proceso, Contacto, Formulario, Navbar, Footer, SEO. |
| **Portales & APIs** | OAuth ML, configuraciÃ³n por portal, sync, dead-letter, importaciÃ³n desde ML. |
| **Agentes & Brokers** | CRUD, matrÃ­cula, comisiones de venta/alquiler, soft-delete, vÃ­nculo con `profiles`. |
| **Chat Redes** | Inbox unificado, crear lead, agendar visita, asignar broker. |
| **Ficha HTML** | Generador de fichas visuales por propiedad (compartir, PDF, HTML autocontenido). |
| **Usuarios & Permisos** | Alta, ediciÃ³n, roles y cambio de contraseÃ±a vÃ­a Edge Function. |
| **ConfiguraciÃ³n** | Identidad corporativa, contacto, redes, tipo de cambio USD, estado de integraciones. |
| **SupervisiÃ³n** | Reglas, alertas, anomalÃ­as, ranking de riesgo, mÃ©tricas ML. |

### ðŸ› ï¸ Transversales
- BÃºsqueda global (`Ctrl+K`) con navegaciÃ³n por teclado.
- Notificaciones con badges por tab y contador en favicon.
- Realtime multi-tab en tablas core.
- AuditorÃ­a de escrituras y acciones sensibles.
- Rate limiting en Edge Functions.

---

## ðŸ§° Stack tecnolÃ³gico

| Capa | TecnologÃ­a |
|---|---|
| **Frontend** | Vanilla JS (scripts clÃ¡sicos con IIFE y globals `window.*`, **sin ES Modules ni bundler**), CSS custom properties, Font Awesome 6.5.1, Zod 3 (solo admin) |
| **Backend** | Supabase: PostgreSQL + Auth (email/contraseÃ±a) + Row Level Security + Realtime + Edge Functions (Deno) |
| **ImÃ¡genes** | Cloudinary (uploads firmados server-side, `f_auto,q_auto`, WebP) |
| **Portales** | Mercado Libre (OAuth 2.0, cron sync, webhooks, auto-reply) |
| **Mapas y grÃ¡ficos** | Leaflet 1.9.4 + Chart.js 4.4.0 (CDN, en `tasacion.html`) |
| **Email** | Brevo (SMTP) para resÃºmenes de supervisiÃ³n |
| **Chat** | Zernio (WhatsApp, Instagram, Facebook, Web) |
| **Deploy** | Cloudflare Pages (estÃ¡tico) + Supabase Edge Functions |
| **Testing** | Playwright (E2E) + `node --check` |
| **CI/CD** | GitHub Actions |

---

## ðŸ—ï¸ Arquitectura

### Principios

1. **Vanilla JS sin build step**: deploy directo de estÃ¡ticos, cache busters `?v=N`.
2. **Supabase como backend Ãºnico**: Auth, DB, Realtime y Edge Functions.
3. **RLS como seguridad principal**: todas las tablas tienen RLS; el frontend nunca ve secretos.
4. **Realtime para reactividad**: `setupCoreRealtime` suscribe las tablas core.
5. **ConfiguraciÃ³n centralizada**: `app_settings` + `site_content` como fuente de verdad.
6. **Secretos solo en Edge Functions**: tokens ML/Zernio, Cloudinary, Brevo y service role nunca llegan al navegador.
7. **IDs de responsable unificados**: `properties.agent_id`, `leads.assigned_to`, `visits.agent_id` y `zernio_conversations.broker_id` apuntan a `agents.id`.
8. **AuditorÃ­a y supervisiÃ³n integradas**.

### Diagrama de arquitectura

```mermaid
flowchart LR
    subgraph Cliente["Navegador (estÃ¡tico)"]
        L[index.html<br/>Landing]
        A[admin.html<br/>Panel CRM]
        T[tasacion.html<br/>ACM]
        P[portal-propietario.html]
        V[confirmar-visita.html]
    end

    subgraph Supabase
        AUTH[Auth]
        DB[(PostgreSQL + RLS)]
        RT[Realtime]
        EF[Edge Functions]
        CRON[pg_cron]
    end

    subgraph Externos
        CLD[Cloudinary]
        ML[Mercado Libre]
        ZN[Zernio]
        BR[Brevo]
    end

    L --> DB
    A --> AUTH
    A --> DB
    A <--> RT
    A --> EF
    A -. iframe + postMessage .-> T
    T --> DB
    P --> DB
    V --> DB

    EF --> CLD
    EF <--> ML
    ZN -- webhook --> EF
    EF --> ZN
    EF --> BR
    CRON --> EF
    CRON --> DB
```

### Grafo de mÃ³dulos

```mermaid
graph TD
    Config[ConfiguraciÃ³n] -->|USD rate, branding| Todos
    Usuarios[Usuarios y Permisos] -->|Roles| Todos
    Agentes <-->|agent_id| Propiedades
    Agentes <-->|assigned_to| CRM
    Agentes <-->|agent_id| Agenda
    Agentes <-->|broker_id| Chat

    Propiedades -->|lead_source| CRM
    Propiedades -->|visita| Agenda
    Propiedades -->|publicar| Portales
    Propiedades -->|tasar| Tasaciones

    CRM -->|agendar visita| Agenda
    Agenda -->|lead| CRM
    Portales <-->|sync| Propiedades
    Portales -->|pregunta| Chat
    Chat -->|nuevo lead| CRM
    Chat -->|agendar visita| Agenda

    Tasaciones -->|valor| Propiedades
    Tasaciones -->|lead propietario| CRM
    Comisiones -->|sobre cierre| Propiedades
    Comisiones -->|broker| Agentes
    Propietarios <-->|expediente| Propiedades
    Propietarios -->|token| PortalPropietario[Portal Propietario]
    Propietarios -->|comisiones| Comisiones
    CMS[Sitio Web CMS] -->|contenido| Landing
    Supervision[SupervisiÃ³n] -->|audita| Todos
```

### Entidades compartidas

| Entidad | Tabla | MÃ³dulos que la usan |
|---|---|---|
| Usuario/Perfil | `profiles` | Todos |
| Broker | `agents` | Propiedades, CRM, Agenda, Chat, Comisiones |
| Propiedad | `properties` | Propiedades, CRM, Agenda, Portales, Tasaciones, Portal Propietario |
| Lead | `leads` | CRM, Agenda, Chat, Landing |
| Visita | `visits` | Agenda, CRM, Confirmar Visita |
| ConversaciÃ³n | `zernio_conversations` | Chat, CRM |
| Propietario | `owners` | Propietarios, Portal, Comisiones |
| TasaciÃ³n | `tasaciones` | Tasaciones, Portal |
| ComisiÃ³n | `commissions` / `commission_liquidations` | Comisiones, Portal |
| PublicaciÃ³n ML | `ml_listings` | Portales, Propiedades |
| Config/Contenido | `app_settings`, `site_content` | Config, CMS, Landing |

---

## ðŸ”— PÃ¡ginas y URLs

| Archivo | URL / Acceso | PropÃ³sito |
|---|---|---|
| `index.html` | https://bienenhaus.com.ar | Landing: hero, catÃ¡logo, servicios, equipo, proceso, stats, contacto |
| `admin.html` | `/admin.html` | Panel administrativo SPA (14 tabs, hash routing) |
| `tasacion.html` | `/tasacion.html?id=<uuid>` | ACM; se abre embebido en iframe desde `tab-tasaciones` |
| `portal-propietario.html` | `/portal-propietario.html?token=<uuid>` | Portal del propietario por token |
| `confirmar-visita.html` | `/confirmar-visita.html?token=<uuid>` | ConfirmaciÃ³n/cancelaciÃ³n de visita |

---

## ðŸ“ Estructura del proyecto

```
BH-OFICIAL/
â”œâ”€â”€ index.html                    # Landing pÃºblica
â”œâ”€â”€ admin.html                    # Panel administrativo (SPA por tabs)
â”œâ”€â”€ tasacion.html                 # ACM de tasaciÃ³n (autÃ³nomo, embebible)
â”œâ”€â”€ portal-propietario.html       # Portal del propietario (token)
â”œâ”€â”€ confirmar-visita.html         # ConfirmaciÃ³n de visita (token)
â”œâ”€â”€ CNAME                         # Dominio custom (Cloudflare Pages)
â”œâ”€â”€ favicon.ico Â· robots.txt Â· sitemap.xml Â· .nojekyll
â”œâ”€â”€ deno-stubs.d.ts               # Tipos auxiliares para Edge Functions
â”œâ”€â”€ playwright.config.js          # ConfiguraciÃ³n E2E
â”œâ”€â”€ package.json Â· package-lock.json
â”‚
â”œâ”€â”€ assets/
â”‚   â”œâ”€â”€ css/
â”‚   â”‚   â”œâ”€â”€ landing.css           # Design system del landing
â”‚   â”‚   â””â”€â”€ admin.css             # Estilos del panel (incluye calendario)
â”‚   â”œâ”€â”€ js/
â”‚   â”‚   â”œâ”€â”€ config.js             # window.BH_CONFIG (Supabase URL + anon key)
â”‚   â”‚   â”œâ”€â”€ supabase-client.js    # Init de window.supabaseClient
â”‚   â”‚   â”œâ”€â”€ utils.js              # BHUtils: esc, escAttr, safeUrl, safeImageUrl, safeCssUrl
â”‚   â”‚   â”œâ”€â”€ cloudinary.js         # Upload firmado (window.BH_Cloudinary)
â”‚   â”‚   â”œâ”€â”€ zod.umd.js            # Zod 3 (solo admin)
â”‚   â”‚   â”œâ”€â”€ landing-app.js        # CatÃ¡logo, filtros, CMS, contacto â†’ leads
â”‚   â”‚   â””â”€â”€ admin-app.js          # Panel completo (~14k lÃ­neas)
â”‚   â”œâ”€â”€ images/                   # favicon, hero-bg.webp, pwa-512x512.png
â”‚   â””â”€â”€ img/                      # logo-bh.png
â”‚
â”œâ”€â”€ supabase/
â”‚   â”œâ”€â”€ functions/                # Edge Functions (Deno) + _shared/
â”‚   â””â”€â”€ migrations/               # Migraciones SQL versionadas
â”‚
â”œâ”€â”€ tests/                        # Suite E2E Playwright
â”œâ”€â”€ scripts/                      # Scripts auxiliares
â”œâ”€â”€ fichas/                       # Fichas HTML de propiedades
â”œâ”€â”€ docs/integrations/            # DocumentaciÃ³n de integraciones
â”œâ”€â”€ .well-known/                  # Archivos de verificaciÃ³n de dominio
â”œâ”€â”€ .github/workflows/            # CI (deploy.yml)
â”‚
â””â”€â”€ *.md                          # AUDITORIA_MODULOS, AUDIT_FINDINGS, AUDIT_INVENTORY,
                                  # CLOUDFLARE_SETUP, CONECTAR_ZERNIO_CHAT,
                                  # REMEDIATION_PLAN, XSS_REVIEW
```

> Carpetas de tooling que **no** se versionan: `.codegraph/`, `.omo/`, `.playwright-mcp/`, `supabase/.temp/`, `node_modules/`, `*.log`, `.env.local`, `test-results/`, `playwright-report/`.

---

## ðŸš€ InstalaciÃ³n y puesta en marcha

### Requisitos

- Cualquier servidor estÃ¡tico (Python, `npx serve`, etc.)
- Node.js â‰¥ 18 (solo para lint y tests)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (solo para migraciones y Edge Functions)

### Local

```bash
# 1. Clonar
git clone https://github.com/facuherrera23/BH-OFICIAL.git
cd BH-OFICIAL

# 2. Servir estÃ¡ticamente (no hay build)
python -m http.server 8788

# 3. Abrir
#   Landing â†’ http://localhost:8788/index.html
#   Admin   â†’ http://localhost:8788/admin.html
```

### Herramientas de desarrollo (opcional)

```bash
npm install                        # Playwright y supabase-js (devDependencies)
npx playwright install chromium    # navegador para E2E
npm run lint                       # node --check de admin-app.js y landing-app.js
npm test                           # suite E2E
```

### ConfiguraciÃ³n del frontend

`assets/js/config.js`:

```js
window.BH_CONFIG = {
  SUPABASE_URL: 'https://<tu-proyecto>.supabase.co',
  SUPABASE_ANON_KEY: '<anon-key>'   // clave pÃºblica por diseÃ±o: la seguridad la da RLS
};
```

- `supabase-client.js` crea `window.supabaseClient` con el CDN `@supabase/supabase-js@2`. Sin CDN o sin `BH_CONFIG`, loguea el error y **no** expone el cliente (*fail-closed*).
- `utils.js` expone `window.BHUtils` (solo helpers de seguridad/URL) y se carga **antes** que `landing-app.js` / `admin-app.js`.
- `cloudinary.js` expone `window.BH_Cloudinary = { uploadImage, uploadImages }` (firma vÃ­a Edge Function `cloudinary-sign`).

### Usuarios

Los usuarios se crean desde el propio panel (**Usuarios & Permisos**) mediante la Edge Function `manage-users`. El rol se guarda en `profiles.role`.

### Variables de entorno de Edge Functions (secrets de Supabase)

| Variable | Uso |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Operaciones privilegiadas |
| `CRYPTO_SECRET` | DerivaciÃ³n PBKDF2 para AES-256-GCM (tokens ML) |
| Credenciales Cloudinary | Firma de uploads |
| Credenciales Mercado Libre | OAuth y API |
| API key + webhook secret Zernio | Guardados en `zernio_config` |
| Credenciales Brevo | EnvÃ­o de digest |

> Nunca se commitean: se cargan con `supabase secrets set`.

---

## ðŸ—„ï¸ Base de datos

PostgreSQL gestionado por Supabase. **37 tablas en el esquema `public`, todas con RLS activada** (verificado contra producciÃ³n el 2026-08-28).

### Diagrama entidad-relaciÃ³n (nÃºcleo de negocio)

> Se muestran las relaciones y los campos documentados en el proyecto. Los campos completos estÃ¡n en `supabase/migrations/`.

```mermaid
erDiagram
    AUTH_USERS ||--o| PROFILES : "id"
    PROFILES ||--o| AGENTS : "profile_id"
    AGENTS ||--o{ PROPERTIES : "agent_id"
    AGENTS ||--o{ LEADS : "assigned_to"
    AGENTS ||--o{ VISITS : "agent_id"
    AGENTS ||--o{ ZERNIO_CONVERSATIONS : "broker_id"
    AGENTS ||--o{ COMMISSIONS : "broker"

    OWNERS ||--o{ PROPERTIES : "owner_id"
    OWNERS ||--o{ OWNER_PORTAL_TOKENS : "acceso"
    OWNERS ||--o{ OWNER_TIMELINE_ENTRIES : "eventos"

    PROPERTIES ||--o{ VISITS : "property_id"
    PROPERTIES ||--o| ML_LISTINGS : "publicaciÃ³n"
    PROPERTIES ||--o{ TASACIONES : "valoraciÃ³n"
    PROPERTIES ||--o{ COMMISSIONS : "cierre"

    LEADS ||--o{ VISITS : "lead_id"
    ZERNIO_ACCOUNTS ||--o{ ZERNIO_CONVERSATIONS : "cuenta"
    ZERNIO_CONVERSATIONS ||--o{ ZERNIO_MESSAGES : "mensajes"

    COMMISSION_LIQUIDATIONS ||--o{ COMMISSIONS : "agrupa"
    COMMISSIONS ||--o{ COMMISSION_PAYMENTS : "pagos"

    PROFILES {
        uuid id PK
        user_role role "super_admin | broker | agente"
    }
    AGENTS {
        uuid id PK
        uuid profile_id FK
        text matricula
        numeric commission_sale
        numeric commission_rent
        timestamptz deleted_at "soft-delete"
    }
    PROPERTIES {
        uuid id PK
        text code "secuencial (property_sequences)"
        text status "draft|publicada|vendida|alquilada|pausada"
        uuid agent_id FK
        uuid owner_id FK
        jsonb images
        numeric price_ars "generated column"
        jsonb portal_settings
        timestamptz deleted_at "soft-delete"
    }
    OWNERS {
        uuid id PK
        text dni_cuit
        jsonb documents "expiraciÃ³n y verificaciÃ³n"
    }
    LEADS {
        uuid id PK
        text source "landing_page|newsletter|ml|chat|..."
        text stage "nuevo|contactado|visita|oferta|..."
        text_array tags
        int score
        uuid assigned_to FK
    }
    VISITS {
        uuid id PK
        uuid lead_id FK
        uuid property_id FK
        uuid agent_id FK
        text status "pendiente|confirmada|completada|cancelada"
        uuid confirmation_token UK
        timestamptz confirmed_at
        text cancel_reason
    }
    TASACIONES {
        uuid id PK
        jsonb data "ACM completo"
        text status "borrador|en_revision|entregada|vencida"
    }
    COMMISSIONS {
        uuid id PK
        text status "pendiente|liquidada|pagada"
    }
    ZERNIO_CONVERSATIONS {
        uuid id PK
        text platform "IG|FB|WA|Web"
        uuid broker_id FK "auto-asignado por trigger"
    }
```

### Tablas por dominio

#### ðŸ¢ NÃºcleo de negocio

| Tabla | DescripciÃ³n |
|---|---|
| `properties` | Propiedades (draft/publicada/vendida/alquilada/pausada), imÃ¡genes JSONB, `agent_id`, `owner_id`, `portal_settings`, `price_ars` generada |
| `agents` | Asesores/brokers: matrÃ­cula, `commission_sale`/`commission_rent`, `profile_id`, soft-delete `deleted_at` |
| `owners` | Propietarios: DNI/CUIT, documentos JSONB (vencimiento y verificaciÃ³n) |
| `leads` | Pipeline CRM: `source`, `stage`, `tags`, `score`, `assigned_to` |
| `visits` | Visitas: estados, `agent_id`, `confirmation_token`, check-in/out |
| `tasaciones` | ACM: `data` JSONB, valoraciÃ³n USD/ARS, estado borrador/en_revision/entregada/vencida |
| `commissions` | Comisiones por cierre (pendiente/liquidada/pagada) |
| `commission_liquidations` | Liquidaciones mensuales |
| `commission_payments` | Pagos registrados |
| `ml_listings` | Publicaciones Mercado Libre (sync, dedup) |
| `property_sequences` | Secuencia de cÃ³digos de propiedad (solo `service_role`) |

#### ðŸŽ¨ CMS y configuraciÃ³n

| Tabla | DescripciÃ³n |
|---|---|
| `site_content` | Contenido por secciÃ³n del landing: hero, services, team, process, stats, contact, footer, social |
| `portal_settings` | CMS en vivo del landing (hero, servicios, stats, testimonios). Lectura solo autenticada |
| `app_settings` | Ajustes globales key/value JSONB: `preferences` (incl. `usd_rate`), `features`, `integrations` |
| `profiles` | Perfiles vinculados a `auth.users` con campo `role` |

#### ðŸ’¬ Chat Zernio

| Tabla | DescripciÃ³n |
|---|---|
| `zernio_config` | Secretos del mÃ³dulo (API key, webhook secret). RLS sin policies: solo `service_role` |
| `zernio_accounts` | Espejo de cuentas sociales conectadas |
| `zernio_conversations` | Hilos DM unificados (IG/FB/WA/Web); `broker_id` auto-asignado por trigger |
| `zernio_messages` | Mensajes; escritura solo vÃ­a Edge Functions |
| `zernio_webhook_events` | DeduplicaciÃ³n de eventos (`payload.id` Ãºnico) |

#### ðŸ›¡ï¸ SupervisiÃ³n y auditorÃ­a

| Tabla | DescripciÃ³n |
|---|---|
| `audit_log` | Registro de auditorÃ­a de escrituras y acciones sensibles (con cadena de integridad) |
| `supervision_rules` | Reglas configurables de detecciÃ³n (solo `super_admin`) |
| `supervision_alerts` | Alertas operativas generadas por reglas |
| `supervision_baselines` | Baselines estadÃ­sticos |
| `supervision_anomalies` | AnomalÃ­as detectadas (ML/estadÃ­stica) |
| `supervision_anomaly_config` | ConfiguraciÃ³n del detector |
| `user_risk_scores` | Score de riesgo por usuario, con factores explicables |
| `user_sessions` | Sesiones registradas |
| `api_key_audit` | AuditorÃ­a de uso de API keys |
| `usage_events` | MÃ©tricas de uso (append-only) |
| `ml_model_metrics` | MÃ©tricas del modelo (precision, recall, F1) |
| `ml_predictions_log` | Log de predicciones |
| `rate_limit_logs` | Sliding window del rate limiter |
| `notification_preferences` | Preferencias por usuario (email/push/slack) |

#### ðŸ“‚ Portal del Propietario y documentos

| Tabla | DescripciÃ³n |
|---|---|
| `owner_portal_tokens` | Tokens de acceso al portal (validaciÃ³n + expiraciÃ³n) |
| `document_requirements` | Requisitos documentales por tipo de operaciÃ³n |
| `owner_timeline_entries` | Timeline de comunicaciones y eventos |

### Triggers y lÃ³gica en base de datos

| Trigger / FunciÃ³n | Efecto |
|---|---|
| `guard_profiles_self_update` | Impide la auto-elevaciÃ³n de rol |
| `trg_visits_sync_lead_stage` | Crear visita â†’ lead pasa a `visita` |
| `trg_visits_lead_cancel_revert` | Cancelar visita â†’ lead vuelve a `contactado` |
| `trg_visits_lead_completed_auto` | Completar visita â†’ sugiere `oferta` |
| Triggers `BEFORE INSERT` en chat | Auto-asignan `broker_id` |
| `set_property_code` / `generate_property_code` | CÃ³digo secuencial de propiedad |
| `get_sidebar_badge_counts` (RPC, SECURITY DEFINER) | Contadores del sidebar respetando RLS |
| `count_pending_visits_for_lead`, `is_super_admin` | Helpers de negocio y permisos |

### Vistas (`security_invoker = true`)

`ml_model_performance`, `daily_user_activity`, `daily_module_activity`, `open_alerts_by_user`, `my_assigned_alerts`, `purge_audit_log`, `supervision_anomalies_recent`, `current_user_risk_scores`.

### PolÃ­ticas RLS destacadas

| Tabla | PolÃ­tica |
|---|---|
| `properties` | Lectura pÃºblica de las publicadas (`TO public`); escritura autenticada |
| `leads` | `INSERT` anÃ³nimo solo con `source IN ('landing_page','newsletter')` |
| `visits` | `SELECT/UPDATE` anÃ³nimo por `confirmation_token`; resto vÃ­a JOIN `agents.profile_id = auth.uid()` |
| `owners` | `SELECT` super_admin/broker; `INSERT/UPDATE/DELETE` solo super_admin |
| `tasaciones` | Solo `authenticated` y `service_role` (sin acceso anÃ³nimo) |
| `portal_settings` | Lectura solo autenticada (sin fuga de secretos) |
| `zernio_config`, `property_sequences` | Sin policies: solo `service_role` (intencional) |
| `supervision_rules` | GestiÃ³n exclusiva de `super_admin` |

---

## ðŸ‘¥ Roles y permisos

El permiso se resuelve con `profiles.role` (enum `user_role`):

| Rol | Alcance |
|---|---|
| `super_admin` | Acceso total, gestiÃ³n de usuarios, ajustes sensibles y supervisiÃ³n |
| `broker` | GestiÃ³n operativa completa y sus asignaciones (`agents.profile_id = auth.uid()`) |
| `agente` | Solo sus propias asignaciones |

**Chat:** `super_admin` ve todo; `broker` solo las conversaciones donde `broker_id` corresponde a su agente.

---

## ðŸ”’ Seguridad

- **RLS en las 37 tablas**; lectura pÃºblica solo donde corresponde.
- **Hardening de funciones**: `search_path` fijo, `REVOKE ALL` a `PUBLIC` y `anon` en 44 funciones, con `GRANT` explÃ­citos.
- **XSS**: `esc()` obligatorio antes de todo `innerHTML`; `safeUrl` / `safeImageUrl` / `safeCssUrl` para atributos. Ver `XSS_REVIEW.md`.
- **CSP** verificada por tests en las 5 pÃ¡ginas.
- **AutenticaciÃ³n por token** en portal y confirmaciÃ³n de visita.
- **SesiÃ³n cruzada por iframe**: `postMessage` con `targetOrigin` explÃ­cito y verificaciÃ³n de `event.origin`.
- **Edge Functions**: `verify_jwt` segÃºn funciÃ³n, chequeo de rol vÃ­a service role y rate limiting.
- **Secretos**: solo en Edge Functions (`Deno.env.get`), tokens ML cifrados con AES-256-GCM.
- **AuditorÃ­a**: `audit_log` con cadena de integridad + `api_key_audit`.

---

## ðŸ–¥ï¸ Panel administrativo (14 mÃ³dulos)

SPA con hash routing (`#tab-dashboard`) y sidebar en 4 categorÃ­as: **Principal**, **GestiÃ³n & CRM**, **Red & DifusiÃ³n** y **Sistema**.

| # | MÃ³dulo | Tab ID |
|---|---|---|
| 1 | Dashboard | `tab-dashboard` |
| 2 | Propiedades | `tab-propiedades` |
| 3 | Leads & CRM | `tab-leads` |
| 4 | Agenda de Visitas | `tab-agenda` |
| 5 | Tasaciones | `tab-tasaciones` |
| 6 | Propietarios | `tab-propietarios` |
| 7 | Sitio Web (CMS) | `tab-sitio-web` |
| 8 | Portales & APIs | `tab-portales` |
| 9 | Agentes & Brokers | `tab-agentes` |
| 10 | Chat Redes | `tab-chat-redes` |
| 11 | Ficha HTML | `tab-ficha-html` |
| 12 | Usuarios & Permisos | `tab-usuarios` |
| 13 | ConfiguraciÃ³n | `tab-configuracion` |
| 14 | Centro de SupervisiÃ³n | `tab-supervision` |

### API global `window.adminApp`

Expone los handlers al HTML (39 mÃ©todos):

- **Entidades:** `edit*` / `delete*` para propiedades, leads, propietarios, visitas y agentes.
- **Propietarios:** `exportOwnersCSV`, `exportOwnersPDF`, `generateOwnerPortalLink`, `deleteOwnerDoc`, `deleteTimelineEntry`.
- **Visitas:** `openVisitModal`, `checkinVisit`, `checkoutVisit`, `exportVisitsCSV`, `exportVisitsICS`.
- **Comisiones:** `markCommissionPaid`, `markLiquidationPaid`, `deletePayment`, `viewCommissionLiquidation`, `viewLiquidationPDF`.
- **Portales/ML:** `mlConnect`, `mlDisconnect`, `mlSaveCredentials`, `mlPublishProperty`, `mlRemoveProperty`, `mlUpdateProperty`, `mlToggleConfig`, `mlImportFromML`, `togglePortal`, `openPortalConfig`.
- **Chat:** `openChatConversation`.
- **SupervisiÃ³n:** `loadSupervision`, `loadAnomaliesTable`.

### NavegaciÃ³n y estado

- Tabs con hash routing y persistencia en `localStorage`.
- BÃºsqueda global `Ctrl+K` con resaltado.
- Panel de notificaciones, badges en tabs y contador en favicon.
- Badges del sidebar en vivo vÃ­a RPC `get_sidebar_badge_counts`.

### ðŸ§© MÃ³dulo Sitio Web (CMS)

11 sub-tabs (Hero, CatÃ¡logo, Servicios, Equipo, Stats, Proceso, Contacto, Formulario, Navbar, Footer, SEO). Guarda en `site_content` y `portal_settings`; el landing re-renderiza con `applySectionContent()` y cachÃ© invalidable (`invalidateCmsCache`, `getCachedCMS`).

### ðŸ§© MÃ³dulo Ficha HTML

- Layout de dos columnas: formulario + preview 1:1 (responsive 1200/1024/680px).
- Autocompletado desde el CRM (debounce 250 ms) y drag & drop de fotos.
- Tres exportaciones: `navigator.share`, `window.print` (PDF) y HTML autocontenido descargable.

### ðŸ§© MÃ³dulo ConfiguraciÃ³n

| SecciÃ³n | Destino |
|---|---|
| Identidad corporativa | `site_content.footer` (razÃ³n social, matrÃ­cula, CUIT) |
| Contacto digital | `site_content.contact` (WhatsApp, email, telÃ©fono, direcciÃ³n, horario) |
| Redes sociales | `site_content.social` (URL vacÃ­a = icono oculto) |
| Preferencias | `app_settings.preferences.usd_rate` |
| Sistema e integraciones | Chips de estado: Supabase, Cloudinary, ML, Zernio |
| SesiÃ³n activa | Usuario, rol y cierre de sesiÃ³n |

El guardado valida, hace *deep merge* (preserva claves no editadas) y hace UPDATE/INSERT. Sin `super_admin`, los campos quedan deshabilitados.

---

## ðŸŒ Landing pÃºblica

Consume `site_content` y `portal_settings` desde `landing-app.js`.

- CatÃ¡logo dinÃ¡mico con filtros server-side, orden, paginaciÃ³n y virtual scroller.
- GalerÃ­a con thumbnails y navegaciÃ³n.
- Formulario de contacto â†’ `leads`, con pills de interÃ©s y validaciÃ³n.
- Secciones de stats, equipo, servicios y proceso desde el CMS.
- ImÃ¡genes con Cloudinary (`f_auto,q_auto`) y lazy loading.
- Mobile-first con menÃº mÃ³vil y botÃ³n flotante de WhatsApp.
- SEO completo (meta, Open Graph, `schema.org`, sitemap, robots).

---

## ðŸ¡ Portal del Propietario

`portal-propietario.html?token=<uuid>` â€” acceso **sin login**.

- Valida token y expiraciÃ³n (`owner_portal_tokens`); muestra error si es invÃ¡lido.
- Lista las propiedades del propietario.
- Muestra documentos (`document_requirements` + `owners.documents`).
- Muestra comisiones y liquidaciones (pendiente / liquidada / pagada).
- El link lo genera el admin con `generateOwnerPortalLink`.

---

## âœ… ConfirmaciÃ³n de visitas

`confirmar-visita.html?token=<uuid>` usa `visits.confirmation_token`.

| AcciÃ³n | Resultado |
|---|---|
| **Confirmar** | `status = 'confirmada'`, `confirmed_at = now()` |
| **Cancelar** | `status = 'cancelada'`, `cancel_reason = 'Cancelado por cliente'` |

Muestra cliente, fecha/hora y estado visual (pendiente / confirmada / completada / cancelada).

---

## ðŸ“ Tasaciones (ACM)

`tasacion.html` es una herramienta autÃ³noma de AnÃ¡lisis Comparativo de Mercado:

- **Comparables**: alta manual, extracciÃ³n por URL, carga y renovaciÃ³n de fotos.
- **Mapa** (Leaflet) con bÃºsqueda por direcciÃ³n (geocoding).
- **CaracterÃ­sticas** (ambientes, uso de terreno) y **coeficientes** (condiciones, depreciaciÃ³n) con recÃ¡lculo en vivo.
- **GrÃ¡ficos** (Chart.js) de anÃ¡lisis comparativo.
- **Guardado** en `tasaciones` (`data` JSONB + estado + valoraciÃ³n USD/ARS).
- **SesiÃ³n** recibida del admin vÃ­a `postMessage`; notifica con `tasaciones-finalized` y `tasaciones-back`.

---

## ðŸ’° Comisiones y liquidaciones

- Tablas: `commissions`, `commission_liquidations` (mensual), `commission_payments`.
- Edge Functions: `trigger_commission_on_close` (crea la comisiÃ³n al cerrar la propiedad) y `monthly_commission_liquidation` (cierre mensual).
- Porcentajes por agente: `commission_sale` y `commission_rent`.
- Admin: marcar como pagada, liquidar, ver PDF de liquidaciÃ³n, eliminar pagos, filtrar por broker/estado.
- El Portal del Propietario muestra el estado.

---

## ðŸ›’ IntegraciÃ³n Mercado Libre

1. **ConexiÃ³n OAuth 2.0** â†’ `mlConnect` (tab Portales).
2. **PublicaciÃ³n** â†’ `mlPublishProperty` con validaciÃ³n de campos y fotos.
3. **SincronizaciÃ³n** â†’ Edge Function `ml-sync` (cron, lotes de 50): precio, stock y estado, en ambas direcciones.
4. **Auto-reply** â†’ plantillas por tipo de pregunta con variables.
5. **Webhook** â†’ firmado y con deduplicaciÃ³n; *dead-letter queue* visible.
6. **ImportaciÃ³n inversa** â†’ `mlImportFromML` trae publicaciones que existen en ML pero no en el CRM.

Los tokens se guardan cifrados (AES-256-GCM) y nunca llegan al frontend.

---

## ðŸ’¬ Chat omnicanal (Zernio)

**Estado:** recepciÃ³n validada en producciÃ³n (HMAC, dedup, persistencia, auditorÃ­a). El envÃ­o saliente espera una API key real.

| Componente | UbicaciÃ³n | Estado |
|---|---|---|
| Webhook receptor | `supabase/functions/zernio-webhook` | âœ… `verify_jwt` OFF |
| Proxy API | `supabase/functions/zernio-proxy` | âœ… `verify_jwt` ON |
| Test de webhook | `supabase/functions/zernio-webhook-test` | âœ… |
| Frontend | tab Chat Redes (`admin-app.js`) | âœ… `super_admin` y `broker` |
| Base de datos | 5 tablas `zernio_*` | âœ… RLS + triggers |
| GuÃ­a | `CONECTAR_ZERNIO_CHAT.md` | âœ… |

**Acciones del inbox:** ver contexto lateral (propiedad/lead/visitas), crear lead, agendar visita, asignar broker, marcar leÃ­do y enviar mensaje.

---

## ðŸ›¡ï¸ Centro de SupervisiÃ³n

- **Reglas configurables** ejecutadas con `pg_cron` (solo `super_admin`).
- **Alertas** con severidad y asignaciÃ³n.
- **AnomalÃ­as** estadÃ­sticas/ML (`supervision-ml-anomaly` + baselines).
- **Risk scoring** por usuario con factores explicables.
- **Notificaciones** push/email y **digest diario** vÃ­a Brevo.
- **API de consulta** (`supervision-api`, lÃ­mite 60 req/min).
- **MÃ©tricas ML** y de uso.
- **RetenciÃ³n y purga** (`purge_policy`).

---

## âš¡ Edge Functions

### Helpers compartidos (`_shared/`)

| Archivo | PropÃ³sito |
|---|---|
| `auth.ts` | `requireAdmin` / `isAdmin`: valida Bearer JWT + rol |
| `cors.ts` Â· `http.ts` | Headers CORS, `jsonResponse`, `optionsResponse`, allowlist de origins |
| `crypto.ts` | AES-256-GCM (clave PBKDF2 derivada de `CRYPTO_SECRET`) |
| `ml.ts` Â· `ml.schemas.ts` | Cliente API Mercado Libre + schemas Zod |
| `rate-limit.ts` | Sliding window log en `rate_limit_logs` |
| `audit.ts` | `auditEvent`, `auditSensitiveAction`, `trackToolUsage`, `auditError` |

### Funciones versionadas en el repo

| FunciÃ³n | JWT | PropÃ³sito |
|---|---|---|
| `cloudinary-sign` | ON + admin | Firma uploads con allowlist de carpetas |
| `manage-users` | ON + super_admin | `invite`, `create-direct`, `set-role`, `update-user`, `update-self` |
| `ml-sync` | cron | Sync con Mercado Libre |
| `cron_exclusivity_renewals` | cron | Avisos de exclusividades por vencer |
| `monthly_commission_liquidation` | cron | LiquidaciÃ³n mensual |
| `trigger_commission_on_close` | evento | Crea comisiÃ³n al cerrar |
| `supervision-api` | ON | Consultas del Centro de SupervisiÃ³n |
| `supervision-digest` | cron | Resumen diario por Brevo |
| `supervision-ml-anomaly` | ON | DetecciÃ³n de anomalÃ­as |
| `supervision-notifications` | ON | Push/email de alertas crÃ­ticas |
| `supervision-notify` | cron | Dispara notificaciones |
| `zernio-proxy` | ON | `send_message`, `mark_read`, `list_accounts`, `backfill_*` |
| `zernio-webhook` | OFF | Recibe webhooks (HMAC, dedup, persistencia) |
| `zernio-webhook-test` | OFF | Test de configuraciÃ³n |

### Desplegadas en producciÃ³n sin fuente en el repo

`ml-oauth`, `ml-callback`, `ml-auth`, `ml-api`, `ml-config`, `ml-categories`, `ml-listing-types`, `ml-metrics`, `ml-answer-question`, `ml-bulk-enqueue`, `ml-revoke-tokens`, `ml-import-listings`, `ml-sync-import`, `ml-webhook`.

> Las funciones huÃ©rfanas `qr-checkin`, `visits-process-reminders`, `admin-user-invite`, `audit-log`, `contact-submit`, `chat-ai`, `chat-upload`, `convert-image` y `process-retention-policies` se eliminaron de producciÃ³n el 2026-08-30.

---

## ðŸ§¬ Migraciones

`supabase/migrations/` (orden cronolÃ³gico):

| MigraciÃ³n | Contenido |
|---|---|
| `20260824000001_audit_system_foundation` | Base de auditorÃ­a (`audit_log`, usuarios, sesiones) |
| `20260824000002_supervision_rules_defaults` | Reglas por defecto |
| `20260824000003_pg_cron_supervision_rules` | Cron de reglas |
| `20260824000004_risk_scoring_system` | `user_risk_scores` |
| `20260824000005_audit_integrity_chain` | Cadena de integridad del log |
| `20260824000006_notification_preferences` | Preferencias de notificaciÃ³n |
| `20260824000007_ml_metrics_dashboard` | MÃ©tricas ML |
| `20260824000008_supervision_repair` | Ajustes de supervisiÃ³n |
| `20260824000009_supervision_alert_assignment` | AsignaciÃ³n de alertas |
| `20260824000010_supervision_notify_integration` | IntegraciÃ³n de notificaciones |
| `20260824000011_purge_policy` | RetenciÃ³n y purga |
| `20260824000012_supervision_digest` | Digest diario |
| `20260824000013_supervision_anomaly_detection` (+ part1/part2) | DetecciÃ³n de anomalÃ­as |
| `20260824000016_api_key_audit_sessions` | AuditorÃ­a de API keys y sesiones |
| `20260826_propietarios_100pct` | MÃ³dulo propietarios completo |
| `20260826000001_cms_complete_landing` | CMS del landing |
| `20260827_chat_broker_access` | Acceso de brokers al chat |
| `20260827_fix_visits_rls` | Fix RLS de visitas |
| `20260827_unify_agent_ids` | UnificaciÃ³n de IDs â†’ `agents.id` |
| `20260827_zernio_chat_completo` | Schema Zernio completo |
| `20260828_fix_owners_rls` | RLS de owners |
| `20260830_fix_properties_public_read` | Lectura pÃºblica de propiedades |
| `20260901000001_fix_p0_security_and_functional` | Hardening P0 (RLS, REVOKEs, vistas, policies anon) |

```bash
supabase migration list     # ver estado
supabase db push            # aplicar pendientes
```

---

## ðŸ”„ Flujos end-to-end

### 1. Lead â†’ Visita â†’ Cierre

```mermaid
flowchart LR
    A[Landing / ML / Chat] --> B[Lead<br/>stage: nuevo]
    B --> C[Broker asignado<br/>contactado]
    C --> D[Visita agendada<br/>+ confirmation_token]
    D --> E[Cliente confirma<br/>confirmar-visita.html]
    E --> F[Check-in / Check-out]
    F --> G[Completada<br/>lead â†’ oferta]
    G --> H[Cierre:<br/>vendida / alquilada]
    H --> I[ComisiÃ³n<br/>automÃ¡tica]
```

### 2. PublicaciÃ³n en Mercado Libre

```
Propiedad â†’ mlPublishProperty â†’ validaciÃ³n â†’ ml-sync (cron) â†’ API ML
   â†’ ml_listings â†’ sync bidireccional (precio / stock / estado)
   â†’ Webhook ML â†’ preguntas â†’ notificaciÃ³n al broker
   â†’ ImportaciÃ³n inversa: mlImportFromML
```

### 3. TasaciÃ³n â†’ CaptaciÃ³n

```
tab-tasaciones â†’ iframe tasacion.html?id= â†’ ACM (comparables, mapa, coeficientes)
   â†’ guardar en tasaciones â†’ finalizar â†’ postMessage al admin
   â†’ Lead de captaciÃ³n â†’ visita â†’ contrato â†’ propiedad publicada
```

### 4. Chat omnicanal

```
WhatsApp / IG / FB / Web â†’ zernio-webhook (HMAC + dedup)
   â†’ conversaciÃ³n + mensaje â†’ Realtime â†’ Inbox unificado
   â†’ crear lead Â· agendar visita Â· asignar broker
```

### 5. Portal del Propietario

```
Admin: Propietarios â†’ generateOwnerPortalLink â†’ owner_portal_tokens
   â†’ Propietario abre ?token= â†’ propiedades, documentos, comisiones
   â†’ Token vencido o invÃ¡lido â†’ mensaje de error
```

### 6. SupervisiÃ³n

```
pg_cron â†’ supervision_rules + baselines + ml-anomaly â†’ alertas / anomalÃ­as
   â†’ supervision-notify â†’ supervision-notifications (push/email)
   â†’ supervision-digest (Brevo) â†’ tab SupervisiÃ³n / supervision-api
```

---

## ðŸ§± Patrones tÃ©cnicos

### `mutate(table, fn)`

Wrapper de escrituras: ejecuta la mutaciÃ³n, invalida la cachÃ© de bÃºsqueda y emite un evento de cambio.

```js
await mutate('properties', () =>
  supabaseClient.from('properties').update(data).eq('id', id)
);
```

### Realtime

`setupCoreRealtime` suscribe `properties`, `leads`, `visits`, `agents`, `owners`, `tasaciones`, `commissions` y las tablas de Zernio para mantener varias pestaÃ±as sincronizadas sin polling.

### Helpers de seguridad (`window.BHUtils`)

`esc`, `escAttr`, `safeUrl` (http/https/mailto/tel/relativos), `safeImageUrl`, `safeCssUrl`.

### ValidaciÃ³n con Zod

Solo en el admin, para formularios (ej. Agente con `commission_sale` / `commission_rent`).

### Reglas de negocio compartidas

| Regla | Fuente |
|---|---|
| Tipo de cambio USD | `app_settings.preferences.usd_rate` |
| Roles | `profiles.role` + RLS |
| Responsable | `agent_id` / `assigned_to` / `broker_id` â†’ `agents.id` |
| Estados de propiedad | `properties.status` |
| Pipeline | `leads.stage` |
| Estado de visita | `visits.status` |
| Feature flags | `app_settings.features` |

---

## ðŸŒ¥ï¸ Deploy

### Cloudflare Pages

| Ajuste | Valor |
|---|---|
| Build command | *(vacÃ­o)* |
| Output directory | `/` |
| Dominio | `CNAME` â†’ `bienenhaus.com.ar` |

GuÃ­a detallada: [`CLOUDFLARE_SETUP.md`](CLOUDFLARE_SETUP.md).

### Cache busters

Al modificar un JS o CSS, subir el `?v=N` en el HTML correspondiente (`admin-app.js`, `landing-app.js`, `admin.css`, `landing.css`, `config.js`, `utils.js`, etc.).

### Edge Functions

```bash
supabase functions deploy <slug>                  # verify_jwt ON (por defecto)
supabase functions deploy <slug> --no-verify-jwt  # webhooks y cron
```

---

## ðŸ§ª Testing y CI

```bash
npm run lint    # node --check sobre admin-app.js y landing-app.js
npm test        # Playwright (19 tests)
```

La suite E2E corre **en modo lectura** contra producciÃ³n (RLS protege las escrituras) y cubre:

- CatÃ¡logo con propiedades publicadas y bÃºsqueda.
- Presencia del formulario de contacto.
- CSP de las 5 pÃ¡ginas.
- RegresiÃ³n de delegaciÃ³n `data-action`.
- Smoke de tasaciones, portal y confirmar-visita.
- Admin (login, tabs, sesiÃ³n persistente): **solo** con `BH_TEST_ADMIN_EMAIL` y `BH_TEST_ADMIN_PASSWORD`.

**CI** (`.github/workflows/deploy.yml`): `node --check` + `npm test` con Chromium headless. `html-validate` corre como informativo.

---

## ðŸ“ Convenciones de desarrollo

- Scripts clÃ¡sicos IIFE + globals (`BH_CONFIG`, `supabaseClient`, `BHUtils`, `BH_Cloudinary`, `adminApp`); sin ES Modules ni bundler.
- **Siempre** `esc()` antes de `innerHTML`; `safeUrl` / `safeImageUrl` en `href` / `src`.
- `async/await` con `try/catch` en cada llamada a Supabase o Edge Functions.
- Escrituras del admin con `mutate()` en lugar de `.insert/.update/.delete` directos.
- Suscripciones Realtime centralizadas en `setupCoreRealtime`.
- Subir el cache buster tras tocar JS/CSS.
- Ejecutar `npm run lint` antes de cada commit.
- Secretos Ãºnicamente en Edge Functions.

---

## ðŸ§¾ Deudas tÃ©cnicas y roadmap

| Ãtem | Impacto | Estado |
|---|---|---|
| Edge Functions desplegadas sin fuente en el repo (ML OAuth/API, etc.) | Mantenibilidad / drift | Pendiente: sincronizar el cÃ³digo |
| Cambios de `admin-app.js` sin commitear (`loadAnomaliesTable`, `supNewRuleBtn`) | Entrega | Commitear y subir cache buster |
| Commit `ed9c75c` sin pushear | Repo desincronizado | `git push` |
| Leaked Password Protection (Supabase Auth) | Seguridad | Activar en Dashboard â†’ Auth (manual) |
| Zernio sin API key para envÃ­os | Funcionalidad parcial | Falta credencial |
| `usd_rate` sin uso en tarjetas del landing | Feature | Conectar `fmtARS` cuando se necesite |
| Notificaciones push reales (Web Push / VAPID) | Futuro | Service Worker pendiente |
| Advisor: `rls_enabled_no_policy` en `property_sequences` y `zernio_config` | Info | Intencional (solo `service_role`) |
| Advisor: `pg_net` en `public` | Info | Requerida por Edge Functions |
| `admin-app.js` de ~14k lÃ­neas | Mantenibilidad | Candidato a dividirse por mÃ³dulo |

---

## ðŸ“š ADRs (Architecture Decision Records)

| ADR | DecisiÃ³n | RazÃ³n |
|---|---|---|
| 001 | Vanilla JS + scripts clÃ¡sicos IIFE | Deploy simple, sin build |
| 002 | Supabase como backend Ãºnico | RLS nativo, DX unificada |
| 003 | `agent_id` en todas las entidades (â†’ `agents.id`) | Trazabilidad, comisiones, permisos |
| 004 | `source` + `tags` en leads | Flexibilidad de origen |
| 005 | Realtime centralizado | UI instantÃ¡nea multi-tab |
| 006 | Config en `app_settings` + `site_content` | Fuente Ãºnica de USD, branding y flags |
| 007 | Edge Functions para secretos | Nada sensible en el frontend |
| 008 | Chat Zernio opcional (feature flag) | No bloquea releases |
| 009 | Soft delete en `properties` y `agents` | AuditorÃ­a y recuperaciÃ³n |
| 010 | `price_ars` como columna generada | Consistencia ARS/USD |
| 011 | `confirmation_token` Ãºnico en `visits` | ConfirmaciÃ³n sin login |
| 012 | Idempotency keys en webhooks | Procesamiento exactly-once |
| 013 | Cache busters `?v=N` | Control total de cachÃ© |
| 014 | Wrapper `mutate()` | Invalida cachÃ© y mantiene Realtime consistente |
| 015 | Zod (UMD) solo en admin | ValidaciÃ³n runtime de formularios |
| 016 | Portal/Visita por token URL | Acceso pÃºblico sin credenciales |

---

## ðŸ“– DocumentaciÃ³n complementaria

| Documento | Contenido |
|---|---|
| [`AUDITORIA_MODULOS.md`](AUDITORIA_MODULOS.md) | AuditorÃ­a mÃ³dulo a mÃ³dulo (P0/P1/P2) |
| [`AUDIT_FINDINGS.md`](AUDIT_FINDINGS.md) Â· [`AUDIT_INVENTORY.md`](AUDIT_INVENTORY.md) | Hallazgos e inventario de auditorÃ­a |
| [`REMEDIATION_PLAN.md`](REMEDIATION_PLAN.md) | Plan de remediaciÃ³n |
| [`XSS_REVIEW.md`](XSS_REVIEW.md) | RevisiÃ³n de superficie XSS |
| [`CLOUDFLARE_SETUP.md`](CLOUDFLARE_SETUP.md) | ConfiguraciÃ³n de Cloudflare Pages |
| [`CONECTAR_ZERNIO_CHAT.md`](CONECTAR_ZERNIO_CHAT.md) | ActivaciÃ³n del chat Zernio |
| `docs/integrations/` | DocumentaciÃ³n de integraciones |

---

## ðŸ“ Changelog

| Fecha | VersiÃ³n | Cambios |
|---|---|---|
| 2026-09-01 | â€” | MigraciÃ³n `20260901000001`: hardening P0 aplicado a producciÃ³n |
| 2026-08-30 | â€” | Suite E2E Playwright; fix RLS `properties_public_read`; RLS de `tasaciones`; REVOKE en 44 funciones; 8 vistas `security_invoker`; policies anon para `leads` y `visits`; `portal_settings` sin fuga de secretos; 9 Edge Functions huÃ©rfanas eliminadas; `acorn` removido |
| 2026-08-28 | â€” | Limpieza de repo y documentaciÃ³n |
| 2026-08-27 | v2.3.0 | Chat Zernio 100 %; auditorÃ­a P0/P1/P2; unificaciÃ³n de IDs de agente; Realtime en tablas core; `mutate()`; split de comisiones venta/alquiler |
| 2026-08-26 | â€” | MÃ³dulo Propietarios y CMS completo |
| 2026-08-25 | v2.2.0 | Fixes visuales del landing, CMS consolidado en un solo tab |
| 2026-08-24 | v2.1.0 | Ficha HTML + Centro de SupervisiÃ³n + paquete de migraciones de auditorÃ­a |

---

<div align="center">

**BIENENHAUS PROPIEDADES** Â· Mantenedor: [@facuherrera23](https://github.com/facuherrera23)

*Documento vivo: actualizar con cada release.*


