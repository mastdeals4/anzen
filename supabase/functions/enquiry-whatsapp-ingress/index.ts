import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { mirrorInboundWhatsApp, InboundAttachmentDescriptor } from "../_shared/enquiryIngestion.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Webhook-Secret",
};

interface InboundWebhookBody {
  messageId: string;
  chatId: string;
  senderPhone: string;
  senderName?: string | null;
  businessPhone?: string | null;
  text?: string | null;
  receivedAt?: string;
  isGroup?: boolean;
  quotedMessage?: {
    id?: string;
    body?: string;
    sender?: string;
  } | null;
  attachments?: Array<{
    filename: string;
    mimeType?: string;
    size?: number;
    base64Data?: string;
    storagePath?: string;
  }>;
  rawPayload?: Record<string, unknown> | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 1. Authenticate webhook caller via shared secret
  const expectedSecret =
    Deno.env.get("WHATSAPP_WEBHOOK_SECRET") ||
    Deno.env.get("OPENWA_WEBHOOK_SECRET") ||
    "test_whatsapp_secret_key_dev";

  const secretHeader = req.headers.get("X-Webhook-Secret") || "";
  const authHeader = req.headers.get("Authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const providedSecret = secretHeader || bearerToken;
  if (!providedSecret || providedSecret !== expectedSecret) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized webhook caller" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 2. Parse and validate payload
  let body: InboundWebhookBody;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { messageId, chatId, senderPhone } = body;
  if (!messageId || !chatId || !senderPhone) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Missing required fields: messageId, chatId, senderPhone",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 3. Handle media uploads if base64Data is present
  const processedAttachments: InboundAttachmentDescriptor[] = [];
  if (body.attachments && Array.isArray(body.attachments)) {
    for (const att of body.attachments) {
      let storagePath = att.storagePath;

      if (!storagePath && att.base64Data) {
        try {
          // Decode base64 to Uint8Array
          const binaryString = atob(att.base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          const safeFilename = (att.filename || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
          const targetPath = `whatsapp/${chatId}/${messageId}_${safeFilename}`;

          const { error: uploadError } = await supabase.storage
            .from("crm-documents")
            .upload(targetPath, bytes, {
              contentType: att.mimeType || "application/octet-stream",
              upsert: true,
            });

          if (!uploadError) {
            storagePath = targetPath;
          } else {
            console.error(`[WhatsApp Ingress] Media upload error for ${safeFilename}:`, uploadError);
          }
        } catch (mediaErr) {
          console.error(`[WhatsApp Ingress] Failed to decode/store media for ${att.filename}:`, mediaErr);
        }
      }

      processedAttachments.push({
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        storagePath: storagePath || undefined,
      });
    }
  }

  // 4. Ingest into canonical communication layer
  try {
    const result = await mirrorInboundWhatsApp(supabase, {
      messageId: body.messageId,
      chatId: body.chatId,
      senderPhone: body.senderPhone,
      senderName: body.senderName,
      businessPhone: body.businessPhone,
      text: body.text,
      receivedAt: body.receivedAt,
      isGroup: body.isGroup,
      quotedMessage: body.quotedMessage,
      attachments: processedAttachments,
      rawPayload: body.rawPayload,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error(`[WhatsApp Ingress] Ingestion error:`, err);
    return new Response(
      JSON.stringify({ success: false, error: err.message || "Failed to mirror WhatsApp message" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
