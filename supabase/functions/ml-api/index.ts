import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

async function getMLCredentials(supabase: any): Promise<{ appId: string; secretKey: string } | null> {
  const { data } = await supabase
    .from("portal_settings")
    .select("settings")
    .eq("portal_name", "Mercado Libre")
    .single();
  const settings = data?.settings || {};
  const appId = settings.ml_app_id || Deno.env.get("ML_APP_ID") || null;
  const secretKey = settings.ml_secret_key || Deno.env.get("ML_SECRET_KEY") || null;
  if (!appId || !secretKey) return null;
  return { appId, secretKey };
}

async function refreshAccessToken(supabase: any, refreshToken: string, mlAppId: string, mlSecretKey: string): Promise<string | null> {
  const res = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: mlAppId,
      client_secret: mlSecretKey,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) return null;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const { data: existing } = await supabase.from("portal_settings").select("settings").eq("portal_name", "Mercado Libre").single();
  await supabase.from("portal_settings").update({
    api_key: data.access_token,
    api_secret: data.refresh_token,
    settings: { ...(existing?.settings || {}), expires_at: expiresAt },
  }).eq("portal_name", "Mercado Libre");
  return data.access_token;
}

async function getAccessToken(supabase: any, mlAppId: string, mlSecretKey: string): Promise<string | null> {
  const { data } = await supabase.from("portal_settings").select("api_key, api_secret, settings").eq("portal_name", "Mercado Libre").single();
  if (!data || !data.api_key) return null;
  const settings = data.settings || {};
  if (settings.expires_at && new Date(settings.expires_at) > new Date(Date.now() + 300000)) return data.api_key;
  return await refreshAccessToken(supabase, data.api_secret, mlAppId, mlSecretKey);
}

async function mlFetch(accessToken: string, method: string, path: string, body?: any): Promise<Response> {
  const opts: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
  };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  return await fetch(`https://api.mercadolibre.com${path}`, opts);
}

function mapPropertyToML(prop: any, categoryId: string): any {
  const attrs: any[] = [
    { id: "OPERATION", value_name: prop.status === "venta" ? "Venta" : "Alquiler" },
    { id: "PROPERTY_TYPE", value_name: "Inmuebles" },
  ];
  if (prop.rooms) attrs.push({ id: "ROOMS", value_name: String(prop.rooms) });
  if (prop.bedrooms) attrs.push({ id: "BEDROOMS", value_name: String(prop.bedrooms) });
  if (prop.bathrooms) attrs.push({ id: "FULL_BATHROOMS", value_name: String(prop.bathrooms) });
  if (prop.surface_m2) attrs.push({ id: "COVERED_AREA", value_name: String(prop.surface_m2) });
  if (prop.total_area) attrs.push({ id: "TOTAL_AREA", value_name: String(prop.total_area) });
  if (prop.parking) attrs.push({ id: "PARKING_LOTS", value_name: String(prop.parking) });
  if (prop.expenses) attrs.push({ id: "MAINTENANCE_FEE", value_name: String(prop.expenses) });
  return {
    title: prop.title?.substring(0, 60) || "Propiedad Bienenhaus",
    category_id: categoryId,
    price: Number(prop.price) || 0,
    currency_id: "ARS",
    listing_type_id: "202",
    buying_mode: "money_order",
    location: {
      address_line: prop.address || "",
      neighborhood: prop.neighborhood ? { id: prop.neighborhood } : undefined,
      latitude: prop.lat || undefined,
      longitude: prop.lng || undefined,
    },
    attributes: attrs,
    pictures: (prop.photos || []).slice(0, 10).map((p: string) => ({ source: p })),
    status: "active",
  };
}

const CATEGORY_MAP: Record<string, string> = {
  departamento: "MLA1459",
  casa: "MLA1468",
  ph: "MLA1472",
  local: "MLA1474",
  oficina: "MLA1473",
  terreno: "MLA1475",
  galpon: "MLA1477",
  quintacochera: "MLA1476",
  otro: "MLA1459",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: profile } = await userClient.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || !(["super_admin", "broker"].includes(profile.role))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    /* Parse action early — some actions don't need ML access token */
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";

    /* =============================================
       ACTIONS THAT DON'T REQUIRE ML ACCESS TOKEN
       (handle before credential/token checks)
       ============================================= */

    /* STATUS — check connection + config state */
    if (action === "status") {
      const { data } = await adminClient
        .from("portal_settings")
        .select("is_active, settings, api_key")
        .eq("portal_name", "Mercado Libre")
        .single();
      const settings = data?.settings || {};
      const hasCredentials = !!(settings.ml_app_id && settings.ml_secret_key);
      const hasToken = !!(data?.api_key);
      return new Response(JSON.stringify({
        connected: data?.is_active || false,
        has_credentials: hasCredentials,
        has_token: hasToken,
        settings,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    /* DISCONNECT — clear ML tokens */
    if (action === "disconnect") {
      const { data: existing } = await adminClient.from("portal_settings").select("settings").eq("portal_name", "Mercado Libre").single();
      await adminClient.from("portal_settings").update({
        api_key: null,
        api_secret: null,
        is_active: false,
        settings: { ...(existing?.settings || {}), expires_at: null, ml_user_id: null, ml_nickname: null },
      }).eq("portal_name", "Mercado Libre");
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    /* =============================================
       FROM HERE: ALL ACTIONS NEED ML ACCESS TOKEN
       ============================================= */

    const creds = await getMLCredentials(adminClient);
    if (!creds) return new Response(JSON.stringify({ error: "ML not configured. Please set ML_APP_ID and ML_SECRET_KEY first." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const accessToken = await getAccessToken(userClient, creds.appId, creds.secretKey);
    if (!accessToken) return new Response(JSON.stringify({ error: "No ML connection. Please authenticate first." }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    /* CATEGORIES */
    if (action === "categories") {
      const res = await mlFetch(accessToken, "GET", "/sites/MLA/categories");
      const data = await res.json();
      return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    /* PUBLISH */
    if (action === "publish") {
      const body = await req.json();
      const { property } = body;
      if (!property) return new Response(JSON.stringify({ error: "Missing property data" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const categoryId = CATEGORY_MAP[property.property_type] || "MLA1459";
      const mlBody = mapPropertyToML(property, categoryId);
      const res = await mlFetch(accessToken, "POST", "/items", mlBody);
      const data = await res.json();
      if (res.ok && data.id) {
        await adminClient.from("ml_listings").upsert({
          property_id: property.id || null,
          ml_item_id: data.id,
          ml_status: data.status || "active",
          last_sync: new Date().toISOString(),
        }, { onConflict: "property_id" });
      }
      return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    /* LIST */
    if (action === "list") {
      const { data: userData } = await adminClient.from("portal_settings").select("settings").eq("portal_name", "Mercado Libre").single();
      const mlUserId = userData?.settings?.ml_user_id;
      if (!mlUserId) return new Response(JSON.stringify({ error: "No ML user ID" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const res = await mlFetch(accessToken, "GET", `/users/${mlUserId}/items/search?status=active&limit=50`);
      const data = await res.json();
      return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    /* UPDATE */
    if (action === "update") {
      const body = await req.json();
      const { item_id, updates } = body;
      if (!item_id || !updates) return new Response(JSON.stringify({ error: "Missing item_id or updates" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const res = await mlFetch(accessToken, "PUT", `/items/${item_id}`, updates);
      const data = await res.json();
      if (res.ok) await adminClient.from("ml_listings").update({ last_sync: new Date().toISOString() }).eq("ml_item_id", item_id);
      return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    /* REMOVE */
    if (action === "remove") {
      const body = await req.json();
      const { item_id } = body;
      if (!item_id) return new Response(JSON.stringify({ error: "Missing item_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const res = await mlFetch(accessToken, "DELETE", `/items/${item_id}`);
      const data = await res.json();
      if (res.ok) await adminClient.from("ml_listings").delete().eq("ml_item_id", item_id);
      return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    /* SEARCH */
    if (action === "search") {
      const query = url.searchParams.get("q") || "";
      const siteId = url.searchParams.get("site") || "MLA";
      const res = await mlFetch(accessToken, "GET", `/sites/${siteId}/search?q=${encodeURIComponent(query)}&limit=20`);
      const data = await res.json();
      return new Response(JSON.stringify(data), { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    /* SYNC-IMPORT */
    if (action === "sync-import") {
      const { data: userData } = await adminClient.from("portal_settings").select("settings").eq("portal_name", "Mercado Libre").single();
      const mlUserId = userData?.settings?.ml_user_id;
      if (!mlUserId) return new Response(JSON.stringify({ error: "No ML user ID" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const searchRes = await mlFetch(accessToken, "GET", `/users/${mlUserId}/items/search?status=active&limit=100`);
      const searchData = await searchRes.json();
      if (!searchData.results) return new Response(JSON.stringify({ error: "No items found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const results: any[] = [];
      for (const itemId of searchData.results.slice(0, 20)) {
        const itemRes = await mlFetch(accessToken, "GET", `/items/${itemId}`);
        const itemData = await itemRes.json();
        results.push(itemData);
      }
      return new Response(JSON.stringify({ items: results, total: searchData.paging?.total || 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});