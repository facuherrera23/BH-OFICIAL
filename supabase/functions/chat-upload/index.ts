/**
 * chat-upload — Upload de adjuntos del chat interno.
 *
 * Recibe un archivo multipart, lo sube al bucket `chat-files` y crea el
 * mensaje correspondiente en `chat_messages` (message_type image|file).
 * Auth: staff/admin (JWT). Valida que el sender sea el usuario autenticado.
 *
 * Contrato: POST multipart { file, channelId, senderId } → mensaje creado.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// Mismos campos que el frontend usa en chat.ts (select de mensajes)
const MESSAGE_SELECT = `
    id, channel_id, sender_id, content, message_type,
    file_url, file_name, file_size,
    reply_to_id, edited_at, created_at, updated_at, deleted_at,
    sender:agents(name, photo_url)
`;

function safeFileName(name: string): string {
    // Elimina separadores de path y caracteres problemáticos
    const base = name.replace(/[\\/]/g, '_').replace(/[^\w.\- ]+/g, '_').trim();
    return base.slice(0, 120) || 'archivo';
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);

    if (req.method !== 'POST') {
        return jsonResponse(405, { error: 'Method not allowed' }, req);
    }

    // 1. Auth: staff/admin
    const token = await requireAdmin(req, supabase);
    if (!token) return jsonResponse(401, { error: 'No autorizado' }, req);

    // 2. Caller user id (admin_users.id === agents.id)
    const {
        data: { user },
    } = await supabase.auth.getUser(token);
    const userId = user?.id ?? '';
    if (!userId) return jsonResponse(401, { error: 'No autorizado' }, req);

    // 3. Rate limit por usuario (abuso de storage/costo)
    const rl = await checkRateLimit('chat-upload', userId);
    if (!rl.allowed) {
        return jsonResponse(429, { error: 'Rate limited', retry_after: rl.retryAfter }, req);
    }

    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        const channelId = formData.get('channelId') as string;
        const senderId = formData.get('senderId') as string;

        if (!file) {
            return jsonResponse(400, { error: 'No file provided' }, req);
        }
        if (!channelId || !senderId) {
            return jsonResponse(400, { error: 'channelId y senderId son requeridos' }, req);
        }
        // El sender debe ser el usuario autenticado (no se puede suplantar)
        if (senderId !== userId) {
            return jsonResponse(403, { error: 'Sender no autorizado' }, req);
        }

        // Validate file type
        if (!ALLOWED_TYPES.includes(file.type)) {
            return jsonResponse(400, { error: `Tipo no permitido: ${file.type}` }, req);
        }

        // Validate file size
        if (file.size > MAX_SIZE) {
            return jsonResponse(400, { error: `Archivo supera ${MAX_SIZE / 1024 / 1024} MB` }, req);
        }

        const buffer = new Uint8Array(await file.arrayBuffer());
        const safeName = safeFileName(file.name);
        const path = `chat-files/${channelId}/${Date.now()}-${safeName}`;

        // Upload original
        const { error: uploadError } = await supabase.storage
            .from('chat-files')
            .upload(path, buffer, { contentType: file.type });
        if (uploadError) throw uploadError;

        // Bucket privado (staff-only, migración 0047): URL firmada de 30 días
        const signed = await supabase.storage
            .from('chat-files')
            .createSignedUrl(path, 60 * 60 * 24 * 30);
        if (signed.error) throw signed.error;
        const fileUrl = signed.data?.signedUrl ?? '';

        // Insert message
        const { data: msg, error: insertError } = await supabase
            .from('chat_messages')
            .insert({
                channel_id: channelId,
                sender_id: senderId,
                content: file.name,
                message_type: file.type.startsWith('image/') ? 'image' : 'file',
                file_url: fileUrl,
                file_name: file.name,
                file_size: file.size,
            })
            .select(MESSAGE_SELECT)
            .single();

        if (insertError) throw insertError;

        return jsonResponse(200, msg, req);
    } catch (err) {
        console.error('[chat-upload] Error:', err);
        return jsonResponse(500, { error: (err as Error).message }, req);
    }
});
