import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body = await req.json();
    const { record } = body; // Supabase Realtime payload: {table, record, old_record}

    if (!record || record.stage !== "cerrado") {
      return new Response(JSON.stringify({ skipped: "not closed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    const propertyId = record.property_id;
    if (!propertyId) {
      return new Response(JSON.stringify({ skipped: "no property" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    // Deduplicación: ya existe comisión para esta propiedad
    // (commissions no tiene lead_id en el schema actual)
    const { data: existing } = await supabase
      .from("commissions")
      .select("id")
      .eq("property_id", propertyId)
      .limit(1)
      .maybeSingle();

    if (existing) {
      return new Response(JSON.stringify({ skipped: "already exists" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    // Propiedad vinculada al lead (consulta directa: evita el embedding en array)
    const { data: property, error: propertyErr } = await supabase
      .from("properties")
      .select("*")
      .eq("id", propertyId)
      .single();

    if (propertyErr || !property) {
      return new Response(JSON.stringify({ skipped: "property not found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    const owner = property.owner_id ? await getOwner(supabase, property.owner_id) : null;
    const broker = record.broker_id ? await getBroker(supabase, record.broker_id) : null;

    if (!owner) {
      return new Response(JSON.stringify({ skipped: "no owner" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    // Calcular comisión según tipo de operación
    const isRental = property.property_type === "alquiler";
    const priceUsd = isRental ? (property.price_usd || 0) / 12 : (property.price_usd || 0); // alquiler: mes
    const commissionRate = isRental ? (owner.commission_rent || 4.0) : (owner.commission_sale || 3.0);
    const commissionAmountUsd = Number((priceUsd * commissionRate / 100).toFixed(2));

    // USD rate desde preferencias (app_settings.preferences.usd_rate)
    const { data: preferences } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "preferences")
      .single();
    const usdRate = preferences?.value?.usd_rate || 1000;

    const commissionAmountArs = Math.round(commissionAmountUsd * usdRate);
    const iibbRate = 3.5; // % IIBB estándar
    const gananciasRate = 0; // owners no registra situación fiscal; default 0
    const iibbAmountArs = Math.round(commissionAmountArs * iibbRate / 100);
    const gananciasAmountArs = Math.round(commissionAmountArs * gananciasRate / 100);
    const netAmountArs = commissionAmountArs - iibbAmountArs - gananciasAmountArs;

    const commission = {
      owner_id: owner.id,
      property_id: property.id,
      broker_id: broker?.id || null,
      operation_type: isRental ? "alquiler" : "venta",
      commission_amount_usd: commissionAmountUsd,
      commission_amount_ars: commissionAmountArs,
      iibb_rate: iibbRate,
      iibb_amount_ars: iibbAmountArs,
      ganancias_rate: gananciasRate,
      ganancias_amount_ars: gananciasAmountArs,
      net_amount_ars: netAmountArs,
      status: "pendiente",
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    };

    const { data: inserted, error } = await supabase
      .from("commissions")
      .insert([commission])
      .select()
      .single();

    if (error) throw error;

    // Notificar al broker si existe
    if (broker?.email) {
      await notifyBrokerCommission(supabase, broker, inserted, owner, property);
    }

    // Timeline en owner_timeline_entries (tabla real, ya no owners.notes JSON)
    await supabase.from("owner_timeline_entries").insert({
      owner_id: owner.id,
      type: "commission",
      text: `Comisión generada: USD ${commissionAmountUsd.toLocaleString("es-AR", { minimumFractionDigits: 2 })} por ${isRental ? "alquiler" : "venta"} de ${property.title}`
    });

    return new Response(JSON.stringify({ success: true, commission_id: inserted.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });
  } catch (err) {
    console.error("trigger_commission_on_close error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});

async function getOwner(supabase: any, ownerId: string) {
  const { data } = await supabase.from("owners").select("*").eq("id", ownerId).single();
  return data;
}

async function getBroker(supabase: any, brokerId: string) {
  const { data } = await supabase.from("agents").select("*").eq("id", brokerId).single();
  return data;
}

async function notifyBrokerCommission(supabase: any, broker: any, commission: any, owner: any, property: any) {
  try {
    const { data: settings } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "integrations")
      .single();

    // Brevo key: env var primero (patrón manage-users), fallback integrations.brevo_api_key
    const brevoKey = Deno.env.get("BREVO_API_KEY") || settings?.value?.brevo_api_key;
    if (!brevoKey || !broker.email) return;

    const html = `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">💰 Nueva Comisión Generada</h2>
        <p>Hola <strong>${broker.full_name}</strong>,</p>
        <p>Se ha generado una nueva comisión por el cierre de una operación:</p>
        <ul>
          <li><strong>Propiedad:</strong> ${property.title} (${property.code})</li>
          <li><strong>Propietario:</strong> ${owner.full_name}</li>
          <li><strong>Operación:</strong> ${commission.operation_type === "venta" ? "Venta" : "Alquiler"}</li>
          <li><strong>Monto Comisión:</strong> USD ${commission.commission_amount_usd.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</li>
        </ul>
        <p>La comisión estará disponible para liquidación el próximo mes.</p>
      </div>
    `;

    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": brevoKey },
      body: JSON.stringify({
        sender: { name: "BIENENHAUS", email: "noreply@bienenhaus.com.ar" },
        to: [{ email: broker.email, name: broker.full_name }],
        subject: `💰 Nueva comisión: ${property.title}`,
        htmlContent: html
      })
    });
  } catch (e) { console.error("Broker notify failed:", e); }
}