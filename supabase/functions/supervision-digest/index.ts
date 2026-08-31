import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/http.ts';

interface DigestConfig {
  brevo_api_key?: string;
  brevo_sender_email?: string;
  brevo_sender_name?: string;
  recipients?: string[];
  include_kpis?: boolean;
  include_rankings?: boolean;
  include_alerts?: boolean;
  include_trends?: boolean;
  include_unassigned?: boolean;
  dashboard_url?: string;
}

async function getConfig(supabase: ReturnType<typeof createClient>): Promise<DigestConfig> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "integrations")
    .single();

  const integrations = data?.value || {};

  return {
    brevo_api_key: Deno.env.get("BREVO_API_KEY") || integrations.brevo_api_key,
    brevo_sender_email: Deno.env.get("BREVO_SENDER_EMAIL") || integrations.brevo_sender_email || "noreply@bienenhaus.com.ar",
    brevo_sender_name: Deno.env.get("BREVO_SENDER_NAME") || integrations.brevo_sender_name || "Bienenhaus Supervisión",
    recipients: integrations.supervision_digest_recipients || [],
    include_kpis: integrations.supervision_digest_kpis ?? true,
    include_rankings: integrations.supervision_digest_rankings ?? true,
    include_alerts: integrations.supervision_digest_alerts ?? true,
    include_trends: integrations.supervision_digest_trends ?? true,
    include_unassigned: integrations.supervision_digest_unassigned ?? true,
    dashboard_url: Deno.env.get("DASHBOARD_URL") || "https://bienenhaus.com.ar/admin.html",
  };
}

async function sendBrevoEmail(
  config: DigestConfig,
  to: string[],
  subject: string,
  htmlContent: string,
  textContent: string
): Promise<{ success: boolean; error?: string; messageId?: string }> {
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

    const result = await res.json();

    if (!res.ok) {
      return { success: false, error: `Brevo error: ${res.status} ${JSON.stringify(result)}` };
    }

    return { success: true, messageId: result.messageId };
  } catch (err) {
    return { success: false, error: `Brevo exception: ${err.message}` };
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("es-AR").format(n);
}

async function fetchDigestData(supabase: ReturnType<typeof createClient>) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const [
    auditRes,
    alertsRes,
    usersRes,
  ] = await Promise.all([
    supabase.from("audit_log").select("*").gte("created_at", weekAgo).lte("created_at", now),
    supabase.from("supervision_alerts").select("*").gte("created_at", weekAgo).lte("created_at", now),
    supabase.from("profiles").select("id, full_name, email, role").eq("role", "super_admin").eq("is_active", true),
  ]);

  const audit = auditRes.data || [];
  const alerts = alertsRes.data || [];
  const admins = usersRes.data || [];

  const uniqueUsers = new Set(audit.map(a => a.user_id).filter(Boolean)).size;
  const actionsTotal = audit.length;
  const actionsToday = audit.filter(a => new Date(a.created_at).toDateString() === new Date().toDateString()).length;
  const successCount = audit.filter(a => a.severity === "success" || a.severity === "info").length;
  const errorCount = audit.filter(a => a.severity === "error" || a.severity === "critical").length;
  const sensitiveCount = audit.filter(a => a.metadata?.sensitive === true).length;
  const exportsCount = audit.filter(a => a.action === "export" || a.action?.includes("export")).length;
  const bulkOpsCount = audit.filter(a => a.action?.includes("bulk") || a.metadata?.bulk === true).length;

  const openAlerts = alerts.filter(a => a.status === "open").length;
  const criticalAlerts = alerts.filter(a => a.severity === "critical").length;
  const highAlerts = alerts.filter(a => a.severity === "high").length;
  const unassignedAlerts = alerts.filter(a => a.status === "open" && !a.assigned_to).length;

  const byUser: Record<string, { count: number; name: string; email: string; errors: number; sensitive: number }> = {};
  audit.forEach(a => {
    const uid = a.user_id || "sistema";
    if (!byUser[uid]) byUser[uid] = { count: 0, name: uid, email: "", errors: 0, sensitive: 0 };
    byUser[uid].count++;
    if (a.severity === "error" || a.severity === "critical") byUser[uid].errors++;
    if (a.metadata?.sensitive === true) byUser[uid].sensitive++;
  });
  const adminMap = new Map(admins.map(u => [u.id, u]));
  Object.keys(byUser).forEach(uid => {
    const admin = adminMap.get(uid);
    if (admin) {
      byUser[uid].name = admin.full_name || admin.email;
      byUser[uid].email = admin.email;
    }
  });
  const topUsers = Object.entries(byUser)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);

  const byModule: Record<string, { count: number; errors: number }> = {};
  audit.forEach(a => {
    const mod = a.module || "general";
    if (!byModule[mod]) byModule[mod] = { count: 0, errors: 0 };
    byModule[mod].count++;
    if (a.severity === "error" || a.severity === "critical") byModule[mod].errors++;
  });
  const topModules = Object.entries(byModule)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);

  const errorsByUser: Record<string, number> = {};
  audit.filter(a => a.severity === "error" || a.severity === "critical").forEach(a => {
    const uid = a.user_id || "sistema";
    errorsByUser[uid] = (errorsByUser[uid] || 0) + 1;
  });
  const topErrors = Object.entries(errorsByUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const sensitiveByUser: Record<string, number> = {};
  audit.filter(a => a.metadata?.sensitive === true).forEach(a => {
    const uid = a.user_id || "sistema";
    sensitiveByUser[uid] = (sensitiveByUser[uid] || 0) + 1;
  });
  const topSensitive = Object.entries(sensitiveByUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const alertsBySeverity = {
    critical: alerts.filter(a => a.severity === "critical").length,
    high: alerts.filter(a => a.severity === "high").length,
    medium: alerts.filter(a => a.severity === "medium").length,
    low: alerts.filter(a => a.severity === "low").length,
    info: alerts.filter(a => a.severity === "info").length,
  };

  const alertsByModule: Record<string, number> = {};
  alerts.forEach(a => {
    const mod = a.module || "system";
    alertsByModule[mod] = (alertsByModule[mod] || 0) + 1;
  });

  const unassignedCritical = alerts
    .filter(a => a.status === "open" && !a.assigned_to && (a.severity === "critical" || a.severity === "high"))
    .slice(0, 10)
    .map(a => ({
      id: a.id,
      title: a.title || a.rule_name || a.alert_type,
      severity: a.severity,
      module: a.module,
      user: a.user_name || a.user_id,
      created: formatDateTime(a.created_at),
    }));

  const dailyActivity: Record<string, { total: number; errors: number; alerts: number }> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
    const dayKey = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "short" });
    dailyActivity[dayKey] = {
      total: audit.filter(a => a.created_at >= dayStart && a.created_at < dayEnd).length,
      errors: audit.filter(a => a.created_at >= dayStart && a.created_at < dayEnd && (a.severity === "error" || a.severity === "critical")).length,
      alerts: alerts.filter(a => a.created_at >= dayStart && a.created_at < dayEnd).length,
    };
  }

  return {
    period: {
      start: formatDate(weekAgo),
      end: formatDate(now),
      generated: formatDateTime(now),
    },
    kpis: {
      uniqueUsers,
      actionsTotal,
      actionsToday,
      successCount,
      errorCount,
      sensitiveCount,
      exportsCount,
      bulkOpsCount,
      openAlerts,
      criticalAlerts,
      highAlerts,
      unassignedAlerts,
    },
    rankings: {
      topUsers,
      topModules,
      topErrors,
      topSensitive,
    },
    alerts: {
      bySeverity: alertsBySeverity,
      byModule: alertsByModule,
      unassignedCritical,
    },
    trends: {
      dailyActivity,
    },
    meta: {
      totalAuditEvents: audit.length,
      totalAlerts: alerts.length,
    },
  };
}

function buildEmailHTML(data: any, config: DigestConfig): string {
  const d = data;
  const dashboardUrl = config.dashboard_url || "https://bienenhaus.com.ar/admin.html";
  const periodLabel = `${d.period.start} – ${d.period.end}`;

  const severityColors = {
    critical: "#EF4444",
    high: "#F97316",
    medium: "#FFB800",
    low: "#3B82F6",
    info: "#1FC8C3",
  };

  const kpiCards = d.kpis ? `
    <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="width:20%;padding:8px;"><div style="background:#fafafa;border-radius:8px;padding:16px;text-align:center;border:1px solid #eee;"><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Usuarios Activos</div><div style="font-size:24px;font-weight:700;color:#111;">${formatNumber(d.kpis.uniqueUsers)}</div></div></td>
        <td style="width:20%;padding:8px;"><div style="background:#fafafa;border-radius:8px;padding:16px;text-align:center;border:1px solid #eee;"><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Acciones Totales</div><div style="font-size:24px;font-weight:700;color:#111;">${formatNumber(d.kpis.actionsTotal)}</div></div></td>
        <td style="width:20%;padding:8px;"><div style="background:#fafafa;border-radius:8px;padding:16px;text-align:center;border:1px solid #eee;"><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Exitosas</div><div style="font-size:24px;font-weight:700;color:${severityColors.info};">${formatNumber(d.kpis.successCount)}</div></div></td>
        <td style="width:20%;padding:8px;"><div style="background:#fafafa;border-radius:8px;padding:16px;text-align:center;border:1px solid #eee;"><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Fallidas</div><div style="font-size:24px;font-weight:700;color:${severityColors.critical};">${formatNumber(d.kpis.errorCount)}</div></div></td>
        <td style="width:20%;padding:8px;"><div style="background:#fafafa;border-radius:8px;padding:16px;text-align:center;border:1px solid #eee;"><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Alertas Abiertas</div><div style="font-size:24px;font-weight:700;color:${severityColors.high};">${formatNumber(d.kpis.openAlerts)}</div></div></td>
      </tr>
    </table>
  ` : "";

  const rankingTable = (title: string, items: [string, any][], keyLabel: string, valueLabel: string, getValue: (v: any) => number, getLabel: (k: string, v: any) => string) => {
    if (!items.length) return "";
    return `
      <h3 style="margin:24px 0 12px;font-size:16px;color:#111;">${title}</h3>
      <table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:10px;text-align:left;border-bottom:2px solid #ddd;">${keyLabel}</th>
            <th style="padding:10px;text-align:right;border-bottom:2px solid #ddd;">${valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(([key, val], i) => `
            <tr style="${i % 2 === 0 ? "background:#fafafa;" : ""}">
              <td style="padding:10px;border-bottom:1px solid #eee;">${i + 1}. ${getLabel(key, val)}</td>
              <td style="padding:10px;text-align:right;border-bottom:1px solid #eee;font-weight:600;color:#111;">${formatNumber(getValue(val))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  };

  const alertsTable = () => {
    if (!d.alerts?.bySeverity) return "";
    const total = Object.values(d.alerts.bySeverity).reduce((a: number, b: number) => a + b, 0);
    if (!total) return "";
    return `
      <h3 style="margin:24px 0 12px;font-size:16px;color:#111;">Alertas por Severidad</h3>
      <table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:10px;text-align:left;border-bottom:2px solid #ddd;">Severidad</th>
            <th style="padding:10px;text-align:right;border-bottom:2px solid #ddd;">Cantidad</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(d.alerts.bySeverity).map(([sev, count]) => `
            <tr>
              <td style="padding:10px;border-bottom:1px solid #eee;"><span style="color:${severityColors[sev as keyof typeof severityColors] || "#111"};font-weight:600;">●</span> ${sev.charAt(0).toUpperCase() + sev.slice(1)}</td>
              <td style="padding:10px;text-align:right;border-bottom:1px solid #eee;font-weight:600;">${formatNumber(count)}</td>
            </tr>
          `).join("")}
          <tr style="background:#f4f4f4;font-weight:700;">
            <td style="padding:10px;border-top:2px solid #ddd;">Total</td>
            <td style="padding:10px;text-align:right;border-top:2px solid #ddd;">${formatNumber(total)}</td>
          </tr>
        </tbody>
      </table>
    `;
  };

  const unassignedAlerts = () => {
    if (!d.alerts?.unassignedCritical?.length) return "";
    return `
      <h3 style="margin:24px 0 12px;font-size:16px;color:#111;">⚠️ Alertas Críticas/Alta Sin Asignar (${d.alerts.unassignedCritical.length})</h3>
      <table role="presentation" style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#fef2f2;">
            <th style="padding:10px;text-align:left;border-bottom:2px solid #fecaca;">Alerta</th>
            <th style="padding:10px;text-align:center;border-bottom:2px solid #fecaca;">Severidad</th>
            <th style="padding:10px;text-align:left;border-bottom:2px solid #fecaca;">Módulo</th>
            <th style="padding:10px;text-align:left;border-bottom:2px solid #fecaca;">Usuario</th>
            <th style="padding:10px;text-align:center;border-bottom:2px solid #fecaca;">Creada</th>
          </tr>
        </thead>
        <tbody>
          ${d.alerts.unassignedCritical.map(a => `
            <tr style="border-bottom:1px solid #fecaca;">
              <td style="padding:10px;font-weight:500;color:#991b1b;">${a.title}</td>
              <td style="padding:10px;text-align:center;"><span style="background:${severityColors[a.severity as keyof typeof severityColors]};color:#fff;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:600;">${a.severity.toUpperCase()}</span></td>
              <td style="padding:10px;color:#7f1d1d;">${a.module}</td>
              <td style="padding:10px;color:#7f1d1d;">${a.user}</td>
              <td style="padding:10px;text-align:center;color:#7f1d1d;font-size:11px;">${a.created}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <p style="margin-top:12px;text-align:center;"><a href="${dashboardUrl}#tab-supervision" style="display:inline-block;background:#EF4444;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Ver todas en Centro de Supervisión</a></p>
    `;
  };

  const trendChart = () => {
    if (!d.trends?.dailyActivity) return "";
    const days = Object.entries(d.trends.dailyActivity);
    const maxTotal = Math.max(...days.map(([, v]) => v.total));
    const maxErrors = Math.max(...days.map(([, v]) => v.errors));
    return `
      <h3 style="margin:24px 0 12px;font-size:16px;color:#111;">Tendencia Semanal (Actividad / Errores / Alertas)</h3>
      <table role="presentation" style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:10px;text-align:left;border-bottom:2px solid #ddd;">Día</th>
            <th style="padding:10px;text-align:center;border-bottom:2px solid #ddd;">Acciones</th>
            <th style="padding:10px;text-align:center;border-bottom:2px solid #ddd;">Errores</th>
            <th style="padding:10px;text-align:center;border-bottom:2px solid #ddd;">Alertas</th>
          </tr>
        </thead>
        <tbody>
          ${days.map(([day, v]) => `
            <tr style="${days.indexOf([day, v]) % 2 === 0 ? "background:#fafafa;" : ""}">
              <td style="padding:10px;border-bottom:1px solid #eee;font-weight:600;">${day}</td>
              <td style="padding:10px;text-align:center;border-bottom:1px solid #eee;">${formatNumber(v.total)}</td>
              <td style="padding:10px;text-align:center;border-bottom:1px solid #eee;color:${v.errors > 0 ? severityColors.critical : "#111"};">${formatNumber(v.errors)}</td>
              <td style="padding:10px;text-align:center;border-bottom:1px solid #eee;">${formatNumber(v.alerts)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  };

  const ctaButton = `<div style="text-align:center;margin-top:32px;"><a href="${dashboardUrl}#tab-supervision" style="display:inline-block;background:#1FC8C3;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Ver Centro de Supervisión Completo</a></div>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f4;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <!-- Header -->
    <div style="background:#1FC8C3;padding:24px;text-align:center;">
      <div style="font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.9);">BIENENHAUS SUPERVISIÓN</div>
      <div style="margin-top:8px;font-size:28px;font-weight:800;color:#fff;">Resumen Semanal</div>
      <div style="margin-top:4px;font-size:14px;color:rgba(255,255,255,0.8);">${d.period.start} – ${d.period.end}</div>
    </div>
    <!-- Body -->
    <div style="padding:32px;">
      <p style="margin:0 0 24px;color:#444;line-height:1.6;">Resumen de actividad, alertas y tendencias del Centro de Supervisión correspondiente a la semana del <strong>${d.period.start}</strong> al <strong>${d.period.end}</strong>.</p>

      ${kpiCards}

      ${d.rankings?.topUsers ? rankingTable(
        "Top 10 Usuarios por Actividad",
        d.rankings.topUsers,
        "Usuario",
        "Acciones",
        v => v.count,
        (k, v) => v.name
      ) : ""}

      ${d.rankings?.topModules ? rankingTable(
        "Top 10 Módulos por Actividad",
        d.rankings.topModules,
        "Módulo",
        "Acciones",
        v => v.count,
        (k, v) => k
      ) : ""}

      ${d.rankings?.topErrors ? rankingTable(
        "Top 10 Usuarios con Errores",
        d.rankings.topErrors,
        "Usuario",
        "Errores",
        v => v,
        (k, v) => {
          const admin = d.rankings.topUsers.find(([uid]) => uid === k);
          return admin ? admin[1].name : k;
        }
      ) : ""}

      ${d.rankings?.topSensitive ? rankingTable(
        "Top 10 Acciones Sensibles",
        d.rankings.topSensitive,
        "Usuario",
        "Sensibles",
        v => v,
        (k, v) => {
          const admin = d.rankings.topUsers.find(([uid]) => uid === k);
          return admin ? admin[1].name : k;
        }
      ) : ""}

      ${alertsTable()}

      ${unassignedAlerts()}

      ${trendChart()}

      ${ctaButton}
    </div>
    <!-- Footer -->
    <div style="background:#fafafa;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="margin:0;font-size:11px;color:#888;">Generado automáticamente el ${d.period.generated} · Bienenhaus Propiedades · Panel Administrativo</p>
    </div>
  </div>
</body>
</html>`;
}

function buildEmailText(data: any, config: DigestConfig): string {
  const d = data;
  const dashboardUrl = config.dashboard_url || "https://bienenhaus.com.ar/admin.html";

  return `
BIENENHAUS SUPERVISIÓN — Resumen Semanal
${"=".repeat(50)}

Período: ${d.period.start} – ${d.period.end}
Generado: ${d.period.generated}

KPIs PRINCIPALES
${"-".repeat(20)}
Usuarios activos: ${formatNumber(d.kpis.uniqueUsers)}
Acciones totales: ${formatNumber(d.kpis.actionsTotal)}
Acciones hoy: ${formatNumber(d.kpis.actionsToday)}
Exitosas: ${formatNumber(d.kpis.successCount)}
Fallidas: ${formatNumber(d.kpis.errorCount)}
Sensibles: ${formatNumber(d.kpis.sensitiveCount)}
Exportaciones: ${formatNumber(d.kpis.exportsCount)}
Ops. masivas: ${formatNumber(d.kpis.bulkOpsCount)}
Alertas abiertas: ${formatNumber(d.kpis.openAlerts)}
  Críticas: ${formatNumber(d.kpis.criticalAlerts)}
  Altas: ${formatNumber(d.kpis.highAlerts)}
Sin asignar: ${formatNumber(d.kpis.unassignedAlerts)}

TOP USUARIOS
${"-".repeat(20)}
${(d.rankings?.topUsers || []).map(([uid, v], i) => `${i + 1}. ${v.name}: ${formatNumber(v.count)} acciones (${v.errors} errores, ${v.sensitive} sensibles)`).join("\n")}

TOP MÓDULOS
${"-".repeat(20)}
${(d.rankings?.topModules || []).map(([mod, v], i) => `${i + 1}. ${mod}: ${formatNumber(v.count)} acciones (${v.errors} errores)`).join("\n")}

ALERTAS POR SEVERIDAD
${"-".repeat(20)}
${Object.entries(d.alerts?.bySeverity || {}).map(([sev, count]) => `${sev.toUpperCase()}: ${formatNumber(count)}`).join(" | ")}

ALERTAS SIN ASIGNAR (Críticas/Alta): ${formatNumber(d.kpis.unassignedAlerts)}

TENDENCIA SEMANAL
${"-".repeat(20)}
${Object.entries(d.trends?.dailyActivity || {}).map(([day, v]) => `${day}: ${formatNumber(v.total)} acciones, ${formatNumber(v.errors)} errores, ${formatNumber(v.alerts)} alertas`).join("\n")}

Ver Centro de Supervisión: ${dashboardUrl}#tab-supervision

---
Bienenhaus Propiedades · Panel Administrativo
`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return optionsResponse(req);
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, req);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse(401, { error: 'Missing authorization' }, req);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  try {
    let body: { force_run?: boolean; test_mode?: boolean; test_email?: string } = {};
    try {
      body = await req.json();
    } catch {}

    const config = await getConfig(supabase);

    if (!config.brevo_api_key) {
      return jsonResponse(500, { error: 'Brevo API key not configured' }, req);
    }

    const digestData = await fetchDigestData(supabase);

    let recipients = config.recipients;
    if (body.test_mode && body.test_email) {
      recipients = [body.test_email];
    } else if (!recipients.length) {
      const { data: admins } = await supabase
        .from("profiles")
        .select("email")
        .eq("role", "super_admin")
        .eq("is_active", true);
      recipients = (admins || []).map(a => a.email).filter(Boolean);
    }

    if (!recipients.length) {
      return jsonResponse(400, { error: 'No recipients configured' }, req);
    }

    const subject = `[Bienenhaus Supervisión] Resumen Semanal ${digestData.period.start} – ${digestData.period.end}`;
    const html = buildEmailHTML(digestData, config);
    const text = buildEmailText(digestData, config);

    const result = await sendBrevoEmail(config, recipients, subject, html, text);

    await supabase.from("audit_log").insert({
      user_id: null,
      action: "supervision_digest_sent",
      module: "supervision",
      status: result.success ? "success" : "error",
      metadata: {
        recipients_count: recipients.length,
        period_start: digestData.period.start,
        period_end: digestData.period.end,
        message_id: result.messageId,
        error: result.error,
      },
    }).select().single();

    return jsonResponse(200, {
      success: result.success,
      recipients: recipients.length,
      period: `${digestData.period.start} – ${digestData.period.end}`,
      kpis: digestData.kpis,
      error: result.error,
    }, req);
  } catch (err) {
    console.error("supervision-digest error:", err);
    return jsonResponse(500, { error: err.message }, req);
  }
});