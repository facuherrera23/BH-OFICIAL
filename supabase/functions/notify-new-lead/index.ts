// ============================================================
// notify-new-lead — Aviso por email cuando entra un lead nuevo.
// La dispara el trigger trg_leads_notify_insert (pg_net) con
// body { lead_id }. La función re-lee el lead con service role:
// si no existe no se envía nada (nada que spoofear sin un UUID real).
// Email vía Brevo (mismo patrón que el resto del proyecto).
// verify_jwt: false (la llamada viene de pg_net, sin JWT).
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return optionsResponse(req);
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Método no permitido' }, req);

  const body = await req.json().catch(() => ({})) as { lead_id?: string };
  const leadId = body.lead_id ?? '';
  if (!UUID_RE.test(leadId)) return jsonResponse(400, { error: 'lead_id inválido' }, req);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: lead, error } = await supabase
    .from('leads')
    .select('id, full_name, email, phone, whatsapp, source, preferred_zone, budget_usd, notes, stage, created_at')
    .eq('id', leadId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !lead) return jsonResponse(404, { error: 'Lead no encontrado' }, req);

  // Destinatarios: super_admins activos
  const { data: admins } = await supabase
    .from('profiles')
    .select('email')
    .eq('role', 'super_admin')
    .eq('is_active', true);
  const recipients = (admins || []).map(a => a.email).filter(e => typeof e === 'string' && e.includes('@'));
  if (!recipients.length) return jsonResponse(200, { skipped: 'sin destinatarios' }, req);

  let brevoKey = Deno.env.get('BREVO_API_KEY') ?? '';
  if (!brevoKey) {
    const { data: settings } = await supabase
      .from('app_settings').select('value').eq('key', 'integrations').maybeSingle();
    brevoKey = (settings?.value as Record<string, string> | null)?.brevo_api_key ?? '';
  }
  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  if (!brevoKey && !resendKey) {
    await alertOnceADay(supabase, 'email_key_missing', lead);
    return jsonResponse(200, { skipped: 'sin API key de email (Brevo/Resend)' }, req);
  }

  const rows: Array<[string, string]> = [
    ['Nombre', esc(lead.full_name)],
    ['Email', esc(lead.email || '—')],
    ['Teléfono', esc(lead.phone || lead.whatsapp || '—')],
    ['Origen', esc(lead.source || '—')],
    ['Zona', esc(lead.preferred_zone || '—')],
    ['Presupuesto', lead.budget_usd ? 'USD ' + Number(lead.budget_usd).toLocaleString('es-AR') : '—'],
  ];
  const html = `
    <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">Nuevo prospecto en el CRM</h2>
      <table cellpadding="6" style="border-collapse: collapse;">
        ${rows.map(([k, v]) => `<tr><td style="color:#666;"><strong>${k}</strong></td><td>${v}</td></tr>`).join('')}
      </table>
      ${lead.notes ? `<p style="background:#f5f5f5;padding:12px;border-radius:8px;">${esc(lead.notes).replace(/\n/g, '<br>')}</p>` : ''}
      <p style="margin-top:16px;">
        <a href="https://bienenhaus.com.ar/admin.html#tab-leads"
           style="background:#c9a96e;color:#141414;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">
          Abrir en el panel
        </a>
      </p>
    </div>`;

  const subject = `Nuevo lead: ${lead.full_name} (${lead.source ?? 'web'})`;
  let sendRes: Response;
  if (brevoKey) {
    sendRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': brevoKey },
      body: JSON.stringify({
        sender: { name: 'BIENENHAUS CRM', email: 'noreply@bienenhaus.com.ar' },
        to: recipients.map(email => ({ email })),
        subject,
        htmlContent: html,
      }),
    });
  } else {
    sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
      body: JSON.stringify({
        from: 'BIENENHAUS CRM <no-reply@bienenhaus.com.ar>',
        to: recipients,
        subject,
        html,
      }),
    });
  }
  if (!sendRes.ok) {
    const txt = await sendRes.text();
    console.error('[notify-new-lead] email provider error:', txt);
    await alertOnceADay(supabase, 'email_send_failed', lead);
    return jsonResponse(502, { error: 'Falló el envío de email' }, req);
  }

  return jsonResponse(200, { ok: true, notified: recipients.length }, req);
});

async function alertOnceADay(supabase: any, kind: 'email_key_missing' | 'email_send_failed', lead: Record<string, unknown>) {
  try {
    const { data: existing } = await supabase
      .from('supervision_alerts')
      .select('id')
      .eq('alert_type', 'crm_email_broken')
      .eq('status', 'open')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .limit(1);
    if (existing && existing.length) return;
    await supabase.from('supervision_alerts').insert([{
      module: 'crm',
      severity: 'high',
      alert_type: 'crm_email_broken',
      title: 'Notificaciones de email del CRM están caídas',
      description: kind === 'email_key_missing'
        ? 'No hay API key de email configurada (Brevo/Resend). Los avisos de nuevos leads no se están enviando.'
        : 'El proveedor de email rechazó el envío del aviso. Revisar la key y el dominio sender.',
      evidence: { kind, lead_id: lead.id },
      status: 'open',
    }]);
  } catch (e) { console.error('[notify-new-lead] alert insert failed:', e); }
}
