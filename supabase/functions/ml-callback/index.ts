import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getMLCredentials(supabase: any): Promise<{ appId: string; secretKey: string; redirectUri: string } | null> {
  const { data } = await supabase
    .from("portal_settings")
    .select("settings")
    .eq("portal_name", "Mercado Libre")
    .single();
  const settings = data?.settings || {};
  const appId = settings.ml_app_id || Deno.env.get("ML_APP_ID") || null;
  const secretKey = settings.ml_secret_key || Deno.env.get("ML_SECRET_KEY") || null;
  const redirectUri = settings.ml_redirect_uri || Deno.env.get("ML_REDIRECT_URI") || null;
  if (!appId || !secretKey || !redirectUri) return null;
  return { appId, secretKey, redirectUri };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      const html = `<html><body><script>window.opener && window.opener.postMessage({type:'ml-auth-error',error:'${error}'},'*');window.close();</script><p>Error: ${error}</p></body></html>`;
      return new Response(html, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
    }

    if (!code || !state) {
      return new Response(JSON.stringify({ error: "Missing code or state" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const creds = await getMLCredentials(adminClient);
    if (!creds) {
      const html = `<html><body><script>window.opener && window.opener.postMessage({type:'ml-auth-error',error:'ML not configured'},'*');window.close();</script><p>ML not configured</p></body></html>`;
      return new Response(html, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
    }

    const { data: pendingState } = await adminClient
      .from("ml_listings")
      .select("id")
      .eq("ml_item_id", state)
      .eq("ml_status", "pending_state")
      .single();

    if (!pendingState) {
      const html = `<html><body><script>window.opener && window.opener.postMessage({type:'ml-auth-error',error:'Invalid or expired state'},'*');window.close();</script><p>Invalid state parameter</p></body></html>`;
      return new Response(html, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
    }

    await adminClient.from("ml_listings").delete().eq("id", pendingState.id);

    const tokenRes = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: creds.appId,
        client_secret: creds.secretKey,
        code: code,
        redirect_uri: creds.redirectUri,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      const errMsg = tokenData.error_description || tokenData.error || 'unknown';
      const html = `<html><body><script>window.opener && window.opener.postMessage({type:'ml-auth-error',error:'Token exchange failed'},'*');window.close();</script><p>Token exchange failed: ${errMsg}</p></body></html>`;
      return new Response(html, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
    }

    const userRes = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    const { data: existingSettings } = await adminClient
      .from("portal_settings")
      .select("settings")
      .eq("portal_name", "Mercado Libre")
      .single();

    await adminClient.from("portal_settings").upsert({
      portal_name: "Mercado Libre",
      is_active: true,
      sync_enabled: true,
      api_key: tokenData.access_token,
      api_secret: tokenData.refresh_token,
      settings: {
        ...(existingSettings?.settings || {}),
        ml_user_id: userData.id,
        ml_nickname: userData.nickname,
        ml_email: userData.email,
        expires_at: expiresAt,
        site_id: userData.site_id || "MLA",
      },
    }, { onConflict: "portal_name" });

    const html = `<html><body><script>
window.opener && window.opener.postMessage({type:'ml-auth-success',user:{id:'${userData.id}',nickname:'${userData.nickname}',email:'${userData.email || ''}'}},'*');
window.close();
</script><p>Conectado exitosamente. Puedes cerrar esta ventana.</p></body></html>`;
    return new Response(html, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
  } catch (err) {
    const errMsg = String(err).replace(/'/g, "");
    const html = `<html><body><script>window.opener && window.opener.postMessage({type:'ml-auth-error',error:'${errMsg}'},'*');window.close();</script><p>Error: ${errMsg}</p></body></html>`;
    return new Response(html, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
  }
});