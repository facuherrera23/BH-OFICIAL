// ============================================================
// social-instagram — Publicación y administración de Instagram.
//
// La API de Instagram requiere una URL PÚBLICAMENTE accesible
// para fotos/videos (Meta la descarga desde ahí). Estrategia:
//   - Fotos de propiedades: URLs Cloudinary ya existentes (las
//     fotos ya viven ahí para las fichas — no es contenido nuevo)
//   - Subidas desde PC: bucket temporal de Supabase Storage →
//     URL pública → IG descarga → cleanup automático post-publish
//   - El contenido termina viviendo ÚNICAMENTE en Instagram
//
// Acciones (todas requireAdmin, verify_jwt ON):
//   profile:         datos del perfil IG (username, followers, etc.)
//   media:           listado del contenido publicado
//   upload_temp:     subir imagen/video a bucket temporal → URL pública
//   create:          crear contenedor de publicación (image/video/reel)
//   publish:         publicar el contenedor (media_publish)
//   delete:          borrar un post de Instagram
//
// Flow de publicación (asincrónico):
//   1. create → devuelve creation_id (container)
//   2. El panel hace polling del status hasta FINISHED
//   3. publish → el post aparece en el feed
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

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const TEMP_BUCKET = 'social-temp';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

interface IgAccount {
    id: string;
    platform: string;
    status: string;
    display_name: string;
    avatar_url: string | null;
}

async function loadAccount(client: SupabaseClient, accountId: string): Promise<IgAccount> {
    const { data } = await client
        .from('social_accounts')
        .select('id, platform, status, display_name, avatar_url')
        .eq('id', accountId)
        .maybeSingle() as { data: IgAccount | null };
    const acc = data;
    if (!acc || acc.platform !== 'instagram') throw new Error('Cuenta de Instagram no encontrada');
    if (acc.status !== 'active') throw new Error('La cuenta está desconectada — reconectala');
    return acc;
}

function clip(s: string, max: number): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

async function graphFetch(url: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`Instagram ${res.status}: ${body}`);
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') return {};
    return res.json();
}

async function ensureTempBucket() {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some(b => b.name === TEMP_BUCKET)) {
        await supabase.storage.createBucket(TEMP_BUCKET, { public: true });
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('social-instagram', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Método no permitido' });

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });
    const { data: userData } = await supabase.auth.getUser(token);
    if (!userData?.user) return respond(401, { error: 'No autorizado' });

    let body: {
        action?: string;
        account_id?: string;
        media_id?: string;
        creation_id?: string;
        image_url?: string;
        video_url?: string;
        caption?: string;
        media_type?: string;
        file_base64?: string;
        file_type?: string;
        file_name?: string;
        temp_path?: string;
    };
    try {
        body = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' });
    }

    try {
        if (!body.action) return respond(400, { error: 'Falta la acción' });
        const accountId = String(body.account_id ?? '');

        /* ------- Perfil de Instagram ------- */
        if (body.action === 'profile') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);
            // El IG user id es el external_id guardado
            const { data: acc } = await supabase.from('social_accounts')
                .select('external_id').eq('id', accountId).maybeSingle();
            const igUserId = acc?.external_id;

            const profile = (await graphFetch(
                `${GRAPH_API}/${igUserId}?fields=username,profile_picture_url,followers_count,media_count&access_token=${accessToken}`,
            )) as Record<string, unknown>;
            return respond(200, { profile });
        }

        /* ------- Listado del contenido publicado ------- */
        if (body.action === 'media') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);
            const { data: acc } = await supabase.from('social_accounts')
                .select('external_id').eq('id', accountId).maybeSingle();
            const igUserId = acc?.external_id;

            const media = (await graphFetch(
                `${GRAPH_API}/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=50&access_token=${accessToken}`,
            )) as { data?: Array<Record<string, unknown>> };
            return respond(200, { media: media.data ?? [] });
        }

        /* ------- Subida temporal a Storage (para IG descargar) ------- */
        if (body.action === 'upload_temp') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);

            const raw = String(body.file_base64 ?? '');
            const fileType = clip(String(body.file_type ?? 'image/jpeg'), 50);
            const fileName = clip(String(body.file_name ?? 'upload'), 80).replace(/[^a-zA-Z0-9._-]/g, '_');
            if (!raw) return respond(400, { error: 'Archivo inválido' });

            const isVideo = fileType.startsWith('video/');
            const sizeBytes = raw.length * 0.75;
            if (isVideo && sizeBytes > MAX_VIDEO_BYTES) return respond(400, { error: 'El video supera 100 MB' });
            if (!isVideo && sizeBytes > MAX_IMAGE_BYTES) return respond(400, { error: 'La imagen supera 8 MB' });

            await ensureTempBucket();
            const bin = atob(raw.includes(',') ? raw.split(',')[1] : raw);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

            const path = `ig_${Date.now()}_${fileName}`;
            const { error: upErr } = await supabase.storage
                .from(TEMP_BUCKET)
                .upload(path, buf, { contentType: fileType });
            if (upErr) throw new Error(`Storage: ${upErr.message}`);

            const { data: urlData } = supabase.storage.from(TEMP_BUCKET).getPublicUrl(path);
            return respond(200, { url: urlData?.publicUrl || '', temp_path: path });
        }

        /* ------- Crear contenedor de publicación ------- */
        if (body.action === 'create') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);
            const { data: acc } = await supabase.from('social_accounts')
                .select('external_id').eq('id', accountId).maybeSingle();
            const igUserId = acc?.external_id;

            const caption = clip(String(body.caption ?? ''), 2200);
            const mediaType = ['FEED', 'REELS'].includes(String(body.media_type)) ? String(body.media_type) : 'FEED';
            const mediaUrl = clip(String(body.image_url || body.video_url || ''), 2000);

            if (!mediaUrl) return respond(400, { error: 'Falta la URL de la imagen o video' });

            const params: Record<string, string> = { caption, access_token: accessToken };
            if (mediaType === 'REELS') {
                params.video_url = mediaUrl;
                params.media_type = 'REELS';
            } else {
                params.image_url = mediaUrl;
            }

            const created = (await graphFetch(`${GRAPH_API}/${igUserId}/media`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params),
            })) as { id?: string };
            if (!created.id) throw new Error('Instagram no devolvió el ID del contenedor');

            return respond(200, { creation_id: created.id });
        }

        /* ------- Publicar (después de que el contenedor esté listo) ------- */
        if (body.action === 'publish') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);
            const { data: acc } = await supabase.from('social_accounts')
                .select('external_id').eq('id', accountId).maybeSingle();
            const igUserId = acc?.external_id;

            const creationId = clip(String(body.creation_id ?? ''), 100);
            if (!creationId) return respond(400, { error: 'Falta el ID del contenedor' });

            const published = (await graphFetch(`${GRAPH_API}/${igUserId}/media_publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ creation_id: creationId, access_token: accessToken }),
            })) as { id?: string };
            if (!published.id) throw new Error('Instagram no devolvió el ID del post');

            return respond(200, { media_id: published.id });
        }

        /* ------- Borrar post de Instagram ------- */
        if (body.action === 'delete') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const mediaId = clip(String(body.media_id ?? ''), 100);
            if (!mediaId) return respond(400, { error: 'Falta el ID del post' });

            await graphFetch(`${GRAPH_API}/${mediaId}?access_token=${accessToken}`, { method: 'DELETE' });
            return respond(200, { ok: true });
        }

        /* ------- Cleanup: borrar archivo temporal ------- */
        if (body.action === 'cleanup_temp') {
            const path = clip(String(body.temp_path || ''), 200);
            if (path) {
                await supabase.storage.from(TEMP_BUCKET).remove([path]);
            }
            return respond(200, { ok: true });
        }

        return respond(400, { error: 'Acción inválida' });
    } catch (err) {
        return respond(500, { error: (err as Error).message });
    }
});
