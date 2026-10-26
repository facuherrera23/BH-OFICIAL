// ============================================================
// tasacion-submit — Punto de entrada público del tasacionero web.
//
// El visitante anónimo completa el análisis comparativo y al
// guardar/finalizar se le pide contacto (nombre + WhatsApp) para
// recibir el informe. Este endpoint:
//   1. Crea el lead en el CRM (source='tasacion') — un propietario
//      tasando es el lead más caliente que existe.
//   2. Persiste la tasación (created_by NULL, status 'draft') para
//      que aparezca en el panel de tasaciones del admin.
//
// Defensas (patrón contact-submit): rate limit por IP (5/h),
// honeypot, validación estricta, consentimiento obligatorio
// (Ley 25.326), fotos de comparables removidas server-side
// (payload acotado), dedup de lead por teléfono (60 días — agrega
// actividad al lead existente en vez de duplicarlo; la tasación
// se crea siempre porque cada análisis es un registro único).
//
// RLS de `tasaciones` es authenticated/service_role-only: el insert
// público pasa por acá (service_role) igual que leads en
// contact-submit. verify_jwt OFF (pre-login) — está en NO_VERIFY
// del deploy.yml.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

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
    tasacion?: {
        title?: string;
        data?: Record<string, unknown>;
        type?: string;
        valuation_usd?: number | null;
        valuation_ars?: number | null;
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

/* Higiene del data JSONB: las fotos base64 de los comparables pueden
   sumar megas — se remueven (queda la fachada, acotada). */
const MAX_FACHADA_CHARS = 900_000; // ~675 KB base64
function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...data };
    if (Array.isArray(out.comparables)) {
        out.comparables = (out.comparables as Record<string, unknown>[]).map((c) => {
            if (!c || typeof c !== 'object') return c;
            const comp = { ...c };
            delete comp.photo;
            return comp;
        });
    }
    if (typeof out.photo === 'string' && out.photo.length > MAX_FACHADA_CHARS) {
        delete out.photo;
    }
    return out;
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

    const t = payload.tasacion ?? {};
    const data = t.data && typeof t.data === 'object' ? sanitizeData(t.data) : {};
    const fields = (data.fields ?? {}) as Record<string, string>;
    const type = t.type === 'alquiler' ? 'alquiler' : 'venta';
    const title = clip(String(t.title || fields.f_direccion || fields.f_barrio || 'Tasación web'), 200);
    const valuationUsd = typeof t.valuation_usd === 'number' && isFinite(t.valuation_usd) && t.valuation_usd > 0
        ? t.valuation_usd
        : null;
    const valuationArs = typeof t.valuation_ars === 'number' && isFinite(t.valuation_ars) && t.valuation_ars > 0
        ? t.valuation_ars
        : null;
    const destino = clip(String(fields.f_destino ?? ''), 30);

    const valorTxt = type === 'alquiler'
        ? (valuationArs ? `$ ${Math.round(valuationArs).toLocaleString('es-AR')} / mes` : 'a definir')
        : (valuationUsd ? `U$S ${Math.round(valuationUsd).toLocaleString('es-AR')}` : 'a definir');

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // --- 1. La tasación SIEMPRE se crea (cada análisis es único) ---
    const { data: tasacionRow, error: tasacionErr } = await supabase
        .from('tasaciones')
        .insert([{
            title,
            data,
            status: 'draft',
            type,
            valuation_usd: valuationUsd,
            valuation_ars: valuationArs,
            created_by: null, // pública: la distingue de las internas
        }])
        .select('id')
        .single();
    if (tasacionErr || !tasacionRow) {
        console.error('[tasacion-submit] insert error:', tasacionErr);
        return jsonResponse(500, { error: 'No pudimos guardar tu tasación. Probá de nuevo.' }, req);
    }

    // --- 2. Lead: dedup por teléfono 60 días (actividad si ya existe) ---
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

    const notes = `Tasación web (${type}${destino ? ' · ' + destino : ''}) — ${title}\nValor estimado: ${valorTxt}\nEnviada desde el tasacionero de bienenhaus.com.ar`;

    if (dup) {
        duplicate = true;
        leadId = dup.id;
        await supabase.from('lead_activities').insert([{
            lead_id: dup.id,
            activity_type: 'note',
            title: 'Nueva tasación web (lead existente)',
            description: `${notes}\nTasación #${tasacionRow.id}`,
        }]);
    } else {
        const { data: leadRow, error: leadErr } = await supabase.from('leads').insert([{
            full_name: name,
            email: email || null,
            phone,
            whatsapp: phone,
            source: 'tasacion',
            stage: 'nuevo',
            tipo_cliente: 'propietario',
            operation_type: type === 'alquiler' ? 'alquiler' : 'venta',
            notes: `${notes}\nTasación #${tasacionRow.id}`,
            consent_at: new Date().toISOString(),
            utm_source: clip(String(payload.utm_source ?? ''), 120) || null,
            utm_campaign: clip(String(payload.utm_campaign ?? ''), 120) || null,
        }]).select('id').single();
        if (leadErr) {
            console.error('[tasacion-submit] lead insert error:', leadErr);
            // La tasación ya quedó guardada — el lead falló pero no perdemos el análisis
            return jsonResponse(200, { ok: true, tasacion_id: tasacionRow.id, lead: false }, req);
        }
        leadId = leadRow?.id ?? null;
    }

    return jsonResponse(200, { ok: true, tasacion_id: tasacionRow.id, lead: !!leadId, duplicate }, req);
});
