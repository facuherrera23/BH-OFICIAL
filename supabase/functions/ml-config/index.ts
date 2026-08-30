import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await userClient.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || profile.role !== "super_admin") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    if (req.method === "GET") {
      const { data } = await adminClient
        .from("portal_settings")
        .select("settings")
        .eq("portal_name", "Mercado Libre")
        .single();

      const settings = data?.settings || {};
      return new Response(JSON.stringify({
        ml_app_id: settings.ml_app_id || null,
        ml_redirect_uri: settings.ml_redirect_uri || null,
        has_secret: !!settings.ml_secret_key,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const { ml_app_id, ml_secret_key, ml_redirect_uri } = body;

      if (!ml_app_id || !ml_secret_key) {
        return new Response(JSON.stringify({ error: "ML_APP_ID and ML_SECRET_KEY are required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: existing } = await adminClient
        .from("portal_settings")
        .select("settings")
        .eq("portal_name", "Mercado Libre")
        .single();

      const currentSettings = existing?.settings || {};
      const redirectUri = ml_redirect_uri || `${supabaseUrl}/functions/v1/ml-callback`;

      const newSettings = {
        ...currentSettings,
        ml_app_id: ml_app_id,
        ml_secret_key: ml_secret_key,
        ml_redirect_uri: redirectUri,
      };

      await adminClient.from("portal_settings").upsert({
        portal_name: "Mercado Libre",
        is_active: currentSettings.is_active || false,
        sync_enabled: currentSettings.sync_enabled || false,
        api_key: currentSettings.api_key || null,
        api_secret: currentSettings.api_secret || null,
        settings: newSettings,
      }, { onConflict: "portal_name" });

      return new Response(JSON.stringify({ success: true, redirect_uri: redirectUri }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});