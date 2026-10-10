// ============================================================
// zernio-sync (cron cada 2 min): sincronizador incremental contra
// la Inbox API de Zernio. Puentea la falta de webhook push (la API
// de Zernio no permite gestionar webhooks — solo el dashboard).
//
// El flujo: pull de conversaciones → para las que tienen actividad
// nueva (updatedTime > espejo) se traen sus mensajes → los INSERT
// en zernio_messages disparan el realtime ya cableado del panel.
//
// Auth: header x-sync-secret debe coincidir con zernio_config(key='sync_secret').
// API key: env ZERNIO_API_KEY con fallback a zernio_config(key='api_key').
//
// DEPLOY: supabase functions deploy zernio-sync --no-verify-jwt
// CRON: ver migración 20261010000001_zernio_sync_cron.sql
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || '';
const ZERNIO_BASE = 'https://zernio.com/api/v1';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const VALID_PLATFORMS = ['instagram', 'facebook', 'whatsapp', 'telegram', 'twitter', 'bluesky', 'reddit', 'slack'];

function log(level: string, entry: Record<string, unknown>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, function: 'zernio-sync', ...entry }));
}

function str(v: unknown): string {
    return v === undefined || v === null ? '' : String(v);
}

function normalizePlatform(raw: unknown): string | null {
    const p = str(raw).toLowerCase();
    return VALID_PLATFORMS.includes(p) ? p : null;
}

function normalizeDirection(raw: unknown, fromMe?: boolean): 'in' | 'out' {
    const v = str(raw).toLowerCase();
    if (v === 'out' || v === 'outgoing') return 'out';
    if (v === 'in' || v === 'incoming') return 'in';
    return fromMe ? 'out' : 'in';
}

async function getConfig(key: string): Promise<string> {
    const { data } = await supabase.from('zernio_config').select('value').eq('key', key).maybeSingle();
    return str(data?.value?.[key === 'sync_secret' ? 'secret' : 'key']);
}

async function getApiKey(): Promise<string> {
    const envKey = Deno.env.get('ZERNIO_API_KEY');
    if (envKey) return envKey;
    return getConfig('api_key');
}

async function zernioGet(path: string, apiKey: string): Promise<{ ok: boolean; status: number; data: unknown }> {
    const res = await fetch(`${ZERNIO_BASE}${path}`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        log('warn', { op: 'zernio_get', path, status: res.status, error: t.slice(0, 200) });
        return { ok: false, status: res.status, data: null };
    }
    const data = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
}

interface ConvPayload {
    id: string;
    accountId: string;
    platform: string;
    participantName: string;
    participantUsername: string;
    updatedTime: string;
    lastMessage: string;
    unreadCount: number;
    status: string;
}

async function fetchAllConversations(apiKey: string): Promise<ConvPayload[]> {
    const out: ConvPayload[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
        const r = await zernioGet(`/inbox/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, apiKey);
        if (!r.ok) break;
        const d = r.data as Record<string, unknown> | null;
        const items = (d?.conversations ?? d?.data ?? (Array.isArray(d) ? d : [])) as Array<Record<string, unknown>>;
        if (!Array.isArray(items) || items.length === 0) break;
        for (const c of items) {
            const platform = normalizePlatform(c.platform);
            const accountId = str(c.accountId ?? c.account_id);
            const id = str(c.id);
            if (!platform || !accountId || !id) continue;
            out.push({
                id,
                accountId,
                platform,
                participantName: str(c.participantName ?? c.contact_name ?? c.name),
                participantUsername: str(c.participantUsername ?? c.contact_handle ?? c.handle),
                updatedTime: str(c.updatedTime ?? c.last_message_at),
                lastMessage: str(c.lastMessage ?? c.last_message_preview),
                unreadCount: Number(c.unreadCount ?? c.unread_count ?? 0),
                status: str(c.status),
            });
        }
        const dd = d as Record<string, unknown> | null;
        const pag = dd?.pagination as Record<string, unknown> | undefined;
        cursor = str(pag?.nextCursor ?? dd?.next_cursor ?? dd?.cursor) || null;
        if (!cursor) break;
    }
    return out;
}

async function syncConversationMessages(apiKey: string, conv: ConvPayload): Promise<number> {
    const { data: existing } = await supabase
        .from('zernio_messages')
        .select('platform_message_id')
        .eq('conversation_id', conv.id)
        .not('platform_message_id', 'is', null);
    const seen = new Set((existing ?? []).map((r: { platform_message_id: string }) => r.platform_message_id));

    let inserted = 0;
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ sortOrder: 'asc', accountId: conv.accountId });
        if (cursor) params.set('cursor', cursor);
        const r = await zernioGet(`/inbox/conversations/${conv.id}/messages?${params.toString()}`, apiKey);
        if (!r.ok) break;
        const d = r.data as Record<string, unknown> | null;
        const items = (d?.messages ?? d?.data ?? (Array.isArray(d) ? d : [])) as Array<Record<string, unknown>>;
        if (!Array.isArray(items) || items.length === 0) break;

        const rows: Array<Record<string, unknown>> = [];
        for (const m of items) {
            const pid = str(m.id);
            if (!pid || seen.has(pid)) continue;
            seen.add(pid);

            let attachment: Record<string, unknown> | null = null;
            if (Array.isArray(m.attachments) && m.attachments.length > 0) {
                attachment = m.attachments[0] as Record<string, unknown>;
            } else if (m.attachment && typeof m.attachment === 'object') {
                attachment = m.attachment as Record<string, unknown>;
            }

            rows.push({
                conversation_id: conv.id,
                direction: normalizeDirection(m.direction, m.fromMe ?? m.from_me),
                platform_message_id: pid,
                body: str(m.message ?? m.text ?? m.body),
                attachment,
                status: m.isDeleted ? 'deleted' : (normalizeDirection(m.direction, m.fromMe ?? m.from_me) === 'out' ? 'sent' : 'received'),
                zernio_event_id: null,
                occurred_at: str(m.createdAt ?? m.created_at) || new Date().toISOString(),
            });
        }

        if (rows.length > 0) {
            const { error } = await supabase.from('zernio_messages').upsert(rows, {
                onConflict: 'platform_message_id,conversation_id',
                ignoreDuplicates: true,
            });
            if (error) log('warn', { op: 'insert_messages', conv_id: conv.id, error: error.message });
            else inserted += rows.length;
        }

        const pag = d?.pagination as Record<string, unknown> | undefined;
        cursor = str(pag?.nextCursor ?? d?.next_cursor ?? d?.cursor) || null;
        if (!cursor) break;
    }
    return inserted;
}

Deno.serve(async (req: Request) => {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'content-type': 'application/json' },
        });
    }

    const syncSecret = await getConfig('sync_secret');
    if (syncSecret && req.headers.get('x-sync-secret') !== syncSecret) {
        return new Response(JSON.stringify({ error: 'No autorizado' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
        });
    }

    const apiKey = await getApiKey();
    if (!apiKey) {
        log('error', { error: 'ZERNIO_API_KEY no configurada' });
        return new Response(JSON.stringify({ ok: false, error: 'api key no configurada' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
        });
    }

    const t0 = Date.now();
    const convs = await fetchAllConversations(apiKey);
    if (convs.length === 0) {
        log('warn', { error: 'sin conversaciones o fallo de API', duration_ms: Date.now() - t0 });
        return new Response(JSON.stringify({ ok: false, error: 'sin conversaciones' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
        });
    }

    const { data: mirrorRows } = await supabase
        .from('zernio_conversations')
        .select('id, last_message_at, status, unread_count');
    const mirror = new Map<string, { last_message_at: string | null; status: string; unread_count: number }>();
    for (const r of (mirrorRows ?? []) as Array<{ id: string; last_message_at: string | null; status: string; unread_count: number }>) {
        mirror.set(r.id, { last_message_at: r.last_message_at, status: r.status, unread_count: r.unread_count });
    }

    let updatedConvs = 0;
    let newMessages = 0;

    for (const conv of convs) {
        const m = mirror.get(conv.id);
        const mirrorTs = m?.last_message_at ? Date.parse(m.last_message_at) : 0;
        const remoteTs = conv.updatedTime ? Date.parse(conv.updatedTime) : 0;
        const changed = !m || remoteTs > mirrorTs;
        if (!changed) continue;

        /* asegurar la cuenta (FK de la conversación) */
        const { data: acc } = await supabase
            .from('zernio_accounts')
            .select('zernio_account_id')
            .eq('zernio_account_id', conv.accountId)
            .maybeSingle();
        if (!acc) {
            await supabase.from('zernio_accounts').upsert({
                zernio_account_id: conv.accountId,
                platform: conv.platform,
                username: '',
                status: 'connected',
                last_synced_at: new Date().toISOString(),
            }, { onConflict: 'zernio_account_id' });
        }

        /* traer mensajes nuevos SOLO de conversaciones con actividad */
        newMessages += await syncConversationMessages(apiKey, conv);

        /* reflejar el estado de la conversación (esto dispara el realtime del panel) */
        const convStatus = ['active', 'open'].includes(conv.status.toLowerCase()) ? 'open' : 'closed';
        const patch: Record<string, unknown> = {
            account_id: conv.accountId,
            platform: conv.platform,
            last_message_at: conv.updatedTime || new Date().toISOString(),
            last_message_preview: conv.lastMessage.slice(0, 119),
            unread_count: conv.unreadCount,
            status: convStatus,
        };
        if (conv.participantName) patch.contact_name = conv.participantName;
        if (conv.participantUsername) patch.contact_handle = conv.participantUsername;

        const { error: upErr } = await supabase
            .from('zernio_conversations')
            .upsert({ id: conv.id, ...patch }, { onConflict: 'id' });
        if (upErr) log('warn', { op: 'upsert_conversation', conv_id: conv.id, error: upErr.message });
        else updatedConvs++;
    }

    const summary = {
        ok: true,
        conversations_total: convs.length,
        conversations_updated: updatedConvs,
        messages_new: newMessages,
        duration_ms: Date.now() - t0,
    };
    log('info', summary);
    return new Response(JSON.stringify(summary), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
});
