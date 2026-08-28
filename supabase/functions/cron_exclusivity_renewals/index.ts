import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

interface ExpiringExclusivity {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  exclusive_end: string;
  days_until_expiry: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const now = new Date();
  const results = { alerts_60: 0, alerts_30: 0, alerts_7: 0, expired: 0, errors: [] as string[] };

  try {
    // Buscar exclusividades que vencen en 60, 30, 7 días
    const windows = [60, 30, 7];

    for (const days of windows) {
      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + days);
      const targetDateStr = targetDate.toISOString().split("T")[0];

      const { data: owners, error } = await supabase
        .from("owners")
        .select("id, full_name, email, phone, exclusive_end")
        .eq("exclusive", true)
        .eq("exclusive_end", targetDateStr);

      if (error) throw error;

      for (const owner of owners || []) {
        const alertType = days === 60 ? "60 días" : days === 30 ? "30 días" : "7 días";
        const text = `⚠️ Exclusividad vence en ${alertType} (${owner.exclusive_end})`;
        await addTimelineAlert(supabase, owner.id, text);

        if (owner.email) {
          await sendRenewalEmail(supabase, owner, days);
        }

        if (days === 60) results.alerts_60++;
        else if (days === 30) results.alerts_30++;
        else results.alerts_7++;
      }
    }

    // Exclusividades YA VENCIDAS
    const { data: expired } = await supabase
      .from("owners")
      .select("id, full_name, email, phone, exclusive_end")
      .eq("exclusive", true)
      .lt("exclusive_end", now.toISOString().split("T")[0]);

    for (const owner of expired || []) {
      const text = `🚨 EXCLUSIVIDAD VENCIDA el ${new Date(owner.exclusive_end).toLocaleDateString("es-AR")}`;
      await addTimelineAlert(supabase, owner.id, text);
      results.expired++;
    }

    return new Response(JSON.stringify({ success: true, ...results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });
  } catch (err) {
    console.error("cron_exclusivity_renewals error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});

// Timeline en owner_timeline_entries (tabla real que consume la UI; ya no owners.notes JSON).
// Deduplica por (owner, type, text) para no repetir el mismo alerta en corridas consecutivas.
async function addTimelineAlert(supabase: any, ownerId: string, text: string) {
  try {
    const { data: existing } = await supabase
      .from("owner_timeline_entries")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("type", "alert")
      .eq("text", text)
      .limit(1)
      .maybeSingle();
    if (existing) return;

    await supabase.from("owner_timeline_entries").insert({
      owner_id: ownerId,
      type: "alert",
      text
    });
  } catch (e) { console.error("Timeline add failed:", e); }
}

async function sendRenewalEmail(supabase: any, owner: any, days: number) {
  try {
    const { data: settings } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "integrations")
      .single();

    // Brevo key: env var primero (patrón manage-users), fallback integrations.brevo_api_key
    const brevoKey = Deno.env.get("BREVO_API_KEY") || settings?.value?.brevo_api_key;
    if (!brevoKey) return;

    const subject = days === 60
      ? `Recordatorio: Exclusividad vence en 60 días - ${owner.full_name}`
      : days === 30
      ? `⚠️ Exclusividad vence en 30 días - ${owner.full_name}`
      : `🚨 URGENTE: Exclusividad vence en 7 días - ${owner.full_name}`;

    const html = `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">${subject}</h2>
        <p>Estimado/a <strong>${owner.full_name}</strong>,</p>
        <p>Le recordamos que su contrato de exclusividad con <strong>BIENENHAUS PROPIEDADES</strong> vence el <strong>${new Date(owner.exclusive_end).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</strong> (en ${days} día${days !== 1 ? "s" : ""}).</p>
        <p>Para renovar su exclusividad y mantener la prioridad en la comercialización de su inmueble, por favor contacte a su broker asignado o responda a este email.</p>
        <hr style="margin: 24px 0; border-color: #eee;">
        <p style="font-size: 12px; color: #666;">BIENENHAUS PROPIEDADES · Buenos Aires</p>
      </div>
    `;

    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": brevoKey
      },
      body: JSON.stringify({
        sender: { name: "BIENENHAUS", email: "noreply@bienenhaus.com.ar" },
        to: [{ email: owner.email, name: owner.full_name }],
        subject,
        htmlContent: html
      })
    });
  } catch (e) {
    console.error("Email send failed:", e);
  }
}