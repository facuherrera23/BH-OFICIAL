import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getMLCredentials(supabase: any): Promise<{ appId: string; redirectUri: string } | null> {
  const { data } = await supabase
    .from("portal_settings")
    .select("settings")
    .eq("portal_name", "Mercado Libre")
    .single();
  const settings = data?.settings || {};
  const appId = settings.ml_app_id || Deno.env.get("ML_APP_ID") || null;
  const redirectUri = settings.ml_redirect_uri || Deno.env.get("ML_REDIRECT_URI") || null;
  if (!appId || !redirectUri) return null;
  return { appId, redirectUri };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const creds = await getMLCredentials(adminClient);
    if (!creds) {
      return new Response(JSON.stringify({ error: "ML not configured. Please set ML_APP_ID and ML_SECRET_KEY first." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const state = crypto.randomUUID();

    await adminClient.from("ml_listings").delete().eq("ml_status", "pending_state");
    await adminClient.from("ml_listings").insert({
      property_id: null,
      ml_item_id: state,
      ml_status: "pending_state",
    });

    const authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${creds.appId}&redirect_uri=${encodeURIComponent(creds.redirectUri)}&state=${state}`;

    return new Response(JSON.stringify({ authUrl, state }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});