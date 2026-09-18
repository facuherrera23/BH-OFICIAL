# BIENENHAUS PROPIEDADES — Plataforma Inmobiliaria

Landing pública + panel administrativo (CRM completo) para inmobiliaria premium de **Córdoba** (CPI 1834).

Vanilla JS puro (sin bundler, sin build, scripts IIFE + globals) sobre **Supabase** (PostgreSQL + Auth + RLS + Realtime + Edge Functions Deno). Deploy: **GitHub Pages** (estático, rama `main`).

---

## Módulos

| Módulo | Archivos | Qué hace |
|---|---|---|
| Landing pública | `index.html`, `assets/js/landing-app.js`, `assets/css/landing.css` | Catálogo de propiedades publicadas (**paginado de a 9**), OG/SEO, formulario de contacto que alimenta el CRM, **rotación de teléfono/WhatsApp por visita** (2 líneas reales, sticky por visitante) |
| Fichas públicas | `fichas/` + `scripts/generate-ficha.mjs` | **Páginas indexables** (title/meta/canonical/JSON-LD `RealEstateListing`) con OG para compartir por WhatsApp; regeneradas cada 30' por CI junto con `sitemap.xml` |
| Panel admin (CRM) | `admin.html`, `assets/js/admin-app.js`, `assets/js/admin-crm.js`, `assets/js/admin-crm-tasks.js` | Propiedades, Leads, Agenda/Visitas, Propietarios y documentación, Tasaciones, Agentes, Chat Zernio, CMS del sitio |
| Portal propietario | `portal-propietario.html`, `assets/js/pages/portal-propietario-page.js` | Login con token alfanumérico de 5 caracteres |
| Tasación (interna) | `tasacion.html` | ACM comparativo de mercado (noindex, herramienta de agentes) |
| Confirmación de visitas | `confirmar-visita.html` | Confirmación por token (noindex) |

## Stack técnico

- **Frontend**: vanilla JS puro (sin bundler, estado global vía `window.*`).
- **Backend**: Supabase (PostgreSQL + Auth + RLS + Realtime + Edge Functions Deno).
- **Imágenes**: Cloudinary (upload firmado, `cloudinary-sign`).
- **Deploy**: **GitHub Pages** (producción, auto-publish en push a `main`) + workflow CI (`deploy.yml`: lint → E2E → bump cache busters → deploy Edge Functions). El workflow `ficha-generate.yml` regenera `fichas/*.html` y `sitemap.xml` cada 30' y los commitea.

## SEO / contenido gestionado

- El texto visible de la landing vive en dos capas: defaults estáticos en `index.html` + overrides desde la tabla `site_content` (editables con el CMS del admin).
- El SEO (title/description/OG) también es CMS-driven; JSON-LD (`RealEstateAgent`, Córdoba, CPI 1834) es estático en `index.html` con teléfono canónico fijo — la rotación de teléfonos no afecta datos estructurados.
- `sitemap.xml` lo genera `scripts/generate-ficha.mjs` (home + legales + fichas publicadas).
- Legales: `politica-de-privacidad.html` y `terminos-y-condiciones.html` (borrador base Ley 25.326 — revisar con abogado).

## Edge Functions importantes

- **ML**: OAuth tokens en `ml_connection`, publicación (`ml-publish`), sync, webhook (firma HMAC, crea lead con `source='ml'`), preguntas, métricas.
- **RELA (ZonaProp)**: `rela-proxy`, `rela-callbacks`, `rela-sync`. Pausada: pendiente credenciales de producción.
- **Portal propietario**: RPCs `portal_get_portal_data(p_token)` / `portal_validate_token(p_token)`; RLS por token + expiry.
- **Auth**: `manage-users`, `check-password-hash` (HIBP k-anonymity).
- **`ficha`**: deprecado como generador; queda como redirector legado a la ficha estática.

## Tests

- Lint: `npm run lint` (node --check de los JS principales)
- Unitarios: `npm run test:unit`
- E2E: `npm test` (Playwright: index, admin, CRM, tasación, portal, CSP, **fichas/sitemap/rotación**)

## Notas conservadas

- CSP con `unsafe-inline` en admin (mejora pendiente).
- La analítica del sitio usa Cloudflare Web Analytics (beacon permitido en la CSP de `index.html`).
