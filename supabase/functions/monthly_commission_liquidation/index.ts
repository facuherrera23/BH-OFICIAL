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
    const body = await req.json().catch(() => ({}));
    const { period_start, period_end, broker_id, owner_id, force_regenerate } = body;

    // Default: mes anterior
    const now = new Date();
    const start = period_start ? new Date(period_start) : new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = period_end ? new Date(period_end) : new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const startStr = start.toISOString().split("T")[0];
    const endStr = end.toISOString().split("T")[0];

    // Obtener comisiones pendientes en el período
    let query = supabase
      .from("commissions")
      .select("*")
      .eq("status", "pendiente")
      .gte("due_date", startStr)
      .lte("due_date", endStr);

    if (broker_id) query = query.eq("broker_id", broker_id);
    if (owner_id) query = query.eq("owner_id", owner_id);

    const { data: commissions, error } = await query;
    if (error) throw error;

    if (!commissions?.length) {
      return new Response(JSON.stringify({ success: true, message: "No hay comisiones pendientes en el período", count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    // USD rate desde preferencias
    const { data: settings } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "preferences")
      .single();
    const usdRate = settings?.value?.usd_rate || 1000;

    // Agrupar por broker + owner
    const groups = new Map<string, typeof commissions>();
    for (const c of commissions) {
      const key = `${c.broker_id || "no-broker"}|${c.owner_id || "no-owner"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }

    const results = [];

    for (const [key, groupCommissions] of groups) {
      const [brokerKey, ownerKey] = key.split("|");
      const brokerId = brokerKey === "no-broker" ? null : brokerKey;
      const ownerIdGroup = ownerKey === "no-owner" ? null : ownerKey;

      // Totales: sumar columnas ARS de cada comisión (fallback USD * rate si la columna está en 0)
      const grossUsd = groupCommissions.reduce((sum: number, c: any) => sum + (c.commission_amount_usd || 0), 0);
      const grossArs = groupCommissions.reduce((sum: number, c: any) => sum + (c.commission_amount_ars || 0), 0)
        || Math.round(grossUsd * usdRate);
      const iibbArs = groupCommissions.reduce((sum: number, c: any) => sum + (c.iibb_amount_ars || 0), 0);
      const gananciasArs = groupCommissions.reduce((sum: number, c: any) => sum + (c.ganancias_amount_ars || 0), 0);
      const netArs = groupCommissions.reduce((sum: number, c: any) => sum + (c.net_amount_ars || 0), 0)
        || (grossArs - iibbArs - gananciasArs);

      // Filtro de identidad de liquidación (sin UNIQUE constraint en la tabla: select→update/insert manual)
      const matchLiquidation = (q: any) => {
        q = q.eq("period_start", startStr).eq("period_end", endStr);
        q = brokerId ? q.eq("broker_id", brokerId) : q.is("broker_id", null);
        if (ownerIdGroup) q = q.eq("owner_id", ownerIdGroup);
        return q;
      };

      let liquidationId: string;

      if (!force_regenerate) {
        const { data: existing } = await matchLiquidation(supabase.from("commission_liquidations").select("id"))
          .limit(1)
          .maybeSingle();

        if (existing) {
          // Actualizar existente
          const { data: updated } = await supabase
            .from("commission_liquidations")
            .update({
              gross_commission_usd: grossUsd,
              gross_amount_ars: grossArs,
              iibb_retention_ars: iibbArs,
              ganancias_retention_ars: gananciasArs,
              net_amount_ars: netArs,
              status: "confirmada",
              updated_at: new Date().toISOString()
            })
            .eq("id", existing.id)
            .select()
            .single();
          liquidationId = updated.id;
        } else {
          // Crear nueva
          const { data: created } = await supabase
            .from("commission_liquidations")
            .insert([{
              period_start: startStr,
              period_end: endStr,
              broker_id: brokerId,
              owner_id: ownerIdGroup,
              gross_commission_usd: grossUsd,
              gross_amount_ars: grossArs,
              iibb_retention_ars: iibbArs,
              ganancias_retention_ars: gananciasArs,
              net_amount_ars: netArs,
              status: "confirmada"
            }])
            .select()
            .single();
          liquidationId = created.id;
        }
      } else {
        // Forzar regeneración: eliminar existentes del período y crear
        await matchLiquidation(supabase.from("commission_liquidations").delete());
        const { data: created } = await supabase
          .from("commission_liquidations")
          .insert([{
            period_start: startStr,
            period_end: endStr,
            broker_id: brokerId,
            owner_id: ownerIdGroup,
            gross_commission_usd: grossUsd,
            gross_amount_ars: grossArs,
            iibb_retention_ars: iibbArs,
            ganancias_retention_ars: gananciasArs,
            net_amount_ars: netArs,
            status: "confirmada"
          }])
          .select()
          .single();
        liquidationId = created.id;
      }

      // Actualizar comisiones vinculadas: liquidada + link a la liquidación
      await supabase
        .from("commissions")
        .update({ status: "liquidada", liquidation_id: liquidationId })
        .in("id", groupCommissions.map((c: any) => c.id));

      results.push({
        liquidation_id: liquidationId,
        broker_id: brokerId,
        owner_id: ownerIdGroup,
        commission_count: groupCommissions.length,
        gross_usd: grossUsd,
        gross_ars: grossArs,
        iibb_ars: iibbArs,
        ganancias_ars: gananciasArs,
        net_ars: netArs
      });
    }

    return new Response(JSON.stringify({ success: true, period: { start: startStr, end: endStr }, liquidations: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });
  } catch (err) {
    console.error("monthly_commission_liquidation error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
}