// ============================================================
// tasacion-submit — Solicitud pública de tasación (2026-11-02).
//
// Decisión del dueño: el tasacionero es herramienta interna de los
// agentes. El visitante público NO hace la tasación — la PIDE desde
// el formulario de tasacion.html (contacto + propiedad) y este
// endpoint SOLO crea el lead (source='tasacion') con el detalle en
// notes + actividad en su historial. NUNCA inserta en `tasaciones`:
// la tasación la crea después el agente desde ese lead, con el
// wizard interno.
//
// Defensas (patrón contact-submit): rate limit por IP (5/h),
// honeypot, validación estricta, consentimiento obligatorio
// (Ley 25.326), dedup de lead por teléfono (últimos 8 dígitos,
// 60 días — el dup agrega actividad al lead existente).
//
// Tolerancia al payload legacy `tasacion` (JS cacheado del modelo
// anterior): solo enriquece las notas del lead — jamás se persiste.
//
// verify_jwt OFF (pre-login) — está en NO_VERIFY del deploy.yml.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { ensureFirstContactTask } from '../_shared/firstContact.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

interface TasacionPayload {
    name?: string;
    phone?: string;
    email?: string;
    consent?: boolean;
    website?: string; // honeypot
    utm_source?: string;
    utm_campaign?: string;
    /* Solicitud del form público (2026-11-02) */
    solicitud?: {
        direccion?: string;
        tipo?: string;
        operacion?: string;
        superficie?: string;
        mensaje?: string;
    };
    /* LEGACY (JS cacheado del modelo anterior que mandaba la tasación
       completa): NUNCA se persiste — solo enriquece notas del lead. */
    tasacion?: {
        title?: string;
        data?: Record<string, unknown>;
    };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clip(s: string, max = 2000): string {
    return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

function clientIp(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        'unknown';
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    if (req.method !== 'POST') return jsonResponse(405, { error: 'Método no permitido' }, req);

    const ip = clientIp(req);
    const rl = await checkRateLimit('tasacion-submit', ip);
    if (!rl.allowed) {
        return jsonResponse(429, { error: 'Demasiados intentos. Probá más tarde.' }, req);
    }

    let payload: TasacionPayload;
    try {
        payload = await req.json();
    } catch {
        return jsonResponse(400, { error: 'JSON inválido' }, req);
    }

    // Honeypot: responder éxito falso y no persistir nada
    if (payload.website && payload.website.trim() !== '') {
        return jsonResponse(200, { ok: true }, req);
    }

    const name = clip(String(payload.name ?? ''), 150);
    const phone = clip(String(payload.phone ?? ''), 40);
    const email = clip(String(payload.email ?? ''), 200).toLowerCase();
    const digits = phone.replace(/\D/g, '');

    if (!name) return jsonResponse(400, { error: 'Falta el nombre' }, req);
    if (digits.length < 8) return jsonResponse(400, { error: 'Teléfono inválido' }, req);
    if (email && !EMAIL_RE.test(email)) return jsonResponse(400, { error: 'Email inválido' }, req);
    if (payload.consent !== true) {
        return jsonResponse(400, { error: 'Falta aceptar la política de privacidad' }, req);
    }

    /* Solicitud del form público (2026-11-02). El payload legacy `tasacion`
       (JS cacheado del modelo anterior) solo aporta dirección/tipo — jamás
       se persiste una tasación desde acá. */
    const s = (payload.solicitud && typeof payload.solicitud === 'object' ? payload.solicitud : {}) as Partial<NonNullable<TasacionPayload['solicitud']>>;
    const legacy = (payload.tasacion && typeof payload.tasacion === 'object' ? payload.tasacion : {}) as Partial<NonNullable<TasacionPayload['tasacion']>>;
    const legacyData = (legacy.data && typeof legacy.data === 'object' ? legacy.data : {}) as Record<string, unknown>;
    const legacyFields = (typeof legacyData.fields === 'object' && legacyData.fields !== null
        ? legacyData.fields : {}) as Record<string, string>;

    const sDireccion = clip(String(s.direccion ?? ''), 220);
    const sTipo = clip(String(s.tipo ?? ''), 40);
    const sOperacion = clip(String(s.operacion ?? ''), 40);
    const superficie = clip(String(s.superficie ?? ''), 60);
    const sMensaje = clip(String(s.mensaje ?? ''), 800);

    // Fallback legacy: dirección desde title/fields, operación desde f_destino.
    const direccion = sDireccion
        || clip(String(legacy.title ?? legacyFields.f_direccion ?? legacyFields.f_barrio ?? ''), 220);
    const operacion = sOperacion || clip(String(legacyFields.f_destino ?? ''), 40);
    const opLower = operacion.toLowerCase();

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // Detalle de la solicitud para el historial del lead.
    const detalle = [
        sTipo,
        operacion,
        superficie ? `sup. aprox. ${superficie}` : '',
    ].filter(Boolean).join(' · ');
    const notes = `Solicitud de tasación web — ${direccion || 'dirección no indicada'}`
        + (detalle ? ` (${detalle})` : '')
        + '\nEl propietario pide que un agente realice la tasación'
        + ' (análisis comparativo de mercado).'
        + (sMensaje ? `\nMensaje del propietario: ${sMensaje}` : '');

    // Lead: dedup por teléfono, últimos 8 dígitos, 60 días.
    let leadId: string | null = null;
    let duplicate = false;
    const { data: dup } = await supabase
        .from('leads')
        .select('id')
        .ilike('phone', `%${digits.slice(-8)}%`)
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 60 * 86400000).toISOString())
        .limit(1)
        .maybeSingle();

    if (dup) {
        duplicate = true;
        leadId = dup.id;
        await supabase.from('lead_activities').insert([{
            lead_id: dup.id,
            activity_type: 'note',
            title: 'Nueva solicitud de tasación (lead existente)',
            description: notes,
        }]);
        /* SLA de primer contacto: si el lead existente nunca fue contactado,
           esta nueva solicitud arranca (o reconfirma) el reloj. */
        await ensureFirstContactTask(supabase, dup.id, { channelLabel: 'tasación web' });
    } else {
        const { data: leadRow, error: leadErr } = await supabase.from('leads').insert([{
            full_name: name,
            email: email || null,
            phone,
            whatsapp: phone,
            source: 'tasacion',
            stage: 'nuevo',
            tipo_cliente: 'propietario',
            // "Alquilar" → alquiler; el resto (vender / solo el valor) → venta
            operation_type: opLower.startsWith('alquil') ? 'alquiler' : 'venta',
            notes,
            consent_at: new Date().toISOString(),
            utm_source: clip(String(payload.utm_source ?? ''), 120) || null,
            utm_campaign: clip(String(payload.utm_campaign ?? ''), 120) || null,
        }]).select('id').single();
        if (leadErr) {
            console.error('[tasacion-submit] lead insert error:', leadErr);
            return jsonResponse(500, { error: 'No pudimos registrar tu solicitud. Probá de nuevo.' }, req);
        }
        leadId = leadRow?.id ?? null;
        // Actividad inicial del historial (la misma traza que lee el agente).
        if (leadId) {
            await supabase.from('lead_activities').insert([{
                lead_id: leadId,
                activity_type: 'note',
                title: 'Solicitud de tasación web',
                description: notes,
            }]);
            /* SLA de primer contacto: el lead de tasación es el de MAYOR
               intención (pidió explícitamente una tasación) — nace con plazo. */
            await ensureFirstContactTask(supabase, leadId, { phone, channelLabel: 'tasación web' });
        }
    }

    return jsonResponse(200, { ok: true, lead: !!leadId, duplicate }, req);
});
