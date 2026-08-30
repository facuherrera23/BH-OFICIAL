/**
 * Auto-respuesta para Mercado Libre: plantillas + envío de respuestas.
 * Compartido entre ml-webhook y ml-answer-question.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
    getAccessToken,
    ML_API,
    type MlConnectionRow,
    categorizeMlError,
    MlErrorType,
    runMlApiCallWithRetry,
} from './ml.ts';

/**
 * Ejecuta un fetch a la API de ML con manejo de rate limiting (429).
 * Usa el wrapper compartido runMlApiCallWithRetry para reintento automático.
 */
async function fetchMlWithRetry(
    fn: () => Promise<Response>,
    operationName: string,
): Promise<Response> {
    const result = await runMlApiCallWithRetry('', fn, operationName);
    if (!result.ok) {
        throw new Error(result.error);
    }
    return result.data;
}

/** Devuelve la plantilla activa para un trigger (p.ej. 'new_question'). */
export async function getActiveTemplate(
    supabase: SupabaseClient,
    trigger: string,
): Promise<{ id: number; message: string } | null> {
    const { data } = await supabase
        .from('ml_auto_reply_templates')
        .select('id, message')
        .eq('trigger', trigger)
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1);
    return (data?.[0] ?? null) as { id: number; message: string } | null;
}

/**
 * Devuelve el access token de la conexión ML activa, refrescándolo si
 * está por expirar. Retorna null si no hay conexión activa.
 */
export async function getMlAccessToken(supabase: SupabaseClient): Promise<string | null> {
    const { data } = await supabase
        .from('ml_connection')
        .select(
            'id, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, token_expires_at',
        )
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1);

    const conn = (data?.[0] ?? null) as MlConnectionRow | null;
    if (!conn) return null;

    return await getAccessToken(supabase, conn);
}

/**
 * Responde una pregunta en Mercado Libre y marca la pregunta como respondida.
 * Lanza un error si ML rechaza la respuesta.
 */
export async function sendQuestionAnswer(
    supabase: SupabaseClient,
    questionId: string,
    text: string,
    accessToken: string,
    idempotencyKey?: string,
): Promise<void> {
    const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-format-new': 'true',
    };
    if (idempotencyKey) {
        headers['x-idempotency-key'] = idempotencyKey;
    }

    const res = await fetchMlWithRetry(
        () =>
            fetch(`${ML_API}/answers?api_version=4`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ question_id: Number(questionId), text }),
            }),
        'sendQuestionAnswer',
    );

    const body = await res.text();
    if (!res.ok) {
        throw new Error(`ML answer falló (${res.status}): ${body.slice(0, 300)}`);
    }

    await supabase
        .from('ml_questions')
        .update({
            status: 'answered',
            answer_text: text,
            date_updated: new Date().toISOString(),
        })
        .eq('question_id', questionId);
}

/**
 * Envía un mensaje al comprador dentro del pack de una orden.
 * Endpoint de mensajes de órdenes de ML: POST /orders/{order_id}/messages.
 * Lanza un error si ML rechaza el envío.
 */
export async function sendOrderMessage(
    supabase: SupabaseClient,
    orderId: string,
    text: string,
    accessToken: string,
    idempotencyKey?: string,
): Promise<void> {
    const params = new URLSearchParams({
        message: text,
        mark_as_read: 'true',
    });
    const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
    };
    if (idempotencyKey) {
        headers['x-idempotency-key'] = idempotencyKey;
    }

    const res = await fetchMlWithRetry(
        () =>
            fetch(`${ML_API}/orders/${orderId}/messages?${params.toString()}`, {
                method: 'POST',
                headers,
            }),
        'sendOrderMessage',
    );

    const body = await res.text();
    if (!res.ok) {
        throw new Error(`ML order message falló (${res.status}): ${body.slice(0, 300)}`);
    }

    await supabase
        .from('ml_orders')
        .update({ auto_reply_sent: new Date().toISOString() })
        .eq('order_id', orderId);
}
