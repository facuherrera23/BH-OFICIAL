// Publicación de liquidaciones de alquiler al Portal del Propietario
// (Bloque 3.A). Llamada por el módulo "Administración de Alquileres" al
// cerrar el mes: recibe las liquidaciones (doc k='l' del core) de los
// propietarios MAPEADOS (S.ownerMap) y:
//   1. Upsertea en alquileres_portal_liquidaciones (UNIQUE owner+period:
//      re-publicar un mes reemplaza la versión anterior).
//   2. Avisa por email (Brevo) a cada propietario con email conocido,
//      incluyendo el link a su portal si tiene token vigente.
// verify_jwt ON (la manda el operador logueado del panel).
// No está en NO_VERIFY ni en EXCLUDED_FUNCTIONS del CI.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

interface LiqItem {
    owner_id: string;
    period: string;
    label: string;
    data: Record<string, unknown>;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('alquileres-portal-publish', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Método no permitido' });

    const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        { auth: { persistSession: false } },
    );

    const token = await requireAdmin(req, supabase);
    if (!token) return respond(401, { error: 'No autorizado' });
    const { data: userData } = await supabase.auth.getUser(token);
    if (!userData?.user) return respond(401, { error: 'No autorizado' });
    const operatorId = userData.user.id;

    let body: { items?: LiqItem[]; notify?: boolean };
    try {
        body = await req.json();
    } catch (_) {
        return respond(400, { error: 'JSON inválido' });
    }

    const items = Array.isArray(body.items) ? body.items : [];
    const notify = body.notify !== false;
    if (!items.length) return respond(400, { error: 'Sin items para publicar' });
    if (items.length > 50) return respond(400, { error: 'Máximo 50 liquidaciones por llamada' });

    // Validación de cada item: owner existente y no eliminado, período YYYY-MM,
    // doc de liquidación (k='l') del core.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const periodRe = /^\d{4}-\d{2}$/;
    const validas: LiqItem[] = [];
    const rechazos: string[] = [];
    const ownerIds = [...new Set(items.map(i => String(i.owner_id || '')))].filter(id => uuidRe.test(id));

    const { data: ownersRows, error: ownersErr } = await supabase
        .from('owners')
        .select('id, full_name, email, status, deleted_at')
        .in('id', ownerIds.length ? ownerIds : ['00000000-0000-0000-0000-000000000000']);
    if (ownersErr) return respond(500, { error: String(ownersErr) });
    const ownersById = new Map((ownersRows || []).map(o => [o.id, o]));

    for (const it of items) {
        const oid = String(it.owner_id || '');
        const o = ownersById.get(oid);
        if (!o || o.deleted_at) { rechazos.push('propietario inexistente'); continue; }
        if (o.status !== 'activo') { rechazos.push('propietario inactivo'); continue; }
        if (!periodRe.test(String(it.period || ''))) { rechazos.push('período inválido'); continue; }
        if (!it.data || (it.data as any).k !== 'l') { rechazos.push('no es una liquidación'); continue; }
        validas.push({ ...it, owner_id: oid, period: String(it.period), label: String(it.label || 'Liquidación') });
    }

    let published = 0;
    const notificados: string[] = [];
    const errores: string[] = [];

    for (const it of validas) {
        const { error: upErr } = await supabase
            .from('alquileres_portal_liquidaciones')
            .upsert({
                owner_id: it.owner_id,
                period: it.period,
                label: it.label,
                data: it.data,
                published_by: operatorId,
                published_at: new Date().toISOString(),
            }, { onConflict: 'owner_id,period' });
        if (upErr) { errores.push(`upsert ${it.period}: ${upErr.message}`); continue; }
        published++;

        await supabase.from('audit_log').insert({
            user_id: operatorId,
            action: 'alq_portal_publish',
            module: 'alquileres',
            table_name: 'alquileres_portal_liquidaciones',
            status: 'success',
            metadata: {
                owner_id: it.owner_id,
                period: it.period,
                label: it.label,
                notified: notify,
            },
        });
    }

    // Emails: uno por propietario afectado (con token de portal vigente si existe).
    if (notify && published > 0) {
        const brevoKey = Deno.env.get('BREVO_API_KEY');
        const affected = [...new Set(validas.map(v => v.owner_id))];
        for (const oid of affected) {
            const o = ownersById.get(oid)!;
            if (!o.email) { notificados.push(`${oid}: sin email`); continue; }
            if (!brevoKey) { notificados.push(`${oid}: Brevo sin configurar`); continue; }

            // Link al portal si hay token vigente (mismo criterio que la RPC)
            let portalLink = '';
            try {
                const { data: tk } = await supabase
                    .from('owner_portal_tokens')
                    .select('token')
                    .eq('owner_id', oid)
                    .is('revoked_at', null)
                    .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                if (tk?.token) portalLink = `https://bienenhaus.com.ar/portal-propietario.html?token=${tk.token}`;
            } catch (_) { /* link opcional */ }

            const periodos = validas.filter(v => v.owner_id === oid).map(v => v.label).join(', ');
            const html = `
                <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1b2a41;">
                  <h2 style="margin:0 0 6px;">Tu liquidación ya está disponible</h2>
                  <p style="margin:0 0 14px;color:#51607a;">Bienenhaus Propiedades · Administración de Alquileres</p>
                  <p style="margin:0 0 10px;">Hola ${o.full_name}: publicamos en tu portal la liquidación de <b>${periodos}</b>.</p>
                  <p style="margin:0 0 16px;">Podés verla cuando quieras desde tu portal de propietario.</p>
                  ${portalLink ? `<p style="margin:0 0 22px;"><a href="${portalLink}" style="background:#1FC8C3;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Ver mi portal</a></p>` : '<p style="margin:0 0 22px;">Si no tenés el link de acceso a mano, pedilo a tu asesor.</p>'}
                  <p style="margin:0;color:#8E9BAE;font-size:12px;">Este es un aviso automático del panel de administración.</p>
                </div>`;
            const text = `Bienenhaus: tu liquidación (${periodos}) está disponible en tu portal de propietario.`;

            try {
                const res = await fetch('https://api.brevo.com/v3/smtp/email', {
                    method: 'POST',
                    headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({
                        sender: { email: Deno.env.get('BREVO_SENDER_EMAIL') || 'noreply@bienenhaus.com.ar', name: Deno.env.get('BREVO_SENDER_NAME') || 'Bienenhaus Propiedades' },
                        to: [{ email: o.email }],
                        subject: `Bienenhaus — Liquidación de alquiler disponible en tu portal`,
                        htmlContent: html,
                        textContent: text,
                    }),
                });
                notificados.push(`${o.email}: ${res.ok ? 'enviado' : 'error ' + res.status}`);
            } catch (e) {
                notificados.push(`${o.email}: ${String(e)}`);
            }
        }
    }

    return respond(200, {
        recibidos: items.length,
        publicadas: published,
        rechazados: rechazos.length,
        rechazos: [...new Set(rechazos)],
        notificados,
        errores,
    });
});
