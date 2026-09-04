# BIENENHAUS PROPIEDADES — Plataforma Inmobiliaria

Landing pública + panel administrativo (CRM completo) para inmobiliaria premium de Buenos Aires.

Vanilla JS puro (sin bundler, sin build, scripts IIFE + globals) sobre **Supabase** (PostgreSQL + Auth + RLS + Realtime + Edge Functions). Deploy: **Cloudflare Pages** (estático, rama `main`).

---

## Módulos

| Módulo | Archivos | Qué hace |
|---|---|---|
| Landing pública | `index.html`, `assets/js/landing-app.js`, `assets/css/landing.css` | Catálogo de propiedades publicadas con filtros, CMS dinámico vía tabla `site_content`, formulario de contacto, SEO via `sitemap.xml` |
| Panel admin (CRM) | `admin.html`, `assets/js/admin-app.js` (~19.500 líneas) | Propiedades, Leads, Agenda/Visitas, Propietarios, Tasaciones, Portales (Mercado Libre + RELA), Chat Zernio, CMS del sitio, Configuración, Usuarios/roles, Supervisión y auditoría |
| Portal propietario | `portal-propietario.html` | Acceso del propietario por token a sus tasaciones/propiedades/exclusividad |
| Tasación pública | `tasacion.html` | Formulario de tasación (JS inline con CSP nonce) |
| Confirmación de visitas | `confirmar-visita.html` | Confirmación de visita por token |
| Fichas públicas | `fichas/DA-P*.html`, `scripts/generate-ficha.mjs` | Fichas HTML estáticas por propiedad |

## Stack técnico

- **Frontend**: vanilla JS, scripts clásicos (`<script>`), estado global vía `window.*`. Helpers de seguridad en `assets/js/utils.js` (`esc`, `safeUrl`, `safeImageUrl`, `safeCssUrl`).
- **Config pública**: `assets/js/config.js` expone URL de Supabase y la **anon key** (es público por diseño; la protección real es RLS).
- **Imágenes**: upload firmado a Cloudinary vía edge function `cloudinary-sign` (firma SHA-1 server-side, allowlist de carpetas, rol activo requerido). El API secret nunca toca el navegador.
- **Auth admin**: Supabase Auth (email/password + invitaciones). Roles en `profiles`: `super_admin`, `broker`, `agente` (+ `is_active`). Verificación de contraseña contra Have I Been Pwned vía `check-password-hash` (k-anonymity, fail-open).
- **Edge Functions** (`supabase/functions/`, Deno):
  - `_shared/`: `http.ts` (CORS allowlist), `rate-limit.ts` (sliding window en `rate_limit_logs`, fail-closed), `crypto.ts` (AES-256-GCM para tokens ML), `auth.ts`, `audit.ts`, `ml.ts`/`ml.schemas.ts` (tokens con lock CAS, validación zod), `rela.ts`/`rela.mapper.ts`, `visits.ts`, `auto_reply.ts`.
  - Mercado Libre: OAuth (`ml-oauth`/`ml-auth`/`ml-callback`), publicación (`ml-publish`), sync (`ml-sync`, `ml-sync-import`, `ml-import-listings`), webhooks (`ml-webhook`, con firma `x-meli-signature`), preguntas (`ml-answer-question`), métricas (`ml-metrics`), cola (`ml-bulk-enqueue`), config/estado, etc.
  - RELA (portal): `rela-proxy` (acciones del panel), `rela-callbacks` (webhook autenticado por secret + timing-safe, dedupe por `event_id`), `rela-sync`.
  - Zernio (chat/WhatsApp): `zernio-proxy`, `zernio-webhook` (HMAC).
  - CRM/operación: `contact-submit`, `visits-process-reminders`, `owner-tasks-reminder` (emails vía Brevo), `manage-users`, `ficha`, `convert-image`.
  - Supervisión: `supervision-api`, `supervision-digest`, `supervision-ml-anomaly`, `supervision-notifications`, `supervision-notify`.
- **Base de datos**: 52 migraciones en `supabase/migrations/`. RLS habilitado en las tablas de negocio (`properties`, `owners`, `owner_tasks`, `leads`, `visits`, `agents`, `tasaciones`, `commissions`, `site_content`, `audit_log`, `ml_*`, `rela_*`, `zernio_*`, etc.). Cron jobs con `pg_cron` + `pg_net` para supervisión, digest, purge, scoring y recordatorios.

## Scripts

```bash
npm run lint          # node --check sobre admin-app.js y landing-app.js
npm test              # Playwright E2E (levanta/reutiliza http://localhost:8788)
npm run test:unit     # tests unitarios (node --test tests/unit/)
```

`scripts/syntax-check-edge.cjs` + `scripts/syntax-run-all.mjs` — verificación estática de las edge functions.

## Notas de seguridad conocidas

- Admin requiere CSP `script-src 'unsafe-inline'` (handlers dinámicos); las páginas públicas usan nonce estático (`nonce-bienenhaus2024`) — pendiente de mejora (ver plan de remediación, fase 6).
- Si un bloqueador de extensiones corta el CDN de Supabase, el panel muestra instrucciones en lugar de fallar en silencio.
