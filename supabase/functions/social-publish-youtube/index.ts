// ============================================================
// social-publish-youtube — Publicación de videos a YouTube.
//
// El video NUNCA pasa por Supabase (límites de payload): 
//   1. init:    valida admin + token, crea el registro en social_posts
//               y una sesión de subida reanudable en Google
//               (uploadType=resumable) → devuelve {post_id, session_url}
//   2. (navegador) PUT del archivo DIRECTO a Google con la session_url
//               pre-autorizada — sin exposición del token, sin storage
//   3. complete: verifica el video (videos.list), marca published con
//               su URL; fail: marca el error del upload.
//
// Cuota Google: 10.000 unidades/día (upload ≈1.600 → ~6 videos).
// Requiere admin; verify_jwt ON (solo panel).
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import { getSocialAccessToken } from '../_shared/social.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (límite práctico v1: un PUT)
const PRIVACY = ['public', 'unlisted', 'private'] as const;
type Privacy = (typeof PRIVACY)[number];

/* Límites reales de la API de YouTube (videos.insert). */
const YT_TITLE_MAX = 100;
const YT_DESC_MAX = 5000;
const YT_TAGS_CHARS_MAX = 480;
const YT_QUOTA_UPLOAD = 1600; // unidades de cuota que consume una subida
const DEFAULT_CATEGORY = '22';

function clip(s: string, max: number): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

/** Categoría válida de YouTube (1..30). Cualquier otra cae al default. */
function normalizeCategory(raw: unknown): string {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 30) return DEFAULT_CATEGORY;
    return String(n);
}

/** Elige el comportamiento de los flags de publicación. */
function normalizeFlags(body: {
    embeddable?: unknown;
    made_for_kids?: unknown;
    license?: unknown;
    notify_subscribers?: unknown;
}): { embeddable: boolean; madeForKids: boolean; license: string; notifySubscribers: boolean } {
    return {
        /* embeddable=true permite incrustar el video en la ficha y en otros
           sitios (youtube-nocookie). Con false, YouTube bloquea el embed. */
        embeddable: body.embeddable === undefined ? true : body.embeddable !== false,
        madeForKids: body.made_for_kids === true,
        license: body.license === 'creativeCommon' ? 'creativeCommon' : 'youtube',
        notifySubscribers: body.notify_subscribers === undefined ? true : body.notify_subscribers !== false,
    };
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('social-publish-youtube', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Método no permitido' });

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });
    const { data: userData } = await supabase.auth.getUser(token);
    const adminId = userData?.user?.id;
    if (!adminId) return respond(401, { error: 'No autorizado' });

    let body: {
        action?: string;
        post_id?: string;
        account_id?: string;
        title?: string;
        description?: string;
        tags?: string[] | string;
        privacy?: string;
        file_size?: number;
        file_type?: string;
        property_id?: string;
        video_id?: string;
        upload_error?: string;
        publish_at?: string;
        keyword?: string;
        seo_score?: number;
        category_id?: string | number;
        embeddable?: boolean;
        made_for_kids?: boolean;
        license?: string;
        notify_subscribers?: boolean;
        draft?: boolean;
    };
    try {
        body = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' });
    }

    try {
        /* ------- 1. init: sesión de subida ------- */
        if (body.action === 'init') {
            const accountId = String(body.account_id ?? '');
            const title = clip(String(body.title ?? ''), 100);
            const description = clip(String(body.description ?? ''), 5000);
            const privacy = (PRIVACY as readonly string[]).includes(String(body.privacy ?? 'public'))
                ? (String(body.privacy) as Privacy)
                : 'public';
            const fileSize = Number(body.file_size ?? 0);
            const fileType = clip(String(body.file_type ?? 'video/mp4'), 100);

            if (!accountId) return respond(400, { error: 'Falta la cuenta de YouTube' });
            if (!title) return respond(400, { error: 'El título es obligatorio' });
            if (!fileSize || fileSize < 1024) return respond(400, { error: 'Archivo de video inválido' });
            if (fileSize > MAX_FILE_BYTES) {
                return respond(400, { error: 'El video supera el máximo de 2 GB' });
            }
            // tags: string "a,b,c" → array (límite YT: 500 chars en total)
            let tags: string[] = [];
            if (typeof body.tags === 'string') {
                tags = body.tags.split(',').map((t) => clip(t, 60)).filter(Boolean);
            } else if (Array.isArray(body.tags)) {
                tags = body.tags.map((t) => clip(String(t), 60)).filter(Boolean);
            }
            /* MEJORA 2026-10-30: el recorte viejo (slice(0,3)) destruyó tags en
               silencio ante cualquier excedente — ahora se recorta DESDE EL FINAL
               hasta respetar los ~480 chars que acepta YouTube. Cada tag sale por
               clip(), así que nunca queda solo 1 tag por el límite. */
            while (tags.length > 1 && tags.join(',').length > 480) tags.pop();

            const propertyId = typeof body.property_id === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.property_id)
                ? body.property_id
                : null;

            /* Programación nativa de YouTube: publishAt solo con privacy=private
               — YouTube lo pasa a público automáticamente en ese momento. */
            let publishAtIso: string | undefined;
            if (body.publish_at) {
                const d = new Date(String(body.publish_at));
                if (isNaN(d.getTime()) || d.getTime() < Date.now() + 5 * 60_000) {
                    return respond(400, { error: 'La fecha de programación debe ser futura (mínimo 5 minutos).' });
                }
                publishAtIso = d.toISOString();
            }

            /* MEJORA #18: snapshot del score SEO de vidIQ en el momento de
               publicar — el studio luego calcula la evolución (delta) contra él. */
            const seoScore = Number(body.seo_score);
            const seoScoreOk = Number.isFinite(seoScore) && seoScore >= 0 && seoScore <= 100
                ? Math.round(seoScore)
                : null;

            const { data: acc } = await supabase
                .from('social_accounts')
                .select('id, platform, status')
                .eq('id', accountId)
                .maybeSingle();
            if (!acc || acc.platform !== 'youtube') return respond(404, { error: 'Cuenta de YouTube no encontrada' });
            if (acc.status !== 'active') return respond(400, { error: 'La cuenta está desconectada — reconectala' });

            const accessToken = await getSocialAccessToken(supabase, accountId);

            /* REPARACIÓN 2026-10-30: la keyword y la fecha de programación
               NO se guardaban → al copiar/reintentar desde el historial se
               perdían (y el reintento salía sin tour en la ficha). Ahora
               viven en social_posts.content (JSONB, sin migración). */
            const keyword = clip(String(body.keyword ?? ''), 100);

            /* MEJORA 2026-10-30 (lote 50 mejoras): la categoría, los flags de
               publicación y el modo borrador ya no están hardcodeados.
               - category_id: la real de YouTube (22 = People & Blogs).
               - embeddable: si es false, YouTube bloquea el embed → las
                 fichas NO podrían mostrar el tour.
               - license: 'youtube' | 'creativeCommon'.
               - notify_subscribers: avisar al canal en la publicación.
               - draft: publica en privado y deja el post como borrador
                 (luego se promueve con social-youtube-studio). */
            const categoryId = normalizeCategory(body.category_id);
            const flags = normalizeFlags(body);
            const isDraft = body.draft === true;

            // Post en 'publishing' ANTES de crear la sesión (queda traza aunque el PUT falle)
            const { data: post, error: postErr } = await supabase
                .from('social_posts')
                .insert({
                    account_id: accountId,
                    platform: 'youtube',
                    property_id: propertyId,
                    post_type: 'video',
                    content: {
                        title,
                        description,
                        tags,
                        privacy,
                        category_id: categoryId,
                        embeddable: flags.embeddable,
                        made_for_kids: flags.madeForKids,
                        license: flags.license,
                        notify_subscribers: flags.notifySubscribers,
                        ...(isDraft ? { draft: true } : {}),
                        ...(keyword ? { keyword } : {}),
                        ...(publishAtIso ? { publish_at: publishAtIso } : {}),
                        ...(seoScoreOk !== null ? { seo_score: seoScoreOk } : {}),
                    },
                    status: 'publishing',
                    created_by: adminId,
                })
                .select('id')
                .single();
            if (postErr || !post) return respond(500, { error: postErr?.message ?? 'No se pudo crear el registro' });

            // Sesión reanudable de Google (con programación si se pidió)
            const statusPayload: Record<string, unknown> = {
                privacyStatus: publishAtIso ? 'private' : privacy,
                selfDeclaredMadeForKids: flags.madeForKids,
                embeddable: flags.embeddable,
                license: flags.license,
                notifySubscribers: flags.notifySubscribers,
            };
            if (publishAtIso) statusPayload.publishAt = publishAtIso;

            const sessionRes = await fetch(
                'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json; charset=UTF-8',
                        'X-Upload-Content-Length': String(fileSize),
                        'X-Upload-Content-Type': fileType || 'video/mp4',
                    },
                    body: JSON.stringify({
                        snippet: { title, description, tags, categoryId },
                        status: statusPayload,
                    }),
                },
            );
            if (!sessionRes.ok) {
                const errText = (await sessionRes.text()).slice(0, 250);
                await supabase.from('social_posts').update({
                    status: 'failed',
                    error: `Google init ${sessionRes.status}: ${errText}`,
                }).eq('id', post.id);
                return respond(502, { error: `Google rechazó la subida (${sessionRes.status}): ${errText}` });
            }
            const sessionUrl = sessionRes.headers.get('location');
            if (!sessionUrl) {
                await supabase.from('social_posts').update({
                    status: 'failed',
                    error: 'Google no devolvió session URL',
                }).eq('id', post.id);
                return respond(502, { error: 'Google no devolvió la URL de subida' });
            }

            return respond(200, { post_id: post.id, session_url: sessionUrl });
        }

        /* ------- 3. complete: el PUT del navegador terminó ------- */
        if (body.action === 'complete') {
            const postId = String(body.post_id ?? '');
            const videoId = clip(String(body.video_id ?? ''), 50);
            if (!postId || !videoId) return respond(400, { error: 'Faltan datos de finalización' });

            const { data: post } = await supabase
                .from('social_posts')
                .select('id, account_id, status, content')
                .eq('id', postId)
                .maybeSingle();
            if (!post) return respond(404, { error: 'Publicación no encontrada' });

            /* Modo borrador: el video queda en privado y el post NO se marca
               publicado (el dueño lo promueve después desde el Studio). */
            const postContent = (post.content ?? {}) as Record<string, unknown>;
            const isDraft = postContent.draft === true;

            const accessToken = await getSocialAccessToken(supabase, post.account_id);
            const checkRes = await fetch(
                `https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id=${encodeURIComponent(videoId)}`,
                { headers: { Authorization: `Bearer ${accessToken}` } },
            );
            if (!checkRes.ok) {
                const t = (await checkRes.text()).slice(0, 200);
                return respond(502, { error: `No se pudo verificar el video en YouTube: ${t}` });
            }
            const checkJson = (await checkRes.json()) as { items?: unknown[] };
            if (!checkJson.items?.length) {
                return respond(502, { error: 'YouTube no reconoce el video subido' });
            }

            const { error: updErr } = await supabase.from('social_posts').update({
                status: isDraft ? 'draft' : 'published',
                published_at: isDraft ? null : new Date().toISOString(),
                external_post_id: videoId,
                external_url: `https://www.youtube.com/watch?v=${videoId}`,
                error: null,
            }).eq('id', postId);
            if (updErr) return respond(500, { error: updErr.message });

            if (!isDraft) {
                await supabase.from('social_accounts')
                    .update({ last_publish_at: new Date().toISOString() })
                    .eq('id', post.account_id);
            }

            return respond(200, {
                ok: true,
                draft: isDraft,
                url: `https://www.youtube.com/watch?v=${videoId}`,
            });
        }

        /* ------- fail: el PUT del navegador falló ------- */
        if (body.action === 'fail') {
            const postId = String(body.post_id ?? '');
            if (!postId) return respond(400, { error: 'Falta el post' });
            const failError = clip(String(body.upload_error ?? 'Subida interrumpida'), 400);
            await supabase.from('social_posts').update({
                status: 'failed',
                error: failError,
            }).eq('id', postId);
            /* MEJORA #43: traza en audit_log — sin ella, un fail del PUT con
               social_posts caído (o borrado a mano) era invisible para el
               Centro de Supervisión. Best-effort: no bloquea el 200. */
            await supabase.from('audit_log').insert({
                user_id: adminId,
                action: 'yt_publish_fail',
                module: 'contenido',
                table_name: 'social_posts',
                record_id: postId,
                status: 'error',
                error_code: 'YT_UPLOAD_FAIL',
                metadata: { error: failError },
            });
            return respond(200, { ok: true });
        }

        /* ------- dry_run: valida el paquete SIN publicar -------
           Espejo de las reglas del servidor de Google (title/description/
           tags/privacy/categoría/peso) + estimación de cuota. Sirve para
           el botón "Simular" del panel: el dueño ve los problemas antes
           de gastar 1600 unidades. No llama a YouTube (cuota 0). */
        if (body.action === 'dry_run') {
            const title = clip(String(body.title ?? ''), YT_TITLE_MAX);
            const description = clip(String(body.description ?? ''), YT_DESC_MAX);
            let tags: string[] = [];
            if (typeof body.tags === 'string') tags = body.tags.split(',').map((t) => clip(t, 60)).filter(Boolean);
            else if (Array.isArray(body.tags)) tags = body.tags.map((t) => clip(String(t), 60)).filter(Boolean);
            const fileSize = Number(body.file_size ?? 0);
            const privacy = (PRIVACY as readonly string[]).includes(String(body.privacy ?? 'public'))
                ? (String(body.privacy) as Privacy)
                : 'public';
            const categoryId = normalizeCategory(body.category_id);
            const flags = normalizeFlags(body);
            const publishAt = body.publish_at ? new Date(String(body.publish_at)) : null;

            const issues: Array<{ level: string; message: string }> = [];
            if (!title) issues.push({ level: 'error', message: 'Falta el título.' });
            else if (String(body.title ?? '').length > YT_TITLE_MAX) {
                issues.push({ level: 'error', message: `El título supera los ${YT_TITLE_MAX} caracteres.` });
            }
            if (String(body.description ?? '').length > YT_DESC_MAX) {
                issues.push({ level: 'error', message: `La descripción supera los ${YT_DESC_MAX} caracteres.` });
            }
            const tagsChars = tags.join(',').length;
            if (tagsChars > YT_TAGS_CHARS_MAX) {
                issues.push({ level: 'warning', message: `Los tags ocupan ${tagsChars} caracteres (YouTube usa hasta ${YT_TAGS_CHARS_MAX}).` });
            }
            if (tags.length > 15) {
                issues.push({ level: 'info', message: `Hay ${tags.length} tags: YouTube da peso SEO solo a los 3 primeros.` });
            }
            if (!fileSize || fileSize < 1024) {
                issues.push({ level: 'error', message: 'Falta el archivo de video (o está vacío).' });
            } else if (fileSize > MAX_FILE_BYTES) {
                issues.push({ level: 'error', message: 'El video supera el máximo de 2 GB del módulo.' });
            }
            if (publishAt && (isNaN(publishAt.getTime()) || publishAt.getTime() < Date.now() + 5 * 60_000)) {
                issues.push({ level: 'error', message: 'La fecha de programación debe ser futura (mínimo 5 minutos).' });
            }
            if (publishAt && privacy !== 'private') {
                issues.push({ level: 'info', message: 'Al programar, YouTube publica el video en privado hasta la fecha y lo hace público solo entonces.' });
            }
            if (!flags.embeddable) {
                issues.push({ level: 'warning', message: 'El video NO se podrá incrustar: las fichas del sitio dejarán de mostrar el tour.' });
            }

            return respond(200, {
                ok: !issues.some((i) => i.level === 'error'),
                issues,
                estimate: {
                    quota_units: YT_QUOTA_UPLOAD,
                    title_length: title.length,
                    description_length: description.length,
                    tags_count: tags.length,
                    tags_chars: tagsChars,
                    category_id: categoryId,
                },
            });
        }

        return respond(400, { error: 'Acción inválida' });
    } catch (err) {
        return respond(500, { error: (err as Error).message });
    }
});
