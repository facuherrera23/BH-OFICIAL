# Guía paso a paso: Conectar TikTok al módulo Contenido

> **Objetivo:** Que el dueño cree la app de TikTok (developers.tiktok.com) y conecte la cuenta de TikTok del negocio al panel (Contenido), para publicar fotos y videos con Direct Post.
> **Costo:** $0/mes. La app de TikTok es INDEPENDIENTE de la app de Meta (Instagram/Facebook usan otra app).
> **Estado del código:** TODO el módulo está implementado y testeado (33 tests) — se deploya a producción con el commit de TikTok. Falta únicamente lo que está en esta guía (todo lo hace el dueño, ~15 minutos).

---

## 📋 Tabla de Contenidos

1. [Lo que YA está listo (no tocar)](#1-lo-que-ya-está-listo-no-tocar)
2. [Quién hace qué](#2-quién-hace-qué)
3. [Crear la app en developers.tiktok.com](#3-crear-la-app-en-developerstiktokcom)
4. [Configurar la redirect URI (el paso más importante)](#4-configurar-la-redirect-uri-el-paso-más-importante)
5. [Copiar Client Key y Client Secret → pasarlos por canal seguro](#5-copiar-client-key-y-client-secret--pasarlos-por-canal-seguro)
6. [Verificar el dominio — SOLO para publicar FOTOS](#6-verificar-el-dominio--solo-para-publicar-fotos)
7. [Qué hace el agente con las credenciales](#7-qué-hace-el-agente-con-las-credenciales)
8. [Conectar desde el panel (Cuentas)](#8-conectar-desde-el-panel-cuentas)
9. [Piloto: primer post real](#9-piloto-primer-post-real)
10. [Reglas y límites que conviene conocer](#10-reglas-y-límites-que-conviene-conocer)
11. [Auditoría: habilitar posts PÚBLICOS](#11-auditoría-habilitar-posts-públicos)
12. [Troubleshooting](#12-troubleshooting)
13. [Checklist final](#13-checklist-final)

---

## 1. Lo que YA está listo (no tocar)

- [x] Edge Function `social-tiktok` (publicar foto/video, permalink, cleanup) — verify_jwt ON
- [x] Edge Function `social-auth-tiktok` (conexión de cuenta) — verify_jwt OFF (el callback de TikTok no trae JWT)
- [x] Panel: cuarto botón "TikTok" en el switcher de Crear, form completo, historial
- [x] Renovación automática del token (2 h) con refresh rotativo persistido
- [x] Bucket temporal `social-temp` con limpieza automática (el contenido queda **únicamente** en TikTok)
- [x] 33 tests (`tests/contenido-tiktok.spec.js`) + rate limits + auditoría (`tt_publish` en `audit_log`)

## 2. Quién hace qué

| Paso | Dueño | Agente (conmigo) |
|---|---|---|
| Crear la app en developers.tiktok.com | ✅ | — |
| Configurar redirect URI | ✅ | — |
| Pasar Client Key + Secret | ✅ **por canal seguro, NUNCA por chat** | — |
| Cargar credenciales en Supabase (`app_settings`) | — | ✅ |
| Decidir cómo verificar el dominio para fotos | ✅ decide | ✅ implementa |
| Conectar la cuenta desde el panel | ✅ | ✅ acompaña |
| Pilotear el primer post | ✅ publica | ✅ verifica |

## 3. Crear la app en developers.tiktok.com

1. Ir a **[developers.tiktok.com](https://developers.tiktok.com)** → login con la cuenta de **TikTok del negocio** (si el negocio todavía no tiene cuenta de TikTok, crearla primero desde la app de TikTok — recomiendo cuenta de *Empresa* desde el inicio: **Perfil → ☰ → Configuración → Administrar cuenta → Cambiar a cuenta de empresa**).
2. **Manage apps → Connect an app** (o "Create app").
3. Completar **Basic info**: nombre **"Bienenhaus Contenido"** (o el que prefiera), descripción, categoría, ícono.
4. En la sección **Products / Agregar productos**, agregar **DOS**:
   - **Login Kit** ← la conexión de la cuenta
   - **Content Posting API** ← la publicación (Direct Post)
5. Dentro del producto **Content Posting API**, activar la configuración de **Direct Post** (permite publicar en el perfil del usuario autorizado — sin activarla la API solo prepara drafts).

> ℹ️ Los permisos (scopes) los pide el código solo: `user.info.basic` (perfil) + `video.publish` (publicación). No hay que tipear nada, pero si el popup de conexión da error de permisos, verificar que los 2 productos estén agregados.

## 4. Configurar la redirect URI (el paso más importante)

⚠️ **Este paso es el que falla si se tipea mal una letra.** Copiar y pegar EXACTAMENTE esta URL:

```
https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/social-auth-tiktok
```

1. En el panel de la app → producto **Login Kit → Configuración** (Settings)
2. Buscar el campo **redirect_uri** → pegar la URL exacta
3. **Guardar**

❌ Errores típicos: agregar `http://` en vez de `https://`, barra final `/`, espacio al final. Si al conectar aparece "redirect_uri is not matched", es esto.

## 5. Copiar Client Key y Client Secret → pasarlos por canal seguro

1. Panel de la app → sección **Credentials** (o "Key and secret")
2. Copiar **Client Key** (a la vista)
3. Copiar **Client Secret** (botón "Mostrar" → puede pedir la password de TikTok)

🔒 **REGLA DE SEGURIDAD: el Secret NUNCA va por el chat, email ni WhatsApp.** Opciones válidas:
- Compartírmelo de palabra (llamada/reunión) mientras yo lo cargo al momento
- Password manager compartido (Bitwarden/1Password)
- Un archivo que borro después de cargarlo

> Ojo con los nombres: TikTok llama **client_key** a lo que otras plataformas llaman client_id. Al pasarlos, decime cuál es cuál y yo los cargo en el lugar correcto.

## 6. Verificar el dominio — SOLO para publicar FOTOS

⚠️ **Esta es la única parte con letra chica.** La API de TikTok exige que el dominio (o prefijo de URL) de la foto que el servidor de TikTok va a descargar esté **verificado como propiedad tuya** en la app. Los VIDEOS no lo necesitan (se suben binario directo).

**Nuestro problema:** las fotos de propiedades viven en **Cloudinary** (`res.cloudinary.com`) — es un dominio compartido que NO controlamos (no podemos tocar su DNS ni colgar un archivo de verificación en su raíz). TikTok no acepta verificar ese dominio por nosotros.

**Opciones (decisión del dueño):**

| Opción | Qué implica | Costo |
|---|---|---|
| **A. Piloto de VIDEO primero** ✅ recomendado | El video se sube binario directo (FILE_UPLOAD) y **funciona HOY sin verificar nada**. Las fotos quedan pendientes de la decisión. | $0 |
| **B. Dominio propio de Cloudinary (CNAME)** | Crear `cdn.bienenhaus.com.ar` apuntando a Cloudinary (config en Cloudinary) + verificar `bienenhaus.com.ar` en TikTok vía DNS (yo lo hago desde Cloudflare). Las fotos siguen siendo las mismas de Cloudinary, solo cambia el hostname. | Requiere plan pago de Cloudinary que incluya CNAME |
| **C. Servir las fotos desde bienenhaus.com.ar** | Verificar `bienenhaus.com.ar` en TikTok (DNS) y que las fotos que TikTok descarga vivan bajo ese dominio (proxy/copias). | $0 pero más infraestructura |

**Cómo se verifica el dominio (cuando se decida):** panel de la app → widget **"URL properties"** (Manage URL properties) → **Add Domain** → `bienenhaus.com.ar` → TikTok da una firma → yo la agrego como registro DNS en Cloudflare → verificar. Una vez verificado el dominio base, valen TODOS los paths y subdominios.

❌ Si falta el dominio verificado, publicar una foto da el error `url_ownership_unverified` — el panel lo traduce: *"El dominio de la foto no está verificado en la app de TikTok (Content Posting API → Verified Domains): agregá el dominio y probá de nuevo."*

## 7. Qué hace el agente con las credenciales

Con el Client Key + Secret en mano (en minutos):

1. Los guardo en Supabase, tabla `app_settings`, en la key **`social_tiktok`**:
   `{ "client_id": "<client_key>", "client_secret": "<secret>" }`
2. Verifico que el panel muestra TikTok como "configurada" (sin "Sin configurar")
3. Aviso para que el dueño conecte (paso 8)

Las credenciales **no se commitean al repo** ni quedan en archivos del proyecto.

## 8. Conectar desde el panel (Cuentas)

1. Entrar a **[bienenhaus.com.ar/admin.html](https://bienenhaus.com.ar/admin.html)** → módulo **Contenido** → pestaña **Cuentas**
2. Clic en **"Conectar"** en la tarjeta de **TikTok** → se abre el popup de TikTok → autorizar → el popup se cierra solo
3. La foto de perfil y el nombre de la cuenta aparecen en la tarjeta

ℹ️ **Sobre los tokens (automático, no hay que hacer nada):** el token de acceso vive **2 horas** y se renueva solo con un refresh token de **180 días que rota** en cada uso (el sistema guarda el nuevo). Solo hay que **reconectar** si se deja de publicar por más de 6 meses, el dueño cambia la password de TikTok o desautoriza la app — el panel lo avisa en claro: *"desconectá y volvé a conectar la cuenta"*.

## 9. Piloto: primer post real

Orden recomendado: **VIDEO primero** (no necesita dominio verificado), foto después (paso 6).

### Post con video (2 minutos)

1. Contenido → **Crear** → switcher **TikTok** (cuarta pestaña)
2. Origen **"Subir desde PC"** → elegir el video (MP4, máx 50 MB desde el panel; más pesado → YouTube)
3. Escribir el caption (botón **"Insertar CTA"** agrega contacto + hashtags institucionales)
4. **Publicar en TikTok** → TikTok procesa el post (el panel espera hasta ~5 min) → "Publicado en TikTok"
5. Verificar: el post aparece en la cuenta de TikTok del negocio ⚠️ **en PRIVADO** (se ve solo en la cuenta, no en el feed) hasta que la app pase la auditoría (paso 11)
6. En el panel: historial con estado **Publicado** (el link puede tardar — los posts privados no tienen permalink público)

### Post con foto (requiere dominio verificado)

1. Origen **"Foto de la propiedad"** → elegir propiedad (llena el caption) → elegir la foto en el grid
2. El panel envía la foto capada a 1080px JPEG automáticamente (límite de TikTok)
3. Publicar → igual que el video

### Qué verificar después del piloto

- [ ] Post visible en la cuenta de TikTok (privado) desde la app
- [ ] En el panel: historial con estado "Publicado" + link (si es público)
- [ ] En Supabase `audit_log`: acción `tt_publish` con status success

## 10. Reglas y límites que conviene conocer

| Regla | Por qué |
|---|---|
| Posts **PRIVADOS** hasta auditar la app | TikTok lo impone a las apps sin auditoría (`unaudited_client_can_only_post_to_private_accounts`) — el form arranca en "Solo yo" |
| **NO se puede borrar posts por API** | Limitación de TikTok (no de nuestro panel): para eliminar un post, hacelo desde la app de TikTok. El panel no tiene botón eliminar para TikTok |
| El contenido queda **únicamente** en TikTok | Decisión del dueño: las subidas desde PC pasan por un bucket temporal y se borran al terminar |
| Video desde PC: máx **50 MB** | Límite físico del panel (memoria de la función), NO de la API. Videos pesados → YouTube |
| Fotos: máx **1080px**, JPEG/WebP, ≤20 MB | Límite de la API de fotos — el panel reescala solo |
| Caption: video **2200** chars · foto **90** (título) + **4000** (descripción) | Límites de TikTok; el form valida el de video con contador |
| Máx **5 posts pendientes** en 24 h y ~15 posts/día por cuenta | Caps anti-spam de TikTok (compartidos entre todas las apps) |
| Video: máx 10 min por API | Limitación de la API (la app de TikTok acepta más en cuentas con acceso extendido) |
| Token de acceso 2 h + refresh 180 días rotativo | Automático — ver paso 8 |

## 11. Auditoría: habilitar posts PÚBLICOS

Mientras la app esté sin auditar, **todo lo que publicamos queda privado** (se ve solo en la cuenta del negocio). Para publicar al feed público:

1. El dueño prueba la integración (piloto del paso 9)
2. Cuando el flujo ande bien, completar el **form de auditoría** de Content Posting API: **[developers.tiktok.com/application/content-posting-api](https://developers.tiktok.com/application/content-posting-api)** (pide describir la app, capturas del flujo y estimados de uso)
3. Si TikTok aprueba, el panel ya permite elegir **"Público"** en el form (la opción siempre estuvo; TikTok la rechaza hasta auditar)

> ℹ️ TikTok revisa que la integración cumpla sus términos (ej: no marcar el contenido con logos de terceros, respetar la elección de privacidad del usuario). Nuestro caso (una inmobiliaria publicando sus propias propiedades) es exactamente el uso previsto de la API.

## 12. Troubleshooting

| Síntoma | Causa | Solución |
|---|---|---|
| Popup: "redirect_uri is not matched with the uri" | La redirect URI no está (o está mal tipeada) | Paso 4 — copiar/pegar la URL exacta |
| "TikTok todavía no tiene su app configurada" (o estado "Sin configurar" en Cuentas) | Falta la key `social_tiktok` en `app_settings` | Paso 5-7 — pasar credenciales |
| Error `unaudited_client_can_only_post_to_private_accounts` al intentar publicar público | App sin auditar | Elegir "Solo yo" en privacidad, o auditar (paso 11) |
| Error `url_ownership_unverified` al publicar una FOTO | Dominio no verificado | Paso 6 — decidir opción A/B/C |
| Error de scopes / permisos al conectar | Falta el producto Login Kit o Content Posting API | Paso 3 — agregar los 2 productos |
| "El video supera 50 MB (límite del panel para subir desde PC)" | Video pesado desde PC | Comprimir o publicar como tour en YouTube |
| "desconectá y volvé a conectar la cuenta" | Token muerto (cambió la password, desautorizó la app o pasaron 6 meses sin publicar) | Desconectar y reconectar desde Cuentas |
| El post quedó "Publicando" mucho tiempo en el historial | El navegador se cerró a mitad de la subida | El sistema lo marca "Falló" solo a los 30 min — reintentar |
| No aparece el link del post publicado | Los posts privados no tienen permalink público | Normal — el link llega cuando el post es público y pasó moderación |

## 13. Checklist final

**Dueño:**
- [ ] Cuenta de TikTok del negocio (idealmente cuenta de **empresa**)
- [ ] App creada en developers.tiktok.com
- [ ] Productos agregados: **Login Kit** + **Content Posting API** (+ Direct Post activado)
- [ ] **Redirect URI** pegada exacta y guardada
- [ ] Client Key + Client Secret pasados **por canal seguro**
- [ ] Decisión sobre el dominio para FOTOS (opción A/B/C del paso 6)
- [ ] Piloto: 1 post de video ✓ (privado hasta auditar)

**Agente (conmigo):**
- [ ] Credenciales cargadas en `app_settings` key `social_tiktok`
- [ ] Cuenta conectada verificada en el panel (tarjeta con avatar y "conectada")
- [ ] `audit_log` con `tt_publish` success
- [ ] Registro del resultado en `AGENTS.md`

---

## 14. Por qué TikTok NO trae leads de comentarios (limitación real)

De los 4 canales del módulo, TikTok es el único sin captación de leads por comentarios, y **no es algo que se pueda "arreglar" con código**: la Content Posting API es SOLO para publicar (no expone los comentarios de los videos), y la Research API (donde sí hay datos) requiere aprobación de TikTok y está orientada a estudios académicos, no a apps productivas.

**Qué hay en su lugar (sin mantenimiento):**
- El **CTA del caption** (el bloque que agrega el panel con WhatsApp + teléfono) es el canal real de contacto: quien quiere la propiedad escribe por WhatsApp.
- Los leads de TikTok llegan por WhatsApp → se cargan **a mano** en el CRM con origen **TikTok** (el origen ya existe en las listas del panel para poder medir cuántos traen).
- La bandeja **Contenido → Consultas** muestra esta limitación en su nota de TikTok (para que nadie la busque como si fuera un bug).

Si TikTok abre una API de comentarios para apps productivas, el módulo está preparado para sumarla: la tabla de comentarios es genérica (`social_comments.platform` es TEXT libre).

---

*Guía creada 2026-11-11 · Código: `supabase/functions/social-tiktok/`, `social-auth-tiktok/`, `supabase/functions/_shared/social.ts` (refresh rotativo), `assets/js/admin-contenido.js` · Tests: `tests/contenido-tiktok.spec.js` · Docs verificadas contra developers.tiktok.com (nov 2026): Media Transfer Guide, Photo/Direct Post reference, Get/Refresh User Access Token, Content Sharing Guidelines.*
