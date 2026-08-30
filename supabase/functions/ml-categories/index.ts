import { createClient } from 'npm:@supabase/supabase-js@2';
import { fetchMlCategories, runMlApiCallWithRetry } from '../_shared/ml.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

Deno.serve(async (req) => {
    const respond = (status: number, body: unknown): Response => jsonResponse(status, body, req);
    if (req.method === 'OPTIONS') return optionsResponse(req);

    const rl = await rateLimitMiddleware('ml-categories', req);
    if (rl) return rl;

    if (req.method !== 'GET') return respond(405, { error: 'Method not allowed' });

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });

    try {
        const url = new URL(req.url);
        const parentId = url.searchParams.get('parent_id') ?? 'MLA1459';
        const result = await runMlApiCallWithRetry(
            token,
            () => fetchMlCategories(token, parentId),
            'fetchMlCategories',
        );
        if (!result.ok) {
            return respond(429, { error: result.error, retry_after: 60 });
        }
        return respond(200, result.data);
    } catch (err) {
        console.error('[ml-categories] Error sincronizando categorías:', err);
        return respond(500, { error: (err as Error).message });
    }
});
