import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    getAccessToken,
    type MlConnectionRow,
    categorizeMlError,
    MlErrorType,
    fetchWithTimeout,
    runMlApiCallWithRetry,
} from '../_shared/ml.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

async function getActiveConnection(): Promise<{
    access_token: string;
    user_id: number;
    site_id: string;
} | null> {
    const { data: conns } = await supabase
        .from('ml_connection')
        .select(
            'id, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, token_expires_at, user_id, site_id',
        )
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1);

    const conn = (conns?.[0] ?? null) as
        (MlConnectionRow & { user_id: number; site_id: string }) | null;
    if (!conn) return null;

    const accessToken = await getAccessToken(supabase, conn);
    return { access_token: accessToken, user_id: conn.user_id, site_id: conn.site_id };
}

interface MlItemMetrics {
    item_id: string;
    title: string;
    visits: number;
    questions: number;
    sold_quantity: number;
    available_quantity: number;
    price: number;
    currency_id: string;
    status: string;
    permalink: string;
}

interface MlVisitsResponse {
    item_id: string;
    visits: number;
}

interface MlQuestionsResponse {
    questions: Array<{
        id: string;
        item_id: string;
        from: { id: number; nickname: string };
        text: string;
        status: 'UNANSWERED' | 'ANSWERED' | 'CLOSED';
        date_created: string;
        answer?: { text: string; status: 'ACTIVE' | 'DISABLED'; date_created: string };
    }>;
}

interface MlOrdersResponse {
    orders: Array<{
        id: string;
        date_created: string;
        status: string;
        total_amount: number;
        currency_id: string;
        buyer: { id: number; nickname: string };
        order_items: Array<{
            item: { id: string; title: string; quantity: number; unit_price: number };
        }>;
    }>;
}

interface MlOrderResponse {
    id: string;
    date_created: string;
    status: string;
    total_amount: number;
    currency_id: string;
    buyer: { id: number; nickname: string };
    order_items: Array<{
        item: { id: string; title: string; quantity: number; unit_price: number };
    }>;
}

async function fetchMlMetrics(
    accessToken: string,
    userId: number,
): Promise<{
    items: MlItemMetrics[];
    total_visits: number;
    total_questions: number;
    unanswered_questions: number;
    total_sales: number;
    total_revenue: number;
    conversion_rate: number;
}> {
    // Get user's items
    const itemsResult = await runMlApiCallWithRetry(
        accessToken,
        () => fetchWithTimeout(`https://api.mercadolibre.com/users/${userId}/items/search`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        }),
        'fetchUserItems',
    );
    if (!itemsResult.ok) throw new Error(itemsResult.error);
    const itemsRes = itemsResult.data;
    const itemsData = await itemsRes.json();
    const itemIds = itemsData.results || [];

    if (itemIds.length === 0) {
        return {
            items: [],
            total_visits: 0,
            total_questions: 0,
            unanswered_questions: 0,
            total_sales: 0,
            total_revenue: 0,
            conversion_rate: 0,
        };
    }

    // Fetch metrics for all items (batch)
    const itemsMetrics: MlItemMetrics[] = [];
    const batchSize = 20;
    let totalVisits = 0;
    let totalQuestions = 0;
    let unansweredQuestions = 0;

    for (let i = 0; i < itemIds.length; i += batchSize) {
        const batch = itemIds.slice(i, i + batchSize);
        const idsParam = batch.join(',');

        // Get item details
        const detailsResult = await runMlApiCallWithRetry(
            accessToken,
            () => fetchWithTimeout(`https://api.mercadolibre.com/items?ids=${idsParam}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            }),
            'fetchItemDetails',
        );
        if (!detailsResult.ok) throw new Error(detailsResult.error);
        const detailsRes = detailsResult.data;
        const detailsData = await detailsRes.json();

        for (const itemResult of detailsData) {
            if (itemResult.code === 200 && itemResult.body) {
                const item = itemResult.body;
                itemsMetrics.push({
                    item_id: item.id,
                    title: item.title,
                    visits: 0, // Will fetch from visits API
                    questions: 0,
                    sold_quantity: item.sold_quantity || 0,
                    available_quantity: item.available_quantity || 0,
                    price: item.price || 0,
                    currency_id: item.currency_id || 'ARS',
                    status: item.status || 'unknown',
                    permalink: item.permalink || '',
                });
                totalVisits += 0; // Visits need separate API
            }
        }
    }

    // Fetch visits for all items (using visits API)
    try {
        const visitsResult = await runMlApiCallWithRetry(
            accessToken,
            () => fetchWithTimeout(`https://api.mercadolibre.com/items/visits?ids=${itemIds.join(',')}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            }),
            'fetchVisits',
        );
        if (!visitsResult.ok) throw new Error(visitsResult.error);
        const visitsRes = visitsResult.data;
        const visitsData = (await visitsRes.json()) as MlVisitsResponse[];

        for (const visitData of visitsData) {
            const metric = itemsMetrics.find((m) => m.item_id === visitData.item_id);
            if (metric) {
                metric.visits = visitData.visits || 0;
                totalVisits += visitData.visits || 0;
            }
        }
    } catch (error) {
        console.error('[ml-metrics] visits fetch failed:', error);
    }

    // Fetch questions for all items
    for (let i = 0; i < itemIds.length; i += batchSize) {
        const batch = itemIds.slice(i, i + batchSize);
        const idsParam = batch.join(',');

        try {
            const questionsResult = await runMlApiCallWithRetry(
                accessToken,
                () => fetchWithTimeout(`https://api.mercadolibre.com/questions/search?item_ids=${idsParam}&limit=50`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                }),
                'fetchQuestions',
            );
            if (!questionsResult.ok) throw new Error(questionsResult.error);
            const questionsRes = questionsResult.data;
            const questionsData = (await questionsRes.json()) as MlQuestionsResponse;

            for (const q of questionsData.questions || []) {
                const metric = itemsMetrics.find((m) => m.item_id === q.item_id);
                if (metric) {
                    metric.questions += 1;
                    totalQuestions += 1;
                    if (q.status === 'UNANSWERED') unansweredQuestions += 1;
                }
            }
        } catch (error) {
            console.error('[ml-metrics] questions fetch failed:', error);
        }
    }

    // Fetch recent orders/sales
    let totalSales = 0;
    let totalRevenue = 0;

    try {
        const ordersResult = await runMlApiCallWithRetry(
            accessToken,
            () => fetchWithTimeout(`https://api.mercadolibre.com/orders/search?seller_id=${userId}&limit=50&sort=date_desc`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            }),
            'fetchOrders',
        );
        if (!ordersResult.ok) throw new Error(ordersResult.error);
        const ordersRes = ordersResult.data;
        const ordersData = (await ordersRes.json()) as MlOrdersResponse;

        for (const order of ordersData.orders || []) {
            if (['paid', 'shipped', 'delivered'].includes(order.status)) {
                totalSales += 1;
                totalRevenue += order.total_amount || 0;
            }
        }
    } catch (error) {
        console.error('[ml-metrics] orders fetch failed:', error);
    }

    const conversionRate = totalVisits > 0 ? (totalSales / totalVisits) * 100 : 0;

    return {
        items: itemsMetrics,
        total_visits: totalVisits,
        total_questions: totalQuestions,
        unanswered_questions: unansweredQuestions,
        total_sales: totalSales,
        total_revenue: totalRevenue,
        conversion_rate: Math.round(conversionRate * 100) / 100,
    };
}

Deno.serve(async (req) => {
    const respond = (status: number, body: unknown): Response => jsonResponse(status, body, req);
    if (req.method === 'OPTIONS') return optionsResponse(req);
    if (req.method !== 'GET') return respond(405, { error: 'Method not allowed' });

    const rl = await rateLimitMiddleware('ml-metrics', req);
    if (rl) return rl;

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });

    const connection = await getActiveConnection();
    if (!connection) return respond(400, { error: 'No hay cuenta de Mercado Libre conectada' });

    try {
        const metrics = await fetchMlMetrics(connection.access_token, connection.user_id);
        return respond(200, metrics);
    } catch (err) {
        return respond(500, { error: (err as Error).message });
    }
});
