// ============================================================
// social-facebook — Publicación y administración de Facebook.
//
// La API de Facebook publica en PÁGINAS (no en perfiles personales).
// Estrategia (misma decisión que Instagram — el contenido termina
// viviendo ÚNICAMENTE en Facebook):
//   - Fotos de propiedades: URLs Cloudinary ya existentes (FB las
//     descarga desde ahí — no es contenido nuevo)
//   - Subidas desde PC: bucket temporal de Supabase Storage →
//     URL pública → FB la descarga → cleanup automático post-publish
//   - Videos: el server descarga los bytes de la URL y los sube
//     con multipart DIRECTO a /{page-id}/videos (sin file_url)
//
// Diferencia clave con Instagram: la FOTO es sincrónica —
// POST /{page-id}/photos devuelve el id del post directo y no hay
// que crear contenedor ni hacer poll. El VIDEO se sube y después
// entra en procesamiento (poll de status hasta ready).
//
// Acciones (todas requireAdmin, verify_jwt ON):
//   profile:         datos de la página (name, followers, picture)
//   upload_temp:     subir imagen/video a bucket temporal → URL pública
//   create:          foto → POST photos (sync, post_id) |
//                    video → POST videos multipart (video_id + poll)
//   status:          poll del video (status_code FINISHED/ERROR/IN_PROGRESS)
//   media_info:      permalink_url del post publicado
//   delete:          borrar el post de Facebook de verdad
//   cleanup_temp:    borrar archivo temporal
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
/* 50 MB y no más: el archivo viaja base64 en el body del request (~1.33×) y
   el decode pico usa ~2.5× el binario (string base64 + bin + buffer) — con el
   límite de 256 MB de memoria por request de las Edge Functions, un video de
   100 MB reventaba por OOM antes de decodificar. 50 MB deja margen cómodo
   (pico ~160 MB) y coincide con el tope por archivo del bucket Storage free. */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
// FB acepta captions muy largos (63k) — el form del panel es más estricto.
const MAX_CAPTION_CHARS = 63206;

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

interface FbAccount {
    id: string;
    platform: string;
    status: string;
    display_name: string;
    avatar_url: string | null;
}

async function loadAccount(client: SupabaseClient, accountId: string): Promise<FbAccount> {
    const { data } = await client
        .from('social_accounts')
        .select('id, platform, status, display_name, avatar_url')
        .eq('id', accountId)
        .maybeSingle() as { data: FbAccount | null };
    const acc = data;
    if (!acc || acc.platform !== 'facebook') throw new Error('Cuenta de Facebook no encontrada');
    if (acc.status !== 'active') throw new Error('La cuenta está desconectada — reconectala');
    return acc;
}

function clip(s: string, max: number): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

/* FB responde los errores como JSON {"error":{"message","code",...}} —
   mostrar el JSON crudo no le dice nada al usuario. code 190 = token
   inválido (password cambiada / app desautorizada): la acción es
   reconectar la página. */
function friendlyGraphError(status: number, raw: string): string {
    let msg = '';
    let code = 0;
    try {
        const json = JSON.parse(raw) as { error?: { message?: string; code?: number } };
        msg = json.error?.message || '';
        code = json.error?.code || 0;
    } catch {
        msg = raw.slice(0, 200);
    }
    if (!msg) msg = `HTTP ${status}`;
    if (code === 190) {
        return `El token de la página ya no es válido (cambiaste la password de Meta o desautorizaste la app) — desconectá y volvé a conectar la página. (${msg.slice(0, 160)})`;
    }
    return `Facebook ${status}: ${msg.slice(0, 200)}`;
}

async function graphFetch(url: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const raw = (await res.text()).slice(0, 2000);
        throw new Error(friendlyGraphError(res.status, raw));
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

    const rl = await rateLimitMiddleware('social-facebook', req);
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
        video_id?: string;
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

        /* ------- Datos de la página ------- */
        if (body.action === 'profile') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);
            const { data: acc } = await supabase.from('social_accounts')
                .select('external_id').eq('id', accountId).maybeSingle();
            const pageId = acc?.external_id;

            const profile = (await graphFetch(
                `${GRAPH_API}/${pageId}?fields=name,fan_count,followers_count,picture&access_token=${accessToken}`,
            )) as Record<string, unknown>;
            return respond(200, { profile });
        }

        /* ------- Subida temporal a Storage (para FB descargar) ------- */
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
            await cleanupTempOrphans('fb_');
            const bin = atob(raw.includes(',') ? raw.split(',')[1] : raw);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

            const path = `fb_${Date.now()}_${fileName}`;
            const { error: upErr } = await supabase.storage
                .from(TEMP_BUCKET)
                .upload(path, buf, { contentType: fileType });
            if (upErr) throw new Error(`Storage: ${upErr.message}`);

            const { data: urlData } = supabase.storage.from(TEMP_BUCKET).getPublicUrl(path);
            return respond(200, { url: urlData?.publicUrl || '', temp_path: path });
        }

        /* ------- Publicar (foto sincrónica | video con procesamiento) ------- */
        if (body.action === 'create') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);
            const { data: acc } = await supabase.from('social_accounts')
                .select('external_id').eq('id', accountId).maybeSingle();
            const pageId = acc?.external_id;

            const caption = clip(String(body.caption ?? ''), MAX_CAPTION_CHARS);
            const mediaType = String(body.media_type) === 'video' ? 'video' : 'photo';
            const mediaUrl = clip(String(body.image_url || body.video_url || ''), 2000);
            if (!mediaUrl) return respond(400, { error: 'Falta la URL de la imagen o video' });

            if (mediaType === 'photo') {
                // Sincrónico: FB devuelve el id (y post_id si ya está en el feed).
                // published:true explícito — post al feed de la página (el default
                // es true, lo fijamos para que no dependa de la versión de la API).
                const created = (await graphFetch(`${GRAPH_API}/${pageId}/photos`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        url: mediaUrl,
                        caption,
                        published: 'true',
                        access_token: accessToken,
                    }),
                })) as { id?: string; post_id?: string };
                if (!created.id) throw new Error('Facebook no devolvió el ID de la foto');
                return respond(200, {
                    media_id: created.post_id || created.id,
                    done: true,
                });
            }

            // Video: el server descarga los bytes y los reenvía con multipart
            // directo al endpoint de FB (sin file_url — decisión del dueño).
            const mediaRes = await fetch(mediaUrl);
            if (!mediaRes.ok) {
                throw new Error(`No se pudo descargar el video (${mediaRes.status}) para subirlo a Facebook`);
            }
            // Guard antes de buffer: si el origen ya declara que pesa más que el
            // tope, fallar sin cargar el archivo en memoria del edge function.
            const declared = Number(mediaRes.headers.get('content-length') || 0);
            if (declared && declared > MAX_VIDEO_BYTES) {
                throw new Error('El video supera 50 MB');
            }
            const blob = await mediaRes.blob();
            // Segundo guard: origen sin content-length (chunked) — el buffer
            // puede superar el tope igual.
            if (blob.size > MAX_VIDEO_BYTES) throw new Error('El video supera 50 MB');
            const form = new FormData();
            form.append('source', blob, 'video.mp4');
            form.append('description', caption);
            form.append('access_token', accessToken);
            const created = (await graphFetch(`${GRAPH_API}/${pageId}/videos`, {
                method: 'POST',
                body: form,
            })) as { id?: string };
            if (!created.id) throw new Error('Facebook no devolvió el ID del video');
            return respond(200, { video_id: created.id });
        }

        /* ------- Estado del video en procesamiento (poll del panel) ------- */
        if (body.action === 'status') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const videoId = clip(String(body.video_id ?? ''), 100);
            if (!videoId) return respond(400, { error: 'Falta el ID del video' });

            const st = (await graphFetch(
                `${GRAPH_API}/${videoId}?fields=status&access_token=${accessToken}`,
            )) as { status?: Record<string, unknown> | null };
            /* Tolerante: la forma del objeto status cambió entre versiones de
               la API (video_status / value) y el error puede venir en el nivel
               superior o dentro de una phase (uploading/processing/publishing).
               'ready'-like → FINISHED, con error (arriba o en phase) → ERROR,
               resto → IN_PROGRESS. */
            const s = st.status || {};
            const val = String(s.video_status ?? s.value ?? '').toLowerCase();
            const phases = [s.uploading_phase, s.processing_phase, s.publishing_phase] as Array<Record<string, unknown> | undefined>;
            const phaseError = phases.find((p) => p && String(p.status ?? '').toLowerCase() === 'error');
            const msg = (s.error_message as string) || (s.error_description as string) ||
                ((phaseError?.error_message || phaseError?.error_description) as string) || null;
            let status_code = 'IN_PROGRESS';
            if (['ready', 'done', 'finished', 'complete', 'processed'].indexOf(val) >= 0) status_code = 'FINISHED';
            else if (['error', 'errored', 'failed'].indexOf(val) >= 0 || phaseError) status_code = 'ERROR';
            return respond(200, { status_code, error: msg });
        }

        /* ------- Permalink del post publicado (para el CRM) ------- */
        if (body.action === 'media_info') {
            if (!accountId) return respond(400, { error: 'Falta la cuenta' });
            await loadAccount(supabase, accountId);
            const accessToken = await getSocialAccessToken(supabase, accountId);

            const mediaId = clip(String(body.media_id ?? ''), 100);
            if (!mediaId) return respond(400, { error: 'Falta el ID del post' });

            const info = (await graphFetch(
                `${GRAPH_API}/${mediaId}?fields=permalink_url,link,message&access_token=${accessToken}`,
            )) as Record<string, unknown>;
            /* Los POSTS tienen permalink_url; las FOTOS tienen link (si create
               devolvió solo el id de la foto sin post_id, el fallback salva). */
            return respond(200, { media_info: info });
        }

        /* ------- Borrar post de Facebook de verdad ------- */
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
