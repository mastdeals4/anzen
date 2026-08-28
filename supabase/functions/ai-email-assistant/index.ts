// ai-email-assistant
//
// Improves the *wording* of an outgoing pricing/CRM email. The function is
// deliberately conservative: it must NOT change product names, quantities,
// prices, currencies, AC ERP#, inquiry numbers, or any structured data
// block the caller marks as "protected".
//
// JWT-verified. Returns the improved body as JSON. The frontend shows a
// diff/preview and the user must accept before the draft is updated.
// Never auto-sends.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type Purpose = "sourcing_request" | "sourcing_reminder" | "customer_quote" | "crm_bulk_email";

interface RequestBody {
  purpose: Purpose;
  subject: string;
  body: string;            // current draft (plain text or simple HTML)
  /** Lines / tokens that must be preserved verbatim — product table, prices, AC ERP#, etc. */
  protectedTokens?: string[];
  /** Optional tone hint (default: professional / concise) */
  tone?: "professional" | "friendly" | "firm";
}

interface ResponseBody {
  success: boolean;
  subject?: string;
  body?: string;
  notes?: string;
  warnings?: string[];
  error?: string;
  code?: string;
}

const SYSTEM_PROMPT = `You are an assistant that ONLY improves the wording, grammar, and
professionalism of a business email used in a B2B pharmaceutical raw-material
trading workflow.

HARD RULES (must not be broken):
1. Do NOT change product names, specifications, quantities, prices, currencies,
   AC ERP numbers, inquiry numbers, dates, contact details, addresses, or
   anything that looks like a number, code, identifier, or structured table row.
2. Do NOT add new products, prices, or commitments not present in the input.
3. Do NOT remove or alter lines listed under PROTECTED TOKENS — those must
   appear verbatim in the output.
4. Do NOT change the meaning. Improve phrasing, fix grammar, tighten tone.
5. Keep the same approximate length. Do not pad. Do not summarise away facts.
6. If the input is already clean and professional, return it as-is.

Return STRICT JSON:
{
  "subject": "<possibly improved subject>",
  "body": "<improved body — same facts, same numbers>",
  "notes": "<one-line note describing what you changed, or 'no changes needed'>",
  "warnings": ["any concern about content you did not change"]
}`;

async function callOpenAI(req: RequestBody, openaiApiKey: string): Promise<ResponseBody> {
  const protectedBlock = (req.protectedTokens || [])
    .filter(t => typeof t === "string" && t.trim().length > 0)
    .slice(0, 50)
    .map(t => `- ${t}`)
    .join("\n") || "(none)";

  const userPrompt = `Purpose: ${req.purpose}
Tone: ${req.tone || "professional"}

PROTECTED TOKENS (must appear verbatim in output):
${protectedBlock}

SUBJECT:
${req.subject}

BODY:
${req.body.slice(0, 8000)}

Return the improved version as the JSON object described in the system prompt.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt   },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 1500,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);

  return {
    success: true,
    subject: typeof parsed.subject === "string" ? parsed.subject.slice(0, 300) : req.subject,
    body:    typeof parsed.body === "string" ? parsed.body : req.body,
    notes:   typeof parsed.notes === "string" ? parsed.notes.slice(0, 400) : undefined,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 5).map((w: any) => String(w).slice(0, 200)) : undefined,
  };
}

function verifyProtectedTokens(body: string | undefined, tokens: string[] | undefined): string[] {
  const warnings: string[] = [];
  if (!body || !tokens) return warnings;
  for (const t of tokens) {
    if (!t || t.trim().length === 0) continue;
    if (!body.includes(t)) warnings.push(`Protected token missing from output: "${t.slice(0, 80)}"`);
  }
  return warnings;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // JWT verification
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!jwt) {
      return new Response(JSON.stringify({ success: false, error: "Missing Authorization header", code: "NO_JWT" } as ResponseBody),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData?.user) {
      return new Response(JSON.stringify({ success: false, error: "Invalid session", code: "BAD_JWT" } as ResponseBody),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json() as RequestBody;
    const validPurpose: Purpose[] = ["sourcing_request", "sourcing_reminder", "customer_quote", "crm_bulk_email"];
    if (!validPurpose.includes(body.purpose)) {
      return new Response(JSON.stringify({ success: false, error: "Unknown purpose", code: "BAD_PURPOSE" } as ResponseBody),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!body.body || body.body.trim().length < 10) {
      return new Response(JSON.stringify({ success: false, error: "Email body too short to improve", code: "EMPTY_BODY" } as ResponseBody),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const openaiApiKey = Deno.env.get("OPENAI_API_KEY") || "";
    if (!openaiApiKey) {
      return new Response(JSON.stringify({
        success: false, error: "AI assistant is not configured (OPENAI_API_KEY missing).", code: "NO_OPENAI_KEY",
      } as ResponseBody),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const result = await callOpenAI(body, openaiApiKey);
    // Defensive: warn the caller if any protected token disappeared from the improved body.
    const tokenWarnings = verifyProtectedTokens(result.body, body.protectedTokens);
    if (tokenWarnings.length > 0) {
      result.warnings = [...(result.warnings || []), ...tokenWarnings];
    }
    return new Response(JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("[ai-email-assistant] error:", err?.message || err);
    return new Response(JSON.stringify({
      success: false, error: err?.message || "AI assistant failed", code: "ASSIST_FAILED",
    } as ResponseBody),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
