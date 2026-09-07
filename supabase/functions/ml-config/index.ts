import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { invalidateMlCredentialsCache, getMlRedirectUri } from "../_shared/ml.ts";

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
      const { data: appRows } = await adminClient
        .from("site_settings")
        .select("key, value")
        .in("key", ["ml_app_id", "ml_client_secret"]);
      const appId = appRows?.find((r) => r.key === "ml_app_id")?.value?.value ?? null;
      const hasSecret = !!appRows?.find((r) => r.key === "ml_client_secret")?.value?.value;
      const redirectUri = await getMlRedirectUri(adminClient);

      const { data: portal } = await adminClient
        .from("portal_settings")
        .select("settings")
        .eq("portal_name", "Mercado Libre")
        .maybeSingle();
      const legacyAppId = portal?.settings?.ml_app_id ?? null;

      return new Response(JSON.stringify({
        ml_app_id: appId ?? legacyAppId,
        ml_redirect_uri: redirectUri,
        has_secret: hasSecret,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const { ml_app_id, ml_secret_key, ml_redirect_uri } = body;
      const appId = (ml_app_id ?? "").trim();
      const secret = (ml_secret_key ?? "").trim();

      if (!appId || !secret) {
        return new Response(JSON.stringify({ error: "ML_APP_ID and ML_SECRET_KEY are required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const redirectUri = (ml_redirect_uri ?? "").trim() || `${supabaseUrl}/functions/v1/ml-oauth`;

      await adminClient.from("site_settings").upsert([
        { key: "ml_app_id", value: { value: appId } },
        { key: "ml_client_secret", value: { value: secret } },
        { key: "ml_redirect_uri", value: { value: redirectUri } },
      ], { onConflict: "key" });

      const { data: existing } = await adminClient
        .from("portal_settings")
        .select("settings")
        .eq("portal_name", "Mercado Libre")
        .maybeSingle();
      const currentSettings = existing?.settings || {};

      await adminClient.from("portal_settings").upsert({
        portal_name: "Mercado Libre",
        is_active: currentSettings.is_active || false,
        sync_enabled: currentSettings.sync_enabled || false,
        api_key: currentSettings.api_key || null,
        api_secret: currentSettings.api_secret || null,
        settings: {
          ...currentSettings,
          ml_app_id: appId,
          ml_secret_key: secret,
          ml_redirect_uri: redirectUri,
        },
      }, { onConflict: "portal_name" });

      invalidateMlCredentialsCache();

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