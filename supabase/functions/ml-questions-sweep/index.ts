import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { getMlAccessToken } from '../_shared/auto_reply.ts';
import { ML_API, getMlCredentials, fetchWithTimeout } from '../_shared/ml.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);
    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });

    const clientIp =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        'cron';
    const rl = await checkRateLimit('ml-questions-sweep', clientIp);
    if (!rl.allowed) return respond(429, { error: 'Rate limited' });

    const [{ data: conn }, settings] = await Promise.all([
        supabase
            .from('ml_connection')
            .select('user_id')
            .eq('provider', 'mercadolibre')
            .eq('is_active', true)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        getMlCredentials(supabase),
    ]);
    if (!conn) return respond(200, { ok: true, skipped: 'sin conexión ML activa' });
    if (!settings.clientId) return respond(200, { ok: true, skipped: 'sin credenciales ML' });

    let token: string | null = null;
    try {
        token = await getMlAccessToken(supabase);
    } catch (err) {
        return respond(200, { ok: false, error: `ML token: ${(err as Error).message}` });
    }
    if (!token) return respond(200, { ok: false, error: 'ML token: no hay conexión ML activa' });

    /* Solo UNANSWERED: evita re-procesar el historial viejo ya contestado y las
       preguntas que el auto-reply del webhook ya cerró. */
    const qRes = await fetchWithTimeout(
        `${ML_API}/questions/search?seller_id=${conn.user_id}&status=UNANSWERED&limit=50`,
        { headers: { authorization: `Bearer ${token}` } },
    );
    if (!qRes.ok) {
        return respond(200, {
            ok: false,
            error: `ML questions HTTP ${qRes.status}: ${(await qRes.text()).slice(0, 200)}`,
        });
    }
    const qData = (await qRes.json()) as {
        questions?: Array<{ id?: number | string; date_created?: string }>;
    };
    const questions = qData.questions ?? [];

    const ids = questions.map((q) => String(q.id ?? '')).filter(Boolean);
    const { data: known } = ids.length
        ? await supabase.from('ml_questions').select('question_id').in('question_id', ids)
        : { data: [] as Array<{ question_id: string }> };
    const knownIds = new Set((known ?? []).map((r) => String(r.question_id)));

    const webhookUrl = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/ml-webhook`;
    let replayed = 0;
    const errors: string[] = [];
    for (const q of questions) {
        const id = String(q.id ?? '');
        if (!id || knownIds.has(id)) continue;
        try {
            const wRes = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    topic: 'questions',
                    resource: `/questions/${id}`,
                    user_id: Number(conn.user_id),
                    application_id: Number(settings.clientId),
                    attempts: 0,
                    sent: typeof q.date_created === 'string' ? q.date_created : new Date().toISOString(),
                    received: new Date().toISOString(),
                }),
            });
            if (wRes.ok) {
                replayed++;
            } else {
                errors.push(`${id}: HTTP ${wRes.status}`);
            }
        } catch (err) {
            errors.push(`${id}: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 250));
    }

    const nuevas = ids.filter((id) => !knownIds.has(id)).length;
    return respond(200, {
        ok: true,
        encontradas_sin_respuesta: questions.length,
        nuevas_para_crm: nuevas,
        reinyectadas: replayed,
        errors: errors.slice(0, 5),
    });
});
