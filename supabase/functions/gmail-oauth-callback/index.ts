import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "User not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { code, redirect_uri } = await req.json();
    if (!code || !redirect_uri) {
      return new Response(JSON.stringify({ error: "Missing code or redirect_uri" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || Deno.env.get("GMAIL_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || Deno.env.get("GMAIL_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: "Google OAuth credentials not configured on server" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      return new Response(JSON.stringify({ error: `Token exchange failed: ${errorData}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tokenData = await tokenResponse.json();

    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!profileResponse.ok) {
      return new Response(JSON.stringify({ error: "Failed to fetch Gmail profile" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const profileData = await profileResponse.json();
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + tokenData.expires_in);

    const { error: dbError } = await supabase
      .from("gmail_connections")
      .upsert({
        user_id: user.id,
        email_address: profileData.email,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        access_token_expires_at: expiresAt.toISOString(),
        is_connected: true,
        sync_enabled: true,
        last_sync: null,
      }, { onConflict: "user_id,email_address" });

    if (dbError) {
      return new Response(JSON.stringify({ error: dbError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, email: profileData.email }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
