import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import {
    getMlCredentials,
    getMe,
    getRegisteredMlWebhookTopics,
    runMlApiCallWithRetry,
} from '../_shared/ml.ts';
import { decrypt } from '../_shared/crypto.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

interface ActiveConnection {
    id: string;
    user_id: string;
    nickname: string | null;
    email: string | null;
    site_id: string | null;
    access_token_encrypted: string;
    access_token_iv: string;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('ml-portal-status', req);
    if (rl) return rl;

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });

    const url = new URL(req.url);
    const includeWebhooks = url.searchParams.get('webhooks') === '1';

    const { data: conn } = await supabase
        .from('ml_connection')
        .select(
            'id, user_id, nickname, email, site_id, access_token_encrypted, access_token_iv, token_expires_at, updated_at',
        )
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    const { data: counts } = await supabase
        .from('ml_listings')
        .select('status', { count: 'exact', head: false });

    const listingsByStatus: Record<string, number> = {};
    (counts ?? []).forEach((row) => {
        const s = String((row as { status?: string }).status ?? 'unknown');
        listingsByStatus[s] = (listingsByStatus[s] ?? 0) + 1;
    });

    const { data: recentListings } = await supabase
        .from('ml_listings')
        .select('id, property_id, ml_item_id, status, permalink, price, last_synced_at')
        .order('last_synced_at', { ascending: false, nullsFirst: false })
        .limit(20);

    const settings = await getMlCredentials(supabase);
    const hasCredentials = !!settings.clientId && !!settings.clientSecret;

    if (!conn) {
        return respond(200, {
            connected: false,
            has_credentials: hasCredentials,
            credentials_source: Deno.env.get('ML_CLIENT_ID') ? 'env' : 'db',
            user: null,
            listings: [],
            listings_count: 0,
            listings_by_status: listingsByStatus,
            message: hasCredentials
                ? 'Credenciales configuradas. Hacé click en "Conectar ML" para vincular tu cuenta.'
                : 'No hay credenciales configuradas.',
        });
    }

    let user: { id: number; nickname: string; email: string; site_id: string } | null = null;
    let userError: string | null = null;
    try {
        const accessToken = await decrypt(
            (conn as ActiveConnection).access_token_encrypted,
            (conn as ActiveConnection).access_token_iv,
        );
        const meResult = await runMlApiCallWithRetry(
            accessToken,
            () => getMe(accessToken),
            'getMe',
        );
        if (meResult.ok) {
            user = meResult.data;
        } else {
            userError = meResult.error;
        }
    } catch (err) {
        userError = (err as Error).message;
    }

    let webhooks: Record<string, boolean> | null = null;
    if (includeWebhooks && user) {
        try {
            const accessToken = await decrypt(
                (conn as ActiveConnection).access_token_encrypted,
                (conn as ActiveConnection).access_token_iv,
            );
            webhooks = await getRegisteredMlWebhookTopics(accessToken, user.id);
        } catch (err) {
            webhooks = { error: (err as Error).message.slice(0, 100) } as unknown as Record<
                string,
                boolean
            >;
        }
    }

    return respond(200, {
        connected: true,
        has_credentials: hasCredentials,
        user: user ?? {
            id: Number((conn as ActiveConnection).user_id),
            nickname: (conn as ActiveConnection).nickname ?? '',
            email: (conn as ActiveConnection).email ?? '',
            site_id: (conn as ActiveConnection).site_id ?? 'MLA',
        },
        user_error: userError,
        listings: recentListings ?? [],
        listings_count: (counts ?? []).length,
        listings_by_status: listingsByStatus,
        webhooks,
        last_connected_at: (conn as { updated_at?: string }).updated_at ?? null,
    });
});
