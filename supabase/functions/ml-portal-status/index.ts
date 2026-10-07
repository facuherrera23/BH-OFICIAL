import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import {
    getMlCredentials,
    getMe,
    getRegisteredMlWebhookTopics,
    runMlApiCallWithRetry,
    fetchWithTimeout,
    ML_API,
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

interface MlRecentQuestion {
    id: string;
    item_id: string;
    status: string;
    date_created: string | null;
    from_nickname: string | null;
    text_head: string | null;
    answered: boolean;
    answer_text_head: string | null;
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
    const includeQuestions = url.searchParams.get('questions') === '1';

    const [{ data: conn }, { data: counts }, { data: recentListings }, settings] = await Promise.all([
        supabase
            .from('ml_connection')
            .select(
                'id, user_id, nickname, email, site_id, access_token_encrypted, access_token_iv, token_expires_at, updated_at',
            )
            .eq('is_active', true)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        supabase
            .from('ml_listings')
            .select('ml_status', { count: 'exact', head: false }),
        supabase
            .from('ml_listings')
            .select('id, property_id, ml_item_id, ml_status, last_sync')
            .order('last_sync', { ascending: false, nullsFirst: false })
            .limit(20),
        getMlCredentials(supabase),
    ]);

    const listingsByStatus: Record<string, number> = {};
    (counts ?? []).forEach((row) => {
        const s = String((row as { ml_status?: string }).ml_status ?? 'unknown');
        listingsByStatus[s] = (listingsByStatus[s] ?? 0) + 1;
    });

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

    let webhooks: Record<string, boolean | string> | null = null;
    if (includeWebhooks && user) {
        try {
            const accessToken = await decrypt(
                (conn as ActiveConnection).access_token_encrypted,
                (conn as ActiveConnection).access_token_iv,
            );
            webhooks = await getRegisteredMlWebhookTopics(accessToken, user.id);
        } catch (err) {
            webhooks = { error: (err as Error).message.slice(0, 100) } as unknown as Record<string, boolean | string>;
        }
    }

    /* Preguntas reales recibidas en ML (mismo patrón que ml-metrics: items del
       vendedor -> questions/search por lotes de 20 item_ids). Base para backfill
       y para validar el webhook con datos reales. */
    let recentQuestions: MlRecentQuestion[] | null = null;
    if (includeQuestions && user) {
        try {
            const accessToken = await decrypt(
                (conn as ActiveConnection).access_token_encrypted,
                (conn as ActiveConnection).access_token_iv,
            );
            const itemsRes = await fetchWithTimeout(
                `${ML_API}/users/${(conn as ActiveConnection).user_id}/items/search`,
                { headers: { authorization: `Bearer ${accessToken}` } },
            );
            if (itemsRes.ok) {
                const itemsData = (await itemsRes.json()) as { results?: string[] };
                const itemIds = itemsData.results ?? [];
                const batches: string[][] = [];
                for (let i = 0; i < itemIds.length && batches.length < 3; i += 20) {
                    batches.push(itemIds.slice(i, i + 20));
                }
                const collected: MlRecentQuestion[] = [];
                await Promise.allSettled(
                    batches.map(async (batch) => {
                        const qRes = await fetchWithTimeout(
                            `${ML_API}/questions/search?item_ids=${batch.join(',')}&limit=50`,
                            { headers: { authorization: `Bearer ${accessToken}` } },
                        );
                        if (!qRes.ok) return;
                        const qData = (await qRes.json()) as {
                            questions?: Array<{
                                id?: number | string;
                                item_id?: string;
                                from?: { nickname?: string } | null;
                                text?: string | null;
                                status?: string;
                                date_created?: string;
                                answer?: { text?: string } | null;
                            }>;
                        };
                        for (const q of qData.questions ?? []) {
                            collected.push({
                                id: String(q.id ?? ''),
                                item_id: String(q.item_id ?? ''),
                                status: String(q.status ?? ''),
                                date_created: typeof q.date_created === 'string' ? q.date_created : null,
                                from_nickname: q.from?.nickname ?? null,
                                text_head: typeof q.text === 'string' ? q.text.slice(0, 140) : null,
                                answered: !!q.answer,
                                answer_text_head:
                                    typeof q.answer?.text === 'string' ? q.answer.text.slice(0, 140) : null,
                            });
                        }
                    }),
                );
                recentQuestions = collected
                    .sort((a, b) => (b.date_created ?? '').localeCompare(a.date_created ?? ''))
                    .slice(0, 20);
            }
        } catch {
            recentQuestions = null;
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
        questions: recentQuestions,
        last_connected_at: (conn as { updated_at?: string }).updated_at ?? null,
    });
});
