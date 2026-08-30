import { createClient } from 'npm:@supabase/supabase-js@2';
import { decrypt } from '../_shared/crypto.ts';
import { getAccessToken, ML_API, type MlConnectionRow } from '../_shared/ml.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { isAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

Deno.serve(async (req) => {
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);
    if (req.method === 'OPTIONS') return optionsResponse(req);

    const rl = await rateLimitMiddleware('ml-revoke-tokens', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });
    if (!(await isAdmin(req, supabase))) return respond(401, { error: 'No autorizado' });

    // Fetch the active ML connection
    const { data: connRaw, error: connErr } = await supabase
        .from('ml_connection')
        .select(
            'id, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, token_expires_at',
        )
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (connErr) return respond(500, { error: 'Error leyendo conexión ML' });
    const conn = connRaw as MlConnectionRow | null;
    if (!conn) return respond(404, { error: 'No hay conexión activa de ML' });

    const revokeErrors: string[] = [];

    // Revoke access token
    try {
        const accessToken = await getAccessToken(supabase, conn);
        const res = await fetch(`${ML_API}/oauth/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: accessToken }),
        });
        if (!res.ok) {
            const text = await res.text();
            revokeErrors.push(`access (${res.status}): ${text.slice(0, 200)}`);
        }
    } catch (e) {
        revokeErrors.push(`access: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Revoke refresh token
    try {
        const refreshToken = await decrypt(conn.refresh_token_encrypted, conn.refresh_token_iv);
        const res = await fetch(`${ML_API}/oauth/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken }),
        });
        if (!res.ok) {
            const text = await res.text();
            revokeErrors.push(`refresh (${res.status}): ${text.slice(0, 200)}`);
        }
    } catch (e) {
        revokeErrors.push(`refresh: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Delete the connection regardless of revoke outcome
    const { error: delErr } = await supabase
        .from('ml_connection')
        .delete()
        .eq('id', conn.id);

    if (delErr) {
        return respond(500, {
            error: 'Tokens revocados pero falló el borrado de la conexión',
            details: delErr.message,
        });
    }

    if (revokeErrors.length > 0) {
        return respond(207, {
            message: 'Conexión eliminada con errores parciales en revocación de tokens',
            revoke_errors: revokeErrors,
        });
    }

    return respond(200, { message: 'Tokens revocados y conexión eliminada' });
});
