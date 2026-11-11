// ============================================================
// social-tiktok — Publicación en TikTok (Content Posting API).
//
// Diferencias clave con Facebook/Instagram:
//   - El access token vive 2h: getSocialAccessToken (_shared/social.ts)
//     refresca automáticamente (<5 min) y persiste el refresh token
//     ROTADO que TikTok devuelve en cada refresh.
//   - El VIDEO va por FILE_UPLOAD: el server descarga los bytes de la
//     URL temporal/Cloudinary y los sube con PUT directo al upload_url
//     que TikTok devuelve (chunks: ≤50 MB ⇒ 1 chunk, permitido — el
//     chunk final puede pesar hasta 128 MB). Sin file_url ni
//     URL pública propia (decisión del dueño — mismo patrón FB/IG).
//   - La FOTO SOLO acepta PULL_FROM_URL (limitación de la API): TikTok
//     descarga la imagen desde la URL Cloudinary ya existente —
//     requiere el dominio verificado en la app de TikTok
//     (error url_ownership_unverified si falta).
//   - NO existe endpoint para borrar posts: el delete del panel no
//     aplica para TikTok (la fila del historial se borra a mano).
//   - Posts de clientes NO auditados (app sin auditoría de Content
//     Posting API) solo pueden publicarse PRIVADOS — TikTok los
//     bloquea con unaudited_client_can_only_post_to_private_accounts.
//     El post_id público solo llega cuando el post pasa moderación.
//
// Acciones (todas requireAdmin, verify_jwt ON):
//   profile:      datos del usuario (display_name, avatar)
//   upload_temp:  subir imagen/video al bucket temporal → URL pública
//   create:       foto → /post/publish/content/init (PULL_FROM_URL) |
//                 video → /post/publish/video/init (FILE_UPLOAD 1 chunk)
//                 + PUT del binario al upload_url → publish_id
//   status:       poll /post/publish/status/fetch → FINISHED/ERROR/IN_PROGRESS
//   media_info:   permalink best-effort (necesita username del perfil)
//   cleanup_temp: borrar archivo temporal
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

const API_BASE = 'https://open.tiktokapis.com/v2';
const TEMP_BUCKET = 'social-temp';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/* 50 MB y no más: el archivo viaja base64 en el body del request (~1.33×) y
   el decode pico usa ~2.5× el binario — con el límite de 256 MB de memoria
   por request de las Edge Functions, más grande reventaba por OOM (misma
   física que FB/IG). 50 MB ⇒ 1 solo chunk (el chunk final puede pesar hasta
   128 MB según la Media Transfer Guide de TikTok). */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/* ------- Cleanup de huérfanos en social-temp -------
   Si el browser muere entre upload_temp y cleanup_temp, el archivo
   queda huérfano para siempre (el contenido vive en la red destino —
   el bucket es SOLO puente). En cada subida limpiamos los PROPIOS con
   más de 24h: prefijo propio del server (fb_/ig_/tt_) para no pisar
   archivos de los otros flujos en vuelo. Máx 20 por llamada,
   best-effort: jamás rompe la subida que lo disparó. */
async function cleanupTempOrphans(prefix: string): Promise<void> {
    try {
        const { data: files, error } = await supabase.storage
            .from(TEMP_BUCKET)
            .list('', { limit: 100, sortBy: { column: 'created_at', order: 'asc' } });
        if (error || !Array.isArray(files)) return;
        const cutoff = Date.now() - 24 * 3600 * 1000;
        let removed = 0;
        for (const f of files) {
            if (removed >= 20) break;
            if (!String(f.name ?? '').startsWith(prefix)) continue;
            const t = Date.parse(String((f as { created_at?: string }).created_at ?? ''));
            if (!isFinite(t)) continue;
            if (t > cutoff) break; // orden asc: todo lo que sigue es más nuevo
            const { error: delErr } = await supabase.storage.from(TEMP_BUCKET).remove([f.name]);
            if (!delErr) removed++;
        }
        if (removed) console.log(`[contenido] cleanup social-temp (${prefix}): ${removed} eliminados`);
    } catch (_) { /* best-effort */ }
}
/* Límites reales de TikTok (UTF-16 runes): título de FOTO ≤90, descripción
   de FOTO ≤4000, título (caption) de VIDEO ≤2200. */
const MAX_PHOTO_TITLE = 90;
const MAX_PHOTO_DESC = 4000;
const MAX_VIDEO_TITLE = 2200;

const PRIVACY_LEVELS = ['SELF_ONLY', 'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS'];

interface TtAccount {
    id: string;
    platform: string;
    status: string;
    display_name: string;
    avatar_url: string | null;
}

async function loadAccount(client: SupabaseClient, accountId: string): Promise<TtAccount> {
    const { data } = await client
        .from('social_accounts')
        .select('id, platform, status, display_name, avatar_url')
        .eq('id', accountId)
        .maybeSingle() as { data: TtAccount | null };
    const acc = data;
    if (!acc || acc.platform !== 'tiktok') throw new Error('Cuenta de TikTok no encontrada');
    if (acc.status !== 'active') throw new Error('La cuenta está desconectada — reconectala');
    return acc;
}

function clip(s: string, max: number): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

/* TikTok (Content Posting API) responde los errores como
   {"error":{"code":"...","message":"...","logid":"..."}} — el code es STRING.
   Mostrar el JSON crudo no le dice nada al usuario; los códigos frecuentes
   se traducen a la acción concreta que resuelve el problema. */
function friendlyTikTokError(status: number, raw: string): string {
    let code = '';
    let msg = '';
    try {
        const json = JSON.parse(raw) as { error?: { code?: string; message?: string } };
        code = json.error?.code || '';
        msg = json.error?.message || '';
    } catch {
        msg = raw.slice(0, 200);
    }
    if (!msg) msg = `HTTP ${status}`;
    if (code === 'unaudited_client_can_only_post_to_private_accounts') {
        return `TikTok solo permite posts PRIVADOS hasta que la app pase la auditoría de Content Posting API — elegí "Solo yo" en privacidad. (${msg.slice(0, 160)})`;
    }
    if (code === 'url_ownership_unverified') {
        return `El dominio de la foto no está verificado en la app de TikTok (Content Posting API → Verified Domains): agregá el dominio de Cloudinary y probá de nuevo. (${msg.slice(0, 160)})`;
    }
    if (code === 'access_token_invalid') {
        return `El token de TikTok no es válido — desconectá y volvé a conectar la cuenta. (${msg.slice(0, 160)})`;
    }
    if (code === 'scope_not_authorized') {
        return `La app de TikTok no tiene el permiso de publicación (scope video.publish / Content Posting API). (${msg.slice(0, 160)})`;
    }
    if (code === 'rate_limit_exceeded') {
        return `TikTok alcanzó el límite de publicaciones por minuto — esperá un minuto y volvé a intentar. (${msg.slice(0, 160)})`;
    }
    if (code === 'spam_risk_too_many_posts' || code === 'spam_risk_too_many_pending_share') {
        return `TikTok bloqueó la publicación por límite diario de posts (máx 5 pendientes en 24 h) — esperá o publicá desde la app de TikTok. (${msg.slice(0, 160)})`;
    }
    return `TikTok ${status}: ${code ? `${code} — ` : ''}${msg.slice(0, 200)}`;
}

async function ttFetch(url: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const raw = (await res.text()).slice(0, 2000);
        throw new Error(friendlyTikTokError(res.status, raw));
    }
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    /* TikTok responde 200 con error en el body: {"error":{"code","message"}}.
       code != 'ok' ⇒ tratarlo como fallo con el mensaje traducido. */
    const err = json.error as { code?: string; message?: string } | undefined;
    if (err && err.code && err.code !== 'ok') {
        throw new Error(friendlyTikTokError(200, JSON.stringify({ error: err })));
    }
    return json;
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

    const rl = await rateLimitMiddleware('social-tiktok', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Método no permitido' });

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });
    const { data: userData } = await supabase.auth.getUser(token);
    if (!userData?.user) return respond(401, { error: 'No autorizado' });

    let body: {
        action?: string;
        account_id?: string;
        publish_id?: string;
        post_id?: string;
        image_url?: string;
        video_url?: string;
        caption?: string;
        media_type?: string;
        privacy_level?: string;
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

        /* ------- Datos del usuario ------- */
        if (body.action === 'profile') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);
            const profile = (await ttFetch(
                `${API_BASE}/user/info/?fields=open_id,union_id,display_name,avatar_url&access_token=${accessToken}`,
            )) as { data?: { user?: Record<string, unknown> } };
            return respond(200, { profile: profile.data?.user ?? {} });
        }

        /* ------- Subida temporal a Storage (para TikTok/Cloudinary) ------- */
        if (body.action === 'upload_temp') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);

            const raw = String(body.file_base64 ?? '');
            const fileType = clip(String(body.file_type ?? 'image/jpeg'), 50);
            const fileName = clip(String(body.file_name ?? 'upload'), 80).replace(/[^a-zA-Z0-9._-]/g, '_');
            if (!raw) return respond(400, { error: 'Archivo inválido' });

            const isVideo = fileType.startsWith('video/');
            const sizeBytes = raw.length * 0.75;
            if (isVideo && sizeBytes > MAX_VIDEO_BYTES) return respond(400, { error: 'El video supera 50 MB' });
            if (!isVideo && sizeBytes > MAX_IMAGE_BYTES) return respond(400, { error: 'La imagen supera 8 MB' });

            await ensureTempBucket();
            await cleanupTempOrphans('tt_');
            const bin = atob(raw.includes(',') ? raw.split(',')[1] : raw);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

            const path = `tt_${Date.now()}_${fileName}`;
            const { error: upErr } = await supabase.storage
                .from(TEMP_BUCKET)
                .upload(path, buf, { contentType: fileType });
            if (upErr) throw new Error(`Storage: ${upErr.message}`);

            const { data: urlData } = supabase.storage.from(TEMP_BUCKET).getPublicUrl(path);
            return respond(200, { url: urlData?.publicUrl || '', temp_path: path });
        }

        /* ------- Publicar (foto PULL_FROM_URL | video FILE_UPLOAD) ------- */
        if (body.action === 'create') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const caption = clip(String(body.caption ?? ''), Math.max(MAX_VIDEO_TITLE, MAX_PHOTO_DESC));
            const mediaType = String(body.media_type) === 'video' ? 'video' : 'photo';
            const mediaUrl = clip(String(body.image_url || body.video_url || ''), 2000);
            if (!mediaUrl) return respond(400, { error: 'Falta la URL de la imagen o video' });

            /* Privacidad: whitelist de TikTok. Default SELF_ONLY — los posts
               de apps sin auditar SOLO pueden ir privados, y es el valor
               seguro mientras la app no pase la auditoría. */
            const privacy = PRIVACY_LEVELS.indexOf(String(body.privacy_level ?? '')) >= 0
                ? String(body.privacy_level)
                : 'SELF_ONLY';

            /* brand_organic_toggle true: el post promociona el propio negocio
               (la inmobiliaria publica su contenido). brand_content_toggle
               false: NO es paid partnership con un tercero. */
            const postInfo: Record<string, unknown> = {
                privacy_level: privacy,
                brand_organic_toggle: true,
                brand_content_toggle: false,
                disable_comment: false,
            };
            let publishId = '';

            if (mediaType === 'photo') {
                /* La FOTO SOLO acepta PULL_FROM_URL: TikTok descarga la imagen
                   desde la URL (Cloudinary o bucket temporal). Requiere el
                   dominio verificado en la app (url_ownership_unverified). */
                postInfo.title = caption.slice(0, MAX_PHOTO_TITLE);
                postInfo.description = caption.slice(0, MAX_PHOTO_DESC);
                postInfo.auto_add_music = false;
                const created = (await ttFetch(`${API_BASE}/post/publish/content/init/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                    body: JSON.stringify({
                        post_info: postInfo,
                        post_mode: 'DIRECT_POST',
                        media_type: 'PHOTO',
                        source_info: {
                            source: 'PULL_FROM_URL',
                            photo_images: [mediaUrl],
                            photo_cover_index: 0,
                        },
                    }),
                })) as { data?: { publish_id?: string } };
                publishId = created.data?.publish_id || '';
                if (!publishId) throw new Error('TikTok no devolvió el publish_id de la foto');
                return respond(200, { publish_id: publishId });
            }

            /* VIDEO: FILE_UPLOAD. El server descarga los bytes y los sube con
               PUT directo al upload_url de TikTok (chunks: ≤50 MB ⇒ 1 chunk,
               con Content-Range completo). Sin file_url (decisión del dueño). */
            postInfo.title = caption.slice(0, MAX_VIDEO_TITLE);
            postInfo.disable_duet = false;
            postInfo.disable_stitch = false;
            const mediaRes = await fetch(mediaUrl);
            if (!mediaRes.ok) {
                throw new Error(`No se pudo descargar el video (${mediaRes.status}) para subirlo a TikTok`);
            }
            // Guard antes de buffer: fallar sin cargar el archivo en memoria.
            const declared = Number(mediaRes.headers.get('content-length') || 0);
            if (declared && declared > MAX_VIDEO_BYTES) {
                throw new Error('El video supera 50 MB');
            }
            const blob = await mediaRes.blob();
            // Segundo guard: origen sin content-length (chunked).
            if (blob.size > MAX_VIDEO_BYTES) throw new Error('El video supera 50 MB');
            const size = blob.size;

            const init = (await ttFetch(`${API_BASE}/post/publish/video/init/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({
                    post_info: postInfo,
                    source_info: {
                        source: 'FILE_UPLOAD',
                        video_size: size,
                        chunk_size: size,
                        total_chunk_count: 1,
                    },
                }),
            })) as { data?: { publish_id?: string; upload_url?: string } };
            publishId = init.data?.publish_id || '';
            const uploadUrl = init.data?.upload_url || '';
            if (!publishId || !uploadUrl) throw new Error('TikTok no devolvió el upload_url del video');

            /* PUT del binario a TikTok: la upload_url es firmada (sin auth
               header). Content-Range completo 0-{size-1}/{size}. */
            const putRes = await fetch(uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': blob.type && blob.type.startsWith('video/') ? blob.type : 'video/mp4',
                    'Content-Length': String(size),
                    'Content-Range': `bytes 0-${size - 1}/${size}`,
                },
                body: blob,
            });
            if (!putRes.ok) {
                const raw = (await putRes.text()).slice(0, 200);
                throw new Error(`TikTok rechazó la subida del video (${putRes.status}): ${raw}`);
            }
            return respond(200, { publish_id: publishId });
        }

        /* ------- Estado del post (poll del panel) ------- */
        if (body.action === 'status') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const publishId = clip(String(body.publish_id ?? ''), 100);
            if (!publishId) return respond(400, { error: 'Falta el publish_id' });

            const st = (await ttFetch(`${API_BASE}/post/publish/status/fetch/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ publish_id: publishId }),
            })) as { data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: string[] } };
            /* Normalizo a los mismos status_code que FB/IG. El post_id público
               solo llega si el post es público Y pasó moderación (los privados
               no tienen post_id — TikTok no lo entrega). 'publicaly_available'
               es el typo REAL del campo en la API de TikTok. */
            const stData = st.data || {};
            let status_code = 'IN_PROGRESS';
            let error: string | null = null;
            if (stData.status === 'PUBLISH_COMPLETE') status_code = 'FINISHED';
            else if (stData.status === 'FAILED') {
                status_code = 'ERROR';
                error = stData.fail_reason || 'TikTok rechazó la publicación';
            }
            return respond(200, {
                status_code,
                error,
                post_ids: stData.publicaly_available_post_id ?? [],
            });
        }

        /* ------- Permalink best-effort (necesita username del perfil) ------- */
        if (body.action === 'media_info') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const postId = clip(String(body.post_id ?? ''), 100);
            if (!postId) return respond(400, { error: 'Falta el ID del post' });

            /* TikTok NO tiene endpoint para leer un post: el link canónico se
               arma con el username del perfil + el post_id. username es un
               campo opcional del user info — si la API lo rechaza, reintenta
               sin él (permalink queda vacío, no bloquea la publicación). */
            let username = '';
            try {
                const u = (await ttFetch(
                    `${API_BASE}/user/info/?fields=open_id,username,display_name,avatar_url&access_token=${accessToken}`,
                )) as { data?: { user?: { username?: string } } };
                username = u.data?.user?.username || '';
            } catch (_) {
                try {
                    const u = (await ttFetch(
                        `${API_BASE}/user/info/?fields=open_id,display_name,avatar_url&access_token=${accessToken}`,
                    )) as { data?: { user?: { username?: string } } };
                    username = u.data?.user?.username || '';
                } catch (_) { /* best-effort: sin permalink */ }
            }
            const permalink = username ? `https://www.tiktok.com/@${username}/video/${postId}` : '';
            return respond(200, { media_info: { permalink, post_id: postId } });
        }

        /* ------- Cleanup: borrar archivo temporal ------- */
        if (body.action === 'cleanup_temp') {
            const path = clip(String(body.temp_path || ''), 200);
            if (path) {
                await supabase.storage.from(TEMP_BUCKET).remove([path]);
            }
            return respond(200, { ok: true });
        }

        /* TikTok NO tiene endpoint para borrar posts publicados — la acción
           delete NO existe a propósito (a diferencia de FB/IG). */
        return respond(400, { error: 'Acción inválida' });
    } catch (err) {
        return respond(500, { error: (err as Error).message });
    }
});
