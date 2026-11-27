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
  /** Enviados en la ventana 2h (email al cliente o aviso WhatsApp al agente). */
  sent2h: number;
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
Recordatorio de tu visita programada en BIENENHAUS:
- Día/hora: ${fecha}
- Propiedad: ${propLabel}
- Duración estimada: ${dur}
${confirmUrl ? `Confirmá desde este link: ${confirmUrl}` : ''}
Si no podés asistir avisanos para reprogramar.`;

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="color:#b93d2c;margin:0 0 6px;">Recordatorio de visita</h2>
  <p>Hola <strong>${visit.client_name || 'Cliente'}</strong>,</p>
  <p>Te recordamos tu visita programada:</p>
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
 * Procesa recordatorios de visitas en DOS ventanas:
 *
 *   24 h → email al cliente (si dejó email), con link para confirmar/cancelar.
 *   2 h  → email al cliente; y si NO dejó email pero sí teléfono, aviso al
 *          AGENTE con un link de WhatsApp pre-cargado (wa.me) para que el
 *          aviso llegue igual — el 2h es justo donde se cae la visita.
 *
 * Idempotente por las columnas reminder_24h_sent_at / reminder_2h_sent_at
 * (se marcan INMEDIATAMENTE después de confirmar cada envío). Una visita sin
 * email ni teléfono en la ventana 2h se marca igual para no reintentar cada
 * 15 min (cron visits-reminders → visits-process-reminders).
 *
 * 2026-11-26: la ventana 2h existía sólo en una edge function huérfana
 * (visits-reminders, 0 llamadores: el cron llama a visits-process-reminders)
 * — reminder_2h_sent_at era 0 en las 8 visitas de producción. Se porta acá.
 */
export async function processReminders(): Promise<RemindersResult> {
  const now = Date.now();
  const config = await getReminderConfig();

  async function ventana(
    kind: '24h' | '2h',
    flagCol: 'reminder_24h_sent_at' | 'reminder_2h_sent_at',
    aheadIso: string,
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    const { data: visits, error } = await supabase
      .from('visits')
      .select('id, client_name, client_email, client_phone, visit_date, duration_minutes, confirmation_token, status, agent_id, property:properties(title, property_code)')
      .in('status', ['pendiente', 'confirmada'])
      .is('deleted_at', null)
      .is(flagCol, null)
      .gte('visit_date', new Date(now).toISOString())
      .lte('visit_date', aheadIso);

    if (error) throw new Error(error.message);

    /* La ventana 24h NO toma las visitas que ya entran en la ventana 2h.
       Si las tomara, el cliente recibiría DOS emails contradictorios
       ("tu visita programada" + "es en ~2 horas") para la misma visita.
       La ventana 2h las cubre (con su propio link de confirmación). */
    const cutoff2h = now + 2 * 60 * 60 * 1000;
    const candidatos: any[] = kind === '24h'
      ? ((visits as any[]) || []).filter((v) => new Date(v.visit_date).getTime() > cutoff2h)
      : (visits as any[]) || [];

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    const mark = async (visitId: string) => {
      const { error: markErr } = await supabase
        .from('visits')
        .update({ [flagCol]: new Date().toISOString() })
        .eq('id', visitId);
      return !markErr;
    };

    const jobs = (candidatos).map(async (visit) => {
      try {
        if (visit.client_email) {
          // Camino 1: email directo al cliente.
          const confirmUrl = visit.confirmation_token
            ? config.site_origin + '/confirmar-visita.html?token=' + visit.confirmation_token
            : null;
          const { html, text } = kind === '24h'
            ? buildReminderEmail(visit, confirmUrl)
            : buildReminder2hEmail(visit, confirmUrl);
          const subject = kind === '24h'
            ? 'Recordatorio: tu visita programada en BIENENHAUS'
            : 'Tu visita es en ~2 horas (' + fmtDateTimeAR(visit.visit_date) + ')';
          const r = await sendBrevo(config, visit.client_email, subject, html, text);
          if (!r.ok) throw new Error(r.error || 'send failed');
          if (await mark(visit.id)) sent++; else failed++;
          return;
        }

        if (kind === '2h' && visit.client_phone && visit.agent_id) {
          // Camino 2 (2h sin email del cliente): aviso al AGENTE con el
          // WhatsApp pre-cargado — el mensaje sale por WhatsApp del agente.
          const { data: agent } = await supabase
            .from('agents')
            .select('profile_id, full_name')
            .eq('id', visit.agent_id)
            .single();
          let email: string | undefined;
          if (agent?.profile_id) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('email')
              .eq('id', agent.profile_id)
              .single();
            email = profile?.email;
          }
          if (email) {
            const { html, text } = buildReminder2hAgenteEmail(visit, agent?.full_name || '');
            const r = await sendBrevo(
              config, email,
              '[Bienenhaus] Visita en 2 horas: avisale a ' + (visit.client_name || 'el cliente') + ' por WhatsApp',
              html, text,
            );
            if (!r.ok) throw new Error(r.error || 'send failed');
            if (await mark(visit.id)) sent++; else failed++;
            return;
          }
        }

        // Nada que enviar (sin email y — en 2h — sin teléfono/agente): se
        // marca para no reintentar infinitamente cada 15 min.
        await mark(visit.id);
        skipped++;
      } catch (e) {
        console.error('[visits-rem] visita ' + visit.id + ' (' + kind + '):', (e as Error).message);
        failed++;
      }
    });

    await Promise.all(jobs);
    return { sent, failed, skipped };
  }

  const r24 = await ventana('24h', 'reminder_24h_sent_at', new Date(now + 24 * 60 * 60 * 1000).toISOString());
  const r2 = await ventana('2h', 'reminder_2h_sent_at', new Date(now + 2 * 60 * 60 * 1000).toISOString());

  return { sent: r24.sent + r2.sent, failed: r24.failed + r2.failed, sent2h: r2.sent };
}

/* Normalización AR para el deep link de WhatsApp: ESPEJO EXACTO de
   normalizeArPhone + waNumber del CRM (soporta 00/54/0/9, el 15 de celulares
   y las áreas 11/221/341/351). Sin el bloque del "15" un teléfono guardado
   como "15 3513-96-5289" producía un wa.me a un número inexistente. */
function waDigitsAr(phone: string): string {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('549')) d = d.slice(3);
  else if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('9') && d.length <= 12) d = d.slice(1);
  const AR_MOBILE_AREAS: Record<string, number> = { '11': 1, '221': 1, '341': 1, '351': 1 };
  const area3 = d.slice(0, 3);
  const area2 = d.slice(0, 2);
  if (AR_MOBILE_AREAS[area3] || AR_MOBILE_AREAS[area2]) {
    const area = AR_MOBILE_AREAS[area3] ? area3 : area2;
    let rest = d.slice(area.length);
    if (rest.startsWith('15')) rest = rest.slice(2); // marcador móvil doméstico
    d = area + rest;
  } else if (d.startsWith('15')) {
    d = d.slice(2);
  }
  if (d.length < 8 || d.length > 12) return ''; // teléfono incompleto: sin link
  return '549' + d;
}

/* Email 2h al CLIENTE (adaptación fiel del de la función huérfana).
   El link de confirmación también va acá: una visita agendada para dentro de
   2h ya no recibe el email de 24h (quedaría contradictorio), así que el
   cliente necesita poder confirmar/cancelar desde este email. */
function buildReminder2hEmail(visit: any, confirmUrl?: string | null): { html: string; text: string } {
  const fecha = fmtDateTimeAR(visit.visit_date);
  const propLabel = visit.property?.title
    ? visit.property.title + (visit.property.property_code ? ' (' + visit.property.property_code + ')' : '')
    : 'la propiedad agendada';

  const text = 'Hola ' + (visit.client_name || '') + ':\n' +
    'Tu visita en BIENENHAUS es en aproximadamente 2 horas.\n' +
    '- Día y hora: ' + fecha + '\n' +
    '- Propiedad: ' + propLabel + '\n' +
    (confirmUrl ? 'Confirmá desde este link: ' + confirmUrl + '\n' : '') +
    'Si no podés asistir avisanos para reprogramar.';

  const html = '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">' +
    '<h2 style="color:#b93d2c;margin:0 0 6px;">Tu visita es en ~2 horas</h2>' +
    '<p>Hola <strong>' + (visit.client_name || 'Cliente') + '</strong>,</p>' +
    '<p>Te esperamos hoy:</p>' +
    '<table style="border-collapse:collapse;margin:12px 0;">' +
      '<tr><td style="padding:6px 10px;color:#555;">Día y hora</td><td style="padding:6px 10px;"><strong>' + fecha + '</strong></td></tr>' +
      '<tr><td style="padding:6px 10px;color:#555;">Propiedad</td><td style="padding:6px 10px;"><strong>' + propLabel + '</strong></td></tr>' +
    '</table>' +
    (confirmUrl
      ? '<p><a href="' + confirmUrl + '" style="display:inline-block;background:#1FC8C3;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Confirmar mi visita</a></p>'
      : '') +
    '<p style="color:#555;font-size:13px;">Si no podés asistir, respondé este email y lo reprogramamos.</p>' +
  '</body></html>';

  return { html, text };
}

/* Email 2h al AGENTE con el WhatsApp pre-cargado (sin email del cliente). */
function buildReminder2hAgenteEmail(visit: any, agenteNombre: string): { html: string; text: string } {
  const fecha = fmtDateTimeAR(visit.visit_date);
  const propLabel = visit.property?.title
    ? visit.property.title + (visit.property.property_code ? ' (' + visit.property.property_code + ')' : '')
    : 'la propiedad agendada';
  const waLink = waDigitsAr(visit.client_phone)
    ? 'https://wa.me/' + waDigitsAr(visit.client_phone) +
      '?text=' + encodeURIComponent(
        'Hola ' + (visit.client_name || '').split(' ')[0] +
        ', te contacto de Bienenhaus Propiedades. Tu visita a ' + propLabel +
        ' es en un rato (' + fecha + '). ¿Confirmás?'
      )
    : '';

  const text = 'Hola ' + (agenteNombre || '') + ':' +
    '\nTu visita con ' + (visit.client_name || 'el cliente') + ' es en ~2 horas (' + fecha + ').' +
    '\nPropiedad: ' + propLabel +
    '\nTeléfono: ' + (visit.client_phone || '—') +
    (waLink ? '\nMandale un WhatsApp con un clic: ' + waLink : '\nNo tiene teléfono cargado.') +
    '\n\n(Sin email del cliente, el recordatorio automático no puede llegarle: este es el puente.)';

  const html = '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">' +
    '<h2 style="color:#b93d2c;margin:0 0 6px;">Visita en ~2 horas — avisale por WhatsApp</h2>' +
    '<p>Hola <strong>' + (agenteNombre || 'agente') + '</strong>,</p>' +
    '<p>Tu visita con <strong>' + (visit.client_name || 'el cliente') + '</strong> es en aproximadamente 2 horas y el cliente <strong>no dejó email</strong>, así que el recordatorio automático no puede llegarle.</p>' +
    '<table style="border-collapse:collapse;margin:12px 0;">' +
      '<tr><td style="padding:6px 10px;color:#555;">Día y hora</td><td style="padding:6px 10px;"><strong>' + fecha + '</strong></td></tr>' +
      '<tr><td style="padding:6px 10px;color:#555;">Propiedad</td><td style="padding:6px 10px;"><strong>' + propLabel + '</strong></td></tr>' +
      '<tr><td style="padding:6px 10px;color:#555;">Teléfono</td><td style="padding:6px 10px;"><strong>' + (visit.client_phone || '—') + '</strong></td></tr>' +
    '</table>' +
    (waLink
      ? '<p><a href="' + waLink + '" style="display:inline-block;background:#25D366;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Enviar WhatsApp pre-cargado</a></p>'
      : '<p style="color:#b91c1c;">El cliente no tiene teléfono cargado: revisá su ficha en el CRM.</p>') +
    '<p style="color:#555;font-size:13px;">Un aviso 2 horas antes es lo que evita la visita perdida.</p>' +
  '</body></html>';

  return { html, text };
}
