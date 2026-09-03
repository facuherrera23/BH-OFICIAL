// ============================================================
// owner-tasks-reminder — Recordatorio automático de tareas de propietarios
// ============================================================
// Esta Edge Function se ejecuta por CRON (pg_cron cada 15 min, registrado en
// la migración 20260903000015_owner_tasks_crm.sql). Por eso su deploy es SIN
// verify_jwt (`supabase functions deploy owner-tasks-reminder --no-verify-jwt`):
// la invoca el job de la BD con el service_role_key, no el frontend.
//
// Proceso:
//  1. Selecciona tareas cuyo recordatorio dispara y aún no se envió:
//       reminder_sent_at IS NULL
//       AND status IN ('pendiente','en_progreso')
//       AND now() >= due_date - (remind_before_minutes || ' minutes')::interval
//  2. Resuelve el email del agente asignado (assigned_to -> agents.profile_id
//     -> profiles.email) y respeta notification_preferences.email = false.
//  3. Envía por Brevo (mismo patrón que supervision-notify / supervision-digest).
//  4. Marca reminder_sent_at = now() INMEDIATAMENTE después de confirmar el
//     envío de CADA tarea (no en batch al final) para no reenviar si la
//     función se corta a mitad de camino.
//
// Errores: si falla el envío de una tarea individual, se loguea y se continúa
// con las demás (no aborta el batch completo).
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse } from '../_shared/http.ts';

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

  const integrations = data?.value || {};

  return {
    brevo_api_key: Deno.env.get("BREVO_API_KEY") || integrations.brevo_api_key,
    brevo_sender_email: Deno.env.get("BREVO_SENDER_EMAIL") || integrations.brevo_sender_email || "noreply@bienenhaus.com.ar",
    brevo_sender_name: Deno.env.get("BREVO_SENDER_NAME") || integrations.brevo_sender_name || "Bienenhaus Tareas",
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
    return { success: false, error: `Brevo exception: ${err.message}` };
  }
}

const TYPE_LABEL: Record<string, string> = {
  note: "Nota interna",
  alert: "Alerta",
  commission: "Comisión",
  document: "Documento",
  contact: "Contacto",
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
  description: string;
  due_date: string;
  type: string;
  priority: string;
  owner_name?: string;
}): { html: string; text: string } {
  const priorityColors: Record<string, string> = {
    alta: "#EF4444",
    media: "#F97316",
    baja: "#1FC8C3",
  };
  const color = priorityColors[task.priority] || "#1FC8C3";

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
      <div style="font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.9);">BIENENHAUS TAREAS</div>
      <div style="margin-top:8px;font-size:24px;font-weight:800;color:#fff;">Recordatorio de tarea</div>
    </div>
    <div style="padding:32px;">
      <h1 style="margin:0 0 16px;font-size:22px;color:#111;">${task.description || "Tarea sin descripción"}</h1>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Motivo</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;text-align:right;">${TYPE_LABEL[task.type] || task.type}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Prioridad</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:${color};font-weight:700;text-align:right;">${PRIORITY_LABEL[task.priority] || task.priority}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Vence</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;text-align:right;">${fmtDateTime(task.due_date)}</td>
        </tr>
        ${task.owner_name ? `
        <tr>
          <td style="padding:10px 0;color:#888;font-size:13px;">Propietario</td>
          <td style="padding:10px 0;color:#111;font-weight:600;text-align:right;">${task.owner_name}</td>
        </tr>` : ""}
      </table>
      <div style="text-align:center;">
        <a href="https://bienenhaus.com.ar/admin.html#tab-propietarios" style="display:inline-block;background:${color};color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Ver en Propietarios</a>
      </div>
    </div>
    <div style="background:#fafafa;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="margin:0;font-size:11px;color:#888;">Recibiste este email por una tarea asignada a vos que está por vencer.<br>Bienenhaus Propiedades · Panel Administrativo</p>
    </div>
  </div>
</body>
</html>`;

  const text = `
BIENENHAUS TAREAS — Recordatorio de tarea
${"=".repeat(40)}

${task.description || "Tarea sin descripción"}

Motivo: ${TYPE_LABEL[task.type] || task.type}
Prioridad: ${PRIORITY_LABEL[task.priority] || task.priority}
Vence: ${fmtDateTime(task.due_date)}
${task.owner_name ? `Propietario: ${task.owner_name}` : ""}

Ver en Propietarios: https://bienenhaus.com.ar/admin.html#tab-propietarios

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

  // Fire-and-forget: el cron no espera respuesta, pero respondemos 200 ok.
  const process = async (): Promise<{ sent: number; failed: number; skipped: number }> => {
    const { data: tasks, error } = await supabase
      .from("owner_tasks")
      .select(`
        id,
        description,
        type,
        priority,
        due_date,
        status,
        assigned_to,
        remind_before_minutes,
        owner:owners!inner(full_name)
      `)
      .is("reminder_sent_at", null)
      .in("status", ["pendiente", "en_progreso"]);

    if (error) {
      console.error("owner-tasks-reminder: query error", error);
      return { sent: 0, failed: 0, skipped: 0 };
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const task of tasks || []) {
      const triggerAt = new Date(
        new Date(task.due_date).getTime() - (task.remind_before_minutes || 1440) * 60 * 1000
      );

      // Momento de disparo: now() >= due_date - remind_before_minutes
      if (Date.now() < triggerAt.getTime()) {
        skipped += 1;
        continue;
      }

      if (!task.assigned_to) {
        // Sin responsable asignado: no se puede notificar, marcamos como enviado
        // (reminder_sent_at) para no reintentar infinitamente cada 15 min.
        const { error: upErr } = await supabase
          .from("owner_tasks")
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq("id", task.id);
        if (upErr) {
          console.error("owner-tasks-reminder: mark no-assignee task failed", task.id, upErr);
          failed += 1;
        } else {
          skipped += 1;
        }
        continue;
      }

      try {
        const { data: agent } = await supabase
          .from("agents")
          .select("profile_id, full_name")
          .eq("id", task.assigned_to)
          .single();

        const profileId = agent?.profile_id;
        let email: string | undefined;

        if (profileId) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("email")
            .eq("id", profileId)
            .single();
          email = profile?.email;
        }

        if (!email) {
          throw new Error(`No email for agent ${task.assigned_to}`);
        }

        // Respetar notification_preferences.email = false si existe.
        const { data: prefs } = await supabase
          .from("notification_preferences")
          .select("email")
          .eq("user_id", profileId)
          .maybeSingle();

        if (prefs && prefs.email === false) {
          const { error: markErr } = await supabase
            .from("owner_tasks")
            .update({ reminder_sent_at: new Date().toISOString() })
            .eq("id", task.id);
          if (markErr) {
            console.error("owner-tasks-reminder: mark email-disabled task failed", task.id, markErr);
            failed += 1;
          } else {
            skipped += 1;
          }
          continue;
        }

        const config = await getConfig(supabase);
        const { html, text } = buildEmailContent({
          description: task.description,
          due_date: task.due_date,
          type: task.type,
          priority: task.priority,
          owner_name: task.owner?.full_name,
        });

        const subject = `[Bienenhaus TAREAS] Recordatorio: ${task.description}`;
        const result = await sendBrevoEmail(config, email, subject, html, text);

        if (!result.success) {
          throw new Error(result.error || "send failed");
        }

        // Marcar enviado INMEDIATAMENTE después de confirmar esta tarea.
        const { error: markErr } = await supabase
          .from("owner_tasks")
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq("id", task.id);

        if (markErr) {
          console.error("owner-tasks-reminder: mark task failed after send", task.id, markErr);
        }

        sent += 1;
      } catch (err) {
        console.error(`owner-tasks-reminder: task ${task.id} failed`, (err as Error).message);
        failed += 1;
        // Se continúa con la siguiente tarea; no se aborta el batch.
      }
    }

    return { sent, failed, skipped };
  };

  try {
    const result = await process();
    // Log mínimo para trazar el cron sin loguear contenido sensible.
    console.log("owner-tasks-reminder done", result);
    return jsonResponse(200, { success: true, ...result }, req);
  } catch (err) {
    console.error("owner-tasks-reminder error:", err);
    return jsonResponse(500, { error: (err as Error).message }, req);
  }
});