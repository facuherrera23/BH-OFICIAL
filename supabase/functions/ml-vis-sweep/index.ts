// ============================================================
// ml-vis-sweep — Red de seguridad para consultas de Mercado Libre.
//
// El problema estructural: ML desactiva los tópicos de notificaciones
// ("fall back") si el callback no responde ~500ms (cold starts de edge
// functions tras un deploy lo disparan) — incidente real 24-26/10:
// 48 horas de consultas sin entrar al CRM mientras el dueño las veía
// en el panel de ML (caso Walter Caiola: 2 consultas sin respuesta).
//
// Este barrido corre por cron cada 30 min (pg_cron, patrón x-sync-secret
// contra zernio_config): trae el listado de buyers/consultas de los
// últimos 3 días y RE-INYECTA al webhook las que NO tienen lead en el
// CRM. El flujo normal (handleVisLeads) hace el resto: crea el lead
// con identidad, marca anónimas si no hay, responde preguntas nuevas.
// Idempotente: leads.ml_lead_id UNIQUE + claim del ledger evitan
// duplicar lo que ya existe.
//
// Auth: x-sync-secret (igual que backup-snapshot/zernio-sync) — solo
// pg_cron lo conoce. verify_jwt OFF (está en NO_VERIFY del deploy.yml).
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getMlAccessToken } from '../_shared/auto_reply.ts';
import { getMlCredentials, runMlApiCallWithRetry } from '../_shared/ml.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const ML_API = 'https://api.mercadolibre.com';
/* 3 días de ventana: cubre un fin de semana completo de outage sin
   re-procesar demasiado historial. */
const WINDOW_DAYS = 3;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function respond(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function getSyncSecret(): Promise<string> {
    const { data } = await supabase.from('zernio_config').select('value').eq('key', 'sync_secret').maybeSingle();
    return data?.value?.secret || '';
}

interface CollectedLead {
    id: string;
    contact_type: string;
    item_id: string | null;
}

Deno.serve(async (req: Request) => {
    if (req.method !== 'POST') return respond(405, { error: 'Método no permitido' });

    const secret = await getSyncSecret();
    if (secret && req.headers.get('x-sync-secret') !== secret) {
        return respond(401, { error: 'No autorizado' });
    }

    try {
        const { data: conn } = await supabase
            .from('ml_connection')
            .select('id, user_id')
            .eq('is_active', true)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!conn?.user_id) return respond(200, { ok: true, skipped: 'sin conexión ML' });

        const settings = await getMlCredentials(supabase);
        const accessToken = await getMlAccessToken(supabase);

        /* 1. Listado de consultas (buyers + guests) de la ventana */
        const dateFrom = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
        const collected: CollectedLead[] = [];
        for (let offset = 0; offset < 150; offset += 50) {
            const buyersResult = await runMlApiCallWithRetry(
                accessToken as string,
                async () => {
                    const r = await fetch(
                        `${ML_API}/vis/users/${conn.user_id}/leads/buyers?offset=${offset}&limit=50&date_from=${dateFrom}&include_guest=true`,
                        { headers: { authorization: `Bearer ${accessToken}` } },
                    );
                    if (!r.ok) throw new Error(`buyers HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
                    return r.json();
                },
                'mlVisSweepBuyers',
            );
            if ('error' in buyersResult) throw new Error(buyersResult.error);

            const data = buyersResult.data as {
                results?: Array<{ item_id?: string; leads?: Array<{ id?: string; contact_type?: string }> }>;
                guest?: Array<{ item_id?: string; leads?: Array<{ id?: string; contact_type?: string }> }>;
                paging?: { total?: number };
            };
            let added = 0;
            for (const buyer of data.results ?? []) {
                for (const l of buyer.leads ?? []) {
                    if (!l?.id) continue;
                    collected.push({ id: l.id, contact_type: l.contact_type ?? 'contacto', item_id: buyer.item_id ?? null });
                    added++;
                }
            }
            for (const g of data.guest ?? []) {
                for (const l of g.leads ?? []) {
                    if (!l?.id) continue;
                    collected.push({ id: l.id, contact_type: l.contact_type ?? 'contacto', item_id: g.item_id ?? null });
                    added++;
                }
            }
            const total = data.paging?.total ?? collected.length;
            if (added === 0 || collected.length >= total) break;
        }

        /* 2. Filtrar: solo las consultas SIN lead en el CRM */
        const unique = [...new Map(collected.map((l) => [l.id, l])).values()];
        if (!unique.length) return respond(200, { ok: true, found: 0, missing: 0, injected: 0 });

        const { data: existing } = await supabase
            .from('leads')
            .select('ml_lead_id')
            .in('ml_lead_id', unique.map((l) => l.id));
        const existingIds = new Set((existing ?? []).map((r) => (r as { ml_lead_id: string }).ml_lead_id));
        const missing = unique.filter((l) => !existingIds.has(l.id));
        if (!missing.length) return respond(200, { ok: true, found: unique.length, missing: 0, injected: 0 });

        /* 3. Re-inyección al webhook (sent=now: el dedup de eventos no debe
           bloquear la recuperación — los dedups reales son de leads/ledger) */
        const webhookUrl = `${SUPABASE_URL}/functions/v1/ml-webhook`;
        let injected = 0;
        const errors: string[] = [];
        for (const l of missing) {
            try {
                const wRes = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        topic: 'vis_leads',
                        resource: `/vis/leads/${l.id}`,
                        user_id: Number(conn.user_id),
                        application_id: Number(settings.clientId),
                        attempts: 0,
                        sent: new Date().toISOString(),
                        received: new Date().toISOString(),
                        actions: [l.contact_type],
                    }),
                });
                if (wRes.ok) injected++;
                else errors.push(`${l.id}: HTTP ${wRes.status}`);
            } catch (err) {
                errors.push(`${l.id}: ${(err as Error).message}`);
            }
        }

        return respond(200, {
            ok: true,
            found: unique.length,
            missing: missing.length,
            injected,
            errors: errors.slice(0, 5),
        });
    } catch (err) {
        console.error('[ml-vis-sweep] error:', (err as Error).message);
        return respond(500, { ok: false, error: (err as Error).message });
    }
});
