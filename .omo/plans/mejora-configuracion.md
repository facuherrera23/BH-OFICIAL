# Plan: Mejora del apartado "Configuración" — BH-OFICIAL

> Estado: PROPUESTO (pendiente de aprobación de alcance). No se ha tocado código.
> Fecha: 2026-08-23 · Relevamiento completo hecho sobre main (post `b43cd45`).

---

## 1. Diagnóstico (estado actual relevado)

### 1.1 La sección Configuración es decorativa
`admin.html` líneas ~724–742 (`#tab-configuracion`): 4 inputs `disabled` con valores hardcodeados
(Razón Social, Matrícula C.R.I., URL del sitio, Supabase URL). Sin JS asociado, sin persistencia,
sin valor operativo.

### 1.2 Superposición con el módulo CMS
El editor CMS (`#tab-sitio-web`, sección 7 de admin.html) hoy mezcla contenido editorial con datos
corporativos:

| Bloque CMS | Campos | Destino en DB (`site_content`) |
|---|---|---|
| `#cms-contacto` | WhatsApp (`cont_wpp`), Email (`cont_email`), Teléfono (`cont_phone`), Dirección (`cont_addr`) | fila `contact`: `whatsapp`, `email`, `phone`, `address` |
| `#cms-footer` | Marca de Agua (`foot_wm`), Matrícula (`foot_cri`), CUIT (`foot_cuit`) | fila `footer`: `copyright`, `matricula`, `cuit` |

La landing ya consume esas claves dinámicamente (`landing-app.js` `applySectionContent`):
- reescribe todos los `href` de `wa.me` con `contact.whatsapp`
- reescribe `mailto:` con `contact.email`
- setea teléfono/dirección/email en contacto y footer
- consume `contact.schedule` (**clave que aún NO existe en la DB** → agregarla funciona al instante)
- **NO consume** `contact.map_embed` (clave almacenada pero muerta)

### 1.3 Redes sociales hardcodeadas y rotas
`index.html` tiene 6 anchors a dominios genéricos sin cuenta (`https://instagram.com/`,
`facebook.com/`, `linkedin.com/`) en dos bloques (≈523–525 y ≈655–657). Ningún contenido los alimenta.

### 1.4 Sin preferencias de panel
No existe tabla de settings internos (moneda secundaria, notificaciones, paginado, etc.).

### 1.5 🔴 CRÍTICO colateral: `property_sequences` SIN RLS
Advisor de Supabase lo marcó crítico: la tabla es legible/escribible por anon con la publishable key.

**Cuidado**: `generate_property_code` NO es `SECURITY DEFINER` → el trigger corre con privilegios del
invocador. Habilitar RLS sin más **rompería la creación de propiedades**. Fix correcto (Fase 0):

```sql
ALTER TABLE public.property_sequences ENABLE ROW LEVEL SECURITY;

ALTER FUNCTION public.generate_property_code SECURITY DEFINER SET search_path = public;
```

Con la función en SECURITY DEFINER, el trigger pasa a correr como dueño de la función (postgres),
bypasea RLS, y la tabla queda **totalmente bloqueada** para anon/authenticated a nivel SQL sin
necesidad de políticas. Verificar post-fix creando una propiedad de prueba (código FH-P#### se genera).

### 1.6 Convenciones obligatorias del repo (aplican a todas las fases)
- Sin subagentes: implemento yo directamente.
- react-doctor debe quedar **100/100** tras cada fase (`npx react-doctor@latest`).
- `node --check assets/js/admin-app.js` tras cada cambio JS.
- Cache-busters manuales en `admin.html` (hoy `?v=19`; subir a v20, v21… por fase que toque assets).
- Comentarios justificados al hook (categoría 3 seguridad / no obvio).
- E2E con Playwright + servidor local `python -m http.server 8788`; cerrar navegador y matar
  servidor al terminar. NO probar flujos que muten producción salvo ok explícito.
- Commit estilo repo: `feat(scope): descripción` en español. Solo archivos intencionados staged
  (excluir `.codegraph/`, `.omo/`, `.playwright-mcp/`, `supabase/.temp/`).
- Encoding mixto en admin.html: algunas líneas viejas tienen mojibake — anclar edits en texto EXACTO
  que devuelve Read; escribir texto nuevo en UTF-8 limpio.

---

## 2. Diseño objetivo

Separación de responsabilidades:

| Módulo | Responsabilidad |
|---|---|
| **CMS (Sitio Web)** | Solo contenido editorial: hero, servicios, proceso, equipo, stats |
| **Configuración** | Identidad corporativa, redes sociales, preferencias del panel, estado de integraciones |
| **Portales** | Integraciones externas (ZonaProp/Argenprop/ML) — sin cambios |

Persistencia:
- Identidad/contacto/redes → filas existentes de `site_content` (`contact`, `footer`) + nuevas claves.
  La landing no cambia su fuente de datos: sigue leyendo `site_content`.
- Preferencias internas → tabla nueva `app_settings` (key-value JSONB).
- Nada se duplica: Configuración edita las MISMAS filas que hoy edita el CMS, solo cambia la
  ubicación de la UI.

Permisos propuestos (pendiente confirmación):
- Guardar Configuración: `super_admin` only (UI deshabilitada + validación JS para otros roles).
  Alternativa: mismo criterio laxo que el CMS actual (cualquier autenticado).

**Nuance importante detectado en auto-revisión**: hoy `site_content` escribe desde el cliente con
RLS que aparentemente permite a cualquier autenticado (por eso el CMS funciona sin restricción).
Un "super_admin only" REAL requiere cambio de políticas RLS sobre `site_content` (afectaría también
al CMS) o enrutar los guardados de Configuración por edge function con validación de rol (+~40 min
no incluidos en las estimaciones base). El guard solo-JS bloquea la UI pero no es seguridad real.

---

## 3. Fases

### Fase 0 — Fix crítico RLS `property_sequences` (~15 min)
1. Aplicar el SQL de §1.5 vía migración (`supabase_apply_migration`, nombre `rls_property_sequences`).
2. Verificación: crear propiedad de prueba desde el panel → código FH-P#### generado OK;
   consulta anon directa a la tabla → bloqueada.
3. Commit separado: `fix(db): habilita RLS en property_sequences y asegura generate_property_code`.

### Fase 1 — Migración de campos corporativos: CMS → Configuración (~1 h)
Mover UI, NO datos:
1. `admin.html`: quitar bloques `#cms-contacto` y `#cms-footer` del editor CMS; crear la nueva
   estructura de `#tab-configuracion` (ver F2 para layout) con los mismos IDs de campo
   (`cms_cont_wpp` → renombrar a `cfg_*` y actualizar el mapeo).
2. `assets/js/admin-app.js`: mover el mapeo `{ section: 'contact', path: ... }` (líneas ~1488–1494)
   y su lógica de carga/guardado al módulo Configuración. El upsert a `site_content` queda idéntico.
3. El CMS pierde esas pestañas/bloques; editorial intacto.
4. Verificación E2E: editar WhatsApp en Configuración → fila `contact` actualizada; landing local
   refleja el link nuevo. Campos editoriales del CMS siguen guardando.
5. Cache-buster → `?v=20`. Commit: `feat(config): migra datos corporativos del CMS a Configuración`.

### Fase 2 — Identidad corporativa completa (~1–1.5 h)
Nueva estructura de `#tab-configuracion` en cards:
- **Card "Datos de la empresa"**: Razón Social*, CUIT*, Matrícula CRI*, Marca de Agua/Copyright*,
  Dirección, Horario de atención (nuevo → clave `schedule`; la landing YA la consume),
  Mapa embed (*decisión*: conectar el iframe de contacto en la landing o descartar la clave).
- **Card "Contacto digital"**: WhatsApp, Email, Teléfono.
- Botón Guardar único por card → upsert a `contact`/`footer` (patrón existente `mergedContent`).

*Razón social formal no existe hoy en DB → decidir clave nueva (`footer.razon_social`) o reusar
`copyright`. Recomiendo clave nueva + render en footer legal de la landing (pequeño ajuste).

Verificación: E2E edición + reflejo en landing local; campos vacíos no pisan valores existentes
(merge, no replace). Cache-buster `?v=21`.

### Fase 3 — Redes sociales dinámicas (~45 min)
1. Nuevas claves en fila `contact`: `instagram_url`, `facebook_url`, `linkedin_url` (inputs URL en
   Configuración, card "Redes Sociales").
2. `index.html`: dejar los anchors actuales como fallback (no romper estático).
3. `landing-app.js`: en `case 'contact'`, reescribir `href` de cada `.social-circle` con el patrón
   ya usado para wa.me; si la clave viene vacía → ocultar el ícono correspondiente
   (hoy muestran links rotos a instagram.com/).
4. Verificación: setear Instagram en Configuración → link real en landing; vaciarlo → ícono oculto.
   Cache-busters: `admin.html ?v=22` + verificar si `index.html` tiene buster propio para
   `landing-app.js` (chequear línea exacta antes de subir).

### Fase 4 — Preferencias del panel: tabla `app_settings` (~1.5 h)
1. Migración: `CREATE TABLE public.app_settings (id text PRIMARY KEY, value jsonb NOT NULL,
   updated_at timestamptz DEFAULT now())` + RLS: SELECT para `authenticated`, ALL solo para
   `super_admin` (check contra `profiles.role`). Sembrar defaults.
2. UI en Configuración, card "Preferencias": moneda secundaria + tasa de cambio USD→ARS (para
   mostrar precio estimado en propiedades — requiere pequeño cambio de render en properties),
   items por página en tablas, email interno para futuras notificaciones de leads/tasaciones.
3. JS: helpers `getSetting/setSetting` + carga inicial junto al bootstrap del panel.
4. Verificación E2E + react-doctor + `node --check`. Cache-buster `?v=23`.
Commit: `feat(config): preferencias del panel con app_settings (RLS super_admin)`.

### Fase 5 — Estado & Seguridad (opcional, ~1 h)
1. Cards de estado (solo lectura): Supabase ✓ (cliente init), Cloudinary ✓ (config presente),
   Mercado Libre (estado real vía edge `ml-config`), SMTP Brevo (informativo, límite 30/hora).
2. Card "Sesión": usuario actual, rol, botón "Cerrar sesión en todos los dispositivos"
   (`supabaseClient.auth.signOut({ scope: 'global' })`).
3. Link cruzado a Portales para credenciales API.

---

## 4. Verificación transversal (por cada fase)

1. `node --check assets/js/admin-app.js` → SYNTAX OK
2. `npx react-doctor@latest` → 100/100 Great
3. Playwright E2E local (puerto 8788): estructura DOM + interacciones seguras (no mutar producción);
   consola final con 0 errores inesperados
4. Prueba manual del usuario para escrituras reales (guardar settings, crear propiedad en F0)
5. Limpieza: cerrar navegador, matar servidor
6. Commit granular por fase + push solo cuando el usuario lo pida

## 5. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| RLS rompe generación de códigos | F0 convierte la función a SECURITY DEFINER ANTES de habilitar RLS; test de creación de propiedad |
| Mover campos CMS rompe la landing | Se reutilizan las mismas filas/claves de `site_content`; solo cambia la UI. Landing no cambia |
| Mojibake preexistente en admin.html | Anclas de edición copiadas byte a byte desde Read; nunca "arreglar" líneas viejas de paso |
| react-doctor cae por sinks nuevos | No introducir innerHTML con variables mutables; usar patrones existentes (`esc`, data.map) |
| Doble edición CMS↔Config durante transición | F1 remueve los campos del CMS en el mismo commit que los agrega a Configuración |

## 6. Cobertura: qué queda deliberadamente FUERA (evaluado y descartado por ahora)

| Ítem evaluado | Decisión | Motivo |
|---|---|---|
| Logo/favicon editable (upload a Cloudinary) | **Candidato a sumar** (~+30 min): clave `brand.logo_url` + consumo en landing header/footer | Es parte natural de "identidad corporativa"; el plan base no lo incluía |
| Auditoría de cambios de configuración (quién cambió qué) | Fuera de alcance | Requiere triggers de auditoría + UI de historial; valor bajo para equipo de 3 usuarios |
| Gestión del secret SMTP Brevo desde el panel | Fuera de alcance (queda server-side) | Exponer secrets en panel es anti-patrón; ya vive como secret de edge functions |
| Edición SEO de la landing (meta title/description) | Posible extensión futura de CMS, no de Configuración | Territorio editorial |
| Plantillas de mensaje de WhatsApp por propiedad (`wa.me?text=`) | Posible extensión futura | Nice-to-have comercial, no configuración base |

Con esto cubierto: el plan abarca todo lo razonablemente esperable de un módulo
"Configuración" para este producto. Lo único que recomiendo incorporar al alcance es el
logo editable si querés identidad 100% gestionable desde el panel.

## 7. Decisiones abiertas (bloqueantes para empezar)

1. **F0 ahora?** SQL listo. Sí/No.
2. **Alcance total**: ¿F1→F5 completas o subconjunto? Recomendado: 0+1+2+3 ya; 4 después; 5 opcional.
3. **Permisos de guardado en Configuración**: solo `super_admin` (recomendado) vs cualquier autenticado.
4. **`map_embed`**: ¿conectar el mapa en la sección contacto de la landing o eliminar la clave?
5. **Razón social**: ¿clave nueva `footer.razon_social` renderizada en el footer legal?
