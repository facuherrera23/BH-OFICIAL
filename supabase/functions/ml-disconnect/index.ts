import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('ml-disconnect', req);
    if (rl) return rl;

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });

    const { data: userData } = await supabase.auth.getUser(token);
    const adminId = userData?.user?.id;
    if (!adminId) return respond(401, { error: 'No autorizado' });

    const { data: active } = await supabase
        .from('ml_connection')
        .select('id, user_id, nickname')
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!active) return respond(200, { ok: true, message: 'No había conexión activa' });

    const { error } = await supabase
        .from('ml_connection')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', active.id);

    if (error) {
        return respond(500, { error: 'No se pudo desconectar', detail: error.message });
    }

    await supabase.from('audit_log').insert({
        action: 'ml_disconnect',
        module: 'portales',
        entity_type: 'ml_connection',
        entity_id: active.id,
        entity_label: active.nickname ?? active.user_id,
        actor_id: adminId,
        metadata: { event: 'oauth_disconnect', ml_user_id: active.user_id },
    });

    return respond(200, {
        ok: true,
        message: 'Cuenta de Mercado Libre desconectada',
        disconnected_user_id: active.user_id,
    });
});
