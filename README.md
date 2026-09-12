# BIENENHAUS PROPIEDADES — Plataforma Inmobiliaria

Landing pública + panel administrativo (CRM completo) para inmobiliaria premium de Buenos Aires.

Vanilla JS puro (sin bundler, sin build, scripts IIFE + globals) sobre **Supabase** (PostgreSQL + Auth + RLS + Realtime + Edge Functions). Deploy: **Cloudflare Pages** (estático, rama `main`).

---

## Módulos

| Módulo | Archivos | Qué hace |
|---|---|---|
| Landing pública | `index.html`, `assets/js/landing-app.js`, `assets/css/landing.css` | Catálogo de propiedades publicadas, OG/SEO, formulario de contacto que alimenta el CRM |
| Panel admin (CRM) | `admin.html`, `assets/js/admin-app.js` (~10.600 líneas), `assets/js/admin-crm.js`, `assets/js/admin-crm-tasks.js` | Propiedades, Leads, Agenda/Visitas, **Propietarios y documentación**, Tasaciones, Agentes, Chat Zernio, CMS del sitio |
| **Portal propietario** | `portal-propietario.html`, `assets/js/pages/portal-propietario-page.js` | Login con token alfanumérico de 5 caracteres (sin `0/O/1/I/L`) con duración configurable por el agente |
| Tasación pública | `tasacion.html` | Formulario de tasación (JS inline con CSP nonce) |
| Confirmación de visitas | `confirmar-visita.html` | Confirmación por token |
| Fichas públicas | `fichas/`<br>+ `scripts/generate-ficha.mjs` | Fichas HTML con Open Graph para compartir en WhatsApp; regeneración automática al guardar propiedad |

## Stack técnico

- **Frontend**: vanilla JS puro (sin bundler, estado global vía `window.*`).
- **Backend**: Supabase (PostgreSQL + Auth + RLS + Realtime + Edge Functions Deno).
- **Imágenes**: Cloudinary (upload firmado, `cloudinary-sign`).
- **Deploy**: Cloudflare Pages (estático, rama `main`) + flow de GitHub Actions (lint → test unitarios → test E2E → deploy).

## Edge Functions importantes

- **ML**: OAuth tokens en `ml_connection`, publicación (`ml-publish`), sync (`ml-sync`, `ml-sync-import`), webhook (`ml-webhook`), preguntas (`ml-answer-question`), métricas (`ml-metrics`).
  - Las publicaciones usan **categorías hoja de ML** según `property_type` y siempre incluyen los atributos requeridos de la taxonomía (`TOTAL_AREA`, `COVERED_AREA`, `ROOMS`, `BEDROOMS`, `FULL_BATHROOMS`, `PARKING_LOTS`) con unidades `m²` y encabezado `location` con country/state/city.
  - El webhook valida firma HMAC `x-meli-signature` y crea lead en el CRM automáticamente (`source='ml'`) con resolución de propiedad por `property_ml_meta` → fallback `ml_listings`. Dedupe por `question_id`.
- **RELA (ZonaProp)**: `rela-proxy`, `rela-callbacks` (firma timing-safe), `rela-sync`. Pausada: endpoint de producción depende de credenciales no recibidas todavía.
- **Portal propietario**: `portal_get_portal_data(p_token)` / `portal_validate_token(p_token)` RPCs; RLS filtra por token + expiry.
- **Auth**: `manage-users` (invite/roles/wa invitations), `check-password-hash` (HIBP k-anonymity).

## Tests

- Lint: `npm run lint` (node --check de los JS principales)
- Unitarios: `npm run test:unit` (24 passing: mapping RELA, seguridad utils)
- E2E: `npm test` (Playwright, 29 passing — cubre index, admin auth, CRM, tasación, portal propietario, seguridad CSP)

## Notas conservadas

- CSP con `unsafe-inline` en admin (mejora pendiente).
- Notas internas de propiedades: tabla `property_notes` con RLS SELECT/INSERT append-only, visibles solo desde el panel admin.
