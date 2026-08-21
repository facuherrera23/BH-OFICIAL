# Bienenhaus Propiedades

Landing page + panel administrativo para inmobiliaria premium. Vanilla JS + Supabase + Cloudinary + Mercado Libre.

## URLs

- **Landing**: https://bienenhaus.com.ar
- **Admin**: https://bienenhaus.com.ar/admin
- **Tasaciones**: Se abren via iframe dentro del panel admin

## Stack

- **Frontend**: Vanilla JS (ES Modules), CSS custom properties, Font Awesome 6.5.1
- **Backend**: Supabase (PostgreSQL + Auth + RLS)
- **Imagenes**: Cloudinary (compresion automatica a WebP)
- **Portales**: Mercado Libre (OAuth + Edge Functions)
- **Deploy**: Cloudflare (estatico)

## Estructura

`
Oficial/
  index.html                # Landing page
  admin.html                # Panel administrativo
  tasacion.html             # TAI replica (abre en iframe)
  favicon.ico
  assets/
    css/
      landing.css           # Estilos landing (design system)
      admin.css             # Estilos panel admin
    js/
      config.js             # Supabase + Cloudinary creds
      supabase-client.js    # Cliente Supabase init
      cloudinary.js         # Upload helper (WebP compression)
      landing-app.js        # Landing: catalogo, filtros, CMS, contacto
      admin-app.js          # Admin: auth, CRUD, dashboard, CRM, portales
`

## Base de datos (Supabase)

| Tabla | Descripcion |
|---|---|
| properties | Propiedades publicadas |
| gents | Asesores comerciales |
| owners | Propietarios y expedientes |
| leads | Consultas y prospectos (pipeline CRM) |
| isits | Visitas agendadas |
| 	asaciones | ACM / tasaciones (JSONB data) |
| profiles | Perfiles de usuario (auth) |
| portal_settings | CMS: hero, servicios, stats, testimonials |
| ml_listings | Publicaciones en Mercado Libre |

RLS activado en todas las tablas. Lectura publica para properties/agents; escritura solo para usuarios autenticados con rol admin.

## Panel administrativo

- **Dashboard**: KPIs, grafico de ventas, zonas, leads calientes, ranking brokers
- **Propiedades**: CRUD completo + publicacion a Mercado Libre
- **CRM Leads**: Pipeline Kanban (Nuevos -> Contactados -> Visita -> Oferta)
- **Visitas**: Agenda de visitas con estados
- **Brokers**: Gestion de asesores + ranking
- **Propietarios**: Expedientes + contratos
- **Tasaciones**: ACM completo replica de TAI.html (abre en iframe)
- **Portales**: Config de ZonaProp, Argenprop, Mercado Libre, InmueblesML
- **CMS**: Editor en vivo del sitio web (hero, servicios, stats, testimonios)
- **Usuarios**: Gestion de roles del sistema
- **Configuracion**: Ajustes generales
- **Busqueda global**: Ctrl+K

## Mercado Libre

Integracion completa via OAuth 2.0 + Edge Functions en Supabase:

1. Conexion de cuenta ML desde el panel admin
2. Publicacion de propiedades individuales o masiva
3. Sincronizacion de precios y estados
4. Despublicacion desde el panel

Edge Functions desplegadas:
- ml-auth: Genera URL de autorizacion OAuth
- ml-callback: Intercambia code por access_token
- ml-api: CRUD contra API de Mercado Libre
- ml-config: Estado de conexion y settings

## Seguridad

- RLS activado en todas las tablas
- esc() en admin-app.js para prevenir XSS en innerHTML
- CDN fallback detection (Supabase + Font Awesome)
- Auth validation en tasacion.html (postMessage session)
- Null-checks en todas las funciones CRUD

## Funcionalidades

- Catalogo dinamico con filtros server-side (Supabase)
- CMS en vivo: hero, servicios, stats, testimonials
- WhatsApp flotante + formulario de contacto
- Panel admin completo con auth Supabase
- Export CSV de leads, propiedades y tasaciones
- SEO: meta tags, Open Graph, schema.org RealEstateAgent
- Responsive mobile-first
- Imagenes optimizadas via Cloudinary (WebP auto-conversion)
