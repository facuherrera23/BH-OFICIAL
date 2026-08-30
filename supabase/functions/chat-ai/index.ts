/**
 * chat-ai — Asistente IA del chat interno.
 *
 * Recibe un mensaje de un canal, arma contexto (canal + propiedad/lead + historial),
 * llama a Google Gemini Flash y responde insertando un mensaje del agente IA.
 * La respuesta llega a los clientes vía Realtime (migración 0038).
 *
 * Contrato: POST { channel_id, message_id } → { ok, message_id }
 * Auth: staff/admin (JWT). Rate limit: 10/min por usuario.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const GEMINI_ENDPOINT =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent';

interface ChatMessageRow {
    id: string;
    channel_id: string;
    sender_id: string;
    content: string;
    created_at: string;
    deleted_at: string | null;
}

interface ChannelRow {
    id: string;
    type: 'direct' | 'group' | 'property' | 'lead';
    name: string | null;
    property_id: string | null;
    lead_id: string | null;
}

interface AgentRow {
    id: string;
    name: string;
    is_ai: boolean;
    is_active: boolean;
}

interface PropertyRow {
    id: string;
    code: number | null;
    title: string;
    price: number | null;
    currency: string | null;
    address: string | null;
    location: { name: string } | null;
    area_total: number | null;
    area_covered: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    garages: number | null;
    year_built: number | null;
    description: string | null;
    amenities: string[] | null;
    status: string;
}

interface LeadRow {
    id: string;
    name: string;
    last_name: string;
    intent: string | null;
    city: string | null;
    status: string;
    source: string | null;
}

interface HistoryMessageRow {
    content: string;
    sender_id: string;
    created_at: string;
    sender: { name: string; is_ai: boolean } | null;
}

function buildSystemPrompt(): string {
    return `Sos el Asistente BIENENHAUS, asistente virtual de BIENENHAUS Propiedades (inmobiliaria argentina).

REGLAS ESTRICTAS:
- Respondé SOLO con los datos reales provistos en el contexto (propiedades, leads, historial).
- NUNCA inventes precios, propiedades, datos o información que no esté en el contexto.
- Si no hay datos suficientes, decilo claro y ofrecé que un agente humano tome el control.
- Respondé en español rioplatense, tono profesional y cercano.
- Máximo ~250 palabras. Usá párrafos cortos o viñetas.
- NO reveles detalles internos (roles, RLS, técnicos, IDs internos).
- Sé útil, conciso y directo.`;
}

function formatPropertyContext(p: PropertyRow): string {
    const parts: string[] = [];
    if (p.title) parts.push(p.title);
    if (p.location?.name) parts.push(p.location.name);
    if (p.price != null && p.currency) {
        parts.push(`${p.currency} ${p.price.toLocaleString('es-AR')}`);
    }
    if (p.bedrooms) parts.push(`${p.bedrooms} dorm`);
    if (p.bathrooms) parts.push(`${p.bathrooms} baños`);
    if (p.area_total) parts.push(`${p.area_total} m² totales`);
    if (p.area_covered) parts.push(`${p.area_covered} m² cubiertos`);
    if (p.amenities?.length) parts.push(p.amenities.join(', '));
    if (p.status) parts.push(p.status.charAt(0).toUpperCase() + p.status.slice(1));
    return parts.join(' · ');
}

function formatLeadContext(l: LeadRow): string {
    const parts: string[] = [];
    const fullName = `${l.name} ${l.last_name}`.trim();
    if (fullName) parts.push(fullName);
    if (l.intent) parts.push(`Intención: ${l.intent}`);
    if (l.city) parts.push(l.city);
    if (l.status) parts.push(`Estado: ${l.status}`);
    if (l.source) parts.push(`Origen: ${l.source}`);
    return parts.join(' · ');
}

function formatHistory(messages: HistoryMessageRow[]): string {
    return messages
        .map((m) => {
            const role = m.sender?.is_ai ? 'IA' : 'Humano';
            const name = m.sender?.name ?? 'Desconocido';
            return `[${name}] (${role}): ${m.content}`;
        })
        .join('\n');
}

Deno.serve(async (req) => {
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    if (req.method === 'OPTIONS') return optionsResponse(req);
    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });

    // 1. Auth: staff/admin
    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });

    // 2. Caller user id (admin_users.id === agents.id)
    const {
        data: { user },
    } = await supabase.auth.getUser(token);
    const userId = user?.id ?? '';
    if (!userId) return respond(401, { error: 'No autorizado' });

    // 3. Rate limit per user (cost control)
    const rl = await checkRateLimit('chat-ai', userId);
    if (!rl.allowed) {
        return respond(429, { error: 'Rate limited', retry_after: rl.retryAfter });
    }

    // 4. Parse body
    let payload: { channel_id?: unknown; message_id?: unknown };
    try {
        payload = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' });
    }

    const channelId = typeof payload.channel_id === 'string' ? payload.channel_id.trim() : '';
    const messageId = typeof payload.message_id === 'string' ? payload.message_id.trim() : '';

    if (!channelId || !messageId) {
        return respond(400, { error: 'channel_id y message_id son requeridos' });
    }

    // 5. Verify message exists and belongs to channel + caller
    const { data: msg, error: msgError } = await supabase
        .from('chat_messages')
        .select('id, channel_id, sender_id, content, created_at, deleted_at')
        .eq('id', messageId)
        .maybeSingle();

    if (msgError) {
        console.error('[chat-ai] Error fetching message:', msgError);
        return respond(500, { error: 'Error interno' });
    }
    if (!msg) return respond(404, { error: 'Mensaje no encontrado' });
    if (msg.channel_id !== channelId) {
        return respond(400, { error: 'El mensaje no pertenece al canal' });
    }
    if (msg.sender_id !== userId) {
        return respond(400, { error: 'Solo el autor puede invocar al asistente' });
    }
    if (msg.deleted_at) return respond(200, { ok: true, skipped: 'deleted' });

    // 6. Verify caller is participant of the channel
    const { data: participant } = await supabase
        .from('chat_channel_participants')
        .select('id')
        .eq('channel_id', channelId)
        .eq('agent_id', userId)
        .maybeSingle();

    if (!participant) {
        return respond(403, { error: 'No sos participante del canal' });
    }

    // 7. Fetch AI agent
    const { data: aiAgent, error: aiError } = await supabase
        .from('agents')
        .select('id, name')
        .eq('is_ai', true)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (aiError) {
        console.error('[chat-ai] Error fetching AI agent:', aiError);
        return respond(500, { error: 'Error interno' });
    }
    if (!aiAgent) {
        return respond(500, { error: 'Asistente IA no configurado' });
    }

    // 8. Fetch channel
    const { data: channel, error: channelError } = await supabase
        .from('chat_channels')
        .select('type, name, property_id, lead_id')
        .eq('id', channelId)
        .maybeSingle();

    if (channelError) {
        console.error('[chat-ai] Error fetching channel:', channelError);
        return respond(500, { error: 'Error interno' });
    }
    if (!channel) return respond(404, { error: 'Canal no encontrado' });

    // 9. Build context blocks
    const contextBlocks: string[] = [];

    if (channel.name) {
        contextBlocks.push(`Canal: ${channel.name}`);
    }

    if (channel.type === 'property' && channel.property_id) {
        const { data: property } = await supabase
            .from('properties')
            .select(
                'code, title, price, currency, address, location:locations(name), area_total, area_covered, bedrooms, bathrooms, garages, year_built, description, amenities, status',
            )
            .eq('id', channel.property_id)
            .maybeSingle();

        if (property) {
            contextBlocks.push(`Propiedad: ${formatPropertyContext(property as PropertyRow)}`);
        }
    }

    if (channel.type === 'lead' && channel.lead_id) {
        const { data: lead } = await supabase
            .from('leads')
            .select('name, last_name, intent, city, status, source')
            .eq('id', channel.lead_id)
            .maybeSingle();

        if (lead) {
            contextBlocks.push(`Lead: ${formatLeadContext(lead as LeadRow)}`);
        }
    }

    // 10. Fetch history (last 20 messages before the triggering message)
    const { data: history } = await supabase
        .from('chat_messages')
        .select('content, sender_id, created_at, sender:agents(name, is_ai)')
        .eq('channel_id', channelId)
        .is('deleted_at', null)
        .lt('created_at', msg.created_at)
        .order('created_at', { ascending: false })
        .limit(20);

    const historyMessages = (history ?? []).reverse() as HistoryMessageRow[];
    const historyText = formatHistory(historyMessages);

    // 11. Build user content for Gemini
    const contextText =
        contextBlocks.length > 0 ? contextBlocks.join('\n') : 'Sin contexto adicional.';
    const userContent = `${contextText}\n\n--- Historial reciente ---\n${
        historyText || '(sin historial previo)'
    }\n\n--- Pregunta del usuario ---\n${msg.content}`;

    // 12. Check Gemini API key
    if (!GEMINI_API_KEY) {
        return respond(503, { error: 'Asistente IA no configurado (falta GEMINI_API_KEY)' });
    }

    // 13. Call Gemini Flash
    let geminiResponse: Response;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        geminiResponse = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: buildSystemPrompt() }] },
                contents: [{ role: 'user', parts: [{ text: userContent }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
    } catch (err) {
        console.error('[chat-ai] Network error calling Gemini:', err);
        return respond(504, { error: 'El asistente tardó demasiado' });
    }

    // 14. Parse Gemini response
    let data: Record<string, unknown>;
    try {
        data = await geminiResponse.json();
    } catch {
        return respond(502, { error: 'Respuesta inválida del asistente' });
    }

    if (!geminiResponse.ok) {
        const errorMsg = (data.error?.message as string) ?? 'Error desconocido';
        console.error('[chat-ai] Gemini error:', errorMsg);
        return respond(502, { error: errorMsg.slice(0, 300) });
    }

    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text as string) ?? '';
    const trimmedText = text.trim();

    if (!trimmedText) {
        return respond(502, { error: 'Respuesta vacía del asistente' });
    }

    // 15. Insert AI reply (service_role bypasses RLS)
    const { data: inserted, error: insertError } = await supabase
        .from('chat_messages')
        .insert({
            channel_id: channelId,
            sender_id: aiAgent.id,
            content: trimmedText,
            message_type: 'text',
        })
        .select('id')
        .single();

    if (insertError) {
        console.error('[chat-ai] Error inserting AI reply:', insertError);
        return respond(500, { error: 'Error guardando respuesta' });
    }

    // 16. Success
    return respond(200, { ok: true, message_id: inserted.id });
});
