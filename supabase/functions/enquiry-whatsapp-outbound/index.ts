import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireRole, jsonResponse } from "../_shared/security.ts";
import { mirrorOutboundWhatsApp } from "../_shared/enquiryIngestion.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface OutboundRequestBody {
  conversation_id: string;
  text: string;
  draft_message_id?: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Authenticate human user and require authorized role (admin, manager, sales)
  const authResult = await requireRole(
    req,
    supabaseUrl,
    supabaseServiceKey,
    ["admin", "manager", "sales"],
    corsHeaders
  );

  if (!authResult.ok) {
    return authResult.response;
  }

  const { adminClient, auth } = authResult;

  // 2. Parse request body
  let body: OutboundRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const { conversation_id, text, draft_message_id } = body;
  if (!conversation_id || !text || !text.trim()) {
    return jsonResponse(
      { error: "Missing required fields: conversation_id, text" },
      400,
      corsHeaders
    );
  }

  // 3. Load canonical conversation and strictly derive permitted recipient
  const { data: conv, error: convErr } = await adminClient
    .from("enquiry_conversations")
    .select("id, channel, external_thread_id, participant_identifiers")
    .eq("id", conversation_id)
    .maybeSingle();

  if (convErr || !conv) {
    return jsonResponse(
      { error: `Canonical conversation ${conversation_id} not found` },
      404,
      corsHeaders
    );
  }

  if (conv.channel !== "whatsapp") {
    return jsonResponse(
      { error: `Conversation channel is '${conv.channel}', not 'whatsapp'` },
      400,
      corsHeaders
    );
  }

  // Server strictly determines the permitted recipient phone from the conversation
  // Never trust client-supplied destination numbers to prevent proxy relay abuse
  let recipientPhone = "";
  if (conv.participant_identifiers && conv.participant_identifiers.length > 0) {
    recipientPhone = conv.participant_identifiers[0];
  } else if (conv.external_thread_id) {
    // format might be "businessNumber:chatId" or "chatId"
    const parts = conv.external_thread_id.split(":");
    recipientPhone = parts.length > 1 ? parts[1] : parts[0];
  }

  if (!recipientPhone) {
    return jsonResponse(
      { error: "Could not resolve recipient phone number for this conversation" },
      400,
      corsHeaders
    );
  }

  // 4. Dispatch outbound HTTP call to isolated WhatsApp transport adapter
  const adapterUrl = Deno.env.get("WHATSAPP_ADAPTER_URL") || "http://localhost:3100";
  const adapterApiKey =
    Deno.env.get("WHATSAPP_ADAPTER_API_KEY") || "test_whatsapp_secret_key_dev";

  let adapterResponseData: any = null;
  try {
    const adapterRes = await fetch(`${adapterUrl}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adapterApiKey}`,
      },
      body: JSON.stringify({
        to: recipientPhone,
        text: text.trim(),
      }),
    });

    adapterResponseData = await adapterRes.json();

    if (!adapterRes.ok || !adapterResponseData.success) {
      console.error("[WhatsApp Outbound] Adapter dispatch failed:", adapterResponseData);
      return jsonResponse(
        {
          success: false,
          error: adapterResponseData?.error || "Failed to send message via WhatsApp adapter",
        },
        502,
        corsHeaders
      );
    }
  } catch (fetchErr: any) {
    console.error("[WhatsApp Outbound] Connection error calling adapter:", fetchErr);
    return jsonResponse(
      {
        success: false,
        error: `Could not reach WhatsApp transport adapter: ${fetchErr.message}`,
      },
      502,
      corsHeaders
    );
  }

  // 5. Provider confirmed send: Record canonical outbound message
  const externalMessageId =
    adapterResponseData.messageId || `wa_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  try {
    const mirrorResult = await mirrorOutboundWhatsApp(adminClient, {
      messageId: externalMessageId,
      conversationId: conversation_id,
      recipientPhone,
      text: text.trim(),
      actorId: auth.user.id, // Authenticated human user
      draftMessageId: draft_message_id || null,
      sentAt: adapterResponseData.timestamp || new Date().toISOString(),
      rawPayload: adapterResponseData,
    });

    if (!mirrorResult.success) {
      console.error("[WhatsApp Outbound] Mirror failed:", mirrorResult.error);
      return jsonResponse(
        {
          success: false,
          error: `Message sent via WhatsApp but recording failed: ${mirrorResult.error}`,
          externalMessageId,
        },
        500,
        corsHeaders
      );
    }

    return jsonResponse(
      {
        success: true,
        messageId: mirrorResult.messageId,
        externalMessageId,
        linkedInquiryId: mirrorResult.linkedInquiryId,
      },
      200,
      corsHeaders
    );
  } catch (err: any) {
    console.error("[WhatsApp Outbound] Error saving outbound message:", err);
    return jsonResponse(
      {
        success: false,
        error: `Failed to record sent message: ${err.message}`,
        externalMessageId,
      },
      500,
      corsHeaders
    );
  }
});
