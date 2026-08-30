import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    getActiveTemplate,
    getMlAccessToken,
    sendOrderMessage,
    sendQuestionAnswer,
} from '../_shared/auto_reply.ts';
import { ML_API, getMlCredentials } from '../_shared/ml.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import {
    MlOrderSchema,
    MlWebhookPayloadSchema,
    parseMlResponse,
} from '../_shared/ml.schemas.ts';
import type { MlWebhookPayload, MlOrder } from '../_shared/ml.schemas.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const RATE_LIMIT_FN = 'ml-webhook';

function timingSafeEqual(a: string, b: string): boolean {
    const ba = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

interface LogEntry {
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    function: string;
    topic?: string;
    resource?: string;
    user_id?: number;
    status:
        | 'received'
        | 'processed'
        | 'failed'
        | 'deduplicated'
        | 'auto_reply_sent'
        | 'unhandled'
        | number;
    duration_ms?: number;
    error?: string;
    question_id?: string;
    order_id?: string;
    trigger?: string;
    attempts?: number;
}

function log(entry: Omit<LogEntry, 'timestamp' | 'level'>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', ...entry }));
}
function logWarn(entry: Omit<LogEntry, 'timestamp' | 'level'>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', ...entry }));
}
function logError(entry: Omit<LogEntry, 'timestamp' | 'level'>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', ...entry }));
}

async function verifySignature(req: Request): Promise<boolean> {
    const secret = (await getMlCredentials(supabase)).webhookSecret;
    if (!secret) return false;
    const signature = req.headers.get('x-meli-signature');
    if (!signature) return false;
    return timingSafeEqual(signature, secret);
}

async function logWebhookEvent(
    payload: MlWebhookPayload,
    status: 'received' | 'processed' | 'failed' | 'deduplicated',
    error?: string,
): Promise<void> {
    const { data: existing } = await supabase
        .from('ml_webhook_events')
        .select('id')
        .eq('user_id', payload.user_id)
        .eq('resource', payload.resource)
        .eq('topic', payload.topic)
        .eq('sent_at', payload.sent)
        .maybeSingle();
    const row = {
        user_id: payload.user_id,
        resource: payload.resource,
        topic: payload.topic,
        application_id: payload.application_id,
        attempts: payload.attempts,
        sent_at: payload.sent,
        received_at: payload.received,
        status,
        error: error ?? null,
        payload: JSON.stringify(payload),
    };
    if (existing?.id) {
        await supabase
            .from('ml_webhook_events')
            .update({
                status,
                error: error ?? null,
                payload: JSON.stringify(payload),
                attempts: payload.attempts,
            })
            .eq('id', existing.id);
    } else {
        await supabase.from('ml_webhook_events').insert(row);
    }
}

async function validateNotificationBinding(payload: MlWebhookPayload): Promise<boolean> {
    const clientId = (await getMlCredentials(supabase)).clientId;
    if (clientId && String(payload.application_id) !== clientId) return false;
    const { data: connection } = await supabase
        .from('ml_connection')
        .select('user_id')
        .eq('provider', 'mercadolibre')
        .eq('is_active', true)
        .eq('user_id', payload.user_id)
        .maybeSingle();
    return !!connection;
}

async function handleQuestions(payload: MlWebhookPayload): Promise<void> {
    const questionId = payload.resource.split('/').pop();
    if (!questionId) return;

    const template = await getActiveTemplate(supabase, 'new_question');

    // Resolver item_id (string) y datos de la pregunta desde ML.
    // El resource del webhook es el ID de la pregunta, NO el del item.
    let token: string | null = null;
    try {
        token = await getMlAccessToken(supabase);
    } catch (err) {
        logWarn({ function: 'ml-webhook', topic: 'questions', error: (err as Error).message });
        return;
    }

    if (!token) return;

    let q: { item_id?: unknown; text?: unknown; from?: { user_id?: unknown; nickname?: unknown }; date_created?: unknown } | null = null;
    try {
        const res = await fetch(`${ML_API}/questions/${questionId}?api_version=4`, {
            headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
            logWarn({
                function: 'ml-webhook',
                topic: 'questions',
                question_id: questionId,
                status: res.status,
            });
            return;
        }
        q = await res.json();
    } catch (err) {
        logWarn({
            function: 'ml-webhook',
            topic: 'questions',
            question_id: questionId,
            error: (err as Error).message,
        });
        return;
    }

    const itemId: unknown = q?.item_id;
    let propertyId: string | null = null;
    const mlItemId: string | null = typeof itemId === 'string' ? itemId : null;

    if (itemId != null) {
        const { data: meta } = await supabase
            .from('property_ml_meta')
            .select('property_id, ml_item_id')
            .eq('ml_item_id', itemId)
            .maybeSingle();
        if (meta) {
            propertyId = meta.property_id;
        }
    }

    if (!template) {
        // Sin plantilla activa: solo registrar como no respondida
        if (propertyId) {
            await supabase.from('ml_questions').upsert(
                {
                    question_id: questionId,
                    property_id: propertyId,
                    ml_item_id: mlItemId,
                    status: 'unanswered',
                    received_at: new Date().toISOString(),
                },
                { onConflict: 'question_id' },
            );
        }
        return;
    }

    await supabase.from('ml_questions').upsert(
        {
            question_id: questionId,
            property_id: propertyId,
            ml_item_id: mlItemId,
            question_text: typeof q?.text === 'string' ? q.text : null,
            from_user_id: typeof q?.from?.user_id === 'number' ? q.from.user_id : null,
            from_user_nickname: typeof q?.from?.nickname === 'string' ? q.from.nickname : null,
            date_created: typeof q?.date_created === 'string' ? q.date_created : null,
            status: 'answered',
            answer_text: template.message,
            date_updated: new Date().toISOString(),
        },
        { onConflict: 'question_id' },
    );

    try {
        await sendQuestionAnswer(supabase, questionId, template.message, token);
    } catch (err) {
        await supabase
            .from('ml_questions')
            .update({ status: 'unanswered', answer_text: null })
            .eq('question_id', questionId);
        logWarn({
            function: 'ml-webhook',
            topic: 'questions',
            question_id: questionId,
            error: (err as Error).message,
        });
    }
}

const ORDER_STATUS_TRIGGER: Record<string, string> = {
    paid: 'order_paid',
    shipped: 'order_shipped',
    delivered: 'order_delivered',
    confirmed: 'new_order',
};

function deriveOrderStatus(order: MlOrderSchema | null): string {
    if (!order || order.status === 'cancelled') return 'cancelled';
    if (order.status === 'payment_in_process') return 'new';

    const shippingStatus = order.shipping?.status;
    if (shippingStatus === 'delivered') return 'delivered';
    if (shippingStatus === 'shipped' || shippingStatus === 'sent') return 'shipped';

    const approved = (order.payments ?? []).some((p) => p?.status === 'approved');
    if (approved) return 'paid';

    const pending = (order.payments ?? []).some((p) => p?.status === 'pending');
    if (pending) return 'new';

    if (order.status === 'confirmed' || order.status === 'paid') return 'confirmed';
    return 'new';
}

async function handleOrders(payload: MlWebhookPayload): Promise<void> {
    const orderId = payload.resource.split('/').pop();
    if (!orderId) return;

    let token: string | null = null;
    try {
        token = await getMlAccessToken(supabase);
    } catch (err) {
        logWarn({ function: 'ml-webhook', topic: 'orders', error: (err as Error).message });
    }

    let order: MlOrder | null = null;
    if (token) {
        try {
            const res = await fetch(`${ML_API}/orders/${orderId}`, {
                headers: { authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                try {
                    const data = await res.json();
                    order = parseMlResponse(MlOrderSchema, data, 'mlOrder');
                } catch {
                    order = null;
                }
            } else {
                logWarn({
                    function: 'ml-webhook',
                    topic: 'orders',
                    order_id: orderId,
                    status: res.status,
                });
            }
        } catch (err) {
            logWarn({
                function: 'ml-webhook',
                topic: 'orders',
                order_id: orderId,
                error: (err as Error).message,
            });
        }
    }

    const status = deriveOrderStatus(order);

    const itemId: unknown = order?.order_items?.[0]?.item?.id;
    let propertyId: string | null = null;
    const mlItemId: string | null = typeof itemId === 'string' ? itemId : null;
    if (itemId != null) {
        const { data: meta } = await supabase
            .from('property_ml_meta')
            .select('property_id, ml_item_id')
            .eq('ml_item_id', itemId)
            .maybeSingle();
        if (meta) {
            propertyId = meta.property_id;
        }
    }

    const { data: existing } = await supabase
        .from('ml_orders')
        .select('status')
        .eq('order_id', orderId)
        .maybeSingle();
    const prevStatus = existing?.status ?? null;

    const orderPayload: Record<string, unknown> = {
        order_id: orderId,
        ml_item_id: mlItemId,
        status,
        received_at: new Date().toISOString(),
    };
    if (propertyId) orderPayload.property_id = propertyId;
    if (order) {
        if (typeof order.buyer?.id === 'number') orderPayload.buyer_id = order.buyer.id;
        if (typeof order.buyer?.nickname === 'string')
            orderPayload.buyer_nickname = order.buyer.nickname;
        if (typeof order.total_amount === 'number') orderPayload.total_amount = order.total_amount;
        if (typeof order.currency_id === 'string') orderPayload.currency = order.currency_id;
        if (typeof order.date_created === 'string') orderPayload.date_created = order.date_created;
        if (typeof order.date_closed === 'string') orderPayload.date_closed = order.date_closed;
    }

    await supabase.from('ml_orders').upsert(orderPayload, { onConflict: 'order_id' });

    const trigger = ORDER_STATUS_TRIGGER[status];
    if (trigger && token && prevStatus !== status) {
        const template = await getActiveTemplate(supabase, trigger);
        if (template) {
            try {
                await sendOrderMessage(supabase, orderId, template.message, token);
                log({
                    function: 'ml-webhook',
                    topic: 'orders',
                    order_id: orderId,
                    trigger,
                    status: 'auto_reply_sent',
                });
            } catch (err) {
                logWarn({
                    function: 'ml-webhook',
                    topic: 'orders',
                    order_id: orderId,
                    trigger,
                    error: (err as Error).message,
                });
            }
        }
    }
}

async function handleItems(payload: MlWebhookPayload): Promise<void> {
    const itemId = payload.resource.split('/').pop();
    if (!itemId) return;

    const { data: meta } = await supabase
        .from('property_ml_meta')
        .select('property_id, ml_item_id')
        .eq('ml_item_id', itemId)
        .maybeSingle();

    if (meta) {
        await supabase.rpc('ml_enqueue', {
            p_property_id: meta.property_id,
            p_operation: 'update',
            p_internal: true,
        });
    }
}

async function handlePayments(payload: MlWebhookPayload): Promise<void> {
    const paymentId = payload.resource.split('/').pop();
    if (!paymentId) return;

    await supabase.from('ml_payments').upsert({
        payment_id: paymentId,
        status: 'pending',
        received_at: new Date().toISOString(),
        payload: JSON.stringify(payload),
    });
}

async function handleShipments(payload: MlWebhookPayload): Promise<void> {
    const shipmentId = payload.resource.split('/').pop();
    if (!shipmentId) return;

    await supabase.from('ml_shipments').upsert({
        shipment_id: shipmentId,
        status: 'pending',
        received_at: new Date().toISOString(),
        payload: JSON.stringify(payload),
    });
}

Deno.serve(async (req) => {
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    if (req.method === 'OPTIONS') return optionsResponse(req);
    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });

    // Rate Limiting
    const clientIp =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        'unknown';
    const rlResult = await checkRateLimit('ml-webhook', clientIp);
    if (!rlResult.allowed) {
        return respond(429, { error: 'Rate limited', retry_after: rlResult.retryAfter });
    }

    // Verify signature (secret se lee dinamicamente en verifySignature)
    const verified = await verifySignature(req);
    if (!verified) return respond(401, { error: 'Invalid signature' });

    let payload: MlWebhookPayload;
    try {
        const raw = await req.json();
        payload = parseMlResponse(MlWebhookPayloadSchema, raw, 'ml-webhook');
    } catch {
        return respond(400, { error: 'Invalid JSON' });
    }

    const start = Date.now();

    if (!(await validateNotificationBinding(payload))) {
        return respond(401, {
            error: 'Notificacion no perteneciente a la aplicacion/cuenta conectada',
        });
    }

    // Deduplication check
    const { data: existingEvent } = await supabase
        .from('ml_webhook_events')
        .select('status')
        .eq('resource', payload.resource)
        .eq('topic', payload.topic)
        .eq('sent_at', payload.sent)
        .maybeSingle();

    if (existingEvent && existingEvent.status === 'processed') {
        log({
            function: 'ml-webhook',
            topic: payload.topic,
            resource: payload.resource,
            attempts: payload.attempts,
            status: 'deduplicated',
        });
        return respond(200, { ok: true, deduplicated: true });
    }

    await logWebhookEvent(payload, 'received');

    try {
        switch (payload.topic) {
            case 'questions':
                await handleQuestions(payload);
                break;
            case 'orders':
            case 'orders_v2':
                await handleOrders(payload);
                break;
            case 'items':
                await handleItems(payload);
                break;
            case 'payments':
                await handlePayments(payload);
                break;
            case 'shipments':
                await handleShipments(payload);
                break;
            default:
                logWarn({ function: 'ml-webhook', topic: payload.topic, status: 'unhandled' });
        }
        await logWebhookEvent(payload, 'processed');
        log({
            function: 'ml-webhook',
            topic: payload.topic,
            resource: payload.resource,
            duration_ms: Date.now() - start,
            status: 'processed',
        });
        return respond(200, { ok: true });
    } catch (err) {
        logError({
            function: 'ml-webhook',
            topic: payload.topic,
            resource: payload.resource,
            duration_ms: Date.now() - start,
            status: 'failed',
            error: (err as Error).message,
        });
        await logWebhookEvent(payload, 'failed', (err as Error).message);
        return respond(500, { error: (err as Error).message });
    }
});
