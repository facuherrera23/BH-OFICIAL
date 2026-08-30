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

/**
 * Procesa los recordatorios vencidos (para ejecutar por cron).
 * Un recordatorio vence cuando falta trigger_minutes_before para la visita.
 */
export async function processReminders(): Promise<RemindersResult> {
  const { data: reminders, error } = await supabase
    .from('visit_reminders')
    .select('*, visit:visits(*)')
    .eq('is_sent', false);

  if (error) throw new Error(error.message);

  const now = Date.now();
  let sent = 0;
  let failed = 0;

  for (const reminder of (reminders as any[]) || []) {
    try {
      const visit = reminder.visit as any;
      if (!visit || visit.deleted_at || ['cancelada', 'no_show'].includes(visit.status)) continue;

      const startsAt = new Date(visit.starts_at).getTime();
      const triggerMs = Number(reminder.trigger_minutes_before ?? 0) * 60000;
      if (now < startsAt - triggerMs || now > startsAt) continue;

      // Simulación de envío (email/sms/push). Conectar a un gateway cuando exista.
      const minutesBefore = Number(reminder.trigger_minutes_before ?? 0);
      const hours = Math.floor(minutesBefore / 60);
      const mins = minutesBefore % 60;
      const timeStr = hours > 0 ? `${hours}h ${mins}min` : `${mins}min`;
      console.info(
        `[visits-process-reminders] envío ${reminder.type} para visita ${visit.id} (${timeStr} antes)`
      );

      await supabase
        .from('visit_reminders')
        .update({ is_sent: true, sent_at: new Date().toISOString() })
        .eq('id', reminder.id);

      await supabase
        .from('visits')
        .update({ reminder_sent: true, reminder_sent_at: new Date().toISOString() })
        .eq('id', visit.id);

      sent++;
    } catch {
      failed++;
    }
  }

  return { sent, failed };
}
