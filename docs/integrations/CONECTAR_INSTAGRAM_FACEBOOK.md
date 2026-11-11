# Guía paso a paso: Conectar Instagram y Facebook al módulo Contenido

> **Objetivo:** Que el dueño cree la app de Meta y conecte la página de Facebook y la cuenta de Instagram al panel (Contenido), para publicar posts reales.
> **Costo:** $0/mes. **Una sola app de Meta sirve para las DOS redes** (Instagram + Facebook).
> **Estado del código:** TODO el módulo está implementado, testeado (490 tests) y deployado en producción — falta únicamente lo que está en esta guía (todo lo hace el dueño, ~20 minutos).

---

## 📋 Tabla de Contenidos

1. [Lo que YA está listo (no tocar)](#1-lo-que-ya-está-listo-no-tocar)
2. [Quién hace qué](#2-quién-hace-qué)
3. [Paso previo: cuenta de Instagram profesional](#3-paso-previo-cuenta-de-instagram-profesional)
4. [Paso previo: ser admin de la página de Facebook](#4-paso-previo-ser-admin-de-la-página-de-facebook)
5. [Crear la app de Meta](#5-crear-la-app-de-meta)
6. [Configurar las redirect URIs (el paso más importante)](#6-configurar-las-redirect-uris-el-paso-más-importante)
7. [Copiar App ID y App Secret → pasarlos por canal seguro](#7-copiar-app-id-y-app-secret--pasarlos-por-canal-seguro)
8. [Qué hace el agente con las credenciales](#8-qué-hace-el-agente-con-las-credenciales)
9. [Conectar desde el panel (Cuentas)](#9-conectar-desde-el-panel-cuentas)
10. [Piloto: primer post real en cada red](#10-piloto-primer-post-real-en-cada-red)
11. [Reglas y límites que conviene conocer](#11-reglas-y-límites-que-convene-conocer)
12. [Troubleshooting](#12-troubleshooting)
13. [Checklist final](#13-checklist-final)

---

## 1. Lo que YA está listo (no tocar)

- [x] Edge Function `social-facebook` (publicar foto/video, borrar, permalink) — **deployada en producción con verify_jwt ON**
- [x] Edge Function `social-auth-facebook` (conexión de páginas) — **deployada con verify_jwt OFF** (el callback de Meta no trae JWT)
- [x] Edge Function `social-instagram` + `social-auth-instagram` — deployadas
- [x] Panel: tercer botón "Facebook" en el switcher de Crear, form completo, historial con borrado real
- [x] Bucket temporal `social-temp` con limpieza automática (el contenido queda **únicamente** en la red destino)
- [x] 51 tests nuevos (`contenido-facebook.spec.js` 28 + `contenido-instagram.spec.js` 23)
- [x] Rate limits y auditoría (`fb_publish` / `ig_publish` en `audit_log`)

## 2. Quién hace qué

| Paso | Dueño | Agente (conmigo) |
|---|---|---|
| Pasar IG a cuenta profesional + vincular a la página | ✅ | — |
| Ser admin de la página de Facebook | ✅ | — |
| Crear la app en developers.facebook.com | ✅ | — |
| Configurar redirect URIs | ✅ | — |
| Pasar App ID + Secret | ✅ **por canal seguro, NUNCA por chat** | — |
| Cargar credenciales en Supabase (`app_settings`) | — | ✅ |
| Verificar conexión y pilotear | ✅ publica | ✅ acompaña y verifica |
| Borrar páginas de más conectadas por accidente | — | ✅ desde el panel (Cuentas) |

---

## 3. Paso previo: cuenta de Instagram profesional

⚠️ **Las cuentas PERSONALES de Instagram no publican por API** (limitación de Instagram para todos los proveedores, no es algo de nuestro panel). Necesitamos **Business o Creator**:

1. Abrir Instagram (app del celular) → **Perfil → ☰ → Configuración y privacidad**
2. **Tipo de cuenta y herramientas → Cambiar a cuenta profesional**
3. Elegir **Empresa** (o Creador — Empresa es lo estándar para una inmobiliaria)
4. Completar categorías (ej. "Servicios inmobiliarios") y datos de contacto
5. **Elegir "Conectar a una página de Facebook"** cuando lo pida → elegir la página de la inmobiliaria (la del paso 4). Si no aparece la página, se puede vincular después desde Facebook: *Página → Configuración → Instagram vinculada*.

✅ Cómo verificar que quedó bien: en el perfil de IG aparece la categoría ("Empresa inmobiliaria") y el botón de contactar por email/teléfono.

## 4. Paso previo: ser admin de la página de Facebook

- La API de Facebook **publica en PÁGINAS, no en perfiles personales** (otra limitación de la API).
- El dueño tiene que ser **admin** de la página de la inmobiliaria. Verificar: Facebook → Página → Ver perfil → ⚙️ *Configuración de la página → Acceso y control de la página* → el usuario aparece como administrador.

ℹ️ Al conectar, el OAuth va a listar **TODAS las páginas que el dueño administra** y las guarda todas. Si administra páginas ajenas, se desconectan desde el panel en 2 clicks (ver paso 9) — no pasa nada grave, solo quedan listadas.

## 5. Crear la app de Meta

1. Ir a **[developers.facebook.com](https://developers.facebook.com)** → login con la cuenta de Facebook del dueño (la que es admin de la página)
2. **Mis apps → Crear app** (Create App)
3. Tipo de app / caso de uso: **"Negocios" (Business)** — si pregunta por algo más específico, elegir la opción que mencione administrar negocios/páginas
4. Nombre de la app: **"Bienenhaus Contenido"** (o el que prefiera) + email de contacto
5. Crear. Si pide re-autenticar la password de Facebook, ponerla.

### Agregar los productos (esto es lo que habilita cada red)

Dentro del panel de la app, sección **"Agregar productos a tu app"** (Add Products), agregar **DOS**:

1. **Facebook Login** — si el asistente ofrece "Facebook Login for Business", ese es el correcto para apps Business
2. **Instagram Graph API** (aparece como "Instagram")

> ℹ️ Aunque la app sea de Instagram y Facebook, los permisos de IG se piden por el mismo login de Facebook (el dialog de autorización es `facebook.com/dialog/oauth` con scopes `instagram_*`). Por eso **el campo de redirect URIs es UNO solo para las dos redes**.

### Permisos (ya están pedidos por el código, solo verificar que la app no los bloquee)

La app necesita que estos permisos estén disponibles; el código los pide solo, no hay que tipear nada:

| Red | Permisos que pide el panel |
|---|---|
| Instagram | `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `pages_show_list` |
| Facebook | `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_engagement` |

Los 2 últimos habilitan la bandeja **Consultas**: `pages_manage_metadata` suscribe la página al webhook de comentarios (field `feed`) y `pages_manage_engagement` permite ocultar/eliminar comentarios desde el panel; `instagram_manage_comments` hace lo propio en Instagram (responder + eliminar). Los permisos de publicación siguen siendo los mismos de antes.

✅ **No hace falta App Review**: mientras la app quede en **modo Desarrollo** (default al crear) y **solo el dueño** conecte sus cuentas, Facebook no exige revisión ni verificación de negocio. La review se necesita si en el futuro la app pasa a "Live" o conectan usuarios que no son admins de la app — no es nuestro caso hoy.

## 6. Configurar las redirect URIs (el paso más importante)

⚠️ **Este paso es el que falla si se tipea mal una letra.** Copiar y pegar EXACTAMENTE estas dos URLs:

```
https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/social-auth-instagram
https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/social-auth-facebook
```

1. En el panel de la app → menú lateral → **Facebook Login → Configuración** (Settings)
2. Buscar el campo **"URI de redirección de OAuth válidos"** (Valid OAuth Redirect URIs)
3. Pegar las **DOS** URLs (una por línea, sin espacios)
4. **Guardar cambios**

❌ Errores típicos a evitar: agregar `http://` en vez de `https://`, agregar una barra final `/`, o dejar un espacio al final de la línea. Si al conectar el panel dice "URL bloqueada: no se han configurado URLs de redirección", es esto.

## 7. Copiar App ID y App Secret → pasarlos por canal seguro

1. Panel de la app → **Configuración → Básico** (App Settings → Basic)
2. Copiar **App ID** (a la vista)
3. Copiar **App Secret** (botón "Mostrar" → pide la password de Facebook)

🔒 **REGLA DE SEGURIDAD: el App Secret NUNCA va por el chat, email ni WhatsApp.** Opciones válidas:
- Compartírmelo de palabra (llamada/reunión) mientras yo lo cargo al momento
- Password manager compartido (Bitwarden/1Password)
- Un archivo que borro después de cargarlo

> Qué protege el Secret: es la llave para canjear los tokens de publicación de las redes. Con App ID solo, no se puede hacer nada (el App ID por sí solo es público).

## 8. Qué hace el agente con las credenciales

Con el App ID + Secret en mano (en minutos):

1. Los guardo en Supabase, tabla `app_settings`, en **DOS keys** (la misma app en ambas):
   - `social_instagram` → `{ "client_id": "...", "client_secret": "..." }`
   - `social_facebook` → `{ "client_id": "...", "client_secret": "..." }`
2. Verifico que el panel muestra las redes como "configuradas" (sin "Sin configurar")
3. Aviso para que el dueño conecte (paso 9)

Las credenciales **no se commitean al repo** ni quedan en archivos del proyecto.

## 9. Conectar desde el panel (Cuentas)

1. Entrar a **[bienenhaus.com.ar/admin.html](https://bienenhaus.com.ar/admin.html)** → módulo **Contenido** → pestaña **Cuentas**
2. Clic en **"Conectar"** en la tarjeta de **Facebook** → se abre el popup de Meta → autorizar → el popup se cierra solo
   - Resultado: **una tarjeta por cada página** que administra el dueño
   - Si aparecen páginas de más → botón **"Desconectar"** en las que no correspondan (no borra nada de Facebook, solo desvincula del panel)
3. Clic en **"Conectar"** en la tarjeta de **Instagram** → mismo popup de Meta (los scopes de IG se piden ahí)
   - Requisito: la cuenta IG tiene que ser profesional (paso 3) y estar vinculada a la página conectada
4. La foto de perfil de la página/cuenta debería aparecer en la tarjeta (se trae al conectar)

ℹ️ El token de página de Facebook derivado de un login largo **no vence** solo — no hay que reconectar periódicamente. Solo se reconecta si el dueño **cambia la password de Facebook** o **elimina la autorización** de la app (en ese caso el panel lo avisa en claro: "desconectá y volvé a conectar la página").

## 10. Piloto: primer post real en cada red

Orden recomendado: **foto primero, video después** (el video pesa más en procesamiento).

### Post con foto (2 minutos)

1. Contenido → **Crear** → switcher **Facebook** (tercera pestaña)
2. Elegir la **página** → elegir **propiedad** (opcional pero recomendado: llena el caption y aporta la foto) → elegir la foto de la propiedad en el grid
3. Escribir el caption (botón **"Insertar CTA"** agrega contacto + hashtags institucionales)
4. **Publicar en Facebook** → al terminar aparece "Publicado en Facebook" y la barra en 100%
5. Verificar: el post está en el feed de la página con la foto ✓ y en el historial del panel con estado **Publicado** y permalink

Repetir en **Instagram**: switcher → Instagram → misma mecánica (foto de la propiedad viaja por URL de Cloudinary, IG la descarga; caption máx 2200 caracteres).

### Post con video (opcional en el piloto)

- Desde PC el tope es **50 MB** (límite de memoria de la función — más pesado va a YouTube). El form lo dice y lo valida.
- El video entra en procesamiento en Facebook/Instagram y el panel lo polla hasta ~5 min.

### Qué verificar después del piloto

- [ ] Post visible en la página de Facebook / feed de Instagram
- [ ] En el panel: historial con estado "Publicado" + link
- [ ] En Supabase `audit_log`: acción `fb_publish` / `ig_publish` con status success

## 11. Reglas y límites que conviene conocer

| Regla | Por qué |
|---|---|
| El contenido queda **únicamente** en la red destino | Decisión del dueño: las subidas desde PC pasan por un bucket temporal y se borran al terminar |
| Fotos de propiedad viajan por URL de Cloudinary | No hay doble subida: Facebook/Instagram la descarga de la CDN |
| Video desde PC: máx **50 MB** | Límite físico de la función serverless (memoria), NO de la API. Videos pesados → YouTube (sube directo del navegador, sin tope práctico) |
| Facebook publica en **páginas**, no perfiles | Limitación de la API de Meta (para todos los proveedores) |
| Caption de IG máx **2200** caracteres | Límite de Instagram; el form lo valida con contador |
| Una página = una tarjeta en el panel | Si el dueño administra varias páginas, todas quedan conectadas; desconectar las sobrantes desde Cuentas |
| TikTok | Después, con **otra app** en developers.tiktok.com (no es Meta) |

## 12. Troubleshooting

| Síntoma | Causa | Solución |
|---|---|---|
| Popup de Meta: "URL bloqueada: no se han configurado URLs de redirección" | Las redirect URIs no están (o están mal tipeadas) | Paso 6 — copiar/pegar las 2 URLs exactas |
| "No administrás ninguna página de Facebook" | La cuenta que autorizó no es admin de ninguna página | Paso 4 — verificar rol admin |
| "No se pudieron leer las páginas de Facebook" | La app no tiene el producto Facebook Login agregado | Paso 5 — agregar el producto |
| Instagram: "Instagram todavía no tiene su app configurada" (o estado "Sin configurar" en Cuentas) | Falta la key `social_instagram` en `app_settings` | Paso 7-8 — pasar credenciales |
| Instagram: error al publicar "cuenta no es profesional" / `instagram_content_publish` rechazado | Cuenta IG personal, o profesional pero **no vinculada a la página** | Paso 3 — convertir a profesional y vincular a la página |
| Todas las acciones fallan con "El token de la página ya no es válido (code 190)" | El dueño cambió la password de Meta o desautorizó la app | Desconectar y volver a conectar la página desde Cuentas (el panel lo dice en claro) |
| "El video supera 50 MB (límite del panel para subir desde PC)" | Video pesado desde PC | Comprimir o publicar como tour en YouTube |
| El post quedó "Publicando" mucho tiempo en el historial | El navegador se cerró a mitad de la subida | El sistema lo marca "Falló" solo a los 30 min — reintentar |
| Publicar funciona pero no aparece el post en IG | IG demora unos segundos en activar el post | Esperar ~30s y refrescar el feed |

## 13. Checklist final

**Dueño:**
- [ ] Instagram convertido a **cuenta profesional** y vinculado a la página de Facebook
- [ ] Admin de la **página de Facebook** de la inmobiliaria
- [ ] App creada en developers.facebook.com (tipo **Business**)
- [ ] Productos agregados: **Facebook Login** (+ Instagram Graph API)
- [ ] **2 redirect URIs** pegadas exactas y guardadas
- [ ] App ID + App Secret pasados **por canal seguro**
- [ ] Piloto: 1 post con foto en Facebook ✓ + 1 en Instagram ✓
- [ ] **Webhook de comentarios** verificado (object Page + object Instagram) y **Suscribir cuentas** en verde (sección 14)

**Agente (conmigo):**
- [ ] Credenciales cargadas en `app_settings` keys `social_instagram` Y `social_facebook`
- [ ] Cuentas conectadas verificadas en el panel (tarjetas con avatar y "conectada")
- [ ] Páginas sobrantes desconectadas (si las hubo)
- [ ] `audit_log` con `fb_publish` / `ig_publish` success
- [ ] Registro del resultado en `AGENTS.md`

---

## 14. Webhook de comentarios (traer leads del CRM)

Las publicaciones de Facebook e Instagram YA generan consultas: cuando alguien comenta un post, el comentario entra a la bandeja **Contenido → Consultas** y desde ahí se crea el lead (el mismo criterio que los comentarios de YouTube en el Studio). Una vez configurado, no requiere mantenimiento.

**Dueño (una vez, ~10 minutos, con la app ya creada de la sección 5):**

1. En el panel: **Contenido → Consultas** → caja "Webhook de comentarios". Copiá los DOS valores:
   - **Callback URL**: `https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/social-webhook-meta`
   - **Verify token**: lo genera el panel (botón de copiar al lado).
2. En **developers.facebook.com → tu app → Webhooks**:
   - Objeto **Page** → pegar Callback URL + Verify token → **Verify and save** (Meta verifica en el momento con un GET).
   - Suscribir al campo **feed** (cubre los comentarios de la página).
   - Objeto **Instagram** → la MISMA Callback URL + el MISMO token → **Verify and save** → suscribir al campo **comments**.
3. Volver al panel y apretar **Suscribir cuentas**: suscribe cada página de Facebook (campo feed) y cada usuario IG (campo comments) con su token — Meta lo exige además de la app.

**Qué hace el sistema:** el webhook (`social-webhook-meta`) recibe cada comentario **firmado** (X-Hub-Signature-256 con el App Secret) y lo deja en la tabla `social_comments`. El botón **Sincronizar** de la bandeja, además, trae los comentarios de los posts publicados directo del Graph API (cubre lo que el webhook no entregó — mismo criterio de red de seguridad que ML). Desde cada comentario: **Crear lead** (el lead nace con `consent_at`, dedup 60 días por email/teléfono si la persona lo escribió en el texto, y tarea de primer contacto), **Responder** (el reply se publica en la red con la cuenta conectada), **Ocultar/Eliminar** (moderación real desde el panel) o **Descartar** (sin lead). Los comentarios que uno deja como respuesta propia no ensucian la bandeja (quedan marcados como "respuesta propia").

**Notas:**
- Con la app en modo **Development**, los comentarios reales solo se entregan para cuentas admin/tester de la app (en la práctica: la del dueño). Para el público general, pasar la app a **Live**.
- El permiso `pages_manage_metadata` (agregado al login del panel el 2026-11-11) es el que permite suscribir la página. Si una cuenta fue conectada ANTES de esa fecha, reconectala desde Cuentas para que el token lo tenga.
- Con las conexiones hechas ese mismo día también llegan `pages_manage_engagement` (Facebook) e `instagram_manage_comments` (Instagram) — responder, ocultar y eliminar comentarios desde la bandeja. **Todas las cuentas conectadas antes de esa fecha hay que reconectarlas**: sin el scope, el botón "Suscribir cuentas" y las acciones de moderar fallan con error de permiso (los flujos de publicación siguen funcionando con la conexión vieja, el gate es por acción).
- **TikTok no participa de esta bandeja**: no expone comentarios por API (ver CONECTAR_TIKTOK.md §14).

---

*Guía creada 2026-11-11 · Código: `supabase/functions/social-facebook/`, `social-auth-facebook/`, `social-instagram/`, `social-auth-instagram/`, `assets/js/admin-contenido.js` · Tests: `tests/contenido-facebook.spec.js`, `tests/contenido-instagram.spec.js`*
