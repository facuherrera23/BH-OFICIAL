import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AlertPayload {
  alert_id: string;
  severity: string;
  title: string;
  description: string;
  module: string;
  user_id: string;
  user_email: string;
  user_name: string;
  evidence?: Record<string, unknown>;
  created_at: string;
}

interface NotificationConfig {
  brevo_api_key?: string;
  brevo_sender_email?: string;
  brevo_sender_name?: string;
  slack_webhook_url?: string;
  teams_webhook_url?: string;
  notify_emails?: string[]; // super_admins adicionales
}

async function getConfig(supabase: ReturnType<typeof createClient>): Promise<NotificationConfig> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "integrations")
    .single();

  const integrations = data?.value || {};

  // También leer de env vars (prioridad sobre DB)
  return {
    brevo_api_key: Deno.env.get("BREVO_API_KEY") || integrations.brevo_api_key,
    brevo_sender_email: Deno.env.get("BREVO_SENDER_EMAIL") || integrations.brevo_sender_email || "noreply@bienenhaus.com.ar",
    brevo_sender_name: Deno.env.get("BREVO_SENDER_NAME") || integrations.brevo_sender_name || "Bienenhaus Supervisión",
    slack_webhook_url: Deno.env.get("SLACK_WEBHOOK_URL") || integrations.slack_webhook_url,
    teams_webhook_url: Deno.env.get("TEAMS_WEBHOOK_URL") || integrations.teams_webhook_url,
    notify_emails: integrations.supervision_notify_emails || [],
  };
}

async function sendBrevoEmail(
  config: NotificationConfig,
  to: string[],
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
        to: to.map(email => ({ email })),
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

async function sendSlackWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      return { success: false, error: `Slack error: ${res.status} ${err}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: `Slack exception: ${err.message}` };
  }
}

async function sendTeamsWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      return { success: false, error: `Teams error: ${res.status} ${err}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: `Teams exception: ${err.message}` };
  }
}

function buildEmailContent(alert: AlertPayload, dashboardUrl: string): { html: string; text: string } {
  const severityColors: Record<string, string> = {
    critical: "#EF4444",
    high: "#F97316",
    medium: "#FFB800",
    low: "#3B82F6",
    info: "#1FC8C3",
  };
  const severityLabels: Record<string, string> = {
    critical: "🔴 CRÍTICA",
    high: "🟠 ALTA",
    medium: "🟡 MEDIA",
    low: "🔵 BAJA",
    info: "⚪ INFO",
  };

  const color = severityColors[alert.severity] || "#1FC8C3";
  const label = severityLabels[alert.severity] || alert.severity.toUpperCase();
  const time = new Date(alert.created_at).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f4;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <!-- Header -->
    <div style="background:${color};padding:24px;text-align:center;">
      <div style="font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.9);">BIENENHAUS SUPERVISIÓN</div>
      <div style="margin-top:8px;font-size:28px;font-weight:800;color:#fff;">${label}</div>
    </div>
    <!-- Body -->
    <div style="padding:32px;">
      <h1 style="margin:0 0 16px;font-size:22px;color:#111;">${alert.title}</h1>
      <p style="margin:0 0 24px;color:#444;line-height:1.6;">${alert.description || "Sin descripción adicional"}</p>
      <!-- Details table -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Módulo</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;text-align:right;">${alert.module}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Usuario</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;text-align:right;">${alert.user_name} (${alert.user_email})</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#888;font-size:13px;">Fecha</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;text-align:right;">${time}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#888;font-size:13px;">Severidad</td>
          <td style="padding:10px 0;color:${color};font-weight:700;text-align:right;">${label}</td>
        </tr>
      </table>
      ${alert.evidence && Object.keys(alert.evidence).length > 0 ? `
      <div style="background:#fafafa;border-radius:8px;padding:16px;margin-bottom:24px;">
        <div style="font-size:12px;font-weight:600;color:#888;margin-bottom:8px;">EVIDENCIA</div>
        <pre style="margin:0;font-size:11px;color:#444;overflow:auto;white-space:pre-wrap;">${JSON.stringify(alert.evidence, null, 2)}</pre>
      </div>
      ` : ""}
      <!-- CTA -->
      <div style="text-align:center;">
        <a href="${dashboardUrl}#tab-supervision" style="display:inline-block;background:${color};color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Ver en Centro de Supervisión</a>
      </div>
    </div>
    <!-- Footer -->
    <div style="background:#fafafa;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="margin:0;font-size:11px;color:#888;">Recibiste este email porque estás configurado para recibir alertas de supervisión crítica/alta.<br>Bienenhaus Propiedades · Panel Administrativo</p>
    </div>
  </div>
</body>
</html>`;

  const text = `
BIENENHAUS SUPERVISIÓN — ${label}
${"=".repeat(40)}

${alert.title}
${alert.description || "Sin descripción adicional"}

Módulo: ${alert.module}
Usuario: ${alert.user_name} (${alert.user_email})
Fecha: ${time}
Severidad: ${label}

${alert.evidence && Object.keys(alert.evidence).length > 0 ? `Evidencia:\n${JSON.stringify(alert.evidence, null, 2)}` : ""}

Ver en Centro de Supervisión: ${dashboardUrl}#tab-supervision

---
Bienenhaus Propiedades · Panel Administrativo
`;

  return { html, text };
}

function buildSlackPayload(alert: AlertPayload, dashboardUrl: string): Record<string, unknown> {
  const severityColors: Record<string, string> = {
    critical: "#EF4444",
    high: "#F97316",
    medium: "#FFB800",
    low: "#3B82F6",
    info: "#1FC8C3",
  };
  const severityEmoji: Record<string, string> = {
    critical: "🔴",
    high: "🟠",
    medium: "🟡",
    low: "🔵",
    info: "⚪",
  };

  return {
    username: "Bienenhaus Supervisión",
    icon_emoji: ":shield:",
    attachments: [
      {
        color: severityColors[alert.severity] || "#1FC8C3",
        title: `${severityEmoji[alert.severity] || "⚠️"} ${alert.title}`,
        title_link: `${dashboardUrl}#tab-supervision`,
        text: alert.description || "Sin descripción",
        fields: [
          { title: "Módulo", value: alert.module, short: true },
          { title: "Usuario", value: `${alert.user_name} (${alert.user_email})`, short: true },
          { title: "Severidad", value: alert.severity.toUpperCase(), short: true },
          { title: "Fecha", value: new Date(alert.created_at).toLocaleString("es-AR"), short: true },
        ],
        footer: "Bienenhaus Supervisión",
        ts: Math.floor(new Date(alert.created_at).getTime() / 1000),
      },
    ],
  };
}

function buildTeamsPayload(alert: AlertPayload, dashboardUrl: string): Record<string, unknown> {
  const severityColors: Record<string, string> = {
    critical: "EF4444",
    high: "F97316",
    medium: "FFB800",
    low: "3B82F6",
    info: "1FC8C3",
  };

  return {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: severityColors[alert.severity] || "1FC8C3",
    summary: `Bienenhaus: ${alert.title}`,
    sections: [
      {
        activityTitle: `**${alert.title}**`,
        activitySubtitle: `Bienenhaus Supervisión — ${alert.severity.toUpperCase()}`,
        activityImage: "https://bienenhaus.com.ar/assets/images/logo-bh.png",
        facts: [
          { name: "Módulo", value: alert.module },
          { name: "Usuario", value: `${alert.user_name} (${alert.user_email})` },
          { name: "Severidad", value: alert.severity.toUpperCase() },
          { name: "Fecha", value: new Date(alert.created_at).toLocaleString("es-AR") },
        ],
        text: alert.description || "Sin descripción",
      },
    ],
    potentialAction: [
      {
        "@type": "OpenUri",
        name: "Ver en Centro de Supervisión",
        targets: [{ os: "default", uri: `${dashboardUrl}#tab-supervision` }],
      },
    ],
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verificar auth (service_role o super_admin)
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing authorization" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  try {
    const body = await req.json();
    const { alert_id, trigger } = body; // trigger: 'created' | 'escalated' | 'test'

    if (!alert_id) {
      return new Response(JSON.stringify({ error: "alert_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cargar alerta completa
    const { data: alert, error: alertErr } = await supabase
      .from("supervision_alerts")
      .select("*, user:profiles!user_id(email, full_name)")
      .eq("id", alert_id)
      .single();

    if (alertErr || !alert) {
      return new Response(JSON.stringify({ error: "Alert not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Solo notificar critical/high (configurable después)
    const notifySeverities = ["critical", "high"];
    if (!notifySeverities.includes(alert.severity)) {
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: `Severity ${alert.severity} not in notify list`,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const config = await getConfig(supabase);
    const dashboardUrl = Deno.env.get("DASHBOARD_URL") || "https://bienenhaus.com.ar/admin.html";

    const payload: AlertPayload = {
      alert_id: alert.id,
      severity: alert.severity,
      title: alert.title,
      description: alert.description || "",
      module: alert.module,
      user_id: alert.user_id,
      user_email: alert.user?.email || "unknown",
      user_name: alert.user?.full_name || "Sin nombre",
      evidence: alert.evidence as Record<string, unknown>,
      created_at: alert.created_at,
    };

    const { html, text } = buildEmailContent(payload, dashboardUrl);
    const results: Record<string, { success: boolean; error?: string }> = {};

    // 1. Email a super_admins (via Brevo)
    // Obtener emails de super_admins
    const { data: admins } = await supabase
      .from("profiles")
      .select("email")
      .eq("role", "super_admin")
      .eq("is_active", true);

    const adminEmails = (admins || []).map(a => a.email).filter(Boolean);
    const allEmails = [...new Set([...adminEmails, ...(config.notify_emails || [])])];

    if (allEmails.length > 0 && config.brevo_api_key) {
      results.email = await sendBrevoEmail(
        config,
        allEmails,
        `[Bienenhaus ${payload.severity.toUpperCase()}] ${payload.title}`,
        html,
        text
      );
    } else {
      results.email = { success: false, error: "No recipients or Brevo not configured" };
    }

    // 2. Slack webhook
    if (config.slack_webhook_url) {
      results.slack = await sendSlackWebhook(config.slack_webhook_url, buildSlackPayload(payload, dashboardUrl));
    }

    // 3. Teams webhook
    if (config.teams_webhook_url) {
      results.teams = await sendTeamsWebhook(config.teams_webhook_url, buildTeamsPayload(payload, dashboardUrl));
    }

    // Log resultado
    await supabase.from("audit_log").insert({
      user_id: null,
      action: "supervision_notify",
      module: "supervision",
      status: "success",
      metadata: { alert_id, trigger, results },
    }).select().single(); // fire-and-forget

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("supervision-notify error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});