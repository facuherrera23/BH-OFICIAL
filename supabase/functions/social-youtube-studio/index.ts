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
//
// Cuota: ~5 unidades por carga del studio; updates/deletes ~50 c/u —
// muy dentro de las 10.000 diarias.
// ============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import { getSocialAccessToken } from '../_shared/social.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

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
    };
    try {
        body = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' });
    }

    try {
        if (!body.action) return respond(400, { error: 'Falta la acción' });

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

            // 1. Playlist de uploads del canal
            const ch = (await youtubeFetch(
                `${YOUTUBE_API}/channels?part=contentDetails&mine=true`,
                accessToken,
            )) as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
            const uploadsPlaylist = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
            if (!uploadsPlaylist) throw new Error('No se encontró la playlist de uploads del canal');

            // 2. Los últimos 50 uploads (incluye videos subidos manualmente)
            const pl = (await youtubeFetch(
                `${YOUTUBE_API}/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(uploadsPlaylist)}&maxResults=50`,
                accessToken,
            )) as { items?: Array<{ contentDetails?: { videoId?: string } }> };
            const ids = (pl.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean) as string[];
            if (!ids.length) return respond(200, { videos: [] });

            // 3. Detalles + estadísticas de esos videos
            const vids = (await youtubeFetch(
                `${YOUTUBE_API}/videos?part=snippet,statistics,status,contentDetails&id=${ids.join(',')}`,
                accessToken,
            )) as {
                items?: Array<{
                    id?: string;
                    snippet?: { title?: string; description?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string } }; categoryId?: string; tags?: string[] };
                    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
                    status?: { privacyStatus?: string; uploadStatus?: string };
                    contentDetails?: { duration?: string };
                }>;
            };

            return respond(200, {
                videos: (vids.items ?? []).map((v) => ({
                    id: v.id,
                    title: v.snippet?.title ?? '',
                    description: v.snippet?.description ?? '',
                    published_at: v.snippet?.publishedAt ?? null,
                    thumbnail: v.snippet?.thumbnails?.medium?.url ?? null,
                    category_id: v.snippet?.categoryId ?? '22',
                    tags: v.snippet?.tags ?? [],
                    views: Number(v.statistics?.viewCount ?? 0),
                    likes: Number(v.statistics?.likeCount ?? 0),
                    comments: Number(v.statistics?.commentCount ?? 0),
                    privacy: v.status?.privacyStatus ?? 'private',
                    duration: v.contentDetails?.duration ?? '',
                })),
                can_manage: hasManageScope(acc),
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

        return respond(400, { error: 'Acción inválida' });
    } catch (err) {
        return respond(500, { error: (err as Error).message });
    }
});
