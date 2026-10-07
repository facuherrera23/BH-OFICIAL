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
import { getMlAccessToken } from '../_shared/auto_reply.ts';

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

interface VisLeadRow {
    id: string;
    contact_type: string;
    created_at: string;
    external_id: string | null;
    item_id: string | null;
    buyer_name: string | null;
    buyer_email: string | null;
    buyer_phone: string | null;
}

interface VisLeadsImportSummary {
    total: number;
    imported: number;
    failed: number;
    errors: string[];
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
    const includeLeads = url.searchParams.get('leads') === '1';
    const importLeads = url.searchParams.get('import') === '1';
    const leadsDays = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);

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
    /* getMlAccessToken auto-refresca el token (CAS) — el decrypt manual usaba el
       token guardado aunque hubiera expirado, rompiendo getMe y el estado de
       webhooks del panel ("Token ML vencido" que se arregla solo al refrescar). */
    let accessToken: string | null = null;
    try {
        accessToken = await getMlAccessToken(supabase);
    } catch (err) {
        userError = (err as Error).message;
    }
    if (accessToken) {
        try {
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
    }

    let webhooks: Record<string, boolean | string> | null = null;
    if (includeWebhooks && user && accessToken) {
        try {
            webhooks = await getRegisteredMlWebhookTopics(accessToken, user.id);
        } catch (err) {
            webhooks = { error: (err as Error).message.slice(0, 100) } as unknown as Record<string, boolean | string>;
        }
    }

    /* Preguntas reales recibidas en ML (mismo patrón que ml-metrics: items del
       vendedor -> questions/search por lotes de 20 item_ids). Base para backfill
       y para validar el webhook con datos reales. */
    let recentQuestions: MlRecentQuestion[] | null = null;
    if (includeQuestions && user && accessToken) {
        try {
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

    /* Contactos de inmuebles (VIS leads): listado paginado desde ML y, con
       import=1, re-inyección de cada lead como notificación vis_leads al webhook.
       Así entran al CRM por el camino productivo (mismo dedup ml_lead_id, mismo
       enriquecimiento). Recupera las consultas que el webhook anterior rechazaba
       con 400 'Invalid JSON' cuando el tópico vis_leads no estaba en el enum. */
    let visLeads: VisLeadRow[] | null = null;
    let visLeadsImport: VisLeadsImportSummary | null = null;
    let visLeadsDebug: string | null = null;
    if (includeLeads && accessToken) {
        try {
            const dateFrom = new Date(Date.now() - leadsDays * 86_400_000).toISOString().slice(0, 10);
            const collected: VisLeadRow[] = [];
            let total = 0;
            for (let offset = 0; offset < 300; offset += 50) {
                const buyersRes = await fetchWithTimeout(
                    `${ML_API}/vis/users/${(conn as ActiveConnection).user_id}/leads/buyers?offset=${offset}&limit=50&date_from=${dateFrom}&include_guest=true`,
                    { headers: { authorization: `Bearer ${accessToken}` } },
                );
                if (!buyersRes.ok) {
                    visLeadsDebug = `buyers HTTP ${buyersRes.status}: ${(await buyersRes.text()).slice(0, 300)}`;
                    break;
                }
                const data = (await buyersRes.json()) as {
                    results?: Array<{
                        item_id?: string;
                        name?: string | null;
                        email?: string | null;
                        phone?: string | null;
                        leads?: Array<{
                            id?: string;
                            contact_type?: string;
                            created_at?: string;
                            external_id?: string | null;
                            item_id?: string;
                        }>;
                    }>;
                    guest?: Array<{
                        item_id?: string;
                        leads?: Array<{ id?: string; contact_type?: string; created_at?: string }>;
                    }>;
                    paging?: { total?: number };
                };
                let added = 0;
                for (const buyer of data.results ?? []) {
                    for (const l of buyer.leads ?? []) {
                        if (!l.id) continue;
                        collected.push({
                            id: l.id,
                            contact_type: l.contact_type ?? 'contacto',
                            created_at: l.created_at ?? new Date().toISOString(),
                            external_id: l.external_id ?? null,
                            item_id: l.item_id ?? buyer.item_id ?? null,
                            buyer_name: buyer.name ?? null,
                            buyer_email: buyer.email ?? null,
                            buyer_phone: buyer.phone ?? null,
                        });
                        added++;
                    }
                }
                for (const g of data.guest ?? []) {
                    for (const l of g.leads ?? []) {
                        if (!l.id) continue;
                        collected.push({
                            id: l.id,
                            contact_type: l.contact_type ?? 'contacto',
                            created_at: l.created_at ?? new Date().toISOString(),
                            external_id: null,
                            item_id: g.item_id ?? null,
                            buyer_name: null,
                            buyer_email: null,
                            buyer_phone: null,
                        });
                        added++;
                    }
                }
                total = data.paging?.total ?? collected.length;
                if (added === 0 || collected.length >= total) break;
            }
            const seen = new Set<string>();
            visLeads = collected
                .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .slice(0, 300);

            if (importLeads && visLeads.length) {
                const webhookUrl = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/ml-webhook`;
                const summary: VisLeadsImportSummary = {
                    total: visLeads.length,
                    imported: 0,
                    failed: 0,
                    errors: [],
                };
                for (const l of visLeads) {
                    let ok = false;
                    let errMsg = '';
                    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
                        try {
                            const wRes = await fetch(webhookUrl, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({
                                    topic: 'vis_leads',
                                    resource: `/vis/leads/${l.id}`,
                                    user_id: Number((conn as ActiveConnection).user_id),
                                    application_id: Number(settings.clientId),
                                    attempts: 0,
                                    sent: l.created_at,
                                    received: new Date().toISOString(),
                                    actions: [l.contact_type],
                                }),
                            });
                            if (wRes.ok) {
                                ok = true;
                                break;
                            }
                            if (wRes.status === 429) {
                                await new Promise((r) =>
                                    setTimeout(
                                        r,
                                        (Number(wRes.headers.get('retry-after')) || 5) * 1000,
                                    ),
                                );
                                errMsg = 'rate_limited';
                                continue;
                            }
                            errMsg = `HTTP ${wRes.status}: ${(await wRes.text()).slice(0, 120)}`;
                            break;
                        } catch (err) {
                            errMsg = (err as Error).message;
                        }
                    }
                    if (ok) {
                        summary.imported++;
                    } else {
                        summary.failed++;
                        if (summary.errors.length < 10) summary.errors.push(`${l.id}: ${errMsg}`);
                    }
                    /* Pausa para no apilar demasiadas tareas background del webhook
                       (cada una pega la API de ML con el token del vendedor). */
                    await new Promise((r) => setTimeout(r, 300));
                }
                visLeadsImport = summary;
            }
        } catch (err) {
            visLeads = null;
            visLeadsDebug = (err as Error).message.slice(0, 300);
            if (importLeads) {
                visLeadsImport = {
                    total: 0,
                    imported: 0,
                    failed: 0,
                    errors: [(err as Error).message.slice(0, 200)],
                };
            }
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
        vis_leads: visLeads,
        vis_leads_import: visLeadsImport,
        vis_leads_debug: visLeadsDebug,
        last_connected_at: (conn as { updated_at?: string }).updated_at ?? null,
    });
});
