// parse-source-reply-email
//
// Extracts structured pricing-reply data from a supplier (India/China)
// reply email. JWT-verified — no Gmail tokens or service-role secrets
// are returned. Output is review-first: the frontend shows the result
// in an editable modal, and only writes to crm_inquiry_pricing_options +
// crm_inquiries after the user confirms each row.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  emailSubject?: string;
  emailBody?: string;
  fromEmail?: string;
  fromName?: string;
  receivedAt?: string;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  /** Optional hint from caller (defaults to 'india') */
  sourceTypeHint?: "india" | "china" | "local";
}

interface ParsedRow {
  product_name: string;
  inquiry_number: string | null;
  aceerp_no: string | null;
  offered_make: string | null;
  source_price: number | null;
  source_currency: string;
  quantity: string | null;
  availability: "available" | "partial" | "na";
  document_status: "pending" | "received" | "not_required" | "partial";
  lead_time: string | null;
  remark: string | null;
  confidence: number;
  raw_excerpt: string;
  // Part 4 — product/body extraction (all nullable, no DB column required;
  // folded into the pricing-option remark on save until columns exist).
  grade: string | null;
  cas: string | null;
  unit: string | null;
  specification: string | null;
  preferred_manufacturer: string | null;
  required_origin: string | null;
}

interface ParsedResponse {
  success: boolean;
  source_type: "india" | "china" | "local";
  rows: ParsedRow[];
  fromEmail?: string;
  fromName?: string;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  error?: string;
  code?: string;
}

const SYSTEM_PROMPT = `You extract structured pricing details from a SUPPLIER REPLY email.
The supplier is replying with quoted prices, alternate makes/manufacturers,
availability (yes / partial / NA), document availability (COA / MSDS), and
lead time / remarks. The reply may quote multiple products and multiple makes.

Return STRICT JSON with this shape only:
{
  "rows": [
    {
      "product_name": string,
      "inquiry_number": string | null,   // e.g. "INQ-26-0027.2" if mentioned
      "aceerp_no": string | null,
      "offered_make": string | null,     // manufacturer/brand offered for THIS row
      "source_price": number | null,     // numeric only, no symbol
      "source_currency": "INR" | "USD" | "CNY" | "IDR" | "EUR" | "GBP",
      "quantity": string | null,
      "availability": "available" | "partial" | "na",
      "document_status": "pending" | "received" | "not_required" | "partial",
      "lead_time": string | null,
      "remark": string | null,
      "confidence": number,              // 0..1
      "raw_excerpt": string,             // 1-2 line excerpt from email body
      "grade": string | null,            // pharma/food grade, e.g. "USP", "BP", "IP", "Food Grade"
      "cas": string | null,              // CAS registry number if present, e.g. "50-00-0"
      "unit": string | null,             // pricing/quantity unit, e.g. "kg", "MT", "L", "per kg"
      "specification": string | null,    // purity / spec text, e.g. "min 99%", "<10 ppm heavy metals"
      "preferred_manufacturer": string | null, // manufacturer the customer/inquiry asked for (distinct from offered_make)
      "required_origin": string | null   // required country of origin, e.g. "European", "Made in Germany"
    }
  ]
}

EXTRACTION RULES:
- One row PER (product × offered make). If a supplier offers two makes for one product, return two rows.
- If the supplier replies "NA" / "not available" / "no offer" for a product, still return a row with availability="na" and source_price=null.
- Source currency defaults to INR if the supplier is in India, CNY for China, USD otherwise. Override only when explicit.
- Strip currency symbols and commas from numbers ("₹ 1,250" → 1250).
- "Awaiting COA" / "COA pending" → document_status="pending".
- "COA attached" / "COA available" → document_status="received".
- grade/cas/unit/specification/preferred_manufacturer/required_origin: extract ONLY if clearly present; otherwise null. Never guess a CAS number.
- offered_make is what the supplier is offering; preferred_manufacturer is what the buyer requested — keep them distinct.
- If product, make, or price is ambiguous, lower confidence.
- raw_excerpt must be present and verbatim (1-2 lines max).
- DO NOT invent products that are not in the body.
- DO NOT include any commentary outside the JSON.`;

async function callOpenAI(emailSubject: string, emailBody: string, sourceHint: string, openaiApiKey: string): Promise<ParsedRow[]> {
  const userPrompt = `Parse this supplier reply email. Source hint: ${sourceHint}.

SUBJECT: ${emailSubject}

BODY:
${emailBody.slice(0, 12_000)}

Return ONLY the JSON object described in the system prompt.`;

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
      temperature: 0.1,
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
  const rows: ParsedRow[] = Array.isArray(parsed.rows) ? parsed.rows : [];
  // Server-side CAS validation: keep the model's CAS only if it matches the
  // canonical registry format (2-7 / 2 / 1 digits). Never trust free text.
  const CAS_RE = /^\d{2,7}-\d{2}-\d$/;
  return rows
    .filter(r => r && typeof r.product_name === "string" && r.product_name.trim().length > 0)
    .map(r => {
      const casRaw = r.cas ? String(r.cas).trim() : "";
      const cas = CAS_RE.test(casRaw) ? casRaw : null;
      return {
      product_name:     String(r.product_name).slice(0, 200),
      inquiry_number:   r.inquiry_number ? String(r.inquiry_number).slice(0, 60) : null,
      aceerp_no:        r.aceerp_no ? String(r.aceerp_no).slice(0, 60) : null,
      offered_make:     r.offered_make ? String(r.offered_make).slice(0, 120) : null,
      source_price:     typeof r.source_price === "number" ? r.source_price : null,
      source_currency:  ["INR","USD","CNY","IDR","EUR","GBP"].includes(r.source_currency) ? r.source_currency : "INR",
      quantity:         r.quantity ? String(r.quantity).slice(0, 60) : null,
      availability:     ["available","partial","na"].includes(r.availability) ? r.availability : "available",
      document_status:  ["pending","received","not_required","partial"].includes(r.document_status) ? r.document_status : "pending",
      lead_time:        r.lead_time ? String(r.lead_time).slice(0, 120) : null,
      remark:           r.remark ? String(r.remark).slice(0, 500) : null,
      confidence:       typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5,
      raw_excerpt:      r.raw_excerpt ? String(r.raw_excerpt).slice(0, 600) : "",
      grade:            r.grade ? String(r.grade).slice(0, 80) : null,
      cas,
      unit:             r.unit ? String(r.unit).slice(0, 40) : null,
      specification:    r.specification ? String(r.specification).slice(0, 300) : null,
      preferred_manufacturer: r.preferred_manufacturer ? String(r.preferred_manufacturer).slice(0, 120) : null,
      required_origin:  r.required_origin ? String(r.required_origin).slice(0, 80) : null,
      };
    });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // 1. JWT verification
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!jwt) {
      return new Response(JSON.stringify({ success: false, error: "Missing Authorization header", code: "NO_JWT" } as ParsedResponse),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData?.user) {
      return new Response(JSON.stringify({ success: false, error: "Invalid session", code: "BAD_JWT" } as ParsedResponse),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Parse + validate body
    const body = await req.json() as RequestBody;
    const emailBody = (body.emailBody || "").toString();
    const emailSubject = (body.emailSubject || "").toString();
    const sourceTypeHint = (body.sourceTypeHint || "india") as "india" | "china" | "local";
    if (!emailBody || emailBody.length < 20) {
      return new Response(JSON.stringify({
        success: false, error: "Email body is empty or too short to parse", code: "EMPTY_BODY",
      } as ParsedResponse),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 3. OpenAI parse
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY") || "";
    if (!openaiApiKey) {
      return new Response(JSON.stringify({
        success: false, source_type: sourceTypeHint, rows: [],
        error: "AI parser is not configured (OPENAI_API_KEY missing).",
        code: "NO_OPENAI_KEY",
      } as ParsedResponse),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const rows = await callOpenAI(emailSubject, emailBody, sourceTypeHint, openaiApiKey);

    const out: ParsedResponse = {
      success: true,
      source_type: sourceTypeHint,
      rows,
      fromEmail: body.fromEmail,
      fromName: body.fromName,
      gmailMessageId: body.gmailMessageId ?? null,
      gmailThreadId: body.gmailThreadId ?? null,
    };
    return new Response(JSON.stringify(out),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("[parse-source-reply-email] error:", err?.message || err);
    return new Response(JSON.stringify({
      success: false, error: err?.message || "Parse failed", code: "PARSE_FAILED",
    } as ParsedResponse),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
