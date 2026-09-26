// ics-feed?token=<agents.ics_token> — feed de calendario publico por broker.
// Devuelve text/calendar con las visitas activas (pendiente/confirmada/en_curso)
// del agente, 30 dias atras a 60 dias adelante. Apt para suscripcion en
// Google Calendar, Apple Calendar y Outlook.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function fmtIcs(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return new Response("token requerido", { status: 400 });

  const SB = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: agent } = await SB.from("agents")
    .select("id, full_name")
    .eq("ics_token", token)
    .is("deleted_at", null)
    .single();
  if (!agent) return new Response("token invalido", { status: 404 });

  const now = Date.now();
  const { data: visits } = await SB.from("visits")
    .select("id, client_name, client_phone, visit_date, duration_minutes, status, notes, properties(title, address, zone)")
    .eq("agent_id", agent.id)
    .is("deleted_at", null)
    .in("status", ["pendiente", "confirmada", "en_curso"])
    .gte("visit_date", new Date(now - 30 * 86400000).toISOString())
    .lte("visit_date", new Date(now + 60 * 86400000).toISOString())
    .order("visit_date", { ascending: true });

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BIENENHAUS//Agenda Broker//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Visitas — " + (agent.full_name || "Broker"),
    "X-WR-TIMEZONE:America/Argentina/Buenos_Aires",
  ];
  for (const v of visits || []) {
    const start = new Date(v.visit_date);
    const end = new Date(start.getTime() + (v.duration_minutes || 60) * 60000);
    const prop = (v.properties && (v.properties.title || "").trim()) || "";
    const addr = (v.properties && (v.properties.address || "").trim()) || "";
    const zone = (v.properties && (v.properties.zone || "").trim()) || "";
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + v.id + "@bienenhaus.com.ar",
      "DTSTAMP:" + fmtIcs(new Date()),
      "DTSTART:" + fmtIcs(start),
      "DTEND:" + fmtIcs(end),
      "SUMMARY:Visita: " + (v.client_name || "Cliente") + (prop ? " — " + prop : ""),
      "LOCATION:" + (addr ? addr + (zone ? ", " + zone : "") : prop || "Por confirmar"),
      "DESCRIPTION:" + [
        "Cliente: " + (v.client_name || "—"),
        "Telefono: " + (v.client_phone || "—"),
        "Estado: " + v.status,
        v.notes ? "Notas: " + v.notes : "",
      ].filter(Boolean).join("\\n"),
      "STATUS:" + (v.status === "confirmada" ? "CONFIRMED" : "TENTATIVE"),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Disposition": "inline; filename=agenda.ics",
    },
  });
});
