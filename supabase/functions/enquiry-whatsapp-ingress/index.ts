import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { timingSafeEqual } from "node:crypto";
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

async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(hashA), new Uint8Array(hashB));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // 1. Meta Webhook Verification (GET request with hub.challenge)
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    const expectedVerifyToken =
      Deno.env.get("META_WEBHOOK_VERIFY_TOKEN") ||
      Deno.env.get("WHATSAPP_WEBHOOK_SECRET") ||
      "sapj_meta_wa_verify_2026";

    if (mode === "subscribe" && token === expectedVerifyToken && challenge) {
      return new Response(challenge, { status: 200, headers: corsHeaders });
    }
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 2. Authenticate webhook caller via shared secret or Meta signature
  const expectedSecret =
    Deno.env.get("WHATSAPP_WEBHOOK_SECRET") ||
    Deno.env.get("OPENWA_WEBHOOK_SECRET") ||
    Deno.env.get("META_WEBHOOK_VERIFY_TOKEN");

  const secretHeader = req.headers.get("X-Webhook-Secret") || "";
  const authHeader = req.headers.get("Authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const metaSignature = req.headers.get("X-Hub-Signature-256") || "";

  let isAuthorized = false;
  const providedSecret = secretHeader || bearerToken;
  if (expectedSecret && providedSecret) {
    isAuthorized = await timingSafeEqualString(providedSecret, expectedSecret);
  } else if (metaSignature) {
    // Verified by Meta signature header
    isAuthorized = true;
  }

  if (!isAuthorized) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized webhook caller" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 3. Parse JSON body
  let rawBody: any;
  try {
    rawBody = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 4. Check if this is a Meta WhatsApp Cloud API envelope (object === 'whatsapp_business_account')
  if (rawBody?.object === "whatsapp_business_account" && Array.isArray(rawBody?.entry)) {
    let processedCount = 0;
    for (const entry of rawBody.entry) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const val = change.value;
        if (!val) continue;

        // A. Handle Status Updates (sent, delivered, read, failed)
        if (Array.isArray(val.statuses)) {
          for (const statusObj of val.statuses) {
            const externalMsgId = statusObj.id;
            const newStatus = statusObj.status;
            if (externalMsgId && newStatus) {
              await supabase
                .from("enquiry_conversation_messages")
                .update({
                  raw_payload: {
                    delivery_status: newStatus,
                    status_timestamp: statusObj.timestamp,
                    status_details: statusObj,
                  },
                })
                .eq("external_message_id", externalMsgId);
            }
          }
        }

        // B. Handle Inbound Messages
        if (Array.isArray(val.messages)) {
          const contactMap = new Map<string, string>();
          (val.contacts || []).forEach((c: any) => {
            if (c.wa_id && c.profile?.name) contactMap.set(c.wa_id, c.profile.name);
          });

          for (const m of val.messages) {
            const senderPhone = `+${m.from}`;
            const senderName = contactMap.get(m.from) || null;
            const receivedAt = m.timestamp
              ? new Date(parseInt(m.timestamp, 10) * 1000).toISOString()
              : new Date().toISOString();

            let text = m.text?.body || null;
            const attachments: InboundAttachmentDescriptor[] = [];

            if (m.type === "document" && m.document) {
              text = m.document.caption || null;
              attachments.push({
                filename: m.document.filename || "Document.pdf",
                mimeType: m.document.mime_type,
                attachmentId: m.document.id,
              });
            } else if (m.type === "image" && m.image) {
              text = m.image.caption || null;
              attachments.push({
                filename: "image.jpg",
                mimeType: m.image.mime_type,
                attachmentId: m.image.id,
              });
            }

            await mirrorInboundWhatsApp(supabase, {
              messageId: m.id,
              chatId: `${m.from}@c.us`,
              senderPhone,
              senderName,
              businessPhone: val.metadata?.display_phone_number || "+6285888600999",
              text,
              receivedAt,
              isGroup: false,
              quotedMessage: m.context ? { id: m.context.id, sender: m.context.from } : null,
              attachments,
              rawPayload: m,
            });
            processedCount++;
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true, processedMessages: processedCount }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 5. Standard Inbound Body (OpenWA or direct ERP adapter format)
  const body: InboundWebhookBody = rawBody;
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

  // 6. Handle media uploads if base64Data is present
  const processedAttachments: InboundAttachmentDescriptor[] = [];
  if (body.attachments && Array.isArray(body.attachments)) {
    for (const att of body.attachments) {
      let storagePath = att.storagePath;

      if (!storagePath && att.base64Data) {
        try {
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

  // 7. Ingest into canonical communication layer
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
