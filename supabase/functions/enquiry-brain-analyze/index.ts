import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireRole } from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface AnalyzeRequest {
  message_id: string;
  force_reanalyze?: boolean;
}

export interface GroundingCitation {
  text: string;
  reason: string;
}

export interface ProposedUpdate {
  request_id: string;
  field: "customer_requirement" | "parameters" | "status" | "waiting_for" | "current_issue" | "next_action" | "assigned_team";
  old_value: unknown;
  new_value: unknown;
  reason: string;
}

export interface ProposedNewRequest {
  category: "commercial" | "technical" | "document" | "sample" | "logistics" | "custom";
  title: string;
  customer_requirement: string;
  parameters: Record<string, unknown>;
  waiting_for: "INTERNAL" | "INDIA" | "MANUFACTURER" | "CUSTOMER" | "NONE";
  assigned_team?: "sales" | "pricing_india" | "regulatory" | "warehouse" | "sourcing" | "management";
  reason: string;
}

export interface AiProposal {
  status: "pending" | "processing" | "suggested" | "no_action" | "failed" | "accepted" | "edited" | "dismissed";
  intent: "new_request" | "clarification" | "requirement_change" | "supplier_response" | "customer_decision" | "no_action";
  confidence_tier: "HIGH" | "MEDIUM" | "LOW";
  needs_verification: boolean;
  summary: string;
  grounding: GroundingCitation[];
  proposed_updates: ProposedUpdate[];
  proposed_new_requests: ProposedNewRequest[];
  suggested_next_action: string | null;
  suggested_waiting_for: "INTERNAL" | "INDIA" | "MANUFACTURER" | "CUSTOMER" | "NONE" | null;
  suggested_team: string | null;
  analyzed_at: string;
  model: string;
  error?: string;
  retry_count?: number;
  retryable?: boolean;
  started_at?: string;
  attempted_at?: string;
}

const SYSTEM_PROMPT = `You are the Enquiry Brain, an AI assistant for a B2B pharmaceutical raw materials trading workflow (Anzen / Sapharmajaya).

Your mission is to read an incoming or outgoing communication message in the context of an existing enquiry and propose structured updates.
You are an INTERPRETER and SUGGESTER. You are NOT the authority and must NEVER mutate business data directly.

CRITICAL RULES:
1. REQUIREMENT GROUPING (AVOID REQUEST EXPLOSION):
   - For a standard customer RFQ: Product + quantity + price requirement + packing + routine COA/MSDS request MUST remain ONE SINGLE commercial request with parameters.
   - Do NOT create separate requests for "price", "packing", and "COA" unless the customer specifically asks for an independent formal deliverable (e.g., formal regulatory registration dossier / DMF, or a physical sample).
   - Technical specifications (e.g. 100 mesh) belong in the requirement/parameters of the product request. If the specification is non-standard or blocked by the manufacturer, suggest updating the request's status to 'BLOCKED' and waiting_for to 'MANUFACTURER' or 'CUSTOMER', rather than exploding into multiple requests.

2. EXISTING REQUEST MATCHING:
   - Prefer matching and updating an EXISTING request ID from the provided active requests list whenever the message discusses the same product.
   - Only propose a new request (proposed_new_requests) if the customer introduces an entirely NEW product or an independent deliverable.

3. SUPPLIER RESPONSE INTERPRETATION:
   - When a supplier or manufacturer reports an unavailability, limitation, or offers an alternative (e.g. "100 mesh unavailable. We can supply 660 mesh"):
     * Intent = "supplier_response".
     * Target the relevant existing request ID.
     * Propose update field "current_issue" with the supplier constraint/alternative (e.g. "100 mesh unavailable; 660 mesh offered").
     * Suggest status: "BLOCKED".
     * Suggest waiting_for: "CUSTOMER" (waiting for customer confirmation on the alternative).
     * Provide grounding quotes.

4. CUSTOMER DECISION & BLOCKER RESOLUTION:
   - When a customer decides, accepts an alternative, or clarifies (e.g. "660 mesh is acceptable. Please quote"):
     * Intent = "customer_decision" or "requirement_change".
     * Target the relevant existing request ID.
     * Propose update field "customer_requirement" with the new accepted specification (e.g. "660 mesh").
     * If an earlier blocker/issue existed, propose update field "current_issue" to null / empty string (blocker resolved).
     * Suggest status: "OPEN" or "IN_PROGRESS".
     * Suggest waiting_for: "INDIA" (pricing team to obtain/prepare price).
     * Suggest next_action: "obtain/prepare price" or "obtain supplier quote".

5. REQUIREMENT EVOLUTION (DIFF PRESERVATION):
   - When a requirement changes:
     * Identify the target request_id.
     * State old_value (e.g. "100 mesh") and new_value (e.g. "660 mesh").
     * Provide grounding: the exact quote from the message.

6. CONFIDENCE TIERS:
   - "HIGH": Explicitly stated in the message text with verbatim quotation.
   - "MEDIUM": Contextually inferred from the thread.
   - "LOW": Ambiguous, vague, or conflicting statements. Must set needs_verification = true.

7. NEVER INVENT:
   - NEVER invent purchase prices, profit margins, or supplier promises.
   - NEVER create internal tasks.
   - NEVER commit to delivery dates without supplier confirmation.

Return a STRICT JSON object matching this schema:
{
  "intent": "new_request" | "clarification" | "requirement_change" | "supplier_response" | "customer_decision" | "no_action",
  "confidence_tier": "HIGH" | "MEDIUM" | "LOW",
  "needs_verification": boolean,
  "summary": string,
  "grounding": [
    {
      "text": string (verbatim quote from message),
      "reason": string
    }
  ],
  "proposed_updates": [
    {
      "request_id": string (UUID of matched request),
      "field": "customer_requirement" | "parameters" | "status" | "waiting_for" | "current_issue" | "next_action" | "assigned_team",
      "old_value": any,
      "new_value": any,
      "reason": string
    }
  ],
  "proposed_new_requests": [
    {
      "category": "commercial" | "technical" | "document" | "sample" | "logistics" | "custom",
      "title": string,
      "customer_requirement": string,
      "parameters": object,
      "waiting_for": "INTERNAL" | "INDIA" | "MANUFACTURER" | "CUSTOMER" | "NONE",
      "assigned_team": "sales" | "pricing_india" | "regulatory" | "warehouse" | "sourcing" | "management",
      "reason": string
    }
  ],
  "suggested_next_action": string | null,
  "suggested_waiting_for": "INTERNAL" | "INDIA" | "MANUFACTURER" | "CUSTOMER" | "NONE" | null,
  "suggested_team": string | null
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

  // Trusted internal service_role call OR authenticated user with appropriate role
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

  let body: AnalyzeRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid JSON request body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { message_id, force_reanalyze = false } = body;
  if (!message_id) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing required parameter: message_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 1. Load canonical message
  const { data: message, error: msgError } = await adminClient
    .from("enquiry_conversation_messages")
    .select("id, conversation_id, channel, direction, sender_address, sender_name, subject, body_text, body_html, received_or_sent_at, ai_processed, ai_summary, ai_proposal")
    .eq("id", message_id)
    .maybeSingle();

  if (msgError || !message) {
    return new Response(
      JSON.stringify({ success: false, error: `Message not found: ${message_id}` }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 2. Idempotency & Lock checks
  const existingProposal = message.ai_proposal as AiProposal | null;

  // 2a. Terminal or completed analysis: return cached unless forced
  if (
    !force_reanalyze &&
    message.ai_processed &&
    message.ai_proposal &&
    (message.ai_proposal.status === "suggested" ||
     message.ai_proposal.status === "no_action" ||
     ["accepted", "edited", "dismissed"].includes(message.ai_proposal.status))
  ) {
    return new Response(
      JSON.stringify({
        success: true,
        cached: true,
        message_id: message.id,
        status: existingProposal.status,
        ai_proposal: existingProposal,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 2b. Concurrency lock: prevent duplicate execution if already processing within last 5 minutes
  if (!force_reanalyze && existingProposal?.status === "processing" && existingProposal.started_at) {
    const startedTime = new Date(existingProposal.started_at).getTime();
    const elapsedMs = Date.now() - startedTime;
    if (elapsedMs < 5 * 60 * 1000) {
      return new Response(
        JSON.stringify({
          success: true,
          in_progress: true,
          message: "Analysis already in progress for this message",
          message_id: message.id,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  // 2c. Retry limit: stop endless loops if max retries exceeded (unless forced)
  const currentRetryCount = existingProposal?.retry_count || 0;
  if (!force_reanalyze && existingProposal?.status === "failed" && currentRetryCount >= 3) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Max retries reached (3). Manual re-analysis required.",
        retryable: false,
        message_id: message.id,
      }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Mark status as 'processing' to establish concurrency lock
  await adminClient
    .from("enquiry_conversation_messages")
    .update({
      ai_proposal: {
        status: "processing",
        started_at: new Date().toISOString(),
        retry_count: currentRetryCount,
      },
    })
    .eq("id", message.id);

  // 3. Load linked inquiry context
  const { data: convLinks } = await adminClient
    .from("enquiry_conversation_links")
    .select("inquiry_id, link_type")
    .eq("conversation_id", message.conversation_id)
    .eq("is_active", true);

  const inquiryIds = (convLinks || []).map((l: { inquiry_id: string }) => l.inquiry_id);

  let activeRequests: any[] = [];
  let inquiryDetails: any[] = [];

  if (inquiryIds.length > 0) {
    const { data: inqs } = await adminClient
      .from("crm_inquiries")
      .select("id, inquiry_number, company_name, contact_person, product_name")
      .in("id", inquiryIds);
    inquiryDetails = inqs || [];

    const { data: reqs } = await adminClient
      .from("enquiry_requests")
      .select("id, inquiry_id, category, request_code, title, customer_requirement, parameters, status, waiting_for, current_issue, next_action, assigned_team")
      .in("inquiry_id", inquiryIds)
      .not("status", "in", '("RESOLVED","CANCELLED","NOT_REQUIRED")')
      .order("created_at", { ascending: true });
    activeRequests = reqs || [];
  }

  // 4. Load minimal recent messages context for grounding (last 4 prior messages)
  const { data: recentMsgs } = await adminClient
    .from("enquiry_conversation_messages")
    .select("direction, sender_address, sender_name, subject, body_text, received_or_sent_at")
    .eq("conversation_id", message.conversation_id)
    .lte("received_or_sent_at", message.received_or_sent_at)
    .order("received_or_sent_at", { ascending: false })
    .limit(5);

  const contextThread = (recentMsgs || []).reverse().map((m: any) => ({
    time: m.received_or_sent_at,
    from: m.sender_name ? `${m.sender_name} <${m.sender_address}>` : m.sender_address,
    direction: m.direction,
    subject: m.subject,
    body: (m.body_text || "").slice(0, 1200),
  }));

  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiApiKey) {
    const newRetryCount = currentRetryCount + 1;
    const failProposal: AiProposal = {
      status: "failed",
      intent: "no_action",
      confidence_tier: "LOW",
      needs_verification: true,
      summary: "AI analysis failed: missing API key",
      grounding: [],
      proposed_updates: [],
      proposed_new_requests: [],
      suggested_next_action: null,
      suggested_waiting_for: null,
      suggested_team: null,
      analyzed_at: new Date().toISOString(),
      model: "gpt-4o-mini",
      error: "OpenAI API key not configured on server",
      retry_count: newRetryCount,
      retryable: newRetryCount < 3,
      attempted_at: new Date().toISOString(),
    };
    await adminClient
      .from("enquiry_conversation_messages")
      .update({
        ai_proposal: failProposal,
        ai_summary: "AI analysis failed: missing API key",
        ai_processed: false,
      })
      .eq("id", message.id);

    return new Response(
      JSON.stringify({
        success: false,
        error: "OpenAI API key not configured. Message remains retryable.",
        retryable: true,
        retry_count: newRetryCount,
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 5. Construct User Prompt
  const promptPayload = {
    current_message: {
      id: message.id,
      direction: message.direction,
      sender: message.sender_name ? `${message.sender_name} <${message.sender_address}>` : message.sender_address,
      subject: message.subject,
      body: (message.body_text || message.body_html || "").slice(0, 4000),
      timestamp: message.received_or_sent_at,
    },
    enquiries_linked: inquiryDetails,
    active_requests_in_system: activeRequests.map((r: any) => ({
      request_id: r.id,
      inquiry_id: r.inquiry_id,
      category: r.category,
      title: r.title,
      requirement: r.customer_requirement,
      parameters: r.parameters,
      status: r.status,
      waiting_for: r.waiting_for,
      current_issue: r.current_issue,
      next_action: r.next_action,
    })),
    recent_thread_history: contextThread,
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
        temperature: 0.1,
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

    const isNoAction = parsed.intent === "no_action" && (!parsed.proposed_updates || parsed.proposed_updates.length === 0) && (!parsed.proposed_new_requests || parsed.proposed_new_requests.length === 0);

    const proposal: AiProposal = {
      status: isNoAction ? "no_action" : "suggested",
      intent: parsed.intent || "no_action",
      confidence_tier: ["HIGH", "MEDIUM", "LOW"].includes(parsed.confidence_tier) ? parsed.confidence_tier : "MEDIUM",
      needs_verification: !!parsed.needs_verification || parsed.confidence_tier === "LOW",
      summary: parsed.summary || "Communication reviewed by Enquiry Brain",
      grounding: Array.isArray(parsed.grounding) ? parsed.grounding : [],
      proposed_updates: Array.isArray(parsed.proposed_updates) ? parsed.proposed_updates : [],
      proposed_new_requests: Array.isArray(parsed.proposed_new_requests) ? parsed.proposed_new_requests : [],
      suggested_next_action: parsed.suggested_next_action || null,
      suggested_waiting_for: parsed.suggested_waiting_for || null,
      suggested_team: parsed.suggested_team || null,
      analyzed_at: new Date().toISOString(),
      model: "gpt-4o-mini",
      retry_count: 0,
      retryable: false,
    };

    // 6. Persist ONLY to enquiry_conversation_messages (ZERO mutations to enquiry_requests or crm_inquiries)
    const { error: updateError } = await adminClient
      .from("enquiry_conversation_messages")
      .update({
        ai_proposal: proposal,
        ai_summary: proposal.summary,
        ai_processed: true,
      })
      .eq("id", message.id);

    if (updateError) {
      throw new Error(`Failed to save AI proposal to message: ${updateError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message_id: message.id,
        status: proposal.status,
        ai_proposal: proposal,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error(`[enquiry-brain-analyze] Error processing message ${message.id}:`, err);

    const newRetryCount = currentRetryCount + 1;
    const isRetryable = newRetryCount < 3;
    const failProposal: AiProposal = {
      status: "failed",
      intent: "no_action",
      confidence_tier: "LOW",
      needs_verification: true,
      summary: `AI analysis failed: ${err.message || "Unknown error"}`,
      grounding: [],
      proposed_updates: [],
      proposed_new_requests: [],
      suggested_next_action: null,
      suggested_waiting_for: null,
      suggested_team: null,
      analyzed_at: new Date().toISOString(),
      model: "gpt-4o-mini",
      error: err.message || "Unknown error during AI analysis",
      retry_count: newRetryCount,
      retryable: isRetryable,
      attempted_at: new Date().toISOString(),
    };

    await adminClient
      .from("enquiry_conversation_messages")
      .update({
        ai_proposal: failProposal,
        ai_summary: `AI analysis failed: ${err.message || "Unknown error"}`,
        ai_processed: false,
      })
      .eq("id", message.id);

    return new Response(
      JSON.stringify({
        success: false,
        error: err.message || "Failed to analyze message",
        retryable: isRetryable,
        retry_count: newRetryCount,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
