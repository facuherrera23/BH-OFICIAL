/**
 * Visitas: QR check-in + recordatorios.
 * Compartido entre qr-checkin y visits-process-reminders.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export interface QrCheckinResult {
  code: string;
  id: number;
}

export interface CheckInResult {
  success: boolean;
  message: string;
  visit?: any;
}

export interface RemindersResult {
  sent: number;
  failed: number;
}

/** Genera y guarda un código QR para una visita. */
export async function generateQrCode(visitId: string): Promise<QrCheckinResult> {
  const code = `VIS-${visitId.slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;

  const { data, error } = await supabase
    .from('qr_checkins')
    .insert({ visit_id: visitId, code })
    .select('id, code')
    .single();

  if (error) throw new Error(error.message);
  return { code: data.code, id: data.id };
}

/** Valida un código QR y registra el check-in del agente. */
export async function checkInWithQr(code: string, userId: string): Promise<CheckInResult> {
  const { data: checkin, error } = await supabase
    .from('qr_checkins')
    .select('*, visit:visits(*)')
    .eq('code', code)
    .single();

  if (error || !checkin) {
    return { success: false, message: 'Código QR inválido' };
  }

  if (checkin.checked_in) {
    return { success: false, message: 'Esta visita ya fue registrada' };
  }

  const visit = checkin.visit as any;
  if (!visit || visit.deleted_at) {
    return { success: false, message: 'La visita no existe' };
  }

  if (visit.agent_id !== userId) {
    return { success: false, message: 'No sos el agente asignado a esta visita' };
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from('qr_checkins')
    .update({ checked_in: true, checked_in_at: now, checked_in_by: userId })
    .eq('id', checkin.id);

  if (updateError) return { success: false, message: 'Error al registrar' };

  await supabase
    .from('visits')
    .update({ status: 'en_curso' })
    .eq('id', checkin.visit_id);

  return { success: true, visit, message: 'Check-in registrado correctamente' };
}

/* ── Config Brevo (mismo patrón que owner-tasks-reminder) ── */

interface ReminderConfig {
  brevo_api_key?: string;
  brevo_sender_email?: string;
  brevo_sender_name?: string;
  site_origin?: string;
}

async function getReminderConfig(): Promise<ReminderConfig> {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'integrations')
    .single();
  const integrations = data?.value || {};
  return {
    brevo_api_key: Deno.env.get('BREVO_API_KEY') || integrations.brevo_api_key,
    brevo_sender_email: Deno.env.get('BREVO_SENDER_EMAIL') || integrations.brevo_sender_email || 'noreply@bienenhaus.com.ar',
    brevo_sender_name: Deno.env.get('BREVO_SENDER_NAME') || integrations.brevo_sender_name || 'Bienenhaus',
    site_origin: Deno.env.get('SITE_ORIGIN') || integrations.site_origin || 'https://bienenhaus.com.ar',
  };
}

async function sendBrevo(config: ReminderConfig, to: string, subject: string, html: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!config.brevo_api_key) return { ok: false, error: 'Brevo API key not configured' };
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': config.brevo_api_key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: config.brevo_sender_email, name: config.brevo_sender_name },
        to: [{ email: to }],
        subject, htmlContent: html, textContent: text,
      }),
    });
    if (!res.ok) return { ok: false, error: `Brevo ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

function fmtDateTimeAR(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

function buildReminderEmail(visit: any, confirmUrl: string | null): { html: string; text: string } {
  const fecha = fmtDateTimeAR(visit.visit_date);
  const propLabel = visit.property?.title ? `${visit.property.title} (${visit.property.property_code || '—'})` : 'la propiedad agendada';
  const dur = visit.duration_minutes ? `${visit.duration_minutes} min` : '60 min';

  const text = `Hola ${visit.client_name || ''}:
Recordatorio de tu visita de mañana en BIENENHAUS:
- Día/hora: ${fecha}
- Propiedad: ${propLabel}
- Duración estimada: ${dur}
${confirmUrl ? `Confirmá desde este link: ${confirmUrl}` : ''}
Si no podés asistir avisanos para reprogramar.`;

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="color:#b93d2c;margin:0 0 6px;">Recordatorio de visita</h2>
  <p>Hola <strong>${visit.client_name || 'Cliente'}</strong>,</p>
  <p>Te recordamos tu visita programada mañana:</p>
  <table style="border-collapse:collapse;margin:12px 0;">
    <tr><td style="padding:6px 10px;color:#555;">Día y hora</td><td style="padding:6px 10px;"><strong>${fecha}</strong></td></tr>
    <tr><td style="padding:6px 10px;color:#555;">Propiedad</td><td style="padding:6px 10px;"><strong>${propLabel}</strong></td></tr>
    <tr><td style="padding:6px 10px;color:#555;">Duración estimada</td><td style="padding:6px 10px;">${dur}</td></tr>
  </table>
  ${confirmUrl ? `<p><a href="${confirmUrl}" style="display:inline-block;background:#1FC8C3;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Confirmar mi visita</a></p>` : ''}
  <p style="color:#555;font-size:13px;">Si no podés asistir, respondé este correo o avisá a tu asesor para reprogramarla.</p>
  <p style="color:#999;font-size:12px;margin-top:24px;">BIENENHAUS Propiedades</p>
</body></html>`;
  return { html, text };
}

/**
 * Procesa recordatorios: visitas en las próximas 24h sin recordatorio enviado,
 * con email de cliente cargado. Envía por Brevo y marca reminder_24h_sent_at.
 */
export async function processReminders(): Promise<RemindersResult> {
  const now = Date.now();
  const in24h = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const { data: visits, error } = await supabase
    .from('visits')
    .select('id, client_name, client_email, client_phone, visit_date, duration_minutes, confirmation_token, status, property:properties(title, property_code)')
    .in('status', ['pendiente', 'confirmada'])
    .is('reminder_24h_sent_at', null)
    .gte('visit_date', new Date(now).toISOString())
    .lte('visit_date', in24h)
    .not('client_email', 'is', null);

  if (error) throw new Error(error.message);

  const config = await getReminderConfig();
  let sent = 0;
  let failed = 0;

  for (const visit of (visits as any[]) || []) {
    try {
      const confirmUrl = visit.confirmation_token
        ? `${config.site_origin}/confirmar-visita.html?token=${visit.confirmation_token}`
        : null;
      const { html, text } = buildReminderEmail(visit, confirmUrl);
      const subject = `Recordatorio: visita mañana ${fmtDateTimeAR(visit.visit_date)}`;
      const r = await sendBrevo(config, visit.client_email, subject, html, text);
      if (!r.ok) {
        console.error(`[visits-rem] visita ${visit.id}: ${r.error}`);
        failed++;
        continue;
      }
      await supabase
        .from('visits')
        .update({ reminder_24h_sent_at: new Date().toISOString() })
        .eq('id', visit.id);
      sent++;
    } catch (e) {
      console.error(`[visits-rem] excepción en visita ${visit.id}:`, e);
      failed++;
    }
  }

  return { sent, failed };
}
