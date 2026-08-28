import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getGmailConnectionSecret } from "../_shared/gmailSecrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface GmailConnection {
  id: string;
  user_id: string;
  email_address: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string | null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getAuthUser(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) throw new Error("MISSING_AUTH");

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) throw new Error("INVALID_AUTH");
  return data.user;
}

async function getConnection(supabase: any, userId: string): Promise<GmailConnection | null> {
  return await getGmailConnectionSecret(supabase, { userId }) as GmailConnection | null;
}

async function getValidAccessToken(supabase: any, connection: GmailConnection): Promise<string> {
  const expiry = new Date(connection.access_token_expires_at || 0);
  if (!Number.isNaN(expiry.getTime()) && expiry.getTime() - 5 * 60 * 1000 > Date.now()) {
    return connection.access_token;
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || Deno.env.get("GMAIL_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || Deno.env.get("GMAIL_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("MISSING_GOOGLE_OAUTH_CONFIG");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) throw new Error("TOKEN_REFRESH_FAILED");
  const data = await response.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  await supabase
    .from("gmail_connections")
    .update({ access_token: data.access_token, access_token_expires_at: expiresAt })
    .eq("id", connection.id);

  return data.access_token;
}

function getHeader(headers: Array<{ name: string; value: string }> = [], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function getAttachments(payload: any): Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> {
  const out: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];
  const visit = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      out.push({
        filename: String(part.filename),
        mimeType: String(part.mimeType || "application/octet-stream"),
        size: Number(part.body?.size || 0),
        attachmentId: String(part.body.attachmentId),
      });
    }
    for (const child of part.parts || []) visit(child);
  };
  visit(payload);
  return out;
}

function safeMessage(message: any, matchedInquiryId: string | null) {
  const headers = message.payload?.headers || [];
  const attachments = getAttachments(message.payload);
  return {
    messageId: message.id,
    threadId: message.threadId,
    from: getHeader(headers, "from"),
    to: getHeader(headers, "to"),
    subject: getHeader(headers, "subject") || "(No Subject)",
    date: getHeader(headers, "date") || (message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null),
    snippet: message.snippet || "",
    hasAttachments: attachments.length > 0,
    labels: message.labelIds || [],
    matchedInquiryId,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const user = await getAuthUser(req, supabaseUrl, anonKey);
    const supabase = createClient(supabaseUrl, serviceKey);

    const connection = await getConnection(supabase, user.id);
    if (!connection) return json({ success: false, code: "NO_GMAIL_CONNECTED", messages: [] }, 200);

    const accessToken = await getValidAccessToken(supabase, connection);
    const url = new URL(req.url);
    let params: Record<string, unknown> = {};
    if (req.method === "POST") {
      params = await req.json().catch(() => ({}));
    }

    const query = String(params.query || url.searchParams.get("query") || "in:inbox");
    const pageToken = String(params.pageToken || url.searchParams.get("pageToken") || "");
    const rawMax = Number(params.maxResults || url.searchParams.get("maxResults") || 25);
    const maxResults = Math.min(Math.max(Number.isFinite(rawMax) ? rawMax : 25, 1), 100);

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(maxResults));
    listUrl.searchParams.set("q", query);
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const listResponse = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!listResponse.ok) return json({ success: false, code: "GMAIL_LIST_FAILED" }, 502);
    const listData = await listResponse.json();
    const ids = (listData.messages || []).map((item: { id: string }) => item.id);

    let matched = new Map<string, string | null>();
    if (ids.length > 0) {
      const { data: linked } = await supabase
        .from("crm_email_inbox")
        .select("message_id,converted_to_inquiry")
        .in("message_id", ids);
      matched = new Map((linked || []).map((row: any) => [row.message_id, row.converted_to_inquiry || null]));
    }

    const messages = await Promise.all(ids.map(async (id: string) => {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
      const response = await fetch(msgUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) return null;
      const message = await response.json();
      return safeMessage(message, matched.get(id) || null);
    }));

    return json({
      success: true,
      emailAddress: connection.email_address,
      nextPageToken: listData.nextPageToken || null,
      messages: messages.filter(Boolean),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message === "MISSING_AUTH" || message === "INVALID_AUTH" ? 401 : 500;
    return json({ success: false, code: message }, status);
  }
});
