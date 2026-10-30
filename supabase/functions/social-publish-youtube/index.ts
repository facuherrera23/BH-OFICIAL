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

function clip(s: string, max: number): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
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
        seo_score?: number;
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

            // Post en 'publishing' ANTES de crear la sesión (queda traza aunque el PUT falle)
            const { data: post, error: postErr } = await supabase
                .from('social_posts')
                .insert({
                    account_id: accountId,
                    platform: 'youtube',
                    property_id: propertyId,
                    post_type: 'video',
                    content: { title, description, tags, privacy, ...(seoScoreOk !== null ? { seo_score: seoScoreOk } : {}) },
                    status: 'publishing',
                    created_by: adminId,
                })
                .select('id')
                .single();
            if (postErr || !post) return respond(500, { error: postErr?.message ?? 'No se pudo crear el registro' });

            // Sesión reanudable de Google (con programación si se pidió)
            const statusPayload: Record<string, unknown> = {
                privacyStatus: publishAtIso ? 'private' : privacy,
                selfDeclaredMadeForKids: false,
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
                        snippet: { title, description, tags, categoryId: '22' },
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
                .select('id, account_id, status')
                .eq('id', postId)
                .maybeSingle();
            if (!post) return respond(404, { error: 'Publicación no encontrada' });

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
                status: 'published',
                published_at: new Date().toISOString(),
                external_post_id: videoId,
                external_url: `https://www.youtube.com/watch?v=${videoId}`,
                error: null,
            }).eq('id', postId);
            if (updErr) return respond(500, { error: updErr.message });

            await supabase.from('social_accounts')
                .update({ last_publish_at: new Date().toISOString() })
                .eq('id', post.account_id);

            return respond(200, { ok: true, url: `https://www.youtube.com/watch?v=${videoId}` });
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

        return respond(400, { error: 'Acción inválida' });
    } catch (err) {
        return respond(500, { error: (err as Error).message });
    }
});
