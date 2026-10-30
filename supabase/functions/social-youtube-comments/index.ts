// ============================================================
// social-youtube-comments — Comentarios del canal + lead desde
// un comentario (decisión del dueño: toda consulta de ML crea su
// lead; el mismo criterio se aplica acá).
//
// Acciones (todas requireAdmin, verify_jwt ON):
//   comments_list:    commentThreads.list de un video (con replies).
//   comments_inbox:   commentThreads.list del canal (bandeja de
//                     comentarios recientes de todos los videos).
//   comment_reply:    comments.insert (responder un comentario).
//   comment_heart:    commentThreads.setRating (dar/corregir like).
//   comment_moderate: commentThreads.setModerationStatus (retener/
//                     aprobar). Exige youtube.force-ssl.
//   comment_lead:     crea (o deduplica) un lead del CRM a partir de
//                     un comentario. El cliente NO puede escribir en
//                     leads (RLS): lo hace el server con service_role.
//
// Scopes: leer comentarios funciona con youtube.readonly; responder,
// dar like y moderar exigen youtube.force-ssl.
//
// Cuota de Google: ~1 unidad por acción de comentarios (dentro de las
// 10.000 diarias del canal).
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COMMENTS = 100;
const MAX_REPLY_CHARS = 10000;

interface CommentAccount {
    id: string;
    platform: string;
    status: string;
    scope: string | null;
}

function clip(s: string, max: number): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

async function loadAccount(client: SupabaseClient, accountId: string): Promise<CommentAccount> {
    const { data } = await client
        .from('social_accounts')
        .select('id, platform, status, scope')
        .eq('id', accountId)
        .maybeSingle() as { data: CommentAccount | null };
    const acc = data;
    if (!acc || acc.platform !== 'youtube') throw new Error('Cuenta de YouTube no encontrada');
    if (acc.status !== 'active') throw new Error('La cuenta está desconectada — reconectala');
    return acc;
}

function hasManageScope(acc: { scope: string | null }): boolean {
    return !!acc.scope && acc.scope.includes(FORCE_SSL_SCOPE);
}

async function youtubeFetch(url: string, accessToken: string, init?: RequestInit): Promise<any> {
    const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`YouTube ${res.status}: ${body}`);
    }
    if (res.status === 204) return {};
    return res.json();
}

/* ------------------------------------------------------------
   Mapeo de la respuesta de la API → algo que el panel pueda
   pintar sin conocer la API de YouTube.
   ------------------------------------------------------------ */
function mapThread(t: any) {
    const sn = t?.snippet ?? {};
    const top = sn.topLevelComment?.snippet ?? {};
    const replies = (sn.replies?.comments ?? []).map((c: any) => ({
        id: c.id ?? '',
        text: clip(c.snippet?.textOriginal ?? c.snippet?.textDisplay ?? '', 3000),
        author: clip(c.snippet?.authorDisplayName ?? 'Anónimo', 120),
        likes: Number(c.snippet?.likeCount ?? 0),
        publishedAt: c.snippet?.publishedAt ?? null,
    }));
    return {
        /* id del hilo = id del comentario de primer nivel (el que
           hay que usar como parentId para responder). */
        id: t.id ?? sn.topLevelComment?.id ?? '',
        videoId: sn.videoId ?? '',
        text: clip(top.textOriginal ?? top.textDisplay ?? '', 3000),
        author: clip(top.authorDisplayName ?? 'Anónimo', 120),
        authorId: sn.authorChannelId?.value ?? '',
        likes: Number(top.likeCount ?? 0),
        replyCount: Number(sn.totalReplyCount ?? replies.length ?? 0),
        publishedAt: sn.publishedAt ?? null,
        replies,
    };
}

/* ------------------------------------------------------------
   Extracción de contacto desde el texto del comentario.
   YouTube NO expone el email ni el teléfono del commenter: lo
   único que hay es lo que la persona escribió. Si escribió un
   teléfono o un email, se usan para el lead.
   ------------------------------------------------------------ */
function extractEmail(text: string): string | null {
    const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? clip(m[0], 120).toLowerCase() : null;
}

function extractPhone(text: string): string | null {
    /* Números de 8+ dígitos (con espacios, guiones o paréntesis). */
    const candidates = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) ?? [];
    for (const raw of candidates) {
        const digits = raw.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) return clip(raw.trim(), 40);
    }
    return null;
}

/* ------------------------------------------------------------
   Idempotencia del lead desde comentario: si ya se creó un lead
   para este comentario, no se crea otro. Se usa audit_log como
   registro (metadata->>'youtube_comment_id') porque no hay una
   tabla nueva (sin migraciones).
   ------------------------------------------------------------ */
async function leadExistsForComment(commentId: string): Promise<boolean> {
    const { data } = await supabase
        .from('audit_log')
        .select('id')
        .eq('action', 'yt_comment_lead')
        .contains('metadata', { youtube_comment_id: commentId })
        .limit(1);
    return Array.isArray(data) && data.length > 0;
}

/** Propiedad vinculada al video (social_posts.property_id). */
async function propertyForVideo(videoId: string): Promise<string | null> {
    const { data } = await supabase
        .from('social_posts')
        .select('property_id')
        .eq('platform', 'youtube')
        .eq('external_post_id', videoId)
        .not('property_id', 'is', null)
        .limit(1) as { data: Array<{ property_id: string | null }> | null };
    const pid = data?.[0]?.property_id;
    return pid && UUID_RE.test(pid) ? pid : null;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const limited = await rateLimitMiddleware('social-youtube-comments', req);
    if (limited) return limited;

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });
    const { data: userData } = await supabase.auth.getUser(token);
    if (!userData?.user) return respond(401, { error: 'No autorizado' });
    const adminId = userData.user.id;

    let body: {
        action?: string;
        account_id?: string;
        video_id?: string;
        channel_id?: string;
        comment_id?: string;
        parent_id?: string;
        text?: string;
        like?: boolean;
        status?: string;
        author?: string;
    };
    try {
        body = await req.json();
    } catch {
        return respond(400, { error: 'Body inválido' });
    }

    const accountId = String(body.account_id ?? '');
    if (!accountId) return respond(400, { error: 'Falta la cuenta' });

    try {
        const acc = await loadAccount(supabase, accountId);
        const accessToken = await getSocialAccessToken(supabase, accountId);

        /* ------- Lista de comentarios de un video ------- */
        if (body.action === 'comments_list') {
            const videoId = clip(String(body.video_id ?? ''), 50);
            if (!videoId) return respond(400, { error: 'Falta el video' });
            const res = await youtubeFetch(
                `${YOUTUBE_API}/commentThreads?part=snippet,replies&videoId=${encodeURIComponent(videoId)}` +
                `&maxResults=${MAX_COMMENTS}&order=time&textFormat=plainText`,
                accessToken,
            );
            const threads = (res.items ?? []).map(mapThread);
            return respond(200, {
                videoId,
                threads,
                total: Number(res.totalResults ?? threads.length),
            });
        }

        /* ------- Bandeja: comentarios recientes del canal ------- */
        if (body.action === 'comments_inbox') {
            const channelId = clip(String(body.channel_id ?? ''), 50);
            if (!channelId) return respond(400, { error: 'Falta el canal' });
            const res = await youtubeFetch(
                `${YOUTUBE_API}/commentThreads?part=snippet&allThreadsRelatedToChannelId=${encodeURIComponent(channelId)}` +
                `&maxResults=${MAX_COMMENTS}&textFormat=plainText`,
                accessToken,
            );
            const threads = (res.items ?? []).map(mapThread);
            /* El endpoint del canal no garantiza orden: se ordena por fecha
               (el dueño quiere lo último primero). */
            threads.sort((a: any, b: any) => {
                const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
                const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
                return tb - ta;
            });
            return respond(200, {
                threads: threads.slice(0, 50),
                total: Number(res.totalResults ?? threads.length),
            });
        }

        /* ------- Responder ------- */
        if (body.action === 'comment_reply') {
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para habilitar la administración completa.' });
            }
            const videoId = clip(String(body.video_id ?? ''), 50);
            const parentId = clip(String(body.parent_id ?? ''), 80);
            const text = clip(String(body.text ?? ''), MAX_REPLY_CHARS);
            if (!videoId || !parentId) return respond(400, { error: 'Faltan datos' });
            if (!text) return respond(400, { error: 'La respuesta está vacía' });
            const out = await youtubeFetch(`${YOUTUBE_API}/comments?part=snippet`, accessToken, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    snippet: { videoId, parentId, textOriginal: text },
                }),
            });
            return respond(200, { ok: true, commentId: out?.id ?? '' });
        }

        /* ------- Like /unlike del comentario del canal ------- */
        if (body.action === 'comment_heart') {
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para habilitar la administración completa.' });
            }
            const commentId = clip(String(body.comment_id ?? ''), 80);
            if (!commentId) return respond(400, { error: 'Falta el comentario' });
            await youtubeFetch(`${YOUTUBE_API}/commentThreads/setRating`, accessToken, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: commentId, rating: body.like === false ? 'none' : 'like' }),
            });
            return respond(200, { ok: true });
        }

        /* ------- Moderar (retener / aprobar) ------- */
        if (body.action === 'comment_moderate') {
            if (!hasManageScope(acc)) {
                return respond(403, { error: 'Reconectá la cuenta de YouTube para habilitar la administración completa.' });
            }
            const commentId = clip(String(body.comment_id ?? ''), 80);
            const status = body.status === 'approved' ? 'approved' : 'held';
            if (!commentId) return respond(400, { error: 'Falta el comentario' });
            await youtubeFetch(`${YOUTUBE_API}/commentThreads/setModerationStatus`, accessToken, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: commentId, moderationStatus: status }),
            });
            return respond(200, { ok: true, status });
        }

        /* ------- Lead desde comentario ------- */
        if (body.action === 'comment_lead') {
            const videoId = clip(String(body.video_id ?? ''), 50);
            const commentId = clip(String(body.comment_id ?? ''), 80);
            const author = clip(String(body.author ?? ''), 120) || 'Interesado de YouTube';
            const text = clip(String(body.text ?? ''), 3000);
            if (!videoId || !commentId) return respond(400, { error: 'Faltan datos' });

            /* Idempotencia: un comentario = un lead. */
            if (await leadExistsForComment(commentId)) {
                return respond(200, { ok: true, duplicate: true });
            }

            const email = extractEmail(text);
            const phone = extractPhone(text);
            const propertyId = await propertyForVideo(videoId);
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const notes = `Comentario en YouTube: "${text}"\nVideo: ${videoUrl}`;

            /* Dedup por email/teléfono (mismo criterio que contact-submit):
               si ya existe la persona, NO se duplica: se le agrega la
               consulta al timeline del lead existente. */
            const filters: string[] = [];
            if (email) filters.push(`email.ilike.${email}`);
            if (phone) {
                const digits = phone.replace(/\D/g, '');
                if (digits.length >= 8) filters.push(`phone.ilike.%${digits.slice(-8)}%`);
            }
            if (filters.length) {
                const { data: dup } = await supabase
                    .from('leads')
                    .select('id')
                    .or(filters.join(','))
                    .is('deleted_at', null)
                    .gte('created_at', new Date(Date.now() - 60 * 86400000).toISOString())
                    .limit(1)
                    .maybeSingle();
                if (dup) {
                    await supabase.from('lead_activities').insert([{
                        lead_id: dup.id,
                        activity_type: 'note',
                        title: 'Consulta desde un comentario de YouTube',
                        description: notes,
                        created_by: adminId,
                    }]);
                    await supabase.from('audit_log').insert({
                        user_id: adminId,
                        action: 'yt_comment_lead',
                        module: 'contenido',
                        table_name: 'leads',
                        record_id: dup.id,
                        status: 'success',
                        metadata: { youtube_comment_id: commentId, video_id: videoId, duplicate: true },
                    });
                    return respond(200, { ok: true, duplicate: true, lead_id: dup.id });
                }
            }

            const { data: lead, error: leadErr } = await supabase
                .from('leads')
                .insert({
                    full_name: author,
                    email: email ?? null,
                    phone: phone ?? null,
                    whatsapp: phone ?? null,
                    notes,
                    source: 'youtube_comment',
                    stage: 'nuevo',
                    property_id: propertyId,
                    consent_at: new Date().toISOString(),
                })
                .select('id')
                .single();
            if (leadErr || !lead) {
                console.error('[social-youtube-comments] lead insert error:', leadErr);
                return respond(500, { error: 'No se pudo crear el lead' });
            }

            /* Timeline: de dónde vino el lead. */
            await supabase.from('lead_activities').insert([{
                lead_id: lead.id,
                activity_type: 'note',
                title: 'Consulta desde un comentario de YouTube',
                description: notes,
                created_by: adminId,
            }]);

            /* Marca de idempotencia + auditoría. */
            await supabase.from('audit_log').insert({
                user_id: adminId,
                action: 'yt_comment_lead',
                module: 'contenido',
                table_name: 'leads',
                record_id: lead.id,
                status: 'success',
                metadata: { youtube_comment_id: commentId, video_id: videoId, duplicate: false },
            });

            return respond(200, { ok: true, lead_id: lead.id, duplicate: false });
        }

        return respond(400, { error: 'Acción inválida' });
    } catch (err) {
        console.error('[social-youtube-comments]', err);
        const msg = (err as Error).message || 'Error inesperado';
        /* 401/403 de Google = la conexión quedó vieja o sin permisos. */
        if (/YouTube 401/.test(msg) || /YouTube 403/.test(msg)) {
            return respond(403, { error: 'needs_reconnect' });
        }
        return respond(500, { error: msg.slice(0, 300) });
    }
});
