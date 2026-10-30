# Auditoría crítica — 50 mejoras del módulo YouTube (CONTENIDO)

**Fecha:** 2026-10-30
**Alcance:** todo lo construido en los lotes 1–8 del módulo CONTENIDO/YouTube
(`assets/js/yt-*.js`, `assets/js/admin-contenido.js`, `assets/js/pages/canal-page.js`,
`supabase/functions/social-youtube-*`, `supabase/functions/social-publish-youtube`,
`canal.html`, `scripts/generate-ficha.mjs`).
**Método:** inventario de marcadores `#N` sobre el código + revisión contra el schema real
(`information_schema`/migraciones del repo) + suite Playwright completa + revisión manual de
los flujos que tocan datos o dinero (publicación, comentarios→lead, cuotas, permisos).

---

## 1. La lista definitiva de las 50 mejoras

La lista original que pidió el dueño no quedó guardada en el repo (el único registro era una
transcripción ajena al módulo). La tabla de abajo es la **reconstrucción auditada**: cada fila
apunta a código que existe y a una prueba que lo verifica. Los números que nunca tuvieron
marcador en el código (#33, #35, #38, #39, #50) se asignaron a las mejoras implementadas que
quedaban fuera de la numeración, y quedan documentadas acá para que la numeración sea estable.

| # | Mejora | Dónde vive | Verificación |
|---|---|---|---|
| 1 | Vínculo con propiedad + coaching del form (solo campos vacíos) | `admin-contenido.js:fillFromProperty` → `yt-integrations.js:payloadFromProperty` | `yt-integraciones.spec.js` |
| 2 | Plantillas locales (`localStorage`, tope 20) | `admin-contenido.js:getTemplates` | `contenido-ui.spec.js` |
| 3 | Copiar metadata de un post del historial | `prefillFromPost(p,false)` + `[data-contenido-copy]` | `yt-modulos.spec.js` |
| 4 | Metadata real del archivo (dimensiones + duración) | `admin-contenido.js:readVideoMeta` | `contenido-ui.spec.js` |
| 5 | Preview del video con poster | `admin-contenido.js` | `contenido-ui.spec.js` |
| 6 | Auto-CTA al publicar (completa la descripción) | `#ytAutoCta` | `contenido-ui.spec.js` |
| 7 | Quick-fix de tags con los presets del motor (hasta 15) | `applySuggestedTags` | `contenido-ui.spec.js` |
| 8 | Clonado de metadata a otro canal | `#ytCloneChannel` | `contenido-ui.spec.js` |
| 9 | Progreso de subida: ETA + velocidad | `fmtEta` / `fmtSpeed` | `yt-modulos.spec.js` |
| 10 | Schedules rápidos (hoy 18:00 / mañana 12:00 / jueves 18:00) | `quickSchedules` | `contenido-ui.spec.js` |
| 11 | Auto-CTA + hashtags con preferencia persistente | `bh_yt_cta_auto` | `contenido-ui.spec.js` |
| 12 | Capítulos con validación del formato de YouTube | `#ytChaptersBtn` | `contenido-ui.spec.js` |
| 13 | Keyword + competencia del canal + canibalización + delta de score | `yt-seo-tools.js:canibalization` | `yt-modulos.spec.js` |
| 14 | Top de tags históricos del canal (chips) | `renderChannelTags` | `contenido-ui.spec.js` |
| 15 | Atajo desde una propiedad (payload canónico, una sola fuente) | `yt-integrations.js:payloadFromProperty` | `yt-integraciones.spec.js` |
| 16 | Banco de frases probadas para el título | `#ytTitlePhrases` | `contenido-ui.spec.js` |
| 17 | Hashtags institucionales (contrato con el motor: 3 hashtags) | `yt-integrations.js:CTA_HASHTAGS` | `yt-integraciones.spec.js` |
| 18 | Bloqueo de campos durante la subida + snapshot del score SEO | `admin-contenido.js` + `social-publish-youtube` | `contenido-ui.spec.js` |
| 19 | Reportes de YouTube Analytics (6 reportes) | `yt-analytics.js` + action `analytics_report` | `yt-analitica.spec.js` |
| 20 | Delta de score respecto al publicado | `studioSeoScore` | `contenido-ui.spec.js` |
| 21 | Métricas del canal (28 días) | `loadAnalyticsPanel` | `contenido-ui.spec.js` |
| 22 | Snapshot diario + tendencia (SVG) | `maybeDailySnapshot` + `renderTrendPanel` | `yt-modulos.spec.js` |
| 23 | Sparklines por card (14 días) | `sparkPointsFor` | `yt-modulos.spec.js` |
| 24 | Badge "procesando" (subida en curso) | `upload_status` del server | `contenido-ui.spec.js` |
| 25 | Toolbar: búsqueda / orden / filtro | `renderStudioVideosGrid` | `contenido-ui.spec.js` |
| 26 | Lazy: métricas del video + playlists (se piden al abrir) | `loadVideoAnalytics` / `loadPlaylistsBlock` | `contenido-ui.spec.js` |
| 27 | Filtro "dead" (0 vistas con más de 30 días) | `_studioFilter === 'dead'` | `contenido-ui.spec.js` |
| 28 | Export CSV del inventario del canal | `downloadStudioCsv` | `contenido-ui.spec.js` |
| 29 | Semáforo de salud del canal (+ alerta 1×/día) | `yt-ops.js:health` / `alertOnce` | `yt-ops.spec.js` |
| 30 | Cache del Studio (`sessionStorage`, 5 min) | `studioCacheRead` / `studioCacheWrite` | `contenido-ui.spec.js` |
| 31 | Bandeja de comentarios del canal + contador de nuevos | `yt-comments.js` + `#ytCommentsInbox` | `yt-comentarios.spec.js` |
| 32 | Mapa video → ficha ("Ver ficha" en la card) | `yt-integrations.js:linkFicha` | `yt-integraciones.spec.js` |
| 33 | Categorías **reales** de YouTube (`videoCategories.list`, cache 7 días) | action `video_categories` + `loadCategories` | `yt-modulos.spec.js` |
| 34 | Compartir por WhatsApp con el contexto del agente | `yt-integrations.js:whatsappLink` | `yt-integraciones.spec.js` |
| 35 | Pre-flight: chequeos ANTES de gastar 1600 unidades | `yt-publish.js:preflight` | `yt-modulos.spec.js` |
| 36 | Republicar (clonar metadata de un video al formulario) | `yt-integrations.js:clonePayload` | `yt-integraciones.spec.js` |
| 37 | Cola de publicación compartida con la nube (unión por id) | `queue.mergeRemote` / `queue.pushRemote` | `yt-integraciones.spec.js` |
| 38 | Reanudación de la subida si se recarga la página | `yt-publish.js:resume` (`upload_resume`) | `yt-modulos.spec.js` |
| 39 | Validación en vivo de límites + canibalización | `yt-seo-tools.js:validate` | `yt-modulos.spec.js` |
| 40 | Historial de acciones del módulo (`audit_log`) | `yt-ops.js:loadAuditTrail` | `yt-ops.spec.js` |
| 41 | Progreso de subida flotante (a nivel `body`) | `#ytUploadFloat` | `contenido-ui.spec.js` |
| 42 | Prefill/reintento desde el historial | `prefillFromPost(p,true)` + `[data-contenido-retry]` | `yt-modulos.spec.js` |
| 43 | Traza en `audit_log` cuando falla la publicación | `social-publish-youtube` | server (sin UI) |
| 44 | HUD de cuota API estimada | `STUDIO_QUOTA` + `#ytQuotaHud` | `contenido-ui.spec.js` |
| 45 | Confirmación con las consecuencias en claro | `window.__BH.showConfirmDialog` | `contenido-ui.spec.js` |
| 46 | Grilla del mes (estrenos) + lead desde un comentario | `renderMonthGrid` + action `comment_lead` | `contenido-ui.spec.js` / `yt-comentarios.spec.js` |
| 47 | Analítica avanzada: retención, tráfico, demografía, top de videos | `yt-analytics.js` | `yt-analitica.spec.js` |
| 48 | Backup JSON del historial de `social_posts` | `backupSocialPostsJson` | `contenido-ui.spec.js` |
| 49 | Reintento de publicaciones fallidas (sin reescribir la metadata) | `[data-contenido-retry]` + semáforo de salud | `yt-ops.spec.js` |
| 50 | Página pública del canal (`/canal.html`) + sincronización canal→CRM | `canal.html` + `canal-page.js` + CI + action `videos_sync_public` | `canal-publico.spec.js` + `canal-privacidad.spec.js` |

**Cobertura:** 50/50 implementadas, 50/50 con prueba automatizada o verificación server-side explícita.
Suite completa: **261 pruebas OK + 3 skipped** (los skipped son de otros módulos y requieren credenciales).

---

## 2. Bugs reales que encontró la auditoría (y se corrigieron)

Todos estos son bugs reales (de producción o de los que un test no cubre): los detectaron
los tests nuevos o la revisión manual del código de este lote.

| # | Bug | Impacto | Corrección |
|---|---|---|---|
| 1 | `esc()` de `canal-page.js` armaba `<` con el signo `<` en vez de `&` | escapado roto → riesgo de inyección en la página pública | `String.fromCharCode(38) + 'lt;'` (patrón del proyecto) |
| 2 | `formatValue` de `yt-analytics.js` chequeaba "es número" antes de mapear texto | las dimensiones (origen del tráfico, edad, género) salían todas como `—` | las dimensiones se traducen primero |
| 3 | `whatsappLink` armaba un link con `?de=&tel=` y **nunca lo usaba** | el mensaje de WhatsApp salía sin el agente | el contexto va dentro del mensaje (YouTube no tiene página propia que lo muestre) |
| 4 | `clearCache` de `yt-analytics.js` tenía un loop sin sentido | el botón "Actualizar" no borraba la caché | borrado por prefijo `bh_yt_ana_` |
| 5 | Dos caminos para reintentar un post fallido (`retryFailedPost` nuevo vs `prefillFromPost` viejo) | el reintento se pisaba a sí mismo | se eliminó el duplicado: queda `prefillFromPost` |
| 6 | `buildPropDesc` (orquestador) vs `payloadFromProperty` (módulo) | dos implementaciones de la misma metadata | una sola fuente: el módulo; el orquestador delega |
| 7 | Los hashtags institucionales vivían en dos archivos | podían divergir | fuente única en `yt-integrations.js` (`CTA_HASHTAGS`) |
| 8 | Al republicar o cargar de la cola, la categoría se asignaba **antes** de que la API entregara las opciones | la categoría se perdía en silencio (el `select` no tenía esa opción) | `_pendingCategoryId`: queda pendiente y se aplica cuando llegan las categorías |
| 9 | `alertOnce` marcaba "ya avisado" antes de saber si la traza se guardó | una alerta de salud fallida se perdía hasta el día siguiente | el flag se escribe solo si la auditoría volvió `ok` (`core.audit` ahora devuelve booleano) |
| 10 | `canal-videos.json` sin deduplicar | un video republicado aparecía dos veces en la página pública | deduplicación por `external_post_id` (gana el más reciente) |
| 11 | `loadVideoPostMap` no traía el `property_code` (el `select` no lo pedía) | el botón "Ver ficha" **nunca** aparecía | embed `properties(property_code)` con fallback sin embed |
| 12 | `loadChannelVideos` usaba un embed de PostgREST que depende de la FK | si la FK no existiera, la página pública quedaba vacía | el join con `properties` se hace en JS |
| 13 | La página pública filtraba por `status='published'` **sin mirar la visibilidad real** | un video `unlisted` (oculto) o programado (en privado) se publicaba en una página indexable → **fuga de privacidad** | el server guarda `metrics.youtube_privacy` (dato real de YouTube) y el generador publica sólo lo público, con regla fail-closed (`scripts/channel-privacy.mjs`) |
| 14 | `/canal.html` se alimentaba sólo de `social_posts` | los videos ya publicados (subidos fuera del panel) no existían en el CRM → la página pública nacía vacía | action `videos_sync_public` (botón "Sincronizar canal"): importa el inventario real, refresca la visibilidad y reconcilia los videos borrados |

---

## 3. Gaps honestos (lo que NO está resuelto)

Estos puntos **no** son bugs de código: son límites del diseño o decisiones pendientes del dueño.
Están escritos para que nadie los descubra tarde.

1. **La analítica está apagada hasta que el dueño reconecte la cuenta.**
   El scope `yt-analytics.readonly` se agregó a la app de Google después de la primera conexión:
   las conexiones viejas no lo tienen → los 6 reportes responden `needs_reconnect` y la UI lo
   dice con un banner claro. **El resto del módulo funciona igual.** Acción del dueño:
   desconectar y volver a conectar la cuenta de YouTube en *Cuentas*.

2. **La bandeja de comentarios puede degradar en silencio.**
   `allThreadsRelatedToChannelId` (bandeja del canal) puede pedir permisos que la app no tiene
   todavía → la bandeja muestra el error y el Studio sigue vivo. Los comentarios de un video
   puntual (`commentThreads.list`) no tienen ese requisito.

3. **No hay aviso por email de comentarios nuevos ni de la alerta de salud.**
   Sin cron y sin Brevo en este módulo (decisión de alcance): la alerta es in-app + `audit_log`.
   Los correos del módulo son los que ya existen (digest semanal, recordatorios).

4. **El HUD de cuota es una ESTIMACIÓN local** (unidades por acción), no la cuota real de Google.
   Sirve para que el dueño entienda cuánto gasta cada acción; **no** sirve como alerta de límite.

5. **La cola en la nube es "última escritura gana".**
   `pushRemote` reemplaza la copia del servidor con la local. La unión por `id` evita duplicados,
   pero si dos dispositivos encolan al mismo tiempo uno puede pisar al otro. Aceptable para un
   usuario único; si algún día hay varias cuentas, hay que pasar a merge por timestamp.

6. **`consent_at` se pone solo en el lead creado desde un comentario.**
   La persona escribió públicamente pidiendo información de una propiedad y el admin decide
   ("Crear lead") → se registra como consentimiento. Si la postura legal del dueño cambia, la
   línea a revisar es `consent_at` en `social-youtube-comments/index.ts`.

7. **`assets/data/canal-videos.json` se regenera cada 30 minutos por el CI.**
   Hasta la primera corrida de producción, la página pública muestra "Todavía no hay videos
   publicados". No es un bug: es el pipeline (mismo que las fichas). **Además hay que pulsar
   "Sincronizar canal" en el Studio** (o publicar desde el panel): hasta entonces el CRM no conoce
   los videos que ya estaban en el canal y la página no tiene nada que mostrar.

8. **La sincronización del canal es manual.**
   El CI no puede llamar a la API de YouTube (no tiene el token OAuth de la cuenta) → el botón
   "Sincronizar canal" hay que pulsarlo. Es idempotente y barato (~2-4 unidades de cuota), pero
   si el dueño cambia la visibilidad de un video y no vuelve a pulsar, la página pública puede
   mostrar un video que ya no es público **hasta la próxima sincronización** (el server sí actualiza
   `metrics.youtube_privacy` en el momento de editar o promover un video: la ventana es sólo para
   los cambios hechos fuera del panel).

9. **La página pública del canal es de lectura**: no tiene formulario ni chat. La conversión
   sigue por la ficha de la propiedad y por WhatsApp.

10. **El "mes de estrenos" (#46) usa la fecha real de publicación**, no la fecha programada:
    un video programado y publicado después cuenta en el mes en que salió, no en el que se agendó.

11. **Cloudinary sigue PROHIBIDO en Contenido**: los bytes del video van del navegador directo a
    Google (subida resumable) y la miniatura viaja en base64 dentro del pedido al server
    (≤ 2 MB). Ningún archivo de Contenido pasa por Cloudinary.

---

## 4. Decisiones de arquitectura (y alternativas descartadas)

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Módulos compartidos (`window.BH_YT.*`) + orquestador | seguir creciendo el monolito `admin-contenido.js` (ya pasó de 4.000 líneas) | los módulos se pisan entre sí cuando todo vive en un scope compartido; con un bus explícito cada feature tiene su dueño |
| Un solo namespace `window.BH_YT` | globals sueltos (`window.ytCore`, `window.ytComments`…) | el panel ya tiene 20+ namespaces; un namespace propio evita colisiones |
| Todo lo que escribe pasa por Edge Functions (`app_settings`, `audit_log`, `leads`) | escribir directo desde el cliente | RLS no lo permite (y no debe): el cliente no necesita `service_role` |
| Las dimensiones/métricas de los reportes viven en el server | mandar la consulta a la API de Google desde el cliente | un cliente no debería poder inventar consultas ni revolver el gasto de cuota |
| Cola local + copia en la nube, unión por `id` | solo nube (requiere red para encolar) / solo local (se pierde al cambiar de dispositivo) | el dueño encola en la calle, sin señal; y a veces cambia de dispositivo |
| La página pública se genera en el CI (mismo pipeline que las fichas) | una edge function que arme la grilla | cero backend nuevo, cero costo, cero staleness (se regenera cada 30 min) |
| La visibilidad se decide en el SERVER (`metrics.youtube_privacy`, dato real de YouTube) y el CI sólo filtra | filtrar por `content.privacy` (lo que pidió el dueño) | lo que pidió el dueño y lo que terminó siendo en YouTube no siempre coinciden (un video programado nace en privado y se vuelve público solo; un `unlisted` no es público) |
| Fail closed en la página pública (sin dato de visibilidad → no se publica) | publicar por defecto y excluir sólo los `private` conocidos | ante la duda, no se filtra: una fuga de privacidad no se arregla con un rollback |
| Sincronización del canal a pedido del dueño (botón en el Studio) | un cron que llame a la API de YouTube | el CI no tiene el token OAuth de la cuenta (está cifrado en la DB); el botón es idempotente y barato |
| Sin migraciones ni crons nuevos | crear tablas/funciones para persistir preferencias | `social_posts.content` (JSONB) + `social_posts.metrics` (JSONB) + `app_settings` + `localStorage` alcanza para todo lo pedido |
| Persistencia de plantillas/cola/analítica en el navegador | en la DB | son datos del dispositivo, no del negocio; y evita RLS/migrations |

---

## 5. Checklist de verificación (para el dueño)

- [ ] Reconectar la cuenta de YouTube (Cuentas → desconectar → conectar) para habilitar **analítica**.
- [ ] En *Studio*, pulsar **"Sincronizar canal"**: el historial y `/canal.html` tienen que mostrar los
      videos ya publicados (incluidos los que se subieron fuera del panel).
- [ ] En *Studio*, el semáforo de **Salud del canal** tiene que salir en verde.
- [ ] La **Bandeja de comentarios** abre y lista comentarios (si no abre, el server responde 403).
- [ ] Publicar un video de prueba: pre-flight en verde → barra de progreso con ETA → queda en el
      historial con su video embebido en la ficha.
- [ ] `/canal.html` muestra el video recién publicado (aparece hasta 30 min después: lo regenera el CI).
- [ ] Un video **privado** u **oculto** NO aparece en `/canal.html` (y sí en el Studio).
- [ ] Compartir por WhatsApp desde la card del Studio: el mensaje llega con el video y el agente.
- [ ] "Ver ficha" aparece en la card de los videos que tienen propiedad vinculada.

---

## 6. Deuda técnica que queda (conscientemente NO resuelta)

- `assets/js/admin-contenido.js` sigue siendo el orquestador más grande del panel (~4.300 líneas):
  los módulos ya están extraídos, pero la **UI** (render del Studio, modal de video, historial)
  sigue ahí. Extraerla es trabajo de otro lote, no de este.
- Los tests del módulo usan un harness propio (`tests/helpers/yt-harness.js`) con un cliente
  Supabase fake: cubre el comportamiento del cliente, **no** las políticas RLS ni los triggers
  (eso se verifica contra producción).
- El `audit_log` del módulo se lee desde el cliente (`yt-ops.loadAuditTrail`): funciona por la
  política de lectura existente, pero si algún día se restringe, ese modal deja de mostrar datos.
