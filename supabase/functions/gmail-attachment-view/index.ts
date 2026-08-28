// gmail-attachment-view
//
// Server-side Gmail attachment fetch returning binary bytes for inline preview
// or temporary download. Never persists to storage or to crm_product_documents.
// Use gmail-attachment-save for the persistent "Save to CRM" path.
//
// Never returns Gmail access/refresh tokens.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getGmailConnectionSecret } from "../_shared/gmailSecrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
  "Access-Control-Expose-Headers": "Content-Type, Content-Disposition, Content-Length",
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
  await supabase
    .from("gmail_connections")
    .update({
      access_token: data.access_token,
      access_token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    })
    .eq("id", connection.id);
  return data.access_token;
}

function decodeBase64UrlToBytes(data = ""): Uint8Array {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// RFC 5987 — encode filename for Content-Disposition.
function encodeFileName(name: string): string {
  return encodeURIComponent(name).replace(/['()]/g, escape).replace(/\*/g, "%2A");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ success: false, code: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const user = await getAuthUser(req, supabaseUrl, anonKey);
    const supabase = createClient(supabaseUrl, serviceKey);

    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const messageId = String(body.messageId || url.searchParams.get("messageId") || "");
    const attachmentId = String(body.attachmentId || url.searchParams.get("attachmentId") || "");
    const filename = String(body.filename || url.searchParams.get("filename") || "attachment");
    const mimeTypeHint = String(body.mimeType || url.searchParams.get("mimeType") || "");
    const disposition = String(body.disposition || url.searchParams.get("disposition") || "inline").toLowerCase();

    if (!messageId || !attachmentId) {
      return json({ success: false, code: "MISSING_REQUIRED_FIELDS" }, 400);
    }

    const connection = await getConnection(supabase, user.id);
    if (!connection) return json({ success: false, code: "NO_GMAIL_CONNECTED" }, 200);
    const accessToken = await getValidAccessToken(supabase, connection);

    const attachmentUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
    const response = await fetch(attachmentUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return json({ success: false, code: "GMAIL_ATTACHMENT_FAILED" }, 502);
    const attachment = await response.json();
    const bytes = decodeBase64UrlToBytes(attachment.data || "");
    if (bytes.length === 0) return json({ success: false, code: "EMPTY_ATTACHMENT" }, 400);

    const contentType = mimeTypeHint || "application/octet-stream";
    const dispositionType = disposition === "attachment" ? "attachment" : "inline";
    const safeFilename = filename.replace(/[\r\n"]/g, "");

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Content-Disposition": `${dispositionType}; filename="${safeFilename}"; filename*=UTF-8''${encodeFileName(filename)}`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message === "MISSING_AUTH" || message === "INVALID_AUTH" ? 401 : 500;
    return json({ success: false, code: message }, status);
  }
});
