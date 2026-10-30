// ============================================================
// social-youtube-studio — Mini YouTube Studio del módulo Contenido.
//
// Acciones (todas requireAdmin, verify_jwt ON):
//   channel:      channels.list (snippet,statistics,contentDetails) →
//                 subs, views, cantidad de videos, avatar, handle, ID de la
//                 playlist de uploads. Funciona con scope readonly.
//   videos:       playlistItems.list (uploads) + videos.list (snippet,
//                 statistics,status,contentDetails) → TODO el inventario
//                 del canal (incluye videos subidos manualmente).
//   video_update: videos.update — título, descripción, tags, visibilidad
//                 y programación (publishAt, nativo de YouTube).
//                 Exige scope youtube.force-ssl.
//   video_delete: videos.delete — borrado permanente con confirmación
//                 previa en el cliente. Exige youtube.force-ssl.
//   thumbnail:    thumbnails.set — miniatura personalizada (imagen
//                 base64 ≤2MB). Exige youtube.force-ssl.
//   videos_sync_public: importa/actualiza el inventario REAL del canal
//                 en social_posts (idempotente) y reconcilia los videos
//                 que ya no están en el canal. Es lo que hace que la
//                 página pública /canal.html muestre los videos ya
//                 publicados (incluidos los subidos fuera del panel) y
//                 que el CRM sepa la visibilidad real de cada video
//                 (metrics.youtube_privacy: public|unlisted|private).
//                 Sólo lectura de YouTube.
//
// MEJORAS 2026-10-30 (lote 49 mejoras — módulo Contenido):
//   playlists:    inventario de playlists del canal + sus items —
//                 readonly. Lazy-load desde el detalle de video.
//   playlist_create / playlist_item_add / playlist_item_remove:
//                 gestión de playlists (parte de force-ssl, igual
//                 que el resto de la administración).
//   snapshot:     captura diaria de views del canal → app_settings
//                 (key social_yt_stats_history, máx 90 días) para
//                 los sparklines del studio. Idempotente por día.
//   analytics:    YouTube Analytics API v2 — totals 28 días del canal
//                 (o filters=video==ID). Requiere scope
//                 yt-analytics.readonly: sin él responde
//                 needs_reconnect (el panel muestra el banner de
//                 reconexión; las conexiones viejas siguen vivas).
//
// Cuota: ~5-10 unidades por carga del studio; updates/deletes ~50 c/u,
// playlists ~20 c/u — muy dentro de las 10.000 diarias. El snapshot
// consume ~7 unidades y el cliente lo dispara 1×/día.
// ============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import { getSocialAccessToken, getSocialCredentials } from '../_shared/social.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2';
const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
/* Snapshot diario de views (sparklines): app_settings.value = [{ d, v: {videoId: views} }] */
const HISTORY_KEY = 'social_yt_stats_history';
const HISTORY_MAX_DAYS = 90;
const PLAYLISTS_MAX = 20;
/* Caché de las categorías de YouTube (cambian por región; 7 días alcanza) */
const CATEGORIES_KEY = 'social_yt_categories';
const CATEGORIES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/* Fallback honesto: la categoría que usa el módulo hoy. La lista completa
   viene de la API (videoCategories.list) para no inventar ids. */
const CATEGORIES_FALLBACK = [{ id: '22', name: 'People & Blogs' }];

/* ============================================================
   Reportes de analítica (YouTube Analytics API)
   ------------------------------------------------------------
   Cada reporte es una consulta a /v2/reports. Se definen acá
   (no en el cliente) para que el contrato sea uno solo y el
   cliente no pueda inventar dimensiones/métricas inválidas.
   Cada llamada cuesta 1 unidad de cuota de Google.
   ============================================================ */
const ANALYTICS_REPORTS: Record<string, {
    dimensions: string;
    metrics: string;
    sort?: string;
    limit?: number;
    label: string;
}> = {
    summary: {
        dimensions: '',
        metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,impressions,impressionsClickThroughRate',
        label: 'Resumen del período',
    },
    daily: {
        dimensions: 'day',
        metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost',
        limit: 90,
        label: 'Evolución día a día',
    },
    top_videos: {
        dimensions: 'video',
        metrics: 'views,estimatedMinutesWatched,impressions,impressionsClickThroughRate,averageViewDuration',
        sort: '-views',
        limit: 20,
        label: 'Top de videos',
    },
    retention: {
        dimensions: 'elapsedVideoTimeRatio',
        metrics: 'averageViewDuration,views',
        limit: 100,
        label: 'Curva de retención',
    },
    traffic: {
        dimensions: 'trafficSource',
        metrics: 'views,estimatedMinutesWatched',
        label: 'Origen del tráfico',
    },
    demographics: {
        dimensions: 'ageGroup,gender',
        metrics: 'viewerPercentage',
        label: 'Audiencia por edad y género',
    },
};
const ANALYTICS_MIN_DAYS = 7;
const ANALYTICS_MAX_DAYS = 365;

interface StudioAccount {
    id: string;
    platform: string;
    status: string;
    scope: string | null;
}

function clip(s: string, max: number): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

async function loadAccount(client: SupabaseClient, accountId: string): Promise<StudioAccount> {
    const { data } = await client
        .from('social_accounts')
        .select('id, platform, status, scope')
        .eq('id', accountId)
        .maybeSingle() as { data: StudioAccount | null };
    const acc = data;
    if (!acc || acc.platform !== 'youtube') throw new Error('Cuenta de YouTube no encontrada');
    if (acc.status !== 'active') throw new Error('La cuenta está desconectada — reconectala');
    return acc;
}

/** El scope de la CONEXIÓN decide qué puede hacer el studio:
 *  readonly+upload → solo lectura; con force-ssl → administración completa. */
function hasManageScope(acc: { scope: string | null }): boolean {
    return !!acc.scope && acc.scope.includes(FORCE_SSL_SCOPE);
}

/* Analítica del canal: scope propio (agregado 2026-10-30). Las conexiones
   hechas antes del cambio NO lo tienen — la UI muestra needs_reconnect. */
function hasAnalyticsScope(acc: { scope: string | null }): boolean {
    return !!acc.scope && acc.scope.includes(ANALYTICS_SCOPE);
}

async function youtubeFetch(url: string, accessToken: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`YouTube ${res.status}: ${body}`);
    }
    /* DELETE devuelve 204 sin body — no parsear JSON de un body vacío */
    if (res.status === 204 || res.headers.get('content-length') === '0') return {};
    return res.json();
}

/** Guarda la visibilidad REAL del video (public|unlisted|private) en el CRM.
 *  La página pública (/canal.html) sólo lista videos públicos: si el dueño
 *  cambia la visibilidad desde el Studio, el CRM tiene que enterarse YA
 *  (si no, la página pública seguiría mostrando un video privado).
 *  Conserva el resto de metrics. Best-effort: si no hay fila, no hace nada. */
async function setPostPrivacy(
    client: SupabaseClient,
    videoId: string,
    privacy: string,
): Promise<void> {
    try {
        const { data } = await client
            .from('social_posts')
            .select('id, metrics')
            .eq('platform', 'youtube')
            .eq('external_post_id', videoId)
            .limit(1)
            .maybeSingle() as { data: { id: string; metrics: Record<string, unknown> | null } | null };
        if (!data) return;
        const metrics = Object.assign({}, data.metrics ?? {}, { youtube_privacy: privacy });
        await client.from('social_posts').update({ metrics }).eq('id', data.id);
    } catch (_) {
        /* best-effort: la visibilidad real se re-sincroniza con
           videos_sync_public (o al publicar de nuevo). */
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('social-youtube-studio', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Método no permitido' });

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });
    const { data: userData } = await supabase.auth.getUser(token);
    if (!userData?.user) return respond(401, { error: 'No autorizado' });
    const adminId = userData.user.id;

    let body: {
        action?: string;
        account_id?: string;
        video_id?: string;
        title?: string;
        description?: string;
        tags?: string[] | string;
        privacy?: string;
        publish_at?: string;
        thumbnail_base64?: string;
        playlist_id?: string;
        playlist_title?: string;
        playlist_description?: string;
        item_id?: string;
        position?: number;
        max?: number;
        report?: string;
        days?: number;
        key?: string;
        value?: unknown;
        audit_action?: string;
        module?: string;
        table_name?: string;
        record_id?: string | null;
        status?: string;
        error_code?: string | null;
        metadata?: unknown;
    };
    try {
        body = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' });
    }

    try {
        if (!body.action) return respond(400, { error: 'Falta la acción' });

        /* ------- Plataformas configurables (¿hay credenciales OAuth?) -------
           REPARACIÓN 2026-10-30: el módulo mostraba "Conectar" para redes
           sin app configurada (Instagram sin app de Meta, por ejemplo) →
           botón que moría con un error. Ahora la UI sabe qué redes están
           realmente configuradas (app_settings social_<plataforma> o env). */
        if (body.action === 'platforms_config') {
            const names = ['youtube', 'instagram', 'facebook', 'tiktok'] as const;
            const platforms: Array<{ platform: string; configured: boolean }> = [];
            for (const name of names) {
                try {
                    const creds = await getSocialCredentials(supabase, name);
                    platforms.push({ platform: name, configured: !!(creds.clientId && creds.clientSecret) });
                } catch (_) {
                    platforms.push({ platform: name, configured: false });
                }
            }
            return respond(200, { platforms });
        }

        /* ------- Ajustes compartidos del módulo (app_settings) -------
           El cliente NO puede escribir app_settings por RLS: el server
           (service_role) lo hace. Solo se exponen claves social_yt_* para
           no abrir otros ajustes del panel. */
        if (body.action === 'settings_get') {
            const key = String(body.key ?? '');
            if (!key.startsWith('social_yt_')) return respond(400, { error: 'Clave no permitida' });
            const { data, error } = await supabase
                .from('app_settings')
                .select('value')
                .eq('key', key)
                .maybeSingle() as { data: { value: unknown } | null; error: { message: string } | null };
            if (error) return respond(500, { error: error.message });
            return respond(200, { key, value: data?.value ?? null });
        }

        if (body.action === 'settings_set') {
            const key = String(body.key ?? '');
            if (!key.startsWith('social_yt_')) return respond(400, { error: 'Clave no permitida' });
            const { error } = await supabase
                .from('app_settings')
                .upsert(
                    { key, value: body.value ?? null, updated_at: new Date().toISOString() },
                    { onConflict: 'key' },
                );
            if (error) return respond(500, { error: error.message });
            return respond(200, { ok: true, key });
        }

        /* ------- Auditoría del módulo (audit_log) -------
           El cliente no puede insertar en audit_log (RLS): lo hace el
           server con service_role. action + module son NOT NULL y la
           columna de usuario es user_id. */
        if (body.action === 'audit_log') {
            /* Contrato: body.action despacha ('audit_log') y body.audit_action
               es el nombre real de la acción auditada. Se usan campos
               separados porque 'action' ya está ocupado por el dispatch. */
            const finalAction = clip(String(body.audit_action ?? ''), 80);
            if (!finalAction) return respond(400, { error: 'Falta la acción de auditoría' });
            const module = clip(String(body.module ?? 'contenido'), 60);
            /* record_id es UUID en el schema real: si el cliente manda un id
               que no es UUID (ej. el id de la cola local 'q_123'), se guarda
               null en vez de romper la insert. */
            const rawRecordId = String(body.record_id ?? '').trim();
            const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawRecordId)
                ? rawRecordId
                : null;
            const { error } = await supabase.from('audit_log').insert({
                user_id: adminId,
                action: finalAction,
                module,
                table_name: clip(String(body.table_name ?? 'social_posts'), 60),
                record_id: recordId,
                status: body.status === 'error' ? 'error' : 'success',
                error_code: body.error_code ? clip(String(body.error_code), 60) : null,
                metadata: body.metadata ?? null,
            });
            if (error) return respond(500, { error: error.message });
            return respond(200, { ok: true });
        }

        /* ------- Categorías de YouTube (videoCategories.list) -------
           La lista real la da la API (cambia por región); se cachea 7 días
           en app_settings. Fallback mínimo si Google falla. */
        if (body.action === 'video_categories') {
            const { data: cached } = await supabase
                .from('app_settings')
                .select('value')
                .eq('key', CATEGORIES_KEY)
                .maybeSingle() as { data: { value: unknown } | null };
            const cachedVal = cached?.value as { at?: number; items?: Array<{ id: string; name: string }> } | null;
            if (cachedVal && cachedVal.items?.length && Date.now() - Number(cachedVal.at ?? 0) < CATEGORIES_TTL_MS) {
                return respond(200, { categories: cachedVal.items, cached: true });
            }
            try {
                const accountId = String(body.account_id ?? '');
                let accessToken = '';
                if (accountId) {
                    const acc = await loadAccount(supabase, accountId);
                    accessToken = await getSocialAccessToken(supabase, accountId);
                } else {
                    const { data: anyAcc } = await supabase
                        .from('social_accounts')
                        .select('id')
                        .eq('platform', 'youtube')
                        .eq('status', 'active')
                        .limit(1)
                        .maybeSingle() as { data: { id: string } | null };
                    if (anyAcc?.id) accessToken = await getSocialAccessToken(supabase, anyAcc.id);
                }
                if (!accessToken) throw new Error('Sin token de YouTube');
                const res = await youtubeFetch(
                    `${YOUTUBE_API}/videoCategories?part=snippet&regionCode=AR`,
                    accessToken,
                ) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
                const items = (res.items ?? [])
                    .filter((c) => !!c.id)
                    .map((c) => ({ id: String(c.id), name: String(c.snippet?.title ?? '') }))
                    .filter((c) => !!c.name);
                if (!items.length) throw new Error('La API no devolvió categorías');
                await supabase.from('app_settings').upsert(
                    { key: CATEGORIES_KEY, value: { at: Date.now(), items }, updated_at: new Date().toISOString() },
                    { onConflict: 'key' },
                );
                return respond(200, { categories: items, cached: false });
            } catch (err) {
                return respond(200, {
                    categories: cachedVal?.items?.length ? cachedVal.items : CATEGORIES_FALLBACK,
                    cached: true,
                    warning: (err as Error).message.slice(0, 160),
                });
            }
        }

        /* ------- Promover un borrador a público ------- */
        if (body.action === 'video_promote') {
            const accountId = String(body.account_id ?? '');
            const videoId = clip(String(body.video_id ?? ''), 50);
            if (!accountId || !videoId) return respond(400, { error: 'Faltan datos' });
            const acc = await loadAccount(supabase, accountId);
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para habilitar la administración completa.' });
            }
            const accessToken = await getSocialAccessToken(supabase, accountId);
            await youtubeFetch(`${YOUTUBE_API}/videos?part=status`, accessToken, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: videoId,
                    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, embeddable: true },
                }),
            });
            const { error } = await supabase
                .from('social_posts')
                .update({
                    status: 'published',
                    published_at: new Date().toISOString(),
                    external_post_id: videoId,
                    external_url: `https://www.youtube.com/watch?v=${videoId}`,
                    error: null,
                })
                .eq('platform', 'youtube')
                .eq('external_post_id', videoId);
            if (error) return respond(500, { error: error.message });
            /* La visibilidad REAL (public) queda registrada en el CRM: la
               página pública sólo muestra videos públicos. */
            await setPostPrivacy(supabase, videoId, 'public');
            return respond(200, { ok: true });
        }

        /* ------- Info del canal (funciona con solo readonly) ------- */
        if (body.action === 'channel') {
            const accountId = String(body.account_id ?? '');
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            const acc = await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const ch = (await youtubeFetch(
                `${YOUTUBE_API}/channels?part=snippet,statistics,contentDetails&mine=true`,
                accessToken,
            )) as {
                items?: Array<{
                    id?: string;
                    snippet?: { title?: string; description?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } };
                    statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string };
                    contentDetails?: { relatedPlaylists?: { uploads?: string } };
                }>;
            };
            const c = ch.items?.[0];
            if (!c?.id) throw new Error('No se pudo leer el canal — reconecta la cuenta');

            return respond(200, {
                channel: {
                    id: c.id,
                    title: c.snippet?.title ?? '',
                    description: c.snippet?.description ?? '',
                    handle: c.snippet?.customUrl ?? '',
                    avatar: c.snippet?.thumbnails?.default?.url ?? null,
                    subscribers: Number(c.statistics?.subscriberCount ?? 0),
                    total_views: Number(c.statistics?.viewCount ?? 0),
                    video_count: Number(c.statistics?.videoCount ?? 0),
                    uploads_playlist: c.contentDetails?.relatedPlaylists?.uploads ?? null,
                },
                can_manage: hasManageScope(acc),
            });
        }

        /* ------- Listado de TODO el inventario del canal ------- */
        if (body.action === 'videos') {
            const accountId = String(body.account_id ?? '');
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            const acc = await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            // 1. Playlist de uploads del canal (+ videoCount real del canal)
            const ch = (await youtubeFetch(
                `${YOUTUBE_API}/channels?part=contentDetails,statistics&mine=true`,
                accessToken,
            )) as {
                items?: Array<{
                    contentDetails?: { relatedPlaylists?: { uploads?: string } };
                    statistics?: { videoCount?: string };
                }>;
            };
            const uploadsPlaylist = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
            if (!uploadsPlaylist) throw new Error('No se encontró la playlist de uploads del canal');
            const channelVideoCount = Number(ch.items?.[0]?.statistics?.videoCount ?? 0);

            /* REPARACIÓN 2026-10-30: el inventario se truncaba a 50 videos SIN
               aviso (un canal con más de 50 perdía videos en pantalla y en el
               CSV). Ahora se pagina la playlist de uploads hasta `max`
               (tope 200) y se informa el total real del canal. */
            const maxRaw = Number(body.max ?? 100);
            const max = Math.min(Math.max(Number.isFinite(maxRaw) ? maxRaw : 100, 50), 200);
            const ids: string[] = [];
            let pageToken: string | undefined;
            do {
                const url = new URL(`${YOUTUBE_API}/playlistItems`);
                url.searchParams.set('part', 'contentDetails');
                url.searchParams.set('playlistId', uploadsPlaylist);
                url.searchParams.set('maxResults', '50');
                if (pageToken) url.searchParams.set('pageToken', pageToken);
                const pl = (await youtubeFetch(url.toString(), accessToken)) as {
                    items?: Array<{ contentDetails?: { videoId?: string } }>;
                    nextPageToken?: string;
                };
                for (const it of pl.items ?? []) {
                    const vid = it.contentDetails?.videoId;
                    if (vid) ids.push(vid);
                }
                pageToken = pl.nextPageToken || undefined;
            } while (pageToken && ids.length < max);
            const capped = ids.slice(0, max);
            if (!capped.length) {
                return respond(200, { videos: [], total: channelVideoCount, truncated: channelVideoCount > 0 });
            }

            // 3. Detalles + estadísticas de esos videos
            const vids = (await youtubeFetch(
                `${YOUTUBE_API}/videos?part=snippet,statistics,status,contentDetails&id=${capped.join(',')}`,
                accessToken,
            )) as {
                items?: Array<{
                    id?: string;
                    snippet?: { title?: string; description?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string } }; categoryId?: string; tags?: string[] };
                    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
                    status?: { privacyStatus?: string; uploadStatus?: string; publishAt?: string };
                    contentDetails?: { duration?: string };
                }>;
            };

            return respond(200, {
                videos: (vids.items ?? []).map((v) => ({
                    id: v.id,
                    title: v.snippet?.title ?? '',
                    description: v.snippet?.description ?? '',
                    published_at: v.snippet?.publishedAt ?? null,
                    /* REPARACIÓN: la fecha de programación no volvía del server
                       → el modal de edición no podía mostrar si un video estaba
                       programado (y al guardar, la fecha se perdía). */
                    publish_at: v.status?.publishAt ?? null,
                    thumbnail: v.snippet?.thumbnails?.medium?.url ?? null,
                    category_id: v.snippet?.categoryId ?? '22',
                    tags: v.snippet?.tags ?? [],
                    views: Number(v.statistics?.viewCount ?? 0),
                    likes: Number(v.statistics?.likeCount ?? 0),
                    comments: Number(v.statistics?.commentCount ?? 0),
                    privacy: v.status?.privacyStatus ?? 'private',
                    upload_status: v.status?.uploadStatus ?? 'processed',
                    duration: v.contentDetails?.duration ?? '',
                })),
                can_manage: hasManageScope(acc),
                /* total = videos del canal (incluye los que no trae la API de
                   uploads); truncated = hay más de los que se está mostrando. */
                total: channelVideoCount || capped.length,
                truncated: (channelVideoCount || capped.length) > capped.length,
            });
        }

        /* ------- Sincronizar el canal real con el CRM -------
           Importa/actualiza el inventario del canal en social_posts para:
             · que la página pública (/canal.html) muestre los videos ya
               publicados, INCLUIDOS los subidos fuera del panel,
             · que el CRM sepa la visibilidad REAL de cada video: una fila
               con status='published' puede ser un video privado o "oculto"
               (unlisted) → nunca puede salir a una página pública.
           Es idempotente: las filas existentes se ACTUALIZAN (no se
           duplican — external_post_id no tiene unique → se buscan antes).
           Sólo lectura de YouTube (funciona con el scope readonly). */
        if (body.action === 'videos_sync_public') {
            const accountId = String(body.account_id ?? '');
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            /* loadAccount valida que la cuenta exista y esté activa.
               No se exige force-ssl: la acción sólo LEE de YouTube. */
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            // 1. Playlist de uploads = inventario completo del canal
            const ch = (await youtubeFetch(
                `${YOUTUBE_API}/channels?part=contentDetails&mine=true`,
                accessToken,
            )) as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
            const uploadsPlaylist = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
            if (!uploadsPlaylist) throw new Error('No se encontró la playlist de uploads del canal');

            const MAX_SYNC = 200;
            const ids: string[] = [];
            let pageToken: string | undefined;
            do {
                const url = new URL(`${YOUTUBE_API}/playlistItems`);
                url.searchParams.set('part', 'contentDetails');
                url.searchParams.set('playlistId', uploadsPlaylist);
                url.searchParams.set('maxResults', '50');
                if (pageToken) url.searchParams.set('pageToken', pageToken);
                const pl = (await youtubeFetch(url.toString(), accessToken)) as {
                    items?: Array<{ contentDetails?: { videoId?: string } }>;
                    nextPageToken?: string;
                };
                for (const it of pl.items ?? []) {
                    const vid = it.contentDetails?.videoId;
                    if (vid) ids.push(vid);
                }
                pageToken = pl.nextPageToken || undefined;
            } while (pageToken && ids.length < MAX_SYNC);
            /* Si quedó pagination sin terminar, el inventario está incompleto:
               no se reconcilia (podríamos marcar como borrado un video que
               existe pero no entró en esta vuelta). */
            const completo = !pageToken;

            // 2. Detalle (snippet + status) de esos videos — en lotes de 50
            type SyncVideo = {
                id?: string;
                snippet?: { title?: string; description?: string; publishedAt?: string; categoryId?: string; tags?: string[] };
                status?: { privacyStatus?: string; uploadStatus?: string };
            };
            const vids: SyncVideo[] = [];
            for (let i = 0; i < ids.length; i += 50) {
                const lote = ids.slice(i, i + 50);
                const res = (await youtubeFetch(
                    `${YOUTUBE_API}/videos?part=snippet,status&id=${lote.join(',')}`,
                    accessToken,
                )) as { items?: SyncVideo[] };
                vids.push(...(res.items ?? []));
            }

            // 3. Filas que ya existen para ESTA cuenta
            const { data: existentes } = await supabase
                .from('social_posts')
                .select('id, external_post_id, status, content, metrics')
                .eq('platform', 'youtube')
                .eq('account_id', accountId)
                .not('external_post_id', 'is', null)
                .limit(500) as {
                data: Array<{
                    id: string;
                    external_post_id: string;
                    status: string;
                    content: Record<string, unknown> | null;
                    metrics: Record<string, unknown> | null;
                }> | null;
            };
            const porId = new Map((existentes ?? []).map((r) => [String(r.external_post_id), r]));

            let importados = 0;
            let actualizados = 0;
            for (const v of vids) {
                const vid = String(v.id ?? '');
                if (!vid) continue;
                const privacy = String(v.status?.privacyStatus ?? 'private');
                const uploadStatus = String(v.status?.uploadStatus ?? 'processed');
                const prev = porId.get(vid);
                const metrics = Object.assign({}, prev?.metrics ?? {}, {
                    youtube_privacy: privacy,
                    youtube_upload_status: uploadStatus,
                });
                const url = `https://www.youtube.com/watch?v=${vid}`;
                if (prev) {
                    /* NO se pisa el contenido que vive en el CRM (score SEO,
                       keyword, flags de publicación): sólo se refrescan los
                       datos que vienen de YouTube. */
                    const prevContent = (prev.content ?? {}) as Record<string, unknown>;
                    const content = Object.assign({}, prevContent, {
                        title: String(v.snippet?.title ?? ''),
                        description: String(v.snippet?.description ?? ''),
                        tags: v.snippet?.tags ?? [],
                        privacy,
                        category_id: v.snippet?.categoryId ?? (prevContent.category_id ?? '22'),
                    });
                    const patch: Record<string, unknown> = {
                        content,
                        metrics,
                        external_url: url,
                        published_at: v.snippet?.publishedAt ?? null,
                    };
                    /* El estado del CRM sólo avanza si el video ya está
                       procesado. Un borrador ('draft') o un fallido NO se
                       promote: esa decisión es del dueño. */
                    if (uploadStatus === 'processed' && prev.status === 'publishing') patch.status = 'published';
                    const { error } = await supabase.from('social_posts').update(patch).eq('id', prev.id);
                    if (error) return respond(500, { error: error.message });
                    actualizados++;
                    continue;
                }
                const { error } = await supabase.from('social_posts').insert({
                    account_id: accountId,
                    platform: 'youtube',
                    post_type: 'video',
                    status: uploadStatus === 'processed' ? 'published' : 'publishing',
                    published_at: v.snippet?.publishedAt ?? null,
                    external_post_id: vid,
                    external_url: url,
                    content: {
                        title: String(v.snippet?.title ?? ''),
                        description: String(v.snippet?.description ?? ''),
                        tags: v.snippet?.tags ?? [],
                        privacy,
                        category_id: v.snippet?.categoryId ?? '22',
                        imported: true,
                    },
                    metrics,
                    created_by: adminId,
                });
                if (error) return respond(500, { error: error.message });
                importados++;
            }

            // 4. Reconciliación: filas 'published' cuyo video ya no está en el canal
            let reconciliados = 0;
            if (completo) {
                const vistos = new Set(vids.map((v) => String(v.id ?? '')));
                for (const r of existentes ?? []) {
                    if (r.status !== 'published') continue;
                    if (vistos.has(String(r.external_post_id))) continue;
                    const { error } = await supabase
                        .from('social_posts')
                        .update({ status: 'failed', error: 'El video ya no está en el canal de YouTube' })
                        .eq('id', r.id);
                    if (!error) reconciliados++;
                }
            }

            return respond(200, {
                ok: true,
                importados,
                actualizados,
                reconciliados,
                total: vids.length,
                completo,
            });
        }

        /* ------- Editar video (metadata + visibilidad + programación) ------- */
        if (body.action === 'video_update') {
            const accountId = String(body.account_id ?? '');
            const videoId = clip(String(body.video_id ?? ''), 50);
            if (!accountId || !videoId) return respond(400, { error: 'Faltan datos' });
            const acc = await loadAccount(supabase, accountId);
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para habilitar la administración completa.' });
            }
            const accessToken = await getSocialAccessToken(supabase, accountId);

            // videos.update exige categoryId si toca el snippet — leerlo antes
            const current = (await youtubeFetch(
                `${YOUTUBE_API}/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
                accessToken,
            )) as { items?: Array<{ snippet?: { categoryId?: string; tags?: string[] } }> };
            const categoryId = current.items?.[0]?.snippet?.categoryId ?? '22';

            const title = clip(String(body.title ?? ''), 100);
            const description = clip(String(body.description ?? ''), 5000);
            let tags: string[] = [];
            if (typeof body.tags === 'string') tags = body.tags.split(',').map((t) => clip(t, 60)).filter(Boolean);
            else if (Array.isArray(body.tags)) tags = body.tags.map((t) => clip(String(t), 60)).filter(Boolean);
            /* MEJORA 2026-10-30: recorte progresivo (antes slice(0,3) destruía
               casi todos los tags ante un excedente). */
            while (tags.length > 1 && tags.join(',').length > 480) tags.pop();
            if (!title) return respond(400, { error: 'El título es obligatorio' });

            const privacy = ['public', 'unlisted', 'private'].includes(String(body.privacy))
                ? String(body.privacy)
                : 'private';
            /* Programación nativa: publishAt solo con privacy=private —
               YouTube lo pasa a público solo en ese momento. */
            let publishAt: string | undefined;
            if (body.publish_at) {
                const d = new Date(body.publish_at);
                if (isNaN(d.getTime()) || d.getTime() < Date.now() + 5 * 60_000) {
                    return respond(400, { error: 'La fecha de programación debe ser futura (mínimo 5 minutos).' });
                }
                publishAt = d.toISOString();
            }

            const updated = await youtubeFetch(
                `${YOUTUBE_API}/videos?part=snippet,status`,
                accessToken,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: videoId,
                        snippet: { title, description, tags, categoryId },
                        status: {
                            privacyStatus: publishAt ? 'private' : privacy,
                            selfDeclaredMadeForKids: false,
                            ...(publishAt ? { publishAt } : {}),
                        },
                    }),
                },
            );
            /* La visibilidad REAL queda reflejada en el CRM (la página
               pública sólo lista videos públicos). Con programación, el
               video está en privado hasta la fecha de publicación. */
            await setPostPrivacy(supabase, videoId, publishAt ? 'private' : privacy);
            return respond(200, { ok: true });
        }

        /* ------- Borrar video (permanente) ------- */
        if (body.action === 'video_delete') {
            const accountId = String(body.account_id ?? '');
            const videoId = clip(String(body.video_id ?? ''), 50);
            if (!accountId || !videoId) return respond(400, { error: 'Faltan datos' });
            const acc = await loadAccount(supabase, accountId);
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para habilitar la administración completa.' });
            }
            const accessToken = await getSocialAccessToken(supabase, accountId);
            await youtubeFetch(`${YOUTUBE_API}/videos?id=${encodeURIComponent(videoId)}`, accessToken, { method: 'DELETE' });
            /* Las fichas HTML embeben videos con social_posts en 'published'
               (generate-ficha.mjs): sin esto, borrar el video del canal dejaba
               el embed apuntando a un video muerto en cada ficha. Best-effort:
               el borrado en YouTube ya ocurrió — la traza queda visible en el
               historial como fallida con el motivo. */
            await supabase
                .from('social_posts')
                .update({ status: 'failed', error: 'Video borrado del canal (Studio)' })
                .eq('platform', 'youtube')
                .eq('external_post_id', videoId);
            return respond(200, { ok: true });
        }

        /* ------- Miniatura personalizada ------- */
        if (body.action === 'thumbnail') {
            const accountId = String(body.account_id ?? '');
            const videoId = clip(String(body.video_id ?? ''), 50);
            if (!accountId || !videoId) return respond(400, { error: 'Faltan datos' });
            const acc = await loadAccount(supabase, accountId);
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para habilitar la administración completa.' });
            }
            const raw = String(body.thumbnail_base64 ?? '');
            const bytes = raw.length * 0.75;
            if (!raw || bytes < 1000) return respond(400, { error: 'Miniatura inválida' });
            if (bytes > MAX_THUMB_BYTES) return respond(400, { error: 'La miniatura supera 2 MB' });
            const accessToken = await getSocialAccessToken(supabase, accountId);
            const bin = atob(raw.includes(',') ? raw.split(',')[1] : raw);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

            const res = await fetch(`${YOUTUBE_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg' },
                body: buf,
            });
            if (!res.ok) {
                const t = (await res.text()).slice(0, 250);
                throw new Error(`Miniatura ${res.status}: ${t}`);
            }
            return respond(200, { ok: true });
        }

        /* ------- Playlists: inventario + items (lazy) ------- */
        if (body.action === 'playlists') {
            const accountId = String(body.account_id ?? '');
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const pls = (await youtubeFetch(
                `${YOUTUBE_API}/playlists?part=snippet,contentDetails&mine=true&maxResults=50`,
                accessToken,
            )) as {
                items?: Array<{
                    id?: string;
                    snippet?: { title?: string; description?: string };
                    contentDetails?: { itemCount?: string | number };
                }>;
            };

            const playlists = [];
            for (const p of (pls.items ?? []).slice(0, PLAYLISTS_MAX)) {
                if (!p.id) continue;
                /* items del playlist: position (snippet) + videoId + título */
                const its = (await youtubeFetch(
                    `${YOUTUBE_API}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(p.id)}&maxResults=50`,
                    accessToken,
                )) as {
                    items?: Array<{
                        id?: string;
                        snippet?: { position?: number; title?: string; resourceId?: { videoId?: string } };
                        contentDetails?: { videoId?: string };
                    }>;
                };
                playlists.push({
                    id: p.id,
                    title: p.snippet?.title ?? '',
                    description: p.snippet?.description ?? '',
                    video_count: Number(p.contentDetails?.itemCount ?? 0),
                    items: (its.items ?? []).map((i) => ({
                        item_id: i.id ?? null,
                        position: Number(i.snippet?.position ?? 0),
                        video_id: i.snippet?.resourceId?.videoId ?? i.contentDetails?.videoId ?? null,
                        title: i.snippet?.title ?? '',
                    })),
                });
            }
            return respond(200, { playlists });
        }

        /* ------- Crear playlist (institucional, por defecto privada) ------- */
        if (body.action === 'playlist_create') {
            const accountId = String(body.account_id ?? '');
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            const acc = await loadAccount(supabase, accountId);
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para administrar playlists.' });
            }
            const plTitle = clip(String(body.playlist_title ?? ''), 60);
            if (!plTitle) return respond(400, { error: 'El título de la playlist es obligatorio' });
            const plDescription = clip(String(body.playlist_description ?? ''), 5000);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const created = (await youtubeFetch(
                `${YOUTUBE_API}/playlists?part=snippet,status`,
                accessToken,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        snippet: { title: plTitle, description: plDescription },
                        status: { privacyStatus: 'private' },
                    }),
                },
            )) as { id?: string };
            return respond(200, { ok: true, playlist_id: created.id ?? null });
        }

        /* ------- Agregar video a playlist (position opcional) ------- */
        if (body.action === 'playlist_item_add') {
            const accountId = String(body.account_id ?? '');
            const playlistId = clip(String(body.playlist_id ?? ''), 60);
            const videoId = clip(String(body.video_id ?? ''), 50);
            if (!accountId || !playlistId || !videoId) return respond(400, { error: 'Faltan datos' });
            const acc = await loadAccount(supabase, accountId);
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para administrar playlists.' });
            }
            const positionRaw = Number(body.position);
            const position = Number.isFinite(positionRaw) && positionRaw >= 0 ? Math.trunc(positionRaw) : null;
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const created = (await youtubeFetch(
                `${YOUTUBE_API}/playlistItems?part=snippet`,
                accessToken,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        snippet: {
                            playlistId,
                            resourceId: { kind: 'youtube#video', videoId },
                            ...(position !== null ? { position } : {}),
                        },
                    }),
                },
            )) as { id?: string };
            return respond(200, { ok: true, item_id: created.id ?? null });
        }

        /* ------- Quitar item de playlist ------- */
        if (body.action === 'playlist_item_remove') {
            const accountId = String(body.account_id ?? '');
            const itemId = clip(String(body.item_id ?? ''), 80);
            if (!accountId || !itemId) return respond(400, { error: 'Faltan datos' });
            const acc = await loadAccount(supabase, accountId);
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para administrar playlists.' });
            }
            const accessToken = await getSocialAccessToken(supabase, accountId);
            await youtubeFetch(`${YOUTUBE_API}/playlistItems?id=${encodeURIComponent(itemId)}`, accessToken, {
                method: 'DELETE',
            });
            return respond(200, { ok: true });
        }

        /* ------- Snapshot diario de views (sparklines) -------
           Idempotente: un snapshot del MISMO día reemplaza su entrada
           (nunca duplica la historia). El cliente lo dispara 1×/día. */
        if (body.action === 'snapshot') {
            const accountId = String(body.account_id ?? '');
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const ch = (await youtubeFetch(
                `${YOUTUBE_API}/channels?part=contentDetails&mine=true`,
                accessToken,
            )) as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
            const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
            if (!uploads) return respond(502, { error: 'No se encontró la playlist de uploads del canal' });

            const pl = (await youtubeFetch(
                `${YOUTUBE_API}/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=50`,
                accessToken,
            )) as { items?: Array<{ contentDetails?: { videoId?: string } }> };
            const ids = (pl.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean) as string[];
            if (!ids.length) return respond(200, { ok: true, days: 0 });

            const vids = (await youtubeFetch(
                `${YOUTUBE_API}/videos?part=statistics&id=${ids.join(',')}`,
                accessToken,
            )) as { items?: Array<{ id?: string; statistics?: { viewCount?: string } }> };
            const views: Record<string, number> = {};
            for (const v of vids.items ?? []) {
                if (v.id) views[v.id] = Number(v.statistics?.viewCount ?? 0);
            }

            const { data: row } = await supabase
                .from('app_settings')
                .select('value')
                .eq('key', HISTORY_KEY)
                .maybeSingle() as { data: { value: unknown } | null };
            let history: Array<{ d: string; v: Record<string, number> }> =
                Array.isArray(row?.value) ? (row.value as Array<{ d: string; v: Record<string, number> }>) : [];
            const today = new Date().toISOString().slice(0, 10);
            const idx = history.findIndex((e) => e?.d === today);
            if (idx >= 0) history[idx] = { d: today, v: views };
            else history.push({ d: today, v: views });
            history = history.slice(-HISTORY_MAX_DAYS);

            const { error: upErr } = await supabase
                .from('app_settings')
                .upsert(
                    { key: HISTORY_KEY, value: history, updated_at: new Date().toISOString() },
                    { onConflict: 'key' },
                );
            if (upErr) return respond(500, { error: upErr.message });
            return respond(200, { ok: true, days: history.length });
        }

        /* ------- Analytics del canal (o un video) — 28 días ------- */
        if (body.action === 'analytics') {
            const accountId = String(body.account_id ?? '');
            const videoId = clip(String(body.video_id ?? ''), 50);
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            const acc = await loadAccount(supabase, accountId);
            if (!hasAnalyticsScope(acc)) {
                return respond(403, { error: 'needs_reconnect' });
            }
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const end = new Date().toISOString().slice(0, 10);
            const start = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const params = new URLSearchParams({
                ids: 'channel==MINE',
                startDate: start,
                endDate: end,
                metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained',
            });
            if (videoId) params.set('filters', `video==${videoId}`);

            let rep: { rows?: Array<Array<string | number>> };
            try {
                rep = (await youtubeFetch(`${ANALYTICS_API}/reports?${params}`, accessToken)) as {
                    rows?: Array<Array<string | number>>;
                };
            } catch (err) {
                /* Token viejo: la conexión tiene el scope guardado pero el
                   consentimiento de Google no incluye la API — hay que
                   reconectar. Mismo contrato que el gate de arriba. */
                return respond(502, { error: 'needs_reconnect', detail: (err as Error).message.slice(0, 200) });
            }

            const r = rep.rows?.[0] ?? null;
            return respond(200, {
                range: { start, end },
                video_id: videoId || null,
                totals: r
                    ? {
                          views: Number(r[0] ?? 0),
                          watch_minutes: Number(r[1] ?? 0),
                          avg_view_seconds: Number(r[2] ?? 0),
                          subscribers_gained: Number(r[3] ?? 0),
                      }
                    : null,
            });
        }

        /* ------- Reportes de analítica (#19/#47) -------
           Un solo action con varios reportes (resumen, diario, top de
           videos, retención, tráfico y demografía). Las dimensiones y
           métricas viven en el server: el cliente no puede inventarlas
           ni pedir una consulta arbitraria a la API de Google. */
        if (body.action === 'analytics_report') {
            const accountId = String(body.account_id ?? '');
            const reportKey = clip(String(body.report ?? 'summary'), 30);
            const videoId = clip(String(body.video_id ?? ''), 50);
            const def = ANALYTICS_REPORTS[reportKey];
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            if (!def) return respond(400, { error: 'Reporte desconocido' });

            const acc = await loadAccount(supabase, accountId);
            if (!hasAnalyticsScope(acc)) {
                return respond(403, { error: 'needs_reconnect' });
            }
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const daysRaw = Number(body.days ?? 28);
            const days = Math.min(
                ANALYTICS_MAX_DAYS,
                Math.max(ANALYTICS_MIN_DAYS, Number.isFinite(daysRaw) ? Math.round(daysRaw) : 28),
            );
            const end = new Date().toISOString().slice(0, 10);
            const start = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

            const params = new URLSearchParams({
                ids: 'channel==MINE',
                startDate: start,
                endDate: end,
                metrics: def.metrics,
            });
            if (def.dimensions) params.set('dimensions', def.dimensions);
            if (def.sort) params.set('sort', def.sort);
            if (def.limit) params.set('maxResults', String(def.limit));
            if (videoId) params.set('filters', `video==${videoId}`);

            let rep: {
                columnHeaders?: Array<{ name?: string; dataType?: string }>;
                rows?: Array<Array<string | number>>;
            };
            try {
                rep = (await youtubeFetch(`${ANALYTICS_API}/reports?${params}`, accessToken)) as typeof rep;
            } catch (err) {
                /* Token viejo o sin consentimiento de la API: hay que
                   reconectar (mismo contrato que el action 'analytics'). */
                const msg = (err as Error).message || '';
                if (/401|403/.test(msg)) return respond(502, { error: 'needs_reconnect', detail: msg.slice(0, 200) });
                return respond(502, { error: 'No se pudo leer la analítica de YouTube.', detail: msg.slice(0, 200) });
            }

            const headers = (rep.columnHeaders ?? []).map((h) => ({
                key: String(h.name ?? ''),
                type: String(h.dataType ?? ''),
            }));
            const rows = (rep.rows ?? []).map((row) => {
                const obj: Record<string, string | number> = {};
                headers.forEach((h, i) => { obj[h.key] = row[i] ?? 0; });
                return obj;
            });

            /* Top de videos: los ids vienen solos (VIDEO_ID). Se traen los
               títulos con UNA llamada a videos.list (1 unidad) para que la
               tabla sea legible sin depender del inventario del cliente. */
            let titles: Record<string, string> = {};
            if (reportKey === 'top_videos') {
                const ids = rows.map((r) => String(r.video ?? '')).filter(Boolean).slice(0, 20);
                if (ids.length) {
                    try {
                        const vd = (await youtubeFetch(
                            `${YOUTUBE_API}/videos?part=snippet&id=${ids.join(',')}`,
                            accessToken,
                        )) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
                        for (const it of vd.items ?? []) {
                            if (it.id) titles[it.id] = it.snippet?.title ?? '';
                        }
                    } catch (_) {
                        /* Sin títulos la tabla sigue viva (muestra el id). */
                    }
                }
            }

            return respond(200, {
                report: reportKey,
                label: def.label,
                range: { start, end, days },
                headers,
                rows,
                titles,
            });
        }

        return respond(400, { error: 'Acción inválida' });
    } catch (err) {
        return respond(500, { error: (err as Error).message });
    }
});
