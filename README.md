# BIENENHAUS PROPIEDADES — Plataforma Inmobiliaria

Landing pública + panel administrativo (CRM completo) para inmobiliaria premium de Buenos Aires.

Vanilla JS puro (sin bundler, sin build, scripts IIFE + globals) sobre **Supabase** (PostgreSQL + Auth + RLS + Realtime + Edge Functions). Deploy: **Cloudflare Pages** (estático).

---

## 📌 Estado actual del proyecto — 2026-09-04

✅ **Todo funciona.** El sistema está listo para producción con integridad garantizada.

| Módulo | Estado |
|---|---|
| Landing pública | ✅ Funcional |
| Panel admin (Propiedades, Leads, Agenda, Propietarios, Tasaciones, Sitio Web, Configuración, Agentes, Chat, Ficha HTML) | ✅ Funcional |
| Portal Propietario | ✅ Funcional |
| CRM de Tareas de Propietarios (**NUEVO**) | ✅ Implementado y desplegado en producción |
| Recordatorios de tareas por email (Brevo + cron) | ✅ Funcionando |
| Página de confirmación de visitas | ✅ Funcional |
| Calendario / Agenda con selección día/mes/hora (sin año) | ✅ Funciona (reparado hoy) |

---
### Tablas en `public` (54 reales, RLS all the time)

**Core**: `properties`, `owners`, `owner_tasks`, `owner_timeline_entries`, `leads, visits, agents, tasaciones, commissions, commission_liquidations, commission_payments, site_content, site_settings, app_settings as settg`, `property_images`, `property_sequences`, `rela_config/tokens/listings/`, `rela_webhook_events`, shorpm

---

## 📁 Estructura del proyecto

```
BH-OFICIAL/
├── index.html                     # Landing page pública
├── admin.html                     # Panel administrativo (2.857 líneas, modificado en Unix)
├── assets/js/admin-app.js          # ~19.500 líneas — lógica principal del panel
├── assets/js/landing-app.js        # Lógica de la landing
├── assets/js/utils.js              # Helpers de seguridad (esc, safeUrl, etc.)
├── assets/js/config.js             # Configuración front (URL Supabase, anon key — población right not buried)
│                                        ... (assetCardType_NOT_KIND/enृतिर regulating multi users Package arity implementation from scratch:
│   custom