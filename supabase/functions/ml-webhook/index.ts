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
    status?:
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

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
    const secret = (await getMlCredentials(supabase)).webhookSecret;
    // Sin secreto configurado no hay nada contra qué comparar: la barrera real es
    // validateNotificationBinding (el user_id debe ser el de la cuenta conectada).
    if (!secret) return true;
    const signature = req.headers.get('x-meli-signature');
    // ML (marketplace) no firma las notificaciones de tópicos de usuario: no hay
    // header de firma documentado y la autenticidad se valida re-consultando el
    // recurso con el token del vendedor. Sin header se confía en binding + rate
    // limit. La versión anterior rechazaba todo lo sin firma Y comparaba el HMAC
    // contra el secreto en plano (matemáticamente imposible): mataba toda
    // notificación real de ML.
    if (!signature) return true;
    // Si ML empieza a firmar algún día (formato ts=...,v1=...): verificar el
    // HMAC-SHA256 correcto sobre los bytes crudos del body — nunca contra el secreto.
    const match = signature.match(/ts=(\d+),v1=([a-f0-9]+)/);
    if (!match) return false;
    const tsHmac = await hmacSha256Hex(secret, match[1] + rawBody);
    if (timingSafeEqual(match[2], tsHmac)) return true;
    const bodyHmac = await hmacSha256Hex(secret, rawBody);
    return timingSafeEqual(match[2], bodyHmac);
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

/* Registro de notificaciones rechazadas por parse/validación: NUNCA más un 400
   silencioso. Bug real 2026-10-07: 6 notificaciones vis_leads de inmuebles
   fueron rechazadas con 400 sin dejar rastro en ml_webhook_events. */
async function logRejectedPayload(rawBody: string, errorMessage: string): Promise<void> {
    const nowIso = new Date().toISOString();
    let userId = '0';
    let resource = 'unknown';
    let topic = 'parse_error';
    let applicationId: string | null = null;
    let payloadJson: unknown = rawBody.slice(0, 4000);
    try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        userId = String(parsed.user_id ?? '0');
        if (typeof parsed.resource === 'string' && parsed.resource) resource = parsed.resource;
        if (typeof parsed.topic === 'string' && parsed.topic) topic = parsed.topic;
        if (parsed.application_id != null) applicationId = String(parsed.application_id);
        payloadJson = parsed;
    } catch {
        /* body no-JSON: queda guardado como string truncado */
    }
    try {
        await supabase.from('ml_webhook_events').insert({
            user_id: userId,
            resource,
            topic,
            application_id: applicationId,
            attempts: 0,
            sent_at: nowIso,
            received_at: nowIso,
            status: 'failed',
            error: errorMessage.slice(0, 500),
            payload: payloadJson,
        });
    } catch (dbErr) {
        console.error('[ml-webhook] logRejectedPayload DB:', (dbErr as Error).message);
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
        // Sin token no se puede procesar nada: el evento queda 'failed' (visible)
        // en ml_webhook_events en vez de 'processed' mentiroso.
        throw new Error(`ML token: ${(err as Error).message}`);
    }

    if (!token) throw new Error('ML token: no hay conexión ML activa');

    let q: { item_id?: unknown; text?: unknown; from?: { user_id?: unknown; nickname?: unknown }; date_created?: unknown } | null = null;
    try {
        const res = await fetch(`${ML_API}/questions/${questionId}?api_version=4`, {
            headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
            // Pregunta eliminada/bloqueada por moderación antes del fetch: el evento
            // queda 'failed' (visible) en vez de 'processed' mentiroso.
            throw new Error(`ML question ${questionId} HTTP ${res.status}`);
        }
        q = await res.json();
    } catch (err) {
        throw new Error(`ML question fetch: ${(err as Error).message}`);
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
        // Fallback: si la publicación se hizo a mano en ML y no está en property_ml_meta
        if (!propertyId) {
            const { data: listing } = await supabase
                .from('ml_listings')
                .select('property_id')
                .eq('ml_item_id', itemId)
                .maybeSingle();
            if (listing?.property_id) propertyId = listing.property_id;
        }
    }

    // Regla del estudio (2026-10-13): en inmuebles ML anonimiza al interesado;
    // sin nombre + método de contacto no se crea lead (antes entraban como
    // "Interesado ML" y quedaban filas vacías en el CRM). La pregunta queda
    // igual en el ledger y se responde con la plantilla activa. Quien consulta
    // de verdad escribe/pide contacto y entra por vis_leads con identidad.
    try {
        const { data: existingQ } = await supabase
            .from('ml_questions')
            .select('lead_id, status')
            .eq('question_id', questionId)
            .maybeSingle();
        if (existingQ && (existingQ.lead_id || existingQ.status === 'answered')) return;

        /* Claim atómico: la misma pregunta llega por questions y por vis_leads
           en paralelo (external_id = question_id). La UNIQUE del ledger deja
           un solo ganador; el que pierde sale sin hacer nada. */
        const { error: claimErr } = await supabase.from('ml_questions').insert({
            question_id: questionId,
            property_id: propertyId,
            ml_item_id: mlItemId,
            question_text: typeof q?.text === 'string' ? q.text : null,
            from_user_id: typeof q?.from?.user_id === 'number' ? q.from.user_id : null,
            from_user_nickname: typeof q?.from?.nickname === 'string' ? q.from.nickname : null,
            received_at: new Date().toISOString(),
            status: 'unanswered',
        });
        if (claimErr && (claimErr as { code?: string }).code === '23505') return;
        if (claimErr) throw new Error('claim ledger: ' + claimErr.message);
    } catch (err) {
        logWarn({ function: 'ml-webhook', topic: 'questions', question_id: questionId, error: 'claim: ' + (err as Error).message });
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
            received_at: new Date().toISOString(),
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

/* ─── Consolidación de leads ML (reglas del estudio, 2026-10-13) ───
   1. Sin identidad de contacto NO se crea lead (ya pasó que entraban como
      "Interesado ML" sin datos — no sirven).
   2. La misma persona interesada en otra publicación (o dos veces por la misma)
      queda en UN SOLO lead con todas las propiedades y la traza de contactos.
   3. Matcheo por email / últimos 10 dígitos del teléfono / "Usuario ML: id" o
      "Evento ML vinculado: id" en las notas; nunca sobre leads terminales. */
const ML_TERMINAL_STAGES_EXCL = '("cerrado_perdido","cerrado_vendido","vendido","descartado")';

async function findConsolidableMlLead(
    supabase: ReturnType<typeof createClient>,
    buyerEmail: string | null,
    buyerPhone: string | null,
    buyerId: number | null,
) {
    const filters: string[] = [];
    if (buyerEmail) filters.push(`email.eq.${buyerEmail}`);
    const digits = (buyerPhone || '').replace(/\D/g, '');
    if (digits.length >= 10) filters.push(`phone.ilike.%${digits.slice(-10)}%`);
    if (buyerId && buyerId >= 1000) {
        filters.push(`notes.ilike.%Usuario ML: ${buyerId}%`);
        filters.push(`notes.ilike.%Evento ML vinculado: ${buyerId}%`);
    }
    if (!filters.length) return null;
    const { data } = await supabase
        .from('leads')
        .select('id, full_name, email, phone, whatsapp, notes, stage, property_id, ml_lead_id')
        .eq('source', 'ml')
        .is('deleted_at', null)
        .not('stage', 'in', ML_TERMINAL_STAGES_EXCL)
        .or(filters.join(','))
        .order('created_at', { ascending: true }) /* el lead canónico es el primero */
        .limit(1)
        .maybeSingle();
    return data ?? null;
}

/* Merge: la info del evento nuevo queda en el lead existente (rellena campos
   vacíos, vincula la propiedad adicional vía lead_properties, nota la traza) y
   registra el id del evento para que sus cambios de estado no re-created el lead. */
async function mergeMlEventIntoLead(
    supabase: ReturnType<typeof createClient>,
    leadId: string,
    opts: {
        buyerEmail: string | null; buyerPhone: string | null; buyerName: string | null;
        buyerId: number | null; propertyId: string | null; mlLeadId: string | null;
        noteLabel: string; noteText: string; propertyContext: string;
    },
) {
    const { data: lead } = await supabase
        .from('leads')
        .select('id, full_name, email, phone, whatsapp, notes, property_id, ml_lead_id')
        .eq('id', leadId)
        .maybeSingle();
    if (!lead) return false;

    const patch: Record<string, string> = {};
    if (!lead.email && opts.buyerEmail) patch.email = opts.buyerEmail;
    if (!lead.phone && opts.buyerPhone) patch.phone = opts.buyerPhone;
    if (!lead.whatsapp && opts.buyerPhone) patch.whatsapp = opts.buyerPhone;
    if ((lead.full_name || '').startsWith('Interesado ML') && opts.buyerName) patch.full_name = opts.buyerName;
    if (!lead.ml_lead_id && opts.mlLeadId) patch.ml_lead_id = opts.mlLeadId;

    const pieces: string[] = [];
    const labelLine = `[${opts.noteLabel}] ${opts.noteText || ''}`.trim();
    if (labelLine.length > opts.noteLabel.length + 2) pieces.push(labelLine);
    if (opts.propertyContext) pieces.push(opts.propertyContext.trim());
    if (opts.mlLeadId && lead.ml_lead_id && lead.ml_lead_id !== opts.mlLeadId) {
        pieces.push(`Evento ML vinculado: ${opts.mlLeadId}`);
    }
    const extra = pieces.filter(Boolean).join('\n');
    const notes = (lead.notes as string) || '';
    if (extra && !notes.includes(extra.substring(0, 60))) {
        patch.notes = notes ? notes + '\n' + extra : extra;
    }

    if (Object.keys(patch).length) {
        await supabase.from('leads').update(patch).eq('id', leadId);
    }

    /* Propiedad adicional: la misma persona consultó otra publicación — queda
       vinculada al MISMO lead (no se crea otra fila en la tabla leads). */
    if (opts.propertyId && opts.propertyId !== lead.property_id) {
        const { data: link } = await supabase
            .from('lead_properties')
            .select('lead_id, property_id')
            .eq('lead_id', leadId)
            .eq('property_id', opts.propertyId)
            .maybeSingle();
        if (!link) {
            await supabase.from('lead_properties').insert({
                lead_id: leadId,
                property_id: opts.propertyId,
                created_at: new Date().toISOString(),
            });
        }
    }
    return true;
}

const VIS_CONTACT_LABELS: Record<string, string> = {
    whatsapp: 'WhatsApp',
    call: 'Llamada',
    question: 'Pregunta',
    visit_request: 'Solicitud de visita',
    contact_request: 'Solicitud de contacto',
    reservation: 'Reserva',
    quotation: 'Cotización',
    quotations: 'Cotización',
    schedule: 'Agenda de visita',
};

/* Leads de inmuebles (VIS): la notificación trae el id del lead en el resource
   (/vis/leads/{uuid}); el detalle — comprador, contacto, item — se consulta
   con el token del vendedor. Cada contacto crea un lead en el CRM con toda la
   info de conversión disponible. El dedup definitivo es ml_lead_id (índice
   único): ML re-notifica cambios de estado del MISMO lead (reservas/agendas)
   y el backfill re-inyecta leads ya procesados. */
async function handleVisLeads(payload: MlWebhookPayload): Promise<void> {
    const leadId = payload.resource.split('/').pop();
    if (!leadId) return;

    let token: string | null = null;
    try {
        token = await getMlAccessToken(supabase);
    } catch (err) {
        throw new Error(`ML token: ${(err as Error).message}`);
    }
    if (!token) throw new Error('ML token: no hay conexión ML activa');

    const res = await fetch(`${ML_API}/vis/leads/${leadId}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`ML vis lead ${leadId} HTTP ${res.status}`);

    const lead = (await res.json()) as {
        item_id?: unknown;
        contact_type?: unknown;
        external_id?: unknown;
        status?: unknown;
        buyer_id?: unknown;
        name?: unknown;
        email?: unknown;
        phone?: unknown;
        created_at?: unknown;
    };

    const itemId = typeof lead.item_id === 'string' ? lead.item_id : null;
    const contactType =
        typeof lead.contact_type === 'string' && lead.contact_type ? lead.contact_type : 'contacto';
    const externalId =
        typeof lead.external_id === 'string' && lead.external_id ? lead.external_id : null;
    const buyerId = typeof lead.buyer_id === 'number' ? lead.buyer_id : null;
    const buyerName = typeof lead.name === 'string' && lead.name ? lead.name : null;
    const buyerEmail = typeof lead.email === 'string' && lead.email ? lead.email : null;
    const buyerPhone = typeof lead.phone === 'string' && lead.phone ? lead.phone : null;
    const createdAt = typeof lead.created_at === 'string' ? lead.created_at : null;

    /* Preguntas de inmuebles: el texto NO está en el lead — se consulta con el
       external_id (id de pregunta clásico de ML). Dedup cruzado con el flujo
       clásico (handleQuestions): si la pregunta ya creó su lead O ya fue
       respondida, no crear un segundo lead. Antes solo miraba lead_id — si el
       ledger tenía la fila sin lead_id, se duplicaba (bug real 2026-10-08: las
       2 preguntas de prueba entraron dos veces al CRM). */
    const isQuestion = contactType === 'question' && !!externalId;
    let questionText = '';
    let questionClaimedByOther = false;
    if (isQuestion) {
        const { data: existingQ } = await supabase
            .from('ml_questions')
            .select('lead_id, status')
            .eq('question_id', externalId)
            .maybeSingle();
        if (existingQ && (existingQ.lead_id || existingQ.status === 'answered')) return;

        /* Claim atómico: la misma pregunta llega por el tópico clásico y por
           vis_leads en paralelo; la UNIQUE de ml_questions deja UN ganador. Si
           perdemos: consolidamos la identidad de este contacto en el lead que
           ya existe (el del ganador), y nuestra fila queda ligada. Si por alguna
           razón el ganador no creó lead (era anónimo, no entró al CRM), nosotros
           sí tenemos identidad → lo creamos acá y vinculamos abajo. */
        const { error: claimErr } = await supabase.from('ml_questions').insert({
            question_id: externalId,
            property_id: null,
            received_at: new Date().toISOString(),
            status: 'unanswered',
        });
        if (claimErr && (claimErr as { code?: string }).code === '23505') {
            await new Promise((r) => setTimeout(r, 1500));
            const { data: qrow } = await supabase
                .from('ml_questions')
                .select('lead_id')
                .eq('question_id', externalId)
                .maybeSingle();
            if (qrow?.lead_id) {
                await mergeMlEventIntoLead(supabase, qrow.lead_id, {
                    buyerEmail, buyerPhone, buyerName, buyerId,
                    propertyId: null, mlLeadId: leadId,
                    noteLabel: 'Contacto Mercado Libre · Pregunta',
                    noteText: questionText,
                    propertyContext: '',
                });
                return;
            }
            const hasIdentity = !!(buyerName || buyerEmail || buyerPhone || buyerId);
            if (!hasIdentity) return;
            /* El ganador era anónimo (no creó lead) pero tenemos identidad →
               sigue el flujo normal y el upsert final vincula el ledger. */
            questionClaimedByOther = true;
        }
        if (claimErr) throw new Error('claim ledger vis: ' + claimErr.message);

        try {
            const qRes = await fetch(`${ML_API}/questions/${externalId}?api_version=4`, {
                headers: { authorization: `Bearer ${token}` },
            });
            if (qRes.ok) {
                const q = (await qRes.json()) as { text?: unknown };
                questionText = typeof q.text === 'string' ? q.text : '';
            }
        } catch {
            /* fail-soft: el lead sigue con el resto del contexto */
        }
    }

    let propertyId: string | null = null;
    let mlPermalink: string | null = null;
    if (itemId) {
        const { data: meta } = await supabase
            .from('property_ml_meta')
            .select('property_id, ml_item_id, permalink')
            .eq('ml_item_id', itemId)
            .maybeSingle();
        if (meta) {
            propertyId = meta.property_id;
            mlPermalink = typeof meta.permalink === 'string' ? meta.permalink : null;
        }
        if (!propertyId) {
            const { data: listing } = await supabase
                .from('ml_listings')
                .select('property_id')
                .eq('ml_item_id', itemId)
                .maybeSingle();
            if (listing?.property_id) propertyId = listing.property_id;
        }
    }
    if (!mlPermalink && itemId && token) {
        try {
            const itemRes = await fetch(`${ML_API}/items/${itemId}`, {
                headers: { authorization: `Bearer ${token}` },
            });
            if (itemRes.ok) {
                const item = (await itemRes.json()) as { permalink?: string };
                if (typeof item.permalink === 'string' && item.permalink) mlPermalink = item.permalink;
            }
        } catch {
            /* fail-soft: el lead sigue sin link al aviso */
        }
    }

    let propContext = '';
    let propAgentId: string | null = null;
    if (propertyId) {
        const { data: prop } = await supabase
            .from('properties')
            .select('property_code, title, agent_id')
            .eq('id', propertyId)
            .maybeSingle();
        if (prop?.property_code) {
            propContext += `\nPropiedad: ${prop.property_code}${prop.title ? ' · ' + prop.title : ''}`;
        }
        /* Pedido del empleador (2026-10-19): el lead de ML entra YA asignado al
           agente de la propiedad — sin esto llegaba sin assigned_to y nadie lo
           tomaba hasta que un admin lo repartiera a mano. */
        if (prop?.agent_id) {
            propAgentId = prop.agent_id as string;
            propContext += `\nAgente asignado automáticamente (propietario de la propiedad)`;
        }
    }
    if (mlPermalink) propContext += `\nAviso ML: ${mlPermalink}`;
    if (buyerId) propContext += `\nUsuario ML: ${buyerId}`;

    const contactLabel = VIS_CONTACT_LABELS[contactType] ?? contactType;

    /* Regla del estudio (2026-10-13): sin identidad de contacto NO entra al CRM.
       La pregunta anónima queda en el ledger y en el panel de Portales, el CRM
       solo guarda leads accionables (nombre + email o teléfono/WhatsApp). */
    const hasIdentity = !!(buyerName || buyerEmail || buyerPhone || buyerId);
    if (!hasIdentity) {
        if (!isQuestion) {
            throw new Error(`vis_lead ${contactType} sin identidad de contacto — el evento queda en el log, no genera lead`);
        }
    } else {
        /* Consolidación global (no por propiedad): la misma persona puede preguntar
           por A y pedir contacto por B — quedan en UN lead con ambas. */
        const existingLead = await findConsolidableMlLead(supabase, buyerEmail, buyerPhone, buyerId);
        if (existingLead) {
            await mergeMlEventIntoLead(supabase, existingLead.id, {
                buyerEmail, buyerPhone, buyerName, buyerId,
                propertyId, mlLeadId: leadId,
                noteLabel: `Contacto Mercado Libre · ${contactLabel}`,
                noteText: questionText || `Interesado vía ${contactLabel}`,
                propertyContext: propContext,
            });
            if (isQuestion && externalId) {
                await supabase.from('ml_questions').upsert(
                    { question_id: externalId, property_id: propertyId, ml_item_id: itemId, lead_id: existingLead.id, received_at: new Date().toISOString(), question_text: questionText || null, from_user_id: buyerId, from_user_nickname: buyerName, date_created: createdAt, status: 'unanswered' },
                    { onConflict: 'question_id' },
                );
            }
            return;
        }
    }

    /* Solo con identidad se crea la fila en el CRM; sin ella, o sale por merge
       o no hay nada accionable — la pregunta igual se responde más abajo. */
    let newLead: { id: string } | null = null;
    if (hasIdentity) {
        const created = await supabase
            .from('leads')
            .insert({
                full_name: buyerName ?? 'Interesado ML',
                email: buyerEmail,
                phone: buyerPhone,
                source: 'ml',
                stage: 'nuevo',
                property_id: propertyId,
                assigned_to: propAgentId,
                ml_lead_id: leadId,
                notes: `[Contacto Mercado Libre · ${contactLabel}] ${
                    questionText || `Interesado vía ${contactLabel}`
                }${propContext}`,
            })
            .select('id')
            .single();
        const leadErr = created.error;
        if (leadErr) {
            if ((leadErr as { code?: string }).code === '23505') return; // re-notificación del mismo vis-lead
            if (isQuestion && externalId && !questionClaimedByOther) {
                await supabase.from('ml_questions').delete().eq('question_id', externalId);
            }
            throw new Error(`lead_create vis: ${leadErr.message}`);
        }
        if (!created.data?.id) throw new Error('lead_create vis: sin id devuelto');
        newLead = created.data;
    }

    /* Preguntas de inmuebles: registro en ml_questions (ledger compartido con el
       flujo clásico, con lead_id vinculado) + auto-reply con plantilla activa. */
    if (isQuestion && externalId) {
        await supabase.from('ml_questions').upsert(
            {
                question_id: externalId,
                property_id: propertyId,
                ml_item_id: itemId,
                lead_id: newLead ? newLead.id : null,
                received_at: new Date().toISOString(),
                question_text: questionText || null,
                from_user_id: buyerId,
                from_user_nickname: buyerName,
                date_created: createdAt,
                status: 'unanswered',
            },
            { onConflict: 'question_id' },
        );

        const template = await getActiveTemplate(supabase, 'new_question');
        if (template) {
            try {
                await sendQuestionAnswer(supabase, externalId, template.message, token);
                await supabase
                    .from('ml_questions')
                    .update({
                        status: 'answered',
                        answer_text: template.message,
                        date_updated: new Date().toISOString(),
                    })
                    .eq('question_id', externalId);
            } catch (err) {
                logWarn({
                    function: 'ml-webhook',
                    topic: 'vis_leads',
                    question_id: externalId,
                    error: 'auto_reply: ' + (err as Error).message,
                });
            }
        }
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
        const { error: enqueueErr } = await supabase.rpc('ml_enqueue', {
            p_property_id: meta.property_id,
            p_operation: 'update',
            p_ml_item_id: meta.ml_item_id,
        });
        /* Se lanza para que el evento quede 'failed' (visible): antes se pasaba
           un parámetro inexistente (p_internal) y el error de PostgREST se
           tragaba en silencio con el evento marcado 'processed'. */
        if (enqueueErr) throw new Error(`ml_enqueue: ${enqueueErr.message}`);
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

    // Body crudo leído UNA sola vez antes de verificar: la firma (si viene) se
    // computa sobre exactamente los bytes recibidos.
    let rawBody = '';
    try {
        rawBody = await req.text();
    } catch {
        return respond(400, { error: 'Invalid body' });
    }

    // Verify signature (secret se lee dinamicamente en verifySignature)
    const verified = await verifySignature(req, rawBody);
    if (!verified) return respond(401, { error: 'Invalid signature' });

    let payload: MlWebhookPayload;
    try {
        payload = parseMlResponse(MlWebhookPayloadSchema, JSON.parse(rawBody), 'ml-webhook');
    } catch (err) {
        /* El rechazo queda registrado en ml_webhook_events con el payload crudo:
           nunca más un 400 invisible (bug de las 6 notificaciones vis_leads). */
        const msg = (err as Error).message;
        console.error('[ml-webhook] parse rechazado:', msg);
        await logRejectedPayload(rawBody, msg);
        return respond(400, { error: 'Invalid JSON' });
    }

    /* ML envía el typo "recieved" y a veces omite sent/received: sent_at es la
       clave de dedup y received_at es NOT NULL — ambos se completan acá. */
    const nowIso = new Date().toISOString();
    payload.sent = payload.sent ?? payload.recieved ?? nowIso;
    payload.received = payload.received ?? payload.recieved ?? payload.sent;

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

    // ML desactiva los tópicos ("fall back") si el callback no responde 200 en
    // ~500ms, y reintenta 5 veces durante 1 hora antes de darla por perdida. El
    // procesamiento (fetch a la API de ML + upserts) tarda más que ese margen:
    // se responde 200 inmediatamente y se procesa en background con
    // EdgeRuntime.waitUntil. Los errores de procesamiento quedan como
    // status='failed' en ml_webhook_events (ya no hay retry de ML — el trade-off
    // que recomienda la propia doc de notificaciones de ML).
    const task = (async () => {
        await logWebhookEvent(payload, 'received');
        try {
            switch (payload.topic) {
                case 'questions':
                    await handleQuestions(payload);
                    break;
                case 'vis_leads':
                    await handleVisLeads(payload);
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
        }
    })();

    const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
        .EdgeRuntime;
    if (edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(task);
    } else {
        await task; // fuera del edge runtime (tests locales): procesar sincrónico
    }
    return respond(200, { ok: true });
});
