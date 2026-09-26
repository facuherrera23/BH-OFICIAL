// visits-reminders (cron): envia recordatorios de visita al cliente por
// email (Brevo) 24h y 2h antes del horario. Idempotente via columnas
// reminder_24h_sent_at / reminder_2h_sent_at.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") || "";
const BREVO_SENDER_EMAIL = Deno.env.get("BREVO_SENDER_EMAIL") || "noreply@bienenhaus.com.ar";
const BREVO_SENDER_NAME = Deno.env.get("BREVO_SENDER_NAME") || "Bienenhaus Propiedades";
const SITE_URL = Deno.env.get("SITE_URL") || "https://bienenhaus.com.ar";

async function sendBrevoEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!BREVO_API_KEY) return false;
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  return res.ok;
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });
}

function buildEmail(kind: "24h" | "2h", v: any): { subject: string; html: string } {
  const when = fmtWhen(v.visit_date);
  const prop = v.properties?.title ? `<p><b>Propiedad:</b> ${v.properties.title}${v.properties.address ? " (" + v.properties.address + ")" : ""}</p>` : "";
  const link = v.confirmation_token ? `${SITE_URL}/confirmar-visita.html?token=${v.confirmation_token}` : "";
  const subject = kind === "24h"
    ? `Recordatorio: tu visita de mañana (${when})`
    : `Tu visita es en ~2 horas (${when})`;
  const html = `
    <div style="font-family:Arial,sans-serif; max-width:520px; margin:0 auto;">
      <h2 style="color:#1fc8c3;">Bienenhaus Propiedades</h2>
      <p>Hola ${v.client_name || ""},</p>
      <p>${kind === "24h" ? "Te recordamos que mañana tenés agendada una visita:" : "Tu visita es en aproximadamente 2 horas:"}</p>
      <p style="font-size:18px;"><b>${when} hs</b></p>
      ${prop}
      ${kind === "24h" && link ? `<p><a href="${link}" style="background:#00c878; color:#000; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Confirmar asistencia</a></p>` : ""}
      <p style="color:#888; font-size:12px;">Si no podés asistir, podés cancelar desde el mismo enlace.</p>
    </div>`;
  return { subject, html };
}

Deno.serve(async () => {
  const now = Date.now();
  const in24h = new Date(now + 24 * 3600_000).toISOString();
  const in2h = new Date(now + 2 * 3600_000).toISOString();
  const nowIso = new Date(now).toISOString();

  const results = { sent24h: 0, sent2h: 0, errors: 0 };

  async function processWindow(aheadIso: string, flagCol: "reminder_24h_sent_at" | "reminder_2h_sent_at", kind: "24h" | "2h") {
    const { data: visits, error } = await SB.from("visits")
      .select("id, client_name, client_email, visit_date, confirmation_token, properties(title, address)")
      .in("status", ["pendiente", "confirmada"])
      .is("deleted_at", null)
      .not("client_email", "is", null)
      .is(flagCol, null)
      .gte("visit_date", nowIso)
      .lte("visit_date", aheadIso);
    if (error) { results.errors++; return; }
    for (const v of visits || []) {
      const { subject, html } = buildEmail(kind, v);
      const ok = await sendBrevoEmail(v.client_email, subject, html);
      if (ok) {
        await SB.from("visits").update({ [flagCol]: new Date().toISOString() }).eq("id", v.id);
        if (kind === "24h") results.sent24h++; else results.sent2h++;
      } else {
        results.errors++;
      }
    }
  }

  await processWindow(in24h, "reminder_24h_sent_at", "24h");
  await processWindow(in2h, "reminder_2h_sent_at", "2h");

  return new Response(JSON.stringify({ ok: true, ...results }), {
    headers: { "Content-Type": "application/json" },
  });
});
