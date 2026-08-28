// classify-sourcing-email
//
// Classifies safe Gmail message fields for Anvi Sourcing review. It never
// reads Gmail tokens and never writes business data. The frontend must show
// the result for human review before saving anything.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type AiType =
  | "Supplier Price Reply"
  | "India Office Query / Revert Needed"
  | "Document / Certificate Received"
  | "Customer Inquiry"
  | "General / No Action"
  | "Needs Review";

interface EmailInput {
  messageId: string;
  threadId?: string | null;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  body?: string;
  hasAttachments?: boolean;
  attachments?: Array<{ filename?: string; mimeType?: string }>;
}

interface ClassifiedEmail {
  messageId: string;
  threadId?: string | null;
  aiType: AiType;
  product: string | null;
  matchedInquiryNumber: string | null;
  aceerpNo: string | null;
  summary: string;
  suggestedAction: string;
  confidence: number;
  extractedQuestion: string | null;
  documentType: "COA" | "MSDS" | "COC" | "GMP" | "ISO" | "DMF" | "TDS" | "SPEC" | "CATALOGUE" | "PRICE_LIST" | "OTHER" | null;
  make: string | null;
  sourceTypeHint: "india" | "china" | "local";
  needsSourceParser: boolean;
}

interface ResponseBody {
  success: boolean;
  results: ClassifiedEmail[];
  error?: string;
  code?: string;
}

const AI_TYPES: AiType[] = [
  "Supplier Price Reply",
  "India Office Query / Revert Needed",
  "Document / Certificate Received",
  "Customer Inquiry",
  "General / No Action",
  "Needs Review",
];

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.5;
}

function fallbackClassify(email: EmailInput): ClassifiedEmail {
  const text = `${email.subject || ""}\n${email.snippet || ""}\n${email.body || ""}`.toLowerCase();
  const attachmentNames = (email.attachments || []).map(a => a.filename || "").join(" ").toLowerCase();
  const all = `${text}\n${attachmentNames}`;

  let aiType: AiType = "General / No Action";
  let suggestedAction = "No sourcing action required.";
  let documentType: ClassifiedEmail["documentType"] = null;
  let extractedQuestion: string | null = null;

  const hasDoc = email.hasAttachments || /(coa|msds|coc|certificate|gmp|iso|dmf|tds|technical data|specification|spec sheet|catalogue|catalog|price list|pricelist)/i.test(all);
  if (hasDoc) {
    aiType = "Document / Certificate Received";
    suggestedAction = "Review document type and link it to the matched inquiry.";
    if (all.includes("coa") || /certificate of analysis/i.test(all)) documentType = "COA";
    else if (all.includes("msds") || all.includes("sds")) documentType = "MSDS";
    else if (all.includes("coc")) documentType = "COC";
    else if (all.includes("gmp")) documentType = "GMP";
    else if (all.includes("iso")) documentType = "ISO";
    else if (all.includes("dmf")) documentType = "DMF";
    else if (all.includes("tds") || /technical data sheet/i.test(all)) documentType = "TDS";
    else if (/price\s*list|pricelist/i.test(all)) documentType = "PRICE_LIST";
    else if (/catalogue|catalog/i.test(all)) documentType = "CATALOGUE";
    else if (/specification|spec sheet/i.test(all)) documentType = "SPEC";
    else documentType = "OTHER";
  }

  if (/(what is|which grade|need spec|specification|quantity|qty|delivery timeline|target price|alternative source|clarify|please confirm|\?)/i.test(all)) {
    aiType = "India Office Query / Revert Needed";
    suggestedAction = "Append the question to CRM remarks and reply to India before expecting price.";
    extractedQuestion = (email.body || email.snippet || "").split(/\r?\n/).find(line => /\?/.test(line))?.trim().slice(0, 300) || null;
  }

  if (/(price|quote|offer|rate|inr|rs\.?|₹|usd|available|lead time|delivery)/i.test(all) && !extractedQuestion) {
    aiType = "Supplier Price Reply";
    suggestedAction = "Open review, confirm inquiry match, and save source price option.";
  }

  if (/(inquiry|requirement|rfq|please quote)/i.test(all) && !/(inr|rs\.?|₹|offer|rate)/i.test(all)) {
    aiType = "Customer Inquiry";
    suggestedAction = "Handle from CRM inbox or inquiry creation flow.";
  }

  const inq = all.match(/\bINQ-[A-Z0-9-]+(?:\.\d+)?\b/i)?.[0] || null;
  const ace = all.match(/\b(?:AC\s*)?ERP#?\s*[:\-]?\s*([A-Z0-9._/-]+)/i)?.[1] || null;

  return {
    messageId: email.messageId,
    threadId: email.threadId || null,
    aiType,
    product: null,
    matchedInquiryNumber: inq,
    aceerpNo: ace,
    summary: (email.snippet || email.subject || "").slice(0, 220),
    suggestedAction,
    confidence: aiType === "General / No Action" ? 0.45 : 0.62,
    extractedQuestion,
    documentType,
    make: null,
    sourceTypeHint: /china/i.test(email.from || all) ? "china" : "india",
    needsSourceParser: aiType === "Supplier Price Reply",
  };
}

async function callOpenAI(emails: EmailInput[], openaiApiKey: string): Promise<ClassifiedEmail[]> {
  const compact = emails.map(email => ({
    messageId: email.messageId,
    threadId: email.threadId || null,
    from: email.from || "",
    subject: email.subject || "",
    date: email.date || "",
    snippet: email.snippet || "",
    body: (email.body || "").slice(0, 1500),
    hasAttachments: !!email.hasAttachments,
    attachmentNames: (email.attachments || []).map(a => a.filename).filter(Boolean).slice(0, 10),
  }));

  const system = `You classify internal CRM/sourcing emails for a pharmaceutical raw-material trading workflow.
Return STRICT JSON only:
{
  "results": [
    {
      "messageId": string,
      "threadId": string | null,
      "aiType": "Supplier Price Reply" | "India Office Query / Revert Needed" | "Document / Certificate Received" | "Customer Inquiry" | "General / No Action" | "Needs Review",
      "product": string | null,
      "matchedInquiryNumber": string | null,
      "aceerpNo": string | null,
      "summary": string,
      "suggestedAction": string,
      "confidence": number,
      "extractedQuestion": string | null,
      "documentType": "COA" | "MSDS" | "COC" | "GMP" | "ISO" | "DMF" | "TDS" | "SPEC" | "CATALOGUE" | "PRICE_LIST" | "OTHER" | null,
      "make": string | null,
      "sourceTypeHint": "india" | "china" | "local",
      "needsSourceParser": boolean
    }
  ]
}

Rules:
- Supplier Price Reply: contains source/supplier price, availability, make, lead time, or NA.
- India Office Query / Revert Needed: asks for quantity, grade, spec, delivery timeline, target price, clarification, or alternative-source approval.
- Document / Certificate Received: attachments or text indicate COA, MSDS/SDS, COC, GMP, ISO, DMF, certificate, TDS (technical data sheet), SPEC (specification sheet), CATALOGUE, or PRICE_LIST. Choose the most specific documentType.
- Do not invent inquiry numbers. Extract only if visible.
- Keep summaries and actions short and practical.
- Confidence must be 0..1.`;

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
      max_tokens: 2500,
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
  const rows = Array.isArray(parsed.results) ? parsed.results : [];
  return rows.map((r: any) => {
    const original = emails.find(e => e.messageId === r.messageId) || emails[0];
    const type = AI_TYPES.includes(r.aiType) ? r.aiType : "Needs Review";
    return {
      messageId: String(r.messageId || original.messageId),
      threadId: r.threadId ? String(r.threadId) : (original.threadId || null),
      aiType: type,
      product: r.product ? String(r.product).slice(0, 160) : null,
      matchedInquiryNumber: r.matchedInquiryNumber ? String(r.matchedInquiryNumber).slice(0, 80) : null,
      aceerpNo: r.aceerpNo ? String(r.aceerpNo).slice(0, 80) : null,
      summary: String(r.summary || original.snippet || "").slice(0, 260),
      suggestedAction: String(r.suggestedAction || "Review this email.").slice(0, 220),
      confidence: clampConfidence(r.confidence),
      extractedQuestion: r.extractedQuestion ? String(r.extractedQuestion).slice(0, 500) : null,
      documentType: ["COA","MSDS","COC","GMP","ISO","DMF","TDS","SPEC","CATALOGUE","PRICE_LIST","OTHER"].includes(r.documentType) ? r.documentType : null,
      make: r.make ? String(r.make).slice(0, 140) : null,
      sourceTypeHint: ["india","china","local"].includes(r.sourceTypeHint) ? r.sourceTypeHint : "india",
      needsSourceParser: type === "Supplier Price Reply" || !!r.needsSourceParser,
    } as ClassifiedEmail;
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!jwt) {
      return new Response(JSON.stringify({ success: false, results: [], error: "Missing Authorization header", code: "NO_JWT" } as ResponseBody), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData?.user) {
      return new Response(JSON.stringify({ success: false, results: [], error: "Invalid session", code: "BAD_JWT" } as ResponseBody), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const emails = Array.isArray(body?.emails) ? body.emails.slice(0, 100) as EmailInput[] : [];
    const safeEmails = emails.filter(email => email?.messageId).map(email => ({
      ...email,
      body: String(email.body || "").slice(0, 12000),
    }));
    if (safeEmails.length === 0) {
      return new Response(JSON.stringify({ success: false, results: [], error: "No emails supplied", code: "NO_EMAILS" } as ResponseBody), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const openaiApiKey = Deno.env.get("OPENAI_API_KEY") || "";
    const results = openaiApiKey
      ? await callOpenAI(safeEmails, openaiApiKey)
      : safeEmails.map(fallbackClassify);

    return new Response(JSON.stringify({ success: true, results } as ResponseBody), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[classify-sourcing-email] error:", err?.message || err);
    return new Response(JSON.stringify({ success: false, results: [], error: err?.message || "Classification failed", code: "CLASSIFY_FAILED" } as ResponseBody), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
