// kunal-relevance-classifier
//
// LLM-final relevance judge for Kunal's AI India Price Review tab.
// Given a Gmail message (with the FULL body already fetched by the frontend
// via gmail-inbox-message), it answers ONE question:
//
//   "Does this email require a Kunal pricing action?"
//
// Kunal pricing actions = India / Sonal source price received, COA/MSDS/docs
// received, India query needed to obtain a price, source availability or
// alternative-source signal, or final price still pending.
//
// Normal delivery, shipping, PO follow-up, customer reminders, meeting
// follow-ups, payment confirmations, newsletters, festive greetings, leave
// notices etc. are explicitly NOT pricing actions and must return
// actionable=false so the caller can file them under "No Action" without
// going to the AI extractor or inquiry matcher.
//
// This function NEVER reads Gmail tokens, NEVER writes business data, and
// has no side effects. Caller (kunalIndiaPrice.ts) decides what to persist.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type Category =
  | "India Price Received"
  | "Document / Certificate Received"
  | "India Query / Missing Info"
  | "Alternative Source / Not Available"
  | "No Action"
  | "Needs Review";

const CATEGORIES: Category[] = [
  "India Price Received",
  "Document / Certificate Received",
  "India Query / Missing Info",
  "Alternative Source / Not Available",
  "No Action",
  "Needs Review",
];

interface EmailInput {
  messageId: string;
  threadId?: string | null;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  body?: string;
  hasAttachments?: boolean;
  attachments?: Array<{ filename?: string; mimeType?: string }>;
}

interface Verdict {
  messageId: string;
  actionable: boolean;
  category: Category;
  reason: string;
  confidence: number;
  pricing_action_needed: boolean;
  document_action_needed: boolean;
  extracted_product: string | null;
  extracted_price: string | null;
  extracted_make: string | null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clamp01(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

// Conservative fallback used only when the LLM call fails outright. Defaults
// to No Action so we never escalate junk into Needs Manual Link.
function fallbackVerdict(e: EmailInput): Verdict {
  return {
    messageId: e.messageId,
    actionable: false,
    category: "No Action",
    reason: "LLM unavailable; defaulted to No Action.",
    confidence: 0.4,
    pricing_action_needed: false,
    document_action_needed: false,
    extracted_product: null,
    extracted_price: null,
    extracted_make: null,
  };
}

async function callOpenAI(emails: EmailInput[], openaiApiKey: string): Promise<Verdict[]> {
  const compact = emails.map(e => ({
    messageId: e.messageId,
    threadId: e.threadId || null,
    from: e.from || "",
    to: e.to || "",
    cc: e.cc || "",
    subject: e.subject || "",
    date: e.date || "",
    // Send the FULL body (capped to keep the prompt under control). The whole
    // point of this function is to read the full email, not the snippet.
    body: (e.body || e.snippet || "").slice(0, 6000),
    hasAttachments: !!e.hasAttachments,
    attachmentNames: (e.attachments || []).map(a => a?.filename || "").filter(Boolean).slice(0, 12),
    attachmentTypes: (e.attachments || []).map(a => a?.mimeType || "").filter(Boolean).slice(0, 12),
  }));

  const system = `You are Kunal's pricing email assistant.

Decide if each full email/thread requires Kunal pricing action.

CRITICAL: Direction and identity matter MORE than the presence of a price
table. The same product + price table is "No Action" when it is OUR sales
team quoting to a customer, and "India Price Received" only when it is the
INDIA/SOURCE team quoting TO us.

================================================================
IDENTITY HINTS — used to decide direction of the latest visible email
================================================================

OUR side / outbound (sales to customer = No Action):
- Senders: Zahra, sales@sapharmajaya.co.id, anyone @sapharmajaya.co.id
- Sign-offs: "PT Shubham Anzen Pharma Jaya", "Sapharmajaya", "PT Shubham"
- Indonesian outbound vocabulary: "Berikut saya berikan penawaran",
  "penawaran untuk produk", "harga kami", "kami tawarkan", "best regards
  <our sales rep>" followed by a PT Shubham Anzen signature
- English outbound vocabulary: "we offer", "we are pleased to quote", "our
  offer", "please find our quotation", "kindly find attached our offer",
  "quoted to customer", "as discussed our price"

Source / India side (inbound to us = potentially India Price Received):
- Senders/forwarded-from: Sonal, India office, Aanvi, "@anvisourcing", any
  Indian supplier/manufacturer domain (e.g. prachin, jubilant, cipla,
  divis, aarti, ipca, lasa, alkem, etc.)
- Subject/body markers: "Source price", "India price", "Sonal price", "INR
  per kg", "Rs./kg", "₹/kg", "our purchase price is", "supplier rate", "make:
  <manufacturer>", "manufacturer: <name>", "as per source"
- Forwarding chain: Aanvi/Sonal/Source forwarding a manufacturer reply to
  Kunal with a source rate counts as India Price Received.

Customer side (inbound to us, but from buyer = No Action / not Kunal):
- Customer email domains (anything other than @sapharmajaya.co.id and not
  one of the source/India supplier domains above)
- "Please quote", "kindly send your best offer", "any update on the offer
  sent", "request update on our offer", "please revert on our offer"

================================================================
CATEGORY DEFINITIONS
================================================================

"India Price Received" — REQUIRES BOTH:
  (a) a concrete price/rate signal from the SOURCE side (INR, Rs., ₹, USD/kg,
      EUR/kg, /kg, /gm, per kg, "make:<x>", supplier rate, purchase price), AND
  (b) source-side identity in From / forwarded-from / signature
      (Sonal / India office / Aanvi forwarding / Indian supplier domain).
  A price table alone is NOT enough — direction must be source→us.

"Document / Certificate Received":
  COA / MSDS / GMP / ISO / DMF / SPEC / TDS / certificate attached or pasted
  in the body, from a supplier/source — not "please share <doc>".

"India Query / Missing Info":
  The India/source team (or Aanvi) is asking for concrete missing sourcing
  info Kunal must answer BEFORE a quote can be made — target price, required
  quantity, specification/grade, manufacturer/make required. A generic
  "please update" is not a query. A customer asking us for an update is also
  NOT this category.

"Alternative Source / Not Available":
  Source side states a specific product is "not available" / "out of stock"
  / proposes an alternative make/manufacturer.

"No Action" — covers everything Kunal does NOT need to act on, including:
- OUTBOUND CUSTOMER QUOTES from our own sales team to a customer
  (Zahra / sapharmajaya.co.id / PT Shubham) — even if they contain a full
  product + price table. Example: "Berikut saya berikan penawaran untuk
  produk dibawah ini: Folic Acid $144/kg + PPN ... Best Regards Zahra,
  PT Shubham Anzen Pharma Jaya" → No Action. The product + price are OUR
  offer to the customer, not a source rate received by us.
- Customer asking for an update on an offer we already sent
  ("May we request an update on the offer sent.", "any update on our offer",
  "follow up on offer", "request update on previous offer",
  "reminder for the offer shared", "please revert on our offer").
- Customer requesting a new quote (that is a CRM inquiry, not a Kunal AI
  source-price email).
- Delivery scheduled / shipping update / tracking / courier / AWB / B/L / container
- PO confirmation / PO follow-up / "please share PO" / "PO copy attached"
- Payment received / payment reminder / invoice copy / remittance advice
- Meeting scheduled / catch-up / follow-up / out of office / leave
- Newsletter / marketing / festive greetings / birthday / congratulations
- General internal chatter without a concrete source price/document/query.

================================================================
DISAMBIGUATION RULES — APPLY STRICTLY IN ORDER
================================================================

Rule 0 (direction gate — runs first):
  Determine the direction of the LATEST visible email in the thread using
  From / To / Cc / forwarded-from / signature.
  - If the latest email is from OUR side (Zahra / sapharmajaya.co.id / PT
    Shubham) TO a customer, OR it contains an outbound-quote phrase
    ("penawaran", "we offer", "we are pleased to quote", "our offer is",
    "please find our quotation", "harga kami", "kami tawarkan", "quoted to
    customer"), the verdict MUST be "No Action" with actionable=false — even
    if the email contains a full product + price table. Stop here.
  - If the latest email is from a CUSTOMER (not us, not source) asking for
    an update / new quote / status, the verdict MUST be "No Action". Stop.

Rule 1 (source-side price reception): If rule 0 did not stop, and the email
  contains a concrete product + price/rate signal AND the direction is
  source→us (From / forwarded-from is Sonal / India office / Aanvi / Indian
  supplier domain, OR signature/body mentions "source rate" / "purchase
  price" / "make:<x>" in a way that means it was received from a supplier),
  the verdict MUST be "India Price Received" with actionable=true.

Rule 2 (document received): If the email or attachments contain a COA /
  MSDS / GMP / ISO / DMF / SPEC / TDS / certificate from a supplier/source,
  the verdict is "Document / Certificate Received" with actionable=true.

Rule 3 (concrete missing-info query from source/India): India/source team
  (or Aanvi) asking Kunal for target price / quantity / specification /
  grade / make — "India Query / Missing Info" with actionable=true.

Rule 4 (availability): Source side stating a product is not available /
  proposing alternative make — "Alternative Source / Not Available".

Rule 5 (default fallback): Otherwise "No Action". The bare presence of the
  word "offer" / "quotation" / "update" / "price" is NEVER enough on its own.

Words like PO / discussion / product / shipment / delivery / customer /
reminder / offer / quotation / update / penawaran are NOT enough on their
own to be actionable. You must see a CONCRETE SOURCE-SIDE pricing,
sourcing, document, or missing-info signal in the full email body before
saying actionable=true. When in doubt, choose actionable=false.

Return STRICT JSON only:
{
  "results": [
    {
      "messageId": string,
      "actionable": boolean,
      "category": "India Price Received" | "Document / Certificate Received" | "India Query / Missing Info" | "Alternative Source / Not Available" | "No Action" | "Needs Review",
      "reason": string,
      "confidence": number (0..1),
      "pricing_action_needed": boolean,
      "document_action_needed": boolean,
      "extracted_product": string | null,
      "extracted_price": string | null,
      "extracted_make": string | null
    }
  ]
}

Rules:
- actionable=true ONLY when category is one of: India Price Received, Document / Certificate Received, India Query / Missing Info, Alternative Source / Not Available.
- actionable=false when category is No Action.
- If you set category="Needs Review", you MUST justify a real pricing signal in reason; otherwise pick No Action instead.
- Do not invent product names, prices, or makes. Extract only what is explicitly in the email.
- Keep reason under 220 characters.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ emails: compact }) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 2200,
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
  const rows = Array.isArray(parsed.results) ? parsed.results : [];
  return rows.map((r: any) => {
    const original = emails.find(e => e.messageId === r.messageId) || emails[0];
    const rawCategory: string = String(r.category || "Needs Review");
    const category: Category = (CATEGORIES as string[]).includes(rawCategory) ? (rawCategory as Category) : "Needs Review";
    const actionableInput = typeof r.actionable === "boolean" ? r.actionable : category !== "No Action";
    // Enforce the invariant: No Action ↔ not actionable.
    const actionable = category === "No Action" ? false : actionableInput;
    return {
      messageId: String(r.messageId || original.messageId),
      actionable,
      category: actionable ? category : "No Action",
      reason: String(r.reason || "").slice(0, 220),
      confidence: clamp01(r.confidence),
      pricing_action_needed: !!r.pricing_action_needed,
      document_action_needed: !!r.document_action_needed,
      extracted_product: r.extracted_product ? String(r.extracted_product).slice(0, 160) : null,
      extracted_price: r.extracted_price ? String(r.extracted_price).slice(0, 80) : null,
      extracted_make: r.extracted_make ? String(r.extracted_make).slice(0, 140) : null,
    } as Verdict;
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Auth: require a valid Supabase JWT (same pattern as classify-sourcing-email).
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!jwt) return json({ success: false, code: "MISSING_AUTH" }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ success: false, code: "INVALID_AUTH" }, 401);

    const body = await req.json().catch(() => ({}));
    const emails: EmailInput[] = Array.isArray(body?.emails) ? body.emails : [];
    if (emails.length === 0) return json({ success: true, results: [] });

    const openaiApiKey = Deno.env.get("OPENAI_API_KEY") || "";
    let results: Verdict[];
    if (!openaiApiKey) {
      results = emails.map(fallbackVerdict);
    } else {
      try {
        results = await callOpenAI(emails, openaiApiKey);
        // Ensure every input has a verdict (LLM sometimes drops rows).
        const byId = new Map(results.map(v => [v.messageId, v]));
        results = emails.map(e => byId.get(e.messageId) || fallbackVerdict(e));
      } catch (_err) {
        results = emails.map(fallbackVerdict);
      }
    }

    return json({ success: true, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    return json({ success: false, code: message, error: message }, 500);
  }
});
