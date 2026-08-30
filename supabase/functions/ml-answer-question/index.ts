import { createClient } from 'npm:@supabase/supabase-js@2';
import { getMlAccessToken, sendQuestionAnswer } from '../_shared/auto_reply.ts';
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

    const rl = await rateLimitMiddleware('ml-answer-question', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });
    if (!(await isAdmin(req, supabase))) return respond(401, { error: 'No autorizado' });

    let payload: { question_id?: unknown; answer?: unknown };
    try {
        payload = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' });
    }

    const questionId = typeof payload.question_id === 'string' ? payload.question_id.trim() : '';
    const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
    if (!questionId || !answer) {
        return respond(400, { error: 'question_id y answer son requeridos' });
    }

    const { data: question } = await supabase
        .from('ml_questions')
        .select('id, question_id, status, ml_item_id')
        .eq('question_id', questionId)
        .maybeSingle();

    if (!question) {
        return respond(404, { error: 'Pregunta no encontrada' });
    }

    let accessToken: string;
    try {
        accessToken = (await getMlAccessToken(supabase)) ?? '';
        if (!accessToken) {
            return respond(400, { error: 'No hay una cuenta de Mercado Libre conectada' });
        }
    } catch (err) {
        console.error('[ml-answer-question] No se pudo obtener token ML:', err);
        return respond(500, { error: `No se pudo obtener token: ${(err as Error).message}` });
    }

    // Idempotency key based on question_id
    const idempotencyKey = `answer:${questionId}`;

    try {
        await sendQuestionAnswer(supabase, questionId, answer, accessToken, idempotencyKey);
    } catch (err) {
        console.error('[ml-answer-question] No se pudo responder en Mercado Libre:', err);
        return respond(502, {
            error: `No se pudo responder en Mercado Libre: ${(err as Error).message}`,
        });
    }

    return respond(200, { ok: true, question_id: questionId });
});
