import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const ADMIN_EMAIL = "admin@bienenhaus.com";
const FROM_EMAIL = "no-reply@bienenhaus.com.ar";

interface ContactPayload {
  name: string;
  email: string;
  phone?: string;
  subject: string;
  message: string;
  website?: string; // honeypot
}

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function getClientIP(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
         req.headers.get("x-real-ip") ||
         "unknown";
}

async function checkRateLimit(supabase: any, ip: string): Promise<boolean> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 60 * 60 * 1000); // 1 hora

  const { data, error } = await supabase
    .from("rate_limit")
    .select("count")
    .eq("identifier", ip)
    .eq("action", "contact_form")
    .gte("window_start", windowStart.toISOString())
    .maybeSingle();

  if (error) {
    console.error("Rate limit check error:", error);
    return true; // fail open
  }

  if (data && data.count >= 5) {
    return false; // rate limited
  }

  // Increment or insert
  if (data) {
    await supabase
      .from("rate_limit")
      .update({ count: data.count + 1 })
      .eq("id", data.id);
  } else {
    await supabase
      .from("rate_limit")
      .insert({ identifier: ip, action: "contact_form", count: 1, window_start: now.toISOString() });
  }
  return true;
}

async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
  return res.json();
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const ip = getClientIP(req);
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Rate limit
  const allowed = await checkRateLimit(supabase, ip);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "Demasiados intentos. Intente en 1 hora." }), { status: 429, headers });
  }

  let payload: ContactPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), { status: 400, headers });
  }

  // Honeypot
  if (payload.website && payload.website.trim() !== "") {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers }); // silencioso
  }

  // Validación básica
  if (!payload.name?.trim() || !payload.email?.trim() || !payload.message?.trim()) {
    return new Response(JSON.stringify({ error: "Faltan campos requeridos" }), { status: 400, headers });
  }

  // Guardar lead en BD
  const { error: leadError } = await supabase.from("leads").insert({
    name: payload.name.trim(),
    email: payload.email.trim(),
    phone: payload.phone?.trim() || null,
    subject: payload.subject.trim(),
    message: payload.message.trim(),
    source: "landing_contact",
    status: "new",
    metadata: { ip, user_agent: req.headers.get("user-agent") },
  });
  if (leadError) {
    console.error("Lead insert error:", leadError);
    return new Response(JSON.stringify({ error: "Error guardando consulta" }), { status: 500, headers });
  }

  // Email a admin
  const adminHtml = `
    <h2>Nueva consulta desde la web</h2>
    <p><strong>Nombre:</strong> ${payload.name}</p>
    <p><strong>Email:</strong> ${payload.email}</p>
    <p><strong>Teléfono:</strong> ${payload.phone || "—"}</p>
    <p><strong>Asunto:</strong> ${payload.subject}</p>
    <p><strong>Mensaje:</strong></p>
    <p>${payload.message.replace(/\n/g, "<br>")}</p>
    <hr>
    <p><small>IP: ${ip}</small></p>
  `;
  try {
    await sendEmail(ADMIN_EMAIL, `[BIENENHAUS] ${payload.subject}`, adminHtml);
  } catch (e) {
    console.error("Admin email error:", e);
  }

  // Auto-reply al usuario
  const userHtml = `
    <h2>Gracias por contactarnos, ${payload.name}</h2>
    <p>Recibimos tu consulta: <strong>${payload.subject}</strong></p>
    <p>Te responderemos a la brevedad.</p>
    <hr>
    <p><small>BIENENHAUS PROPIEDADES</small></p>
  `;
  try {
    await sendEmail(payload.email, `Confirmación: ${payload.subject}`, userHtml);
  } catch (e) {
    console.error("User email error:", e);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});