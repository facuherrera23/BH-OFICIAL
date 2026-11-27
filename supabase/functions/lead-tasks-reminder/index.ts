// ============================================================
// lead-tasks-reminder — Recordatorio automático de tareas de LEADS
// ============================================================
// Cierra el bug del campo cosmético (2026-11-26): lead_tasks.remind_before_minutes
// estaba cargado en TODAS las tareas y ningún cron lo leía (la única familia
// con recordatorios operativos era owner_tasks). Medido en producción: 46
// tareas pendientes, 21 vencidas y nadie recibió un aviso.
//
// MISMO patrón probado de owner-tasks-reminder:
//  · Cron pg_cron cada 15 min → net.http_post con x-sync-secret (zernio_config
//    key='sync_secret'); deploy SIN verify_jwt (en NO_VERIFY de deploy.yml).
//  · Disparo: now() >= due_at - remind_before_minutes (default 1440 = 24 h).
//    Una tarea ya vencida dispara en la primera corrida (una sola vez).
//  · Marca lead_tasks.reminder_sent_at INMEDIATAMENTE después de confirmar el
//    envío de CADA tarea (no en batch al final) para no reenviar si la función
//    se corta a mitad de camino.
//  · Si no hay agente / email / el lead está muerto o cerrado → se MARCA
//    enviado y se salta (evita reintentar infinitamente cada 15 min).
//  · Si falla el envío de una tarea individual, se loguea y se continúa.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { registrarEnvio } from '../_shared/envios.ts';

interface ReminderConfig {
  brevo_api_key?: string;
  brevo_sender_email?: string;
  brevo_sender_name?: string;
}

async function getConfig(supabase: ReturnType<typeof createClient>): Promise<ReminderConfig> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "integrations")
    .single();

  const integrations = (data?.value || {}) as Record<string, string>;

  return {
    brevo_api_key: Deno.env.get("BREVO_API_KEY") || integrations.brevo_api_key,
    brevo_sender_email: Deno.env.get("BREVO_SENDER_EMAIL") || integrations.brevo_sender_email || "noreply@bienenhaus.com.ar",
    brevo_sender_name: Deno.env.get("BREVO_SENDER_NAME") || integrations.brevo_sender_name || "Bienenhaus CRM",
  };
}

async function sendBrevoEmail(
  config: ReminderConfig,
  toEmail: string,
  subject: string,
  htmlContent: string,
  textContent: string
): Promise<{ success: boolean; error?: string }> {
  if (!config.brevo_api_key) {
    return { success: false, error: "Brevo API key not configured" };
  }
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": config.brevo_api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        sender: { email: config.brevo_sender_email, name: config.brevo_sender_name },
        to: [{ email: toEmail }],
        subject,
        htmlContent,
        textContent,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return { success: false, error: `Brevo error: ${res.status} ${err}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: `Brevo exception: ${(err as Error).message}` };
  }
}

const CONTACT_TYPE_LABEL: Record<string, string> = {
  telefono: "Llamada",
  whatsapp: "WhatsApp",
  email: "Email",
};

const PRIORITY_LABEL: Record<string, string> = {
  baja: "Baja",
  media: "Media",
  alta: "Alta",
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildEmailContent(task: {
  title: string;
  description: string | null;
  due_at: string;
  priority: string | null;
  contact_type: string | null;
  lead_name?: string;
}): { html: string; text: string } {
  const priorityColors: Record<string, string> = {
    alta: "#EF4444",
    media: "#F97316",
    baja: "#1FC8C3",
  };
  const color = priorityColors[task.priority || "media"] || "#1FC8C3";
  const via = task.contact_type ? (CONTACT_TYPE_LABEL[task.contact_type] || task.contact_type) : null;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f4;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="background:${color};padding:24px;text-align:center;">
      <div style="font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.9);">BIENENHAUS CRM</div>
      <div style="margin-top:8px;font-size:24px;font-weight:800;color:#fff;">Recordatorio de tarea</div>
    </div>
    <div style="padding:32px;">
      <h1 style="margin:0 0 16px;font-size:22px;color:#111;">${task.title || "Tarea sin título"}</h1>
      ${task.description ? `<p style="margin:0 0 16px;font-size:14px;color:#444;white-space:pre-wrap;">${task.description}</p>` : ""}
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        ${task.lead_name ? `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Lead</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;text-align:right;">${task.lead_name}</td>
        </tr>` : ""}
        ${via ? `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Vía</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;text-align:right;">${via}</td>
        </tr>` : ""}
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Prioridad</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:${color};font-weight:700;text-align:right;">${PRIORITY_LABEL[task.priority || "media"] || task.priority || "Media"}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#888;font-size:13px;">Vence</td>
          <td style="padding:10px 0;color:#111;font-weight:600;text-align:right;">${fmtDateTime(task.due_at)}</td>
        </tr>
      </table>
      <div style="text-align:center;">
        <a href="https://bienenhaus.com.ar/admin.html#tab-leads" style="display:inline-block;background:${color};color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Abrir el CRM</a>
      </div>
    </div>
    <div style="background:#fafafa;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="margin:0;font-size:11px;color:#888;">Recibiste este email por una tarea de lead que tenés a tu cargo y está por vencer.<br>Bienenhaus Propiedades · Panel Administrativo</p>
    </div>
  </div>
</body>
</html>`;

  const text = `
BIENENHAUS CRM — Recordatorio de tarea
${"=".repeat(40)}

${task.title || "Tarea sin título"}
${task.description ? "\n" + task.description + "\n" : ""}
${task.lead_name ? `Lead: ${task.lead_name}\n` : ""}${via ? `Vía: ${via}\n` : ""}Prioridad: ${PRIORITY_LABEL[task.priority || "media"] || task.priority || "Media"}
Vence: ${fmtDateTime(task.due_at)}

Abrir el CRM: https://bienenhaus.com.ar/admin.html#tab-leads

---
Bienenhaus Propiedades · Panel Administrativo
`;

  return { html, text };
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  /* Auth: x-sync-secret (compartido con zernio-sync/backup-snapshot, en
     zernio_config key='sync_secret'). El cron no puede mandar JWT. */
  const syncSecret: string = await supabase
    .from("zernio_config")
    .select("value")
    .eq("key", "sync_secret")
    .maybeSingle()
    .then((r: { data?: { value?: { secret?: string } } | null }) => r.data?.value?.secret || "");
  if (!syncSecret || req.headers.get("x-sync-secret") !== syncSecret) {
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const process = async (): Promise<{ sent: number; failed: number; skipped: number }> => {
    /* La bandeja es ACCIONABLE: tareas sobre leads eliminados o cerrados
       (ganado/perdido) son ruido — se marcan enviadas y se saltan. */
    const STAGES_MUERTOS = new Set(["cerrado_ganado", "cerrado_perdido"]);

    const { data: tasks, error } = await supabase
      .from("lead_tasks")
      .select(`
        id,
        title,
        description,
        priority,
        due_at,
        status,
        assigned_to,
        remind_before_minutes,
        contact_type,
        lead:leads(id, full_name, stage, deleted_at)
      `)
      .is("reminder_sent_at", null)
      .in("status", ["pendiente", "en_progreso"]);

    if (error) {
      console.error("lead-tasks-reminder: query error", error);
      return { sent: 0, failed: 0, skipped: 0 };
    }

    const config = await getConfig(supabase);
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const task of tasks || []) {
      const mark = async () => {
        const { error: markErr } = await supabase
          .from("lead_tasks")
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq("id", task.id);
        if (markErr) {
          console.error("lead-tasks-reminder: mark failed", task.id, markErr);
          return false;
        }
        return true;
      };

      const lead = Array.isArray(task.lead) ? task.lead[0] : task.lead;
      if (!lead || lead.deleted_at) { await mark() ? skipped++ : failed++; continue; }
      if (STAGES_MUERTOS.has(String(lead.stage || ""))) { await mark() ? skipped++ : failed++; continue; }

      /* Momento de disparo: now() >= due_at - remind_before_minutes.
         Una tarea ya vencida dispara en la primera corrida (una sola vez). */
      const triggerAt = new Date(
        new Date(task.due_at).getTime() - (task.remind_before_minutes || 1440) * 60 * 1000
      );
      if (Date.now() < triggerAt.getTime()) {
        skipped += 1;
        continue;
      }

      if (!task.assigned_to) { await mark() ? skipped++ : failed++; continue; }

      /* Variables del envío declaradas FUERA del try para que el catch pueda
         dejar la traza del fallo (P0-4) con el destinatario y el asunto. */
      let email: string | undefined;
      let subject = "";

      try {
        const { data: agent } = await supabase
          .from("agents")
          .select("profile_id, full_name")
          .eq("id", task.assigned_to)
          .single();

        const profileId = agent?.profile_id;

        if (profileId) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("email")
            .eq("id", profileId)
            .single();
          email = profile?.email;
        }

        if (!email) {
          console.error(`lead-tasks-reminder: sin email para el agente ${task.assigned_to} (tarea ${task.id})`);
          await mark();
          skipped += 1;
          continue;
        }

        // Respetar notification_preferences.email = false si existe.
        const { data: prefs } = await supabase
          .from("notification_preferences")
          .select("email")
          .eq("user_id", profileId)
          .maybeSingle();

        if (prefs && prefs.email === false) {
          await mark();
          skipped += 1;
          continue;
        }

        const { html, text } = buildEmailContent({
          title: task.title,
          description: task.description,
          due_at: task.due_at,
          priority: task.priority,
          contact_type: task.contact_type,
          lead_name: lead.full_name,
        });

        subject = `[Bienenhaus CRM] Tarea de lead: ${task.title || "sin título"} — ${lead.full_name || ""}`;
        const result = await sendBrevoEmail(config, email, subject, html, text);

        if (!result.success) {
          throw new Error(result.error || "send failed");
        }

        // Marcar enviado INMEDIATAMENTE después de confirmar esta tarea.
        await mark();
        sent += 1;

        /* Traza del envío OK (P0-4). */
        await registrarEnvio(supabase, {
          origen: 'lead_task_reminder',
          estado: 'enviado',
          lead_id: lead.id,
          tarea_id: task.id,
          agente_id: task.assigned_to,
          destinatario: email,
          asunto: subject,
          proveedor: 'brevo',
          metadata: { lead_stage: lead.stage, due_at: task.due_at, priority: task.priority },
        });
      } catch (err) {
        const msg = (err as Error).message || String(err);
        console.error(`lead-tasks-reminder: tarea ${task.id} falló`, msg);
        failed += 1;
        /* Traza del fallo (P0-4): el trigger de `crm_envios` abre la alerta
           `crm_email_broken` (una por día) y la auto-resuelve con el primer
           envío OK. Antes esa alerta se acumulaba para siempre. */
        try {
          await registrarEnvio(supabase, {
            origen: 'lead_task_reminder',
            estado: 'error',
            lead_id: lead.id,
            tarea_id: task.id,
            agente_id: task.assigned_to,
            destinatario: email,
            asunto: subject,
            proveedor: 'brevo',
            error: msg.slice(0, 900),
            metadata: { lead_stage: lead.stage, due_at: task.due_at, priority: task.priority },
          });
        } catch (_) { /* la traza nunca bloquea el reminder */ }
        /* Sin marcar: la próxima corrida lo reintenta (el fallo fue del envío,
           no de la tarea). Si el email queda roto, el badge de la bandeja
           sigue siendo la red de seguridad. */
      }
    }

    return { sent, failed, skipped };
  };

  const result = await process();
  return new Response(JSON.stringify({ ok: true, ...result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
