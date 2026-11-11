// ============================================================
// social-comments — Bandeja de comentarios de Facebook/Instagram y
// creación de leads desde ellos (módulo CONTENIDO).
//
// El webhook (social-webhook-meta) deja los comentarios en
// social_comments; ESTA función es el backend del tab "Consultas":
//
//   list:          comentarios de la bandeja (+ propiedad vinculada)
//   sync:          importa los comentarios REALES del Graph API de los
//                  posts publicados (cubre los que llegaron antes del
//                  webhook y los que Meta no entregó — red de seguridad
//                  contra el silencio de webhooks, mismo criterio que
//                  ml-vis-sweep)
//   subscribe:     suscribe las cuentas a los campos de webhook
//                  (POST /{page-id}/subscribed_apps?subscribed_fields=feed
//                  y /{ig-user-id}/subscribed_apps?subscribed_fields=comments)
//   webhook_info:  callback URL + verify_token para copiar al dashboard
//                  de Meta (genera el token la primera vez)
//   create_lead:   crea (o deduplica) un lead del CRM desde un
//                  comentario — patrón social-youtube-comments:
//                  admin-initiated, consent_at, dedup 60 días por
//                  email/teléfono, timeline + SLA de primer contacto
//   dismiss:       marca el comentario como revisado (sin lead)
//
// Todas requireAdmin + verify_jwt ON + rate limit. El cliente NUNCA
// escribe en leads/social_comments (RLS): lo hace el server con la
// service key.
// ============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import { getSocialAccessToken } from '../_shared/social.ts';
import { ensureFirstContactTask } from '../_shared/firstContact.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const WEBHOOK_KEY = 'social_meta_webhook';
const SYNC_DAYS = 45; // posts publicados en los últimos 45 días
const SYNC_POSTS_PER_ACCOUNT = 25;
const COMMENTS_PER_POST = 50;

interface CommentRow {
    id: string;
    platform: string;
    external_id: string;
    external_post_id: string | null;
    social_post_id: string | null;
    property_id: string | null;
    account_id: string | null;
    author_name: string | null;
    author_handle: string | null;
    body: string | null;
    parent_external_id: string | null;
    permalink: string | null;
    like_count: number | null;
    status: string;
    lead_id: string | null;
    commented_at: string | null;
    created_at: string;
    metadata: Record<string, unknown>;
}

function clip(s: string, max: number): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

/** Traduce un error del Graph API a algo accionable (los crudos dicen
    poco y el toast del panel tiene ~260 chars). */
function friendlyGraphError(status: number, raw: string): string {
    let code = 0;
    let msg = '';
    try {
        const json = JSON.parse(raw) as { error?: { code?: number; message?: string; error_user_msg?: string } };
        code = json?.error?.code ?? 0;
        msg = json?.error?.error_user_msg || json?.error?.message || raw.slice(0, 140);
    } catch (_) {
        msg = raw.slice(0, 140);
    }
    if (code === 190) return 'El token de la página está vencido o la app fue desautorizada — desconectá y volvé a conectar la cuenta.';
    if (/pages_manage_metadata/i.test(msg) || code === 200) {
        return 'La app de Meta no tiene el permiso necesario para suscribir/leer (pages_manage_metadata / instagram_manage_comments). Agregalo en el dashboard de Meta y reconectá la cuenta.';
    }
    return `Meta rechazó la consulta (HTTP ${status}): ${msg}`.slice(0, 240);
}

async function graphFetch(url: string, init?: RequestInit): Promise<any> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const raw = (await res.text()).slice(0, 2000);
        throw new Error(friendlyGraphError(res.status, raw));
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') return {};
    return res.json();
}

/* ------------------------------------------------------------
   Extracción de contacto desde el texto (mismo criterio que
   social-youtube-comments — el email/teléfono solo existe si la
   persona lo escribió).
   ------------------------------------------------------------ */

function extractEmail(text: string): string | null {
    const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? clip(m[0], 120).toLowerCase() : null;
}

function extractPhone(text: string): string | null {
    const candidates = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) ?? [];
    for (const raw of candidates) {
        const digits = raw.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) return clip(raw.trim(), 40);
    }
    return null;
}

/* ------------------------------------------------------------
   Actions
   ------------------------------------------------------------ */

async function listComments(body: { platform?: string; status?: string; limit?: number }) {
    let q = supabase
        .from('social_comments')
        .select('*, social_posts(external_url), properties(property_code, title)')
        .order('commented_at', { ascending: false, nullsFirst: false })
        .limit(Math.min(Math.max(Number(body.limit ?? 100), 1), 200));
    if (body.platform) q = q.eq('platform', String(body.platform));
    if (body.status) q = q.eq('status', String(body.status));
    const { data, error } = await q;
    if (error) throw new Error('No se pudo leer la bandeja: ' + error.message);
    return { rows: (data ?? []) as (CommentRow & Record<string, unknown>)[] };
}

async function webhookInfo() {
    const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', WEBHOOK_KEY)
        .maybeSingle();
    let verifyToken = data?.value?.verify_token;
    if (!verifyToken) {
        verifyToken =
            crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        await supabase
            .from('app_settings')
            .upsert(
                { key: WEBHOOK_KEY, value: { verify_token: verifyToken, created_at: new Date().toISOString() } },
                { onConflict: 'key' },
            );
    }
    const baseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    return {
        callback_url: `${baseUrl}/functions/v1/social-webhook-meta`,
        verify_token: verifyToken,
        /* La MISMA app de Meta configura el callback UNA vez y sirve las
           dos redes (Page → field feed; Instagram → field comments). */
        fields: { facebook: 'feed', instagram: 'comments' },
    };
}

async function subscribeAccounts(platform: string) {
    if (platform !== 'facebook' && platform !== 'instagram') {
        throw new Error('Plataforma inválida (facebook|instagram)');
    }
    const field = platform === 'facebook' ? 'feed' : 'comments';
    const { data: accounts } = await supabase
        .from('social_accounts')
        .select('id, external_id, display_name, status')
        .eq('platform', platform)
        .eq('status', 'active');
    const results: { account: string; ok: boolean; message: string }[] = [];
    for (const acc of accounts ?? []) {
        try {
            const token = await getSocialAccessToken(supabase, acc.id);
            const url = `${GRAPH_API}/${acc.external_id}/subscribed_apps?subscribed_fields=${field}&access_token=${encodeURIComponent(token)}`;
            await graphFetch(url, { method: 'POST' });
            results.push({ account: acc.display_name || acc.external_id, ok: true, message: `Suscripta a ${field}` });
        } catch (err) {
            results.push({ account: acc.display_name || acc.external_id, ok: false, message: (err as Error).message });
        }
    }
    if (!results.length) results.push({ account: '', ok: false, message: `No hay cuentas de ${platform} conectadas` });
    return { results };
}

async function syncComments(platform: string) {
    if (platform !== 'facebook' && platform !== 'instagram') {
        throw new Error('Plataforma inválida (facebook|instagram)');
    }
    const { data: accounts } = await supabase
        .from('social_accounts')
        .select('id, external_id, display_name, status')
        .eq('platform', platform)
        .eq('status', 'active');
    if (!accounts?.length) throw new Error(`No hay cuentas de ${platform} conectadas — conectala desde Cuentas`);

    const since = new Date(Date.now() - SYNC_DAYS * 86400000).toISOString();
    let posts = 0;
    let fetched = 0;
    const errors: string[] = [];

    for (const acc of accounts) {
        let token: string;
        try {
            token = await getSocialAccessToken(supabase, acc.id);
        } catch (err) {
            errors.push(`${acc.display_name}: ${(err as Error).message}`);
            continue;
        }
        const { data: publishedPosts } = await supabase
            .from('social_posts')
            .select('id, external_post_id, property_id, account_id')
            .eq('account_id', acc.id)
            .eq('status', 'published')
            .not('external_post_id', 'is', null)
            .gte('published_at', since)
            .limit(SYNC_POSTS_PER_ACCOUNT);
        for (const post of publishedPosts ?? []) {
            posts++;
            try {
                const fields =
                    platform === 'facebook'
                        ? 'id,from{name},message,created_time,like_count,parent{id}'
                        : 'id,text,from{username},timestamp,like_count,replies{id,text,timestamp,from{username},like_count}';
                const url = `${GRAPH_API}/${post.external_post_id}/comments?fields=${encodeURIComponent(fields)}&limit=${COMMENTS_PER_POST}&access_token=${encodeURIComponent(token)}`;
                const res = await graphFetch(url);
                const comments = Array.isArray(res?.data) ? res.data : [];

                const rows = (comments as any[]).flatMap((c) => {
                    const isFb = platform === 'facebook';
                    const externalId = clip(isFb ? c.id : c.id, 80);
                    if (!externalId) return [];
                    const base = {
                        platform,
                        external_id: externalId,
                        external_post_id: String(post.external_post_id),
                        social_post_id: post.id,
                        property_id: post.property_id ?? null,
                        account_id: post.account_id ?? null,
                        author_name: clip(isFb ? c.from?.name : c.from?.username, 120) || null,
                        author_handle: isFb ? null : clip(c.from?.username, 120) || null,
                        body: clip(isFb ? c.message : c.text, 3000) || null,
                        parent_external_id: c.parent?.id ? clip(c.parent.id, 120) : null,
                        like_count: Number(c.like_count ?? 0) || 0,
                        commented_at:
                            (isFb ? toIso(c.created_time) : toIso(c.timestamp)) ?? new Date().toISOString(),
                        metadata: { source: 'sync', from_id: clip(c.from?.id, 60) },
                    };
                    const replies = !isFb && Array.isArray(c.replies) ? c.replies : [];
                    const replyRows = replies.map((r: any) => ({
                        ...base,
                        external_id: clip(r.id, 80),
                        body: clip(r.text, 3000) || null,
                        parent_external_id: externalId,
                        author_name: clip(r.from?.username, 120) || null,
                        author_handle: clip(r.from?.username, 120) || null,
                        like_count: Number(r.like_count ?? 0) || 0,
                        commented_at: toIso(r.timestamp) ?? base.commented_at,
                    }));
                    return [base, ...replyRows];
                });
                fetched += rows.length;
                if (rows.length) {
                    const { error } = await supabase.from('social_comments').upsert(rows, {
                        onConflict: 'external_id',
                        ignoreDuplicates: true,
                    });
                    if (error) throw new Error(error.message);
                }
            } catch (err) {
                errors.push(`${String(post.external_post_id).slice(-12)}: ${(err as Error).message.slice(0, 120)}`);
            }
        }
    }
    return { accounts: accounts.length, posts, fetched, errors: errors.slice(0, 5) };
}

/** FB unix-seconds / IG ISO string → ISO. */
function toIso(t: unknown): string | null {
    if (t == null) return null;
    if (typeof t === 'number' && isFinite(t) && t > 0) {
        const d = new Date(t < 1e12 ? t * 1000 : t);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof t === 'string') {
        const n = Number(t);
        if (isFinite(n) && n > 0 && !t.includes('-')) return toIso(n);
        const d = new Date(t);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
}

/* ------------------------------------------------------------
   Lead desde comentario (patrón social-youtube-comments)
   ------------------------------------------------------------ */

async function createLead(body: { comment_id?: string }, adminId: string) {
    const commentId = clip(String(body.comment_id ?? ''), 80);
    if (!commentId) return { error: 'Faltan datos', status: 400 };

    const { data: row } = await supabase
        .from('social_comments')
        .select('*')
        .eq('id', commentId)
        .maybeSingle() as { data: CommentRow | null };
    if (!row) return { error: 'Comentario no encontrado', status: 404 };

    /* Idempotencia: un comentario = un lead. */
    if (row.lead_id) return { ok: true, duplicate: true, lead_id: row.lead_id };

    const platform = row.platform === 'facebook' ? 'facebook' : 'instagram';
    const label = platform === 'facebook' ? 'Facebook' : 'Instagram';
    const text = row.body ?? '';
    const email = extractEmail(text);
    const phone = extractPhone(text);

    /* Propiedad: la del comentario; si el webhook no la matcheó, la
       resuelve desde el post (puede haberse vinculado después). */
    let propertyId = row.property_id;
    let postUrl: string | null = null;
    if (row.social_post_id) {
        const { data: post } = await supabase
            .from('social_posts')
            .select('id, property_id, external_url')
            .eq('id', row.social_post_id)
            .maybeSingle();
        propertyId = propertyId ?? post?.property_id ?? null;
        postUrl = post?.external_url ?? null;
    }

    const author = row.author_name || row.author_handle ||
        (platform === 'facebook' ? 'Interesado de Facebook' : 'Interesado de Instagram');
    const notes =
        `Comentario en ${label}: "${text}"` +
        (postUrl ? `\nPost: ${postUrl}` : '');

    /* Dedup por email/teléfono (60 días, mismo criterio que
       contact-submit y comment_lead): si ya existe la persona, la
       consulta va al timeline del lead existente — no se duplica. */
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
                title: `Consulta desde un comentario de ${label}`,
                description: notes,
                created_by: adminId,
            }]);
            await ensureFirstContactTask(supabase, dup.id, { channelLabel: label });
            /* El comentario queda linkeado al lead existente. */
            await supabase
                .from('social_comments')
                .update({ status: 'lead', lead_id: dup.id, updated_at: new Date().toISOString() })
                .eq('id', row.id);
            await supabase.from('audit_log').insert({
                user_id: adminId,
                action: platform === 'facebook' ? 'fb_comment_lead' : 'ig_comment_lead',
                module: 'contenido',
                table_name: 'leads',
                record_id: dup.id,
                status: 'success',
                metadata: { social_comment_id: row.id, external_id: row.external_id, duplicate: true },
            });
            return { ok: true, duplicate: true, lead_id: dup.id };
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
            source: platform,
            stage: 'nuevo',
            property_id: propertyId,
            consent_at: new Date().toISOString(),
        })
        .select('id')
        .single();
    if (leadErr || !lead) {
        console.error('[social-comments] lead insert error:', leadErr);
        return { error: 'No se pudo crear el lead', status: 500 };
    }

    await supabase.from('lead_activities').insert([{
        lead_id: lead.id,
        activity_type: 'note',
        title: `Consulta desde un comentario de ${label}`,
        description: notes,
        created_by: adminId,
    }]);

    /* SLA de primer contacto: el lead nace con plazo (el comentario es
       una interacción pública — mismo criterio que YouTube/ML/landing). */
    await ensureFirstContactTask(supabase, lead.id, { channelLabel: label });

    await supabase
        .from('social_comments')
        .update({ status: 'lead', lead_id: lead.id, updated_at: new Date().toISOString() })
        .eq('id', row.id);

    await supabase.from('audit_log').insert({
        user_id: adminId,
        action: platform === 'facebook' ? 'fb_comment_lead' : 'ig_comment_lead',
        module: 'contenido',
        table_name: 'leads',
        record_id: lead.id,
        status: 'success',
        metadata: { social_comment_id: row.id, external_id: row.external_id, duplicate: false },
    });

    return { ok: true, duplicate: false, lead_id: lead.id };
}

/* ------------------------------------------------------------
   Router
   ------------------------------------------------------------ */

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, payload: Record<string, unknown>): Response =>
        jsonResponse(status, payload, req);

    const rl = await rateLimitMiddleware('social-comments', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Método no permitido' });

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });
    const { data: userData } = await supabase.auth.getUser(token);
    if (!userData?.user) return respond(401, { error: 'No autorizado' });
    const adminId = userData.user.id;

    let body: Record<string, any> = {};
    try {
        body = await req.json();
    } catch (_) { /* acción sin body */ }

    try {
        switch (String(body.action ?? '')) {
            case 'list':
                return respond(200, await listComments(body));
            case 'webhook_info':
                return respond(200, await webhookInfo());
            case 'subscribe':
                return respond(200, await subscribeAccounts(String(body.platform ?? '')));
            case 'sync':
                return respond(200, await syncComments(String(body.platform ?? '')));
            case 'create_lead': {
                const res = await createLead(body, adminId);
                return respond(res.error ? (res.status ?? 400) : 200, res);
            }
            case 'dismiss': {
                const commentId = clip(String(body.comment_id ?? ''), 80);
                if (!commentId) return respond(400, { error: 'Faltan datos' });
                const { error } = await supabase
                    .from('social_comments')
                    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
                    .eq('id', commentId);
                if (error) return respond(500, { error: 'No se pudo actualizar' });
                return respond(200, { ok: true });
            }
            default:
                return respond(400, { error: 'Acción desconocida' });
        }
    } catch (err) {
        console.error('[social-comments] error:', err);
        return respond(500, { error: (err as Error).message || 'Error interno' });
    }
});
