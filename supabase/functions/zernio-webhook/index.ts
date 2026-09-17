// ============================================================
// zernio-webhook — Receptor de eventos inbox de Zernio.
//
// Payload real de Zernio (docs.zernio.com/webhooks/inbox), SIEMPRE plano:
//   {
//     id: "<event uuid>",
//     event: "message.received" | "message.sent" | "message.delivered" |
//            "message.read" | "message.failed" | "message.edited" |
//            "message.deleted" | "conversation.started" | "webhook.test" |
//            "account.connected" | "account.disconnected" | ...,
//     message:      { id, conversationId, text, direction, accountId?, createdAt/... },
//     conversation: { id?, accountId?, participantName?, participantUsername?, platform?, ... },
//     account:      { id, platform, ... },
//     timestamp:    "ISO-8601"
//   }
//
// Firma: X-Zernio-Signature = hex(HMAC-SHA256(rawBody, webhook_secret)).
// Dedup por event id en zernio_webhook_events (delivery at-least-once).
//
// DEPLOY: supabase functions deploy zernio-webhook --no-verify-jwt
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    auditSensitiveAction,
} from '../_shared/audit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || '';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const PLATFORMS = new Set([
    'instagram', 'facebook', 'whatsapp', 'telegram',
    'twitter', 'bluesky', 'reddit', 'slack',
]);

const ALLOWED_ORIGINS = new Set([
    'https://bienenhaus.com.ar',
    'https://www.bienenhaus.com.ar',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
]);

// ---------- Utilidades ----------

function log(level: string, entry: Record<string, unknown>): void {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        function: 'zernio-webhook',
        ...entry,
    }));
}

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('origin');
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        return {
            'access-control-allow-origin': origin,
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type, x-zernio-signature, x-zernio-event-id',
            vary: 'Origin',
        };
    }
    return {};
}

function respond(status: number, body: unknown, req: Request): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(req), 'content-type': 'application/json' },
    });
}

function optionsResponse(req: Request): Response {
    return new Response('ok', {
        headers: {
            ...corsHeaders(req),
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type, x-zernio-signature, x-zernio-event-id',
        },
    });
}

function timingSafeEqual(a: string, b: string): boolean {
    const ba = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getWebhookSecret(): Promise<string> {
    const envSecret = Deno.env.get('ZERNIO_WEBHOOK_SECRET');
    if (envSecret) return envSecret;
    const { data } = await supabase
        .from('zernio_config')
        .select('value')
        .eq('key', 'webhook_secret')
        .maybeSingle();
    return data?.value?.secret || '';
}

function str(v: unknown): string {
    if (v === undefined || v === null) return '';
    return String(v);
}

function normalizeTs(v: unknown, fallback: unknown = undefined): string {
    const raw = str(v) || str(fallback);
    if (raw) {
        const p = Date.parse(raw);
        if (!isNaN(p)) return new Date(p).toISOString();
    }
    return new Date().toISOString();
}

function truncate(t: string, max = 120): string {
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function normalizePlatform(raw: unknown): string | null {
    const p = str(raw).toLowerCase();
    return PLATFORMS.has(p) ? p : null;
}

function firstAttachment(msg: Record<string, unknown>): Record<string, unknown> | null {
    const arr = msg.attachments;
    if (Array.isArray(arr) && arr.length > 0) return arr[0] as Record<string, unknown>;
    if (msg.attachment && typeof msg.attachment === 'object') return msg.attachment as Record<string, unknown>;
    return null;
}

// ---------- Acceso a datos ----------

async function ensureAccount(accountId: string, platform: string | null): Promise<boolean> {
    if (!accountId) return false;

    const { data } = await supabase
        .from('zernio_accounts')
        .select('zernio_account_id')
        .eq('zernio_account_id', accountId)
        .maybeSingle();
    if (data) return true;

    if (!platform) return false;
    const { error } = await supabase.from('zernio_accounts').insert({
        zernio_account_id: accountId,
        platform,
        username: '',
        status: 'connected',
    });
    return !error;
}

async function upsertConversation(
    convId: string,
    accountId: string,
    contactName: string,
    contactHandle: string,
    platform: string | null,
): Promise<void> {
    const payload: Record<string, unknown> = { id: convId, account_id: accountId };
    if (contactName) payload.contact_name = contactName;
    if (contactHandle) payload.contact_handle = contactHandle;
    if (platform) payload.platform = platform;

    const { error } = await supabase.from('zernio_conversations').upsert(payload, { onConflict: 'id' });
    if (error) throw new Error('upsert_conversation: ' + error.message);
}

async function insertMessage(row: Record<string, unknown>): Promise<string> {
    const { error } = await supabase.from('zernio_messages').insert(row);
    if (!error) return 'inserted';
    if (error.code === '23505') return 'duplicate';
    throw new Error('insert_message: ' + error.message);
}

// ---------- Extracción del contexto de eventos ----------

interface EventCtx {
    type: string;
    eventId: string;
    convId: string;
    accountId: string;
    platform: string | null;
    msg: Record<string, unknown>;
    conv: Record<string, unknown>;
    account: Record<string, unknown>;
}

function extractCtx(ev: Record<string, unknown>): EventCtx {
    const msg = (ev.message && typeof ev.message === 'object' ? ev.message : {}) as Record<string, unknown>;
    const conv = (ev.conversation && typeof ev.conversation === 'object' ? ev.conversation : {}) as Record<string, unknown>;
    const account = (ev.account && typeof ev.account === 'object' ? ev.account : {}) as Record<string, unknown>;

    const convId = str(conv.id) || str(msg.conversationId);
    const accountId = str(account.id) || str(conv.accountId) || str(msg.accountId);
    const platform = normalizePlatform(account.platform) || normalizePlatform(conv.platform);

    return {
        type: str(ev.event),
        eventId: str(ev.id),
        convId,
        accountId,
        platform,
        msg,
        conv,
        account,
    };
}

// ---------- Handlers ----------

async function handleConversationStarted(ctx: EventCtx): Promise<void> {
    if (!ctx.convId || !ctx.accountId) {
        log('warn', { event: ctx.type, error: 'faltan ids', conv_id: ctx.convId, account_id: ctx.accountId });
        return;
    }
    if (!await ensureAccount(ctx.accountId, ctx.platform)) return;
    await upsertConversation(
        ctx.convId,
        ctx.accountId,
        str(ctx.conv.participantName || ctx.conv.contactName || ctx.conv.name),
        str(ctx.conv.participantUsername || ctx.conv.contactHandle || ctx.conv.handle),
        ctx.platform,
    );
    log('info', { event: ctx.type, conv_id: ctx.convId });
}

async function handleMessageReceived(ctx: EventCtx, ev: Record<string, unknown>): Promise<void> {
    if (!ctx.convId || !ctx.accountId) {
        log('warn', { event: ctx.type, error: 'faltan ids', conv_id: ctx.convId, account_id: ctx.accountId });
        return;
    }
    if (!await ensureAccount(ctx.accountId, ctx.platform)) return;
    await upsertConversation(
        ctx.convId,
        ctx.accountId,
        str(ctx.conv.participantName || ctx.conv.contactName || ctx.conv.name),
        str(ctx.conv.participantUsername || ctx.conv.contactHandle || ctx.conv.handle),
        ctx.platform,
    );

    const body = str(ctx.msg.text ?? ctx.msg.body);
    const occurredAt = normalizeTs(ctx.msg.createdAt ?? ctx.msg.timestamp, ev.timestamp);
    const platformMsgId = str(ctx.msg.id ?? ctx.msg.messageId) || null;

    const inserted = await insertMessage({
        conversation_id: ctx.convId,
        direction: 'in',
        platform_message_id: platformMsgId,
        body,
        attachment: firstAttachment(ctx.msg),
        status: 'received',
        zernio_event_id: ctx.eventId || null,
        occurred_at: occurredAt,
    });

    await auditSensitiveAction(
        supabase,
        new Request('http://internal', { method: 'POST' }),
        'message_received',
        'chat',
        'conversation',
        null,
        `Conv ${ctx.convId}: Msg from ${body.slice(0, 50)}`,
        { platform: ctx.platform, account_id: ctx.accountId },
        { platform_message_id: platformMsgId, direction: 'in', source: 'zernio-webhook', event: ctx.type },
    );

    if (inserted === 'inserted') {
        const { error: incErr } = await supabase.rpc('zernio_increment_unread', {
            p_conversation_id: ctx.convId,
            p_last_message_at: occurredAt,
            p_last_message_preview: truncate(body),
        });
        if (incErr) {
            log('warn', { event: ctx.type, conv_id: ctx.convId, error: 'increment_unread: ' + incErr.message });
        }
        log('info', { event: ctx.type, conv_id: ctx.convId, message_id: platformMsgId });
    } else {
        log('info', { event: ctx.type, conv_id: ctx.convId, dedup: true });
    }
}

async function handleMessageStatus(ctx: EventCtx): Promise<void> {
    const status = ctx.type === 'message.sent' ? 'sent'
        : ctx.type === 'message.delivered' ? 'delivered'
        : 'read';
    const platformMsgId = str(ctx.msg.id ?? ctx.msg.messageId);

    if (platformMsgId) {
        await supabase
            .from('zernio_messages')
            .update({ status })
            .eq('platform_message_id', platformMsgId)
            .eq('direction', 'out');
        log('info', { event: ctx.type, platform_message_id: platformMsgId, status });
        return;
    }

    // Fallback: message.sent sin id → insert como mensaje saliente sin platform id
    if (ctx.type === 'message.sent' && ctx.convId && ctx.accountId) {
        if (!await ensureAccount(ctx.accountId, ctx.platform)) return;
        await upsertConversation(
            ctx.convId,
            ctx.accountId,
            str(ctx.conv.participantName || ctx.conv.contactName),
            str(ctx.conv.participantUsername || ctx.conv.contactHandle),
            ctx.platform,
        );
        await insertMessage({
            conversation_id: ctx.convId,
            direction: 'out',
            platform_message_id: null,
            body: str(ctx.msg.text ?? ctx.msg.body),
            attachment: firstAttachment(ctx.msg),
            status: 'sent',
            zernio_event_id: ctx.eventId || null,
            occurred_at: normalizeTs(ctx.msg.createdAt),
        });
        log('info', { event: ctx.type, conv_id: ctx.convId, inserted_fallback: true });
    }
}

async function handleMessageFailed(ctx: EventCtx): Promise<void> {
    const platformMsgId = str(ctx.msg.id ?? ctx.msg.messageId);
    const errObj = (ctx.msg.error && typeof ctx.msg.error === 'object' ? ctx.msg.error : { title: 'Error desconocido' }) as Record<string, unknown>;

    if (platformMsgId) {
        await supabase
            .from('zernio_messages')
            .update({ status: 'failed', error: errObj })
            .eq('platform_message_id', platformMsgId)
            .eq('direction', 'out');
        log('warn', { event: ctx.type, platform_message_id: platformMsgId });
    }
}

async function handleMessageEdited(ctx: EventCtx): Promise<void> {
    const platformMsgId = str(ctx.msg.id ?? ctx.msg.messageId);
    if (!platformMsgId) return;
    const newBody = str(ctx.msg.text ?? ctx.msg.body);
    if (!newBody) return;
    await supabase
        .from('zernio_messages')
        .update({ body: newBody })
        .eq('platform_message_id', platformMsgId);
    log('info', { event: ctx.type, platform_message_id: platformMsgId });
}

async function handleMessageDeleted(ctx: EventCtx): Promise<void> {
    const platformMsgId = str(ctx.msg.id ?? ctx.msg.messageId);
    if (!platformMsgId) return;
    await supabase
        .from('zernio_messages')
        .update({ status: 'deleted' })
        .eq('platform_message_id', platformMsgId);
    log('info', { event: ctx.type, platform_message_id: platformMsgId });
}

async function handleAccountEvent(ctx: EventCtx): Promise<void> {
    if (!ctx.accountId) {
        log('warn', { event: ctx.type, error: 'account id ausente' });
        return;
    }
    if (!await ensureAccount(ctx.accountId, ctx.platform)) {
        log('warn', { event: ctx.type, error: 'no se pudo asegurar cuenta', account_id: ctx.accountId });
        return;
    }

    const update: Record<string, unknown> = {
        status: ctx.type === 'account.connected' ? 'connected' : 'disconnected',
        raw: ctx.account,
        last_synced_at: new Date().toISOString(),
    };
    const username = str(ctx.account.username || ctx.account.name);
    if (username) update.username = username;

    await supabase.from('zernio_accounts').update(update).eq('zernio_account_id', ctx.accountId);
    log('info', { event: ctx.type, account_id: ctx.accountId });
}

// ---------- Entry point ----------

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' }, req);

    const rawBody = await req.text();
    if (rawBody.length > 1_000_000) {
        return respond(413, { error: 'Payload demasiado grande' }, req);
    }

    const secret = await getWebhookSecret();
    if (!secret) return respond(503, { error: 'Servicio no configurado' }, req);

    const signature = (req.headers.get('x-zernio-signature') || '').toLowerCase().trim();
    const computed = await hmacSha256Hex(secret, rawBody);
    if (!signature || !timingSafeEqual(signature, computed)) {
        return respond(401, { error: 'Firma inválida' }, req);
    }

    let ev: Record<string, unknown>;
    try {
        ev = JSON.parse(rawBody);
    } catch {
        return respond(400, { error: 'JSON inválido' }, req);
    }

    const ctx = extractCtx(ev);
    if (!ctx.eventId || !ctx.type) {
        return respond(200, { ok: true, ignored: 'missing id/event' }, req);
    }

    const { error: dedupErr } = await supabase
        .from('zernio_webhook_events')
        .insert({ id: ctx.eventId, event: ctx.type, payload: ev });

    if (dedupErr) {
        if (dedupErr.code === '23505') return respond(200, { ok: true, dedup: true }, req);
        log('error', { operation: 'dedup_insert', event: ctx.type, error: dedupErr.message });
        return respond(500, { error: 'Error interno' }, req);
    }

    try {
        switch (ctx.type) {
            case 'conversation.started': await handleConversationStarted(ctx); break;
            case 'message.received': await handleMessageReceived(ctx, ev); break;
            case 'message.sent':
            case 'message.delivered':
            case 'message.read': await handleMessageStatus(ctx); break;
            case 'message.failed': await handleMessageFailed(ctx); break;
            case 'message.edited': await handleMessageEdited(ctx); break;
            case 'message.deleted': await handleMessageDeleted(ctx); break;
            case 'account.connected':
            case 'account.disconnected': await handleAccountEvent(ctx); break;
            case 'webhook.test':
                log('info', { event: ctx.type, detail: 'ping de prueba de Zernio' });
                break;
            default:
                log('info', { event: ctx.type, detail: 'evento no manejado (ack silencioso)' });
        }
    } catch (err) {
        log('error', { operation: 'handle', event: ctx.type, error: (err as Error).message });
    }

    return respond(200, { ok: true }, req);
});
