// gmail-attachment-save
//
// Server-side Gmail attachment fetch + private Supabase Storage upload for
// Anvi AI Mail Review. Uses only the authenticated user's Gmail connection.
// Never returns Gmail access/refresh tokens.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getGmailConnectionSecret } from "../_shared/gmailSecrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

interface RequestBody {
  messageId: string;
  threadId?: string | null;
  attachmentId: string;
  originalFileName: string;
  displayFileName?: string;
  mimeType?: string;
  inquiryId: string;
  productName: string;
  make?: string | null;
  documentType: "COA" | "MSDS" | "MHD" | "TDS" | "SPEC" | "COC" | "GMP" | "ISO" | "DMF" | "CATALOGUE" | "PRICE_LIST" | "OTHER";
  sourceEmailSubject?: string | null;
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

async function canSaveCrmDocuments(supabase: any, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error("PROFILE_LOOKUP_FAILED");
  return ["admin", "manager"].includes(String(data?.role || "").toLowerCase());
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

function safePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "file";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, code: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const user = await getAuthUser(req, supabaseUrl, anonKey);
    const supabase = createClient(supabaseUrl, serviceKey);
    const canSave = await canSaveCrmDocuments(supabase, user.id);
    if (!canSave) return json({ success: false, code: "DOCUMENT_SAVE_FORBIDDEN" }, 403);

    const body = await req.json() as RequestBody;
    if (!body.messageId || !body.attachmentId || !body.inquiryId || !body.productName) {
      return json({ success: false, code: "MISSING_REQUIRED_FIELDS" }, 400);
    }

    const connection = await getConnection(supabase, user.id);
    if (!connection) return json({ success: false, code: "NO_GMAIL_CONNECTED" }, 200);
    const accessToken = await getValidAccessToken(supabase, connection);

    const attachmentUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(body.messageId)}/attachments/${encodeURIComponent(body.attachmentId)}`;
    const response = await fetch(attachmentUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return json({ success: false, code: "GMAIL_ATTACHMENT_FAILED" }, 502);
    const attachment = await response.json();
    const bytes = decodeBase64UrlToBytes(attachment.data || "");
    if (bytes.length === 0) return json({ success: false, code: "EMPTY_ATTACHMENT" }, 400);

    const displayName = safePart(body.displayFileName || body.originalFileName || "document");
    const folder = `gmail-attachments/${user.id}/${safePart(body.messageId)}`;
    const storagePath = `${folder}/${Date.now()}_${displayName}`;
    const contentType = body.mimeType || "application/octet-stream";

    const { error: uploadError } = await supabase.storage
      .from("crm-documents")
      .upload(storagePath, bytes, {
        contentType,
        upsert: false,
      });
    if (uploadError) return json({ success: false, code: "STORAGE_UPLOAD_FAILED", error: uploadError.message }, 500);

    // DB CHECK currently allows COA/MSDS/MHD/TDS/SPEC/COC/GMP/ISO/DMF/OTHER.
    // CATALOGUE / PRICE_LIST are detected upstream but fold to OTHER on insert
    // until the CHECK constraint is widened (keeps this change migration-free).
    const DB_DOC_TYPES = ["COA","MSDS","MHD","TDS","SPEC","COC","GMP","ISO","DMF","OTHER"];
    const requestedType = body.documentType || "OTHER";
    const docType = DB_DOC_TYPES.includes(requestedType) ? requestedType : "OTHER";
    const { data: doc, error: docError } = await supabase
      .from("crm_product_documents")
      .insert({
        inquiry_id: body.inquiryId,
        product_name: body.productName,
        make: body.make || null,
        document_type: docType,
        original_file_name: body.originalFileName,
        display_file_name: body.displayFileName || body.originalFileName,
        storage_bucket: "crm-documents",
        storage_path: storagePath,
        source_gmail_message_id: body.messageId,
        source_gmail_thread_id: body.threadId || null,
        source_email_subject: body.sourceEmailSubject || null,
        uploaded_by: user.id,
      })
      .select("id,storage_bucket,storage_path,display_file_name,document_type")
      .single();
    if (docError) return json({ success: false, code: "DOCUMENT_INSERT_FAILED", error: docError.message }, 500);

    await Promise.resolve(supabase.from("email_inquiry_links").insert({
      gmail_message_id: body.messageId,
      gmail_thread_id: body.threadId || null,
      inquiry_id: body.inquiryId,
      link_type: "generic",
      created_by: user.id,
    })).catch(() => {});

    return json({
      success: true,
      document: doc,
      storageBucket: "crm-documents",
      storagePath,
      requestedDocumentType: requestedType,
      storedDocumentType: docType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message === "MISSING_AUTH" || message === "INVALID_AUTH" ? 401 : 500;
    return json({ success: false, code: message }, status);
  }
});
