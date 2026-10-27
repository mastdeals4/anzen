import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireRole } from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

export type ReplyDraftType = "customer_reply" | "india_internal" | "supplier_followup";

interface DraftRequest {
  message_id: string;
  inquiry_id: string;
  request_id?: string;
  draft_type?: ReplyDraftType;
  tone?: "professional" | "concise" | "friendly";
}

const SYSTEM_PROMPT = `You are the Enquiry Brain Reply Drafter for a B2B pharmaceutical raw materials trading workflow (Anzen / Sapharmajaya).

Your mission is to generate a professional DRAFT reply based on canonical messages and authoritative enquiry/request state.
You produce a DRAFT ONLY. You are NOT authoritative and will NEVER send emails or mutate business records.

CRITICAL COMMERCIAL SAFETY RULES (NEVER BREAK THESE):
1. NEVER INVENT:
   - NEVER invent prices, profit margins, or discounts.
   - NEVER invent delivery dates, lead times, or stock availability.
   - NEVER invent supplier commitments or payment terms.
   - NEVER invent regulatory certifications (GMP, DMF, Halal) or test compliance unless explicitly confirmed in the provided data.
2. MISSING INFORMATION HANDLING:
   - If pricing is not yet approved/available, draft an appropriate acknowledgment stating that pricing is being confirmed with the sourcing/India team.
   - Use clear placeholders like [To be confirmed by India team] if necessary.
3. DRAFT TYPE SPECIALIZATION:
   - "customer_reply": Courteous, professional response to customer. Acknowledge specifications, state current processing status, or ask polite clarification.
   - "india_internal_followup": Internal briefing to India sourcing/pricing team. Summarize customer requirement, mesh/grade, target quantity, and state clearly what quote or spec is needed.
   - "supplier_followup": Direct, professional RFQ/clarification to manufacturer or supplier requesting availability, specification confirmation, and price quotation.

Return a STRICT JSON object matching this schema:
{
  "subject": string,
  "body": string (plain text email body, formatted with proper greetings and sign-off),
  "summary_note": string
}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  let adminClient: ReturnType<typeof createClient>;

  if (token && token === supabaseServiceKey) {
    adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } else {
    const authResult = await requireRole(
      req,
      supabaseUrl,
      supabaseServiceKey,
      ["admin", "manager", "sales"],
      corsHeaders
    );
    if (!authResult.ok) return authResult.response;
    adminClient = authResult.adminClient;
  }

  let body: DraftRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid JSON request body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { message_id, inquiry_id, request_id, draft_type = "customer_reply", tone = "professional" } = body;
  if (!message_id) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing required parameter: message_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 1. Load canonical trigger message
  const { data: triggerMsg, error: msgError } = await adminClient
    .from("enquiry_conversation_messages")
    .select("id, conversation_id, channel, direction, sender_address, sender_name, subject, body_text, received_or_sent_at")
    .eq("id", message_id)
    .maybeSingle();

  if (msgError || !triggerMsg) {
    return new Response(
      JSON.stringify({ success: false, error: `Message not found: ${message_id}` }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 2. Load linked inquiry details
  let inquiryInfo: any = null;
  if (inquiry_id) {
    const { data: inq } = await adminClient
      .from("crm_inquiries")
      .select("id, inquiry_number, company_name, contact_person, product_name, quantity, target_price")
      .eq("id", inquiry_id)
      .maybeSingle();
    inquiryInfo = inq;
  }

  // 3. Load active requests
  let activeReqs: any[] = [];
  if (inquiry_id) {
    const { data: reqs } = await adminClient
      .from("enquiry_requests")
      .select("id, request_code, title, customer_requirement, parameters, status, waiting_for, current_issue, next_action")
      .eq("inquiry_id", inquiry_id)
      .not("status", "in", '("RESOLVED","CANCELLED","NOT_REQUIRED")');
    activeReqs = reqs || [];
  }

  // 4. Load recent conversation history (up to 5 messages)
  const { data: recentMsgs } = await adminClient
    .from("enquiry_conversation_messages")
    .select("direction, sender_address, sender_name, subject, body_text, received_or_sent_at")
    .eq("conversation_id", triggerMsg.conversation_id)
    .order("received_or_sent_at", { ascending: false })
    .limit(5);

  const contextHistory = (recentMsgs || []).reverse().map((m: any) => ({
    time: m.received_or_sent_at,
    from: m.sender_name ? `${m.sender_name} <${m.sender_address}>` : m.sender_address,
    direction: m.direction,
    subject: m.subject,
    body: (m.body_text || "").slice(0, 1000),
  }));

  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiApiKey) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "OpenAI API key not configured on server",
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const promptPayload = {
    draft_type: draft_type,
    tone: tone,
    trigger_message: {
      from: triggerMsg.sender_name ? `${triggerMsg.sender_name} <${triggerMsg.sender_address}>` : triggerMsg.sender_address,
      subject: triggerMsg.subject,
      body: triggerMsg.body_text || "",
      received_at: triggerMsg.received_or_sent_at,
    },
    inquiry: inquiryInfo,
    active_requests: activeReqs,
    target_request_id: request_id || null,
    recent_history: contextHistory,
  };

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(promptPayload) },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      throw new Error(`OpenAI API error (${openaiResponse.status}): ${errorText}`);
    }

    const openaiData = await openaiResponse.json();
    const rawContent = openaiData.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(rawContent);

    const draftRecord = {
      draft_id: crypto.randomUUID(),
      trigger_message_id: triggerMsg.id,
      inquiry_id: inquiry_id || triggerMsg.conversation_id,
      request_id: request_id || null,
      draft_type: draft_type,
      recipient_address: triggerMsg.sender_address,
      subject: parsed.subject || `Re: ${triggerMsg.subject || "Inquiry"}`,
      body: parsed.body || "",
      model: "gpt-4o-mini",
      generated_at: new Date().toISOString(),
      is_edited: false,
      status: "draft",
      sent_at: null,
      sent_message_id: null,
      summary_note: parsed.summary_note || null,
    };

    // Store draft on trigger message for provenance
    await adminClient
      .from("enquiry_conversation_messages")
      .update({
        ai_reply_draft: draftRecord,
      })
      .eq("id", triggerMsg.id);

    return new Response(
      JSON.stringify({
        success: true,
        draft: draftRecord,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error(`[enquiry-brain-draft] Error generating draft for message ${triggerMsg.id}:`, err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message || "Failed to generate AI reply draft",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
