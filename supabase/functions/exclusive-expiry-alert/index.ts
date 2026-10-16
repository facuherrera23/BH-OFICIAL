// ============================================================
// exclusive-expiry-alert — Notificación legal de exclusividad
//
// Cron diario que detecta exclusividades por vencer y:
// 1. Envía email al propietario via Brevo (evidencia legal)
// 2. Crea tarea al agente asignado (para que renueven o cierren)
// 3. Registra en owner_notifications (trail legal)
//
// Auth: header x-sync-secret (patrón de crons del proyecto)
// Deploy: verify_jwt OFF
// Cron: exclusive-expiry-alert-daily, 12:00 UTC (09:00 ART)
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

function jsonResponse(status: number, body: object, req: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sync-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

async function getSyncSecret(): Promise<string> {
  const { data } = await supabase.from('zernio_config').select('value').eq('key', 'sync_secret').maybeSingle();
  return data?.value?.secret || '';
}

async function sendBrevoEmail(toEmail: string, toName: string, subject: string, html: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const apiKey = Deno.env.get('BREVO_API_KEY');
  if (!apiKey) return { success: false, error: 'BREVO_API_KEY not configured' };
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { name: 'Bienenhaus Propiedades', email: 'bienenhaus.propiedades@gmail.com' },
        to: [{ email: toEmail, name: toName }],
        subject,
        htmlContent: html,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return { success: false, error: data.message || `HTTP ${resp.status}` };
    return { success: true, messageId: data.messageId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function buildExpiryEmail(ownerName: string, daysLeft: number, expiryDate: string, propCount: number): { subject: string; html: string } {
  const urgency = daysLeft <= 1 ? 'HOY' : daysLeft <= 7 ? 'en los próximos días' : 'en los próximos 15 días';
  const subject = daysLeft <= 1
    ? '⚠️ Tu exclusividad con Bienenhaus vence HOY'
    : `Tu exclusividad con Bienenhaus vence ${urgency}`;

  const html = `
  <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0d12;border-radius:16px;overflow:hidden;border:1px solid rgba(31,200,195,0.2);">
    <div style="background:linear-gradient(135deg,#1FC8C5,#0d9488);padding:24px;text-align:center;">
      <h1 style="color:#fff;font-size:22px;margin:0;">BIENENHAUS PROPIEDADES</h1>
    </div>
    <div style="padding:28px 24px;">
      <p style="color:#e2e8f0;font-size:15px;line-height:1.6;margin:0 0 16px;">
        Hola ${ownerName},
      </p>
      <p style="color:#cbd5e1;font-size:14px;line-height:1.6;margin:0 0 16px;">
        Te contactamos para informarte que tu <strong>contrato de exclusividad</strong> con Bienenhaus Propiedades vence el <strong>${expiryDate}</strong> (${daysLeft} ${daysLeft === 1 ? 'día' : 'días'}).
      </p>
      ${propCount > 0 ? `
      <div style="background:rgba(31,200,195,0.08);border:1px solid rgba(31,200,195,0.2);border-radius:12px;padding:16px;margin:16px 0;">
        <p style="color:#5eead4;font-size:13px;margin:0;">
          <strong>${propCount} ${propCount === 1 ? 'propiedad' : 'propiedades'}</strong> ${propCount === 1 ? 'está' : 'están'} bajo este contrato de exclusividad.
        </p>
      </div>
      ` : ''}
      <p style="color:#cbd5e1;font-size:14px;line-height:1.6;margin:0 0 8px;">
        Para renovar tu exclusividad o consultar sobre el estado de tu propiedad, respondé a este email o contactá a tu agente asignado.
      </p>
      <p style="color:#64748b;font-size:12px;margin:16px 0 0;">
        Este email es una notificación automática. Si ya renovaste tu exclusividad, ignorá este mensaje.
      </p>
    </div>
    <div style="background:rgba(255,255,255,0.02);padding:16px 24px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
      <p style="color:#64748b;font-size:11px;margin:0;">
        Bienenhaus Propiedades · Córdoba, Argentina<br>
        <a href="https://bienenhaus.com.ar" style="color:#5eead4;text-decoration:none;">bienenhaus.com.ar</a>
      </p>
    </div>
  </div>`;

  return { subject, html };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-sync-secret',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, req);
  }

  const secret = await getSyncSecret();
  if (secret && req.headers.get('x-sync-secret') !== secret) {
    return jsonResponse(401, { error: 'No autorizado' }, req);
  }

  try {
    const today = new Date();
    const alerts = [
      { type: 'exclusive_expiry_15d', days: 15 },
      { type: 'exclusive_expiry_7d', days: 7 },
      { type: 'exclusive_expiry_1d', days: 1 },
      { type: 'exclusive_expired', days: 0 },
    ];

    const results = { sent: 0, tasks: 0, skipped: 0, errors: 0, details: [] };

    for (const alert of alerts) {
      // Calcular rango de fechas
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + alert.days);
      const dateStr = targetDate.toISOString().slice(0, 10);

      // Buscar owners con exclusividad que vence en ese rango
      const { data: owners, error } = await supabase
        .from('owners')
        .select(`
          id, full_name, email, phone, exclusive_end, agent_id,
          agents(id, full_name)
        `)
        .eq('exclusive', true)
        .is('deleted_at', null)
        .not('exclusive_end', 'is', null)
        .eq('exclusive_end', dateStr);

      if (error) throw error;

      for (const owner of owners || []) {
        // Verificar si ya fue notificado para este tipo
        const { data: alreadyNotified } = await supabase
          .from('owner_notifications')
          .select('id')
          .eq('owner_id', owner.id)
          .eq('notification_type', alert.type)
          .limit(1);

        if (alreadyNotified && alreadyNotified.length > 0) {
          results.skipped++;
          continue;
        }

        // Contar propiedades bajo exclusividad
        const { count: propCount } = await supabase
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('owner_id', owner.id)
          .is('deleted_at', null);

        const expiryDate = new Date(owner.exclusive_end).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
        const daysLeft = alert.days;
        const email = owner.email;

        let emailMessageId: string | null = null;
        let sentToEmail: string | null = null;

        // Enviar email al propietario (si tiene email)
        if (email) {
          const { subject, html } = buildExpiryEmail(owner.full_name, daysLeft, expiryDate, propCount || 0);
          const emailResult = await sendBrevoEmail(email, owner.full_name, subject, html);
          if (emailResult.success) {
            emailMessageId = emailResult.messageId || null;
            sentToEmail = email;
            results.sent++;
          } else {
            console.warn(`[exclusive-alert] email failed for ${owner.full_name}: ${emailResult.error}`);
          }
        }

        // Crear tarea al agente asignado (o genérica)
        const agentId = owner.agent_id || owner.agents?.[0]?.id;
        if (agentId) {
          const taskTitle = `Exclusividad ${daysLeft === 0 ? 'VENCIDA' : 'vence en ' + daysLeft + 'd'} — ${owner.full_name}`;
          const { error: taskError } = await supabase
            .from('owner_tasks')
            .insert([{
              owner_id: owner.id,
              agent_id: agentId,
              title: taskTitle,
              description: `La exclusividad de ${owner.full_name} vence el ${expiryDate}. Contactar para renovar o cerrar. ${propCount || 0} propiedad(es) afectada(s).`,
              type: 'contact',
              priority: daysLeft <= 1 ? 'urgente' : daysLeft <= 7 ? 'alta' : 'media',
              status: 'pendiente',
              due_date: dateStr,
            }]);
          if (!taskError) results.tasks++;
        }

        // Registrar en owner_notifications (trail legal)
        const { error: notifError } = await supabase
          .from('owner_notifications')
          .insert([{
            owner_id: owner.id,
            notification_type: alert.type,
            sent_to_email: sentToEmail,
            sent_to_phone: owner.phone || null,
            agent_id: agentId || null,
            email_message_id: emailMessageId,
            details: {
              owner_name: owner.full_name,
              expiry_date: owner.exclusive_end,
              days_left: daysLeft,
              prop_count: propCount || 0,
              email_sent: !!emailMessageId,
              task_created: !!agentId,
            },
          }]);

        if (notifError) {
          console.warn(`[exclusive-alert] notification log failed: ${notifError.message}`);
          results.errors++;
        }

        results.details.push({
          owner: owner.full_name,
          type: alert.type,
          email_sent: !!emailMessageId,
          task_created: !!agentId,
        });
      }
    }

    return jsonResponse(200, {
      success: true,
      ...results,
      timestamp: new Date().toISOString(),
    }, req);
  } catch (err) {
    console.error('[exclusive-expiry-alert] error:', err);
    return jsonResponse(500, { success: false, error: err.message }, req);
  }
});
