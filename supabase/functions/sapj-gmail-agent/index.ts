import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getGmailConnectionSecret, listGmailConnectionSecrets, type GmailConnectionSecret } from "../_shared/gmailSecrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Agent-Secret, X-Cron-Secret",
};

export type AgentCategory =
  | "PRICE RECEIVED"
  | "DOCUMENT RECEIVED"
  | "SOURCE QUERY / REVERT NEEDED"
  | "ALTERNATIVE MAKE"
  | "NOT AVAILABLE"
  | "NO ACTION"
  | "NEEDS REVIEW";

export type AgentDirection =
  | "SOURCE -> SAPJ"
  | "SAPJ -> CUSTOMER"
  | "CUSTOMER -> SAPJ"
  | "INTERNAL";

export interface ParsedPricingRow {
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
  grade: string | null;
  cas: string | null;
  unit: string | null;
  specification: string | null;
  preferred_manufacturer: string | null;
  required_origin: string | null;
}

export interface DetectedDocument {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  documentType: "COA" | "MSDS" | "GMP" | "TDS" | "SPEC" | "COC" | "ISO" | "DMF" | "CATALOGUE" | "PRICE_LIST" | "OTHER";
  batchNumber: string | null;
  matchStatus: "MATCHED" | "AVAILABLE" | "MISSING" | "REVIEW" | "MISMATCH";
  matchConfidence: "HIGH" | "MEDIUM" | "LOW" | "BLOCK";
  matchedProduct: string | null;
  matchedMake: string | null;
  matchReasons: string[];
}

export interface CandidateInquiry {
  id: string;
  inquiry_number: string;
  aceerp_no: string | null;
  product_name: string;
  company_name: string;
  supplier_name: string | null;
  specification: string | null;
  score: number;
  reasons: string[];
  email_subject?: string | null;
  mail_subject?: string | null;
}

interface ProcessedEmailResult {
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  date: string;
  direction: AgentDirection;
  category: AgentCategory;
  summary: string;
  suggestedAction: string;
  confidence: number;
  product: string | null;
  make: string | null;
  price: number | null;
  currency: string | null;
  matchedInquiryId: string | null;
  matchedInquiryNumber: string | null;
  aceerpNo: string | null;
  candidates: CandidateInquiry[];
  suggestedInquiryId: string | null;
  needsManualLink: boolean;
  alternativeMake: {
    detected: boolean;
    requestedMake: string | null;
    offeredMake: string | null;
    price: number | null;
    currency: string | null;
  } | null;
  pricingRows: ParsedPricingRow[];
  documents: DetectedDocument[];
  evidence: {
    sourceQuote: string;
    matchedSignals: string[];
    why: string;
  };
  cached?: boolean;
}

// In-memory set to prevent concurrent double-execution for the same connection
const runningConnections = new Set<string>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function calculateNextCheckWIB(now: Date = new Date()): string {
  // Asia/Jakarta is UTC+7
  const wibOffsetMs = 7 * 60 * 60 * 1000;
  const wibDate = new Date(now.getTime() + wibOffsetMs);
  const wibHours = wibDate.getUTCHours();
  const wibMinutes = wibDate.getUTCMinutes();
  const currentMins = wibHours * 60 + wibMinutes;

  // Target check times in WIB: 08:00 (480 min), 13:00 (780 min), 18:00 (1080 min)
  let targetHours = 8;
  const targetMinutes = 0;
  let addDays = 0;

  if (currentMins < 480) {
    targetHours = 8;
  } else if (currentMins < 780) {
    targetHours = 13;
  } else if (currentMins < 1080) {
    targetHours = 18;
  } else {
    targetHours = 8;
    addDays = 1;
  }

  const nextWib = new Date(Date.UTC(
    wibDate.getUTCFullYear(),
    wibDate.getUTCMonth(),
    wibDate.getUTCDate() + addDays,
    targetHours,
    targetMinutes,
    0,
    0
  ));

  // Convert back to UTC ISO string
  const nextUtc = new Date(nextWib.getTime() - wibOffsetMs);
  return nextUtc.toISOString();
}

async function getValidAccessToken(supabase: any, connection: GmailConnectionSecret): Promise<string> {
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
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await supabase
    .from("gmail_connections")
    .update({ access_token: data.access_token, access_token_expires_at: expiresAt })
    .eq("id", connection.id);
  return data.access_token;
}

function decodeBase64Url(data = ""): string {
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getHeader(headers: Array<{ name: string; value: string }> = [], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function extractPayload(payload: any) {
  let text = "";
  let html = "";
  const attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];

  const visit = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: String(part.filename),
        mimeType: String(part.mimeType || "application/octet-stream"),
        size: Number(part.body?.size || 0),
        attachmentId: String(part.body.attachmentId),
      });
    }
    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (part.mimeType === "text/html") html ||= decoded;
      if (part.mimeType === "text/plain") text ||= decoded;
    }
    for (const child of part.parts || []) visit(child);
  };

  visit(payload);
  const plainText = (text || stripHtml(html)).slice(0, 25000);
  return { body: plainText, bodyHtml: html.slice(0, 50000), attachments };
}

// ── FAST FIRST-PASS FILTER ──────────────────────────────────────────────────
// Deterministic checks run BEFORE calling any LLM.
function fastFirstPassFilter(
  subject: string,
  from: string,
  body: string
): { isNoAction: boolean; reason: string; direction: AgentDirection } | null {
  const sLower = subject.toLowerCase();
  const fLower = from.toLowerCase();
  const bLower = body.toLowerCase();
  const combined = `${sLower} ${bLower}`;

  // 1. Check outbound quotes sent by our own sales team to a customer
  const isOurDomain = fLower.includes("@sapharmajaya.co.id") || fLower.includes("sales@") || fLower.includes("pt shubham anzen");
  const hasOutboundQuotePhrases =
    combined.includes("berikut saya berikan penawaran") ||
    combined.includes("penawaran untuk produk") ||
    combined.includes("kami tawarkan") ||
    combined.includes("harga kami") ||
    combined.includes("we are pleased to quote") ||
    combined.includes("please find our quotation") ||
    combined.includes("our offer is") ||
    combined.includes("quoted to customer");

  if (isOurDomain || hasOutboundQuotePhrases) {
    return {
      isNoAction: true,
      reason: "Outbound customer quotation sent from SAPJ sales team",
      direction: "SAPJ -> CUSTOMER",
    };
  }

  // 2. Generic customer reminders asking for an update on a quote already sent
  const isCustomerFollowUp =
    combined.includes("may we request an update on the offer sent") ||
    combined.includes("any update on the offer sent") ||
    combined.includes("any update on our offer") ||
    combined.includes("request update on previous offer") ||
    combined.includes("reminder for the offer shared") ||
    combined.includes("please revert on our offer") ||
    combined.includes("revert awaited on quote") ||
    combined.includes("revert awaited for the offer");

  if (isCustomerFollowUp) {
    return {
      isNoAction: true,
      reason: "Customer reminder / follow-up on quote previously sent by SAPJ",
      direction: "CUSTOMER -> SAPJ",
    };
  }

  // 3. Operational, logistics, accounting, administrative noise
  const NOISE_REGEX =
    /\b(tracking number|awb\s*#|bill of lading|\bb\/l\b|courier|dispatch details|container movement|delivery confirmation|payment received|payment reminder|remittance advice|proof of payment|faktur pajak|invoice copy|pib\s*#|out of office|on leave|annual leave|festive greetings|happy new year|eid mubarak|happy diwali|newsletter|unsubscribe|zoom meeting invite|google meet invite)\b/i;

  if (NOISE_REGEX.test(sLower) || (NOISE_REGEX.test(bLower) && !/(quote|rate|price|inr|usd|rs\.?\/kg|\/kg)/i.test(bLower))) {
    return {
      isNoAction: true,
      reason: "Operational logistics / payment / greeting / administrative email",
      direction: "INTERNAL",
    };
  }

  return null;
}

// ── EXTRACT ACE ERP & INQUIRY NUMBERS FROM TEXT ──────────────────────────────
function extractAceErpReference(text: string): string | null {
  const match = text.match(/\bACE(?:[-_ ]?ERP)?[:#\s-]*([A-Za-z0-9_-]{3,20})\b/i);
  return match ? match[1].trim() : null;
}

function extractInquiryNumber(text: string): string | null {
  const match = text.match(/\b(INQ-\d{2}-\d{4}(?:\.\d+)?)\b/i);
  return match ? match[1].trim().toUpperCase() : null;
}

function extractPriceRequestNumber(text: string): string | null {
  const match = text.match(/\b(PR-\d{2}-\d{4})\b/i);
  return match ? match[1].trim().toUpperCase() : null;
}

// ── PRODUCT NAME NORMALIZATION ──────────────────────────────────────────────
function normalizeProduct(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function stripGrade(name: string): string {
  return name.replace(/\b(USP|BP|IP|EP|JP|NF|FCC|PHARMA\s*GRADE|FOOD\s*GRADE|FEED\s*GRADE|TECHNICAL\s*GRADE)\b/gi, "").replace(/\s+/g, " ").trim();
}

function productsMatch(a: string, b: string): { exact: boolean; fuzzy: boolean } {
  const na = normalizeProduct(a);
  const nb = normalizeProduct(b);
  const exact = na === nb;
  const fuzzy = !exact && (stripGrade(na) === stripGrade(nb) || (na.length > 3 && nb.includes(na)) || (nb.length > 3 && na.includes(nb)));
  return { exact, fuzzy };
}

// ── MATCHING ENGINE: ACE ERP -> THREAD -> IN-REPLY-TO -> INQUIRY -> PRODUCT ──
async function matchEmailToInquiry(
  supabase: any,
  email: {
    subject: string;
    body: string;
    from: string;
    threadId: string | null;
    inReplyTo: string | null;
    extractedProduct?: string | null;
    extractedMake?: string | null;
    extractedAceErp?: string | null;
    extractedInquiryNum?: string | null;
  }
): Promise<{
  candidates: CandidateInquiry[];
  suggestedInquiryId: string | null;
  matchedInquiryNumber: string | null;
  aceerpNo: string | null;
  confidence: number;
  needsManualLink: boolean;
  matchReasons: string[];
}> {
  const textAll = `${email.subject}\n${email.body}`;
  const aceErp = email.extractedAceErp || extractAceErpReference(textAll);
  const inqNum = email.extractedInquiryNum || extractInquiryNumber(textAll);
  const prNum = extractPriceRequestNumber(textAll);

  const candidateMap = new Map<string, CandidateInquiry>();

  const addCandidates = (rows: any[], baseScore: number, reason: string) => {
    for (const r of rows) {
      if (!candidateMap.has(r.id)) {
        candidateMap.set(r.id, {
          id: r.id,
          inquiry_number: r.inquiry_number,
          aceerp_no: r.aceerp_no || null,
          product_name: r.product_name,
          company_name: r.company_name || "",
          supplier_name: r.supplier_name || null,
          specification: r.specification || null,
          score: baseScore,
          reasons: [reason],
          email_subject: r.email_subject || null,
          mail_subject: r.mail_subject || null,
        });
      } else {
        const c = candidateMap.get(r.id)!;
        c.score = Math.max(c.score, baseScore);
        if (!c.reasons.includes(reason)) c.reasons.push(reason);
      }
    }
  };

  // STEP 1: ACE ERP Match (highest precedence)
  if (aceErp) {
    const { data: byAce } = await supabase
      .from("crm_inquiries")
      .select("id,inquiry_number,aceerp_no,product_name,company_name,supplier_name,specification,email_subject,mail_subject")
      .ilike("aceerp_no", `%${aceErp}%`)
      .limit(5);
    if (byAce && byAce.length > 0) {
      addCandidates(byAce, 1.0, `ACE ERP exact match (${aceErp})`);
    }
  }

  // STEP 2: Gmail Thread ID Match (preserves relationship even if ACE ERP was deleted in reply)
  if (email.threadId) {
    // Check email_thread_map
    const { data: threadMaps } = await supabase
      .from("email_thread_map")
      .select("price_request_id")
      .eq("gmail_thread_id", email.threadId)
      .limit(5);

    if (threadMaps && threadMaps.length > 0) {
      const prIds = threadMaps.map((tm: any) => tm.price_request_id).filter(Boolean);
      if (prIds.length > 0) {
        const { data: prInquiries } = await supabase
          .from("price_requests")
          .select("inquiry_id")
          .in("id", prIds);
        const inqIds = (prInquiries || []).map((p: any) => p.inquiry_id).filter(Boolean);
        if (inqIds.length > 0) {
          const { data: inqRows } = await supabase
            .from("crm_inquiries")
            .select("id,inquiry_number,aceerp_no,product_name,company_name,supplier_name,specification,email_subject,mail_subject")
            .in("id", inqIds);
          if (inqRows) addCandidates(inqRows, 0.95, "Thread mapping (email_thread_map)");
        }
      }
    }

    // Check email_inquiry_links
    const { data: inqLinks } = await supabase
      .from("email_inquiry_links")
      .select("inquiry_id")
      .eq("gmail_thread_id", email.threadId)
      .limit(5);
    if (inqLinks && inqLinks.length > 0) {
      const linkIds = inqLinks.map((l: any) => l.inquiry_id).filter(Boolean);
      const { data: inqRows } = await supabase
        .from("crm_inquiries")
        .select("id,inquiry_number,aceerp_no,product_name,company_name,supplier_name,specification,email_subject,mail_subject")
        .in("id", linkIds);
      if (inqRows) addCandidates(inqRows, 0.95, "Thread linked to inquiry (email_inquiry_links)");
    }
  }

  // STEP 3: In-Reply-To Header Match
  if (email.inReplyTo) {
    const { data: parentActivities } = await supabase
      .from("crm_email_activities")
      .select("inquiry_id")
      .eq("message_id", email.inReplyTo)
      .not("inquiry_id", "is", null)
      .limit(5);
    if (parentActivities && parentActivities.length > 0) {
      const pInqIds = parentActivities.map((a: any) => a.inquiry_id).filter(Boolean);
      const { data: inqRows } = await supabase
        .from("crm_inquiries")
        .select("id,inquiry_number,aceerp_no,product_name,company_name,supplier_name,specification,email_subject,mail_subject")
        .in("id", pInqIds);
      if (inqRows) addCandidates(inqRows, 0.92, "In-Reply-To parent message matched");
    }
  }

  // STEP 4: Inquiry or Price Request Number Match
  if (inqNum) {
    const { data: byInq } = await supabase
      .from("crm_inquiries")
      .select("id,inquiry_number,aceerp_no,product_name,company_name,supplier_name,specification,email_subject,mail_subject")
      .eq("inquiry_number", inqNum)
      .limit(5);
    if (byInq && byInq.length > 0) {
      addCandidates(byInq, 0.90, `Inquiry number exact (${inqNum})`);
    }
  }

  if (prNum) {
    const { data: byPr } = await supabase
      .from("price_requests")
      .select("inquiry_id")
      .eq("price_request_number", prNum)
      .limit(5);
    if (byPr && byPr.length > 0) {
      const prInqIds = byPr.map((p: any) => p.inquiry_id).filter(Boolean);
      const { data: inqRows } = await supabase
        .from("crm_inquiries")
        .select("id,inquiry_number,aceerp_no,product_name,company_name,supplier_name,specification,email_subject,mail_subject")
        .in("id", prInqIds);
      if (inqRows) addCandidates(inqRows, 0.90, `Price request number exact (${prNum})`);
    }
  }

  // STEP 5: Product Name & Make Matching (Contextual Search)
  const targetProduct = email.extractedProduct || "";
  if (targetProduct && targetProduct.trim().length > 2) {
    const term = targetProduct.split(/\s+/).slice(0, 3).join(" ");
    const { data: productMatches } = await supabase
      .from("crm_inquiries")
      .select("id,inquiry_number,aceerp_no,product_name,company_name,supplier_name,specification,email_subject,mail_subject")
      .ilike("product_name", `%${term}%`)
      .in("pipeline_status", ["new", "in_progress", "follow_up"])
      .order("created_at", { ascending: false })
      .limit(10);

    if (productMatches) {
      for (const row of productMatches) {
        const pm = productsMatch(row.product_name, targetProduct);
        let score = 0.5;
        const reasons: string[] = [];

        if (pm.exact) {
          score = 0.85;
          reasons.push("Product name exact match");
        } else if (pm.fuzzy) {
          score = 0.70;
          reasons.push("Product name fuzzy match");
        } else {
          score = 0.50;
          reasons.push("Product keyword overlap");
        }

        // Supplier / make match boost
        if (email.extractedMake && row.supplier_name && row.supplier_name.toLowerCase().includes(email.extractedMake.toLowerCase())) {
          score += 0.08;
          reasons.push("Supplier/make match");
        }

        addCandidates([row], Math.min(score, 0.89), reasons.join(", "));
      }
    }
  }

  const candidateList = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score);
  const topCandidate = candidateList[0] || null;
  const secondCandidate = candidateList[1] || null;

  // Confidence decision:
  // Score >= 0.85 AND clear winner (gap >= 0.15) -> HIGH confidence auto-match
  const isHighConfidence = topCandidate && topCandidate.score >= 0.85 && (!secondCandidate || (topCandidate.score - secondCandidate.score >= 0.15));

  return {
    candidates: candidateList.slice(0, 5),
    suggestedInquiryId: topCandidate ? topCandidate.id : null,
    matchedInquiryNumber: topCandidate ? topCandidate.inquiry_number : inqNum,
    aceerpNo: topCandidate?.aceerp_no || aceErp || null,
    confidence: topCandidate ? topCandidate.score : 0,
    needsManualLink: !isHighConfidence,
    matchReasons: topCandidate ? topCandidate.reasons : ["No confident match found"],
  };
}

// ── OPENAI MULTI-TASK CLASSIFIER & PRICE/DOC EXTRACTOR ─────────────────────
async function runAiExtraction(
  email: {
    messageId: string;
    threadId: string | null;
    subject: string;
    from: string;
    date: string;
    body: string;
    attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
  },
  openaiApiKey: string
): Promise<{
  direction: AgentDirection;
  category: AgentCategory;
  summary: string;
  suggestedAction: string;
  confidence: number;
  product: string | null;
  make: string | null;
  price: number | null;
  currency: string | null;
  extractedAceErp: string | null;
  extractedInquiryNum: string | null;
  pricingRows: ParsedPricingRow[];
  detectedDocuments: DetectedDocument[];
  rawExcerpt: string;
  alternativeMake: {
    detected: boolean;
    requestedMake: string | null;
    offeredMake: string | null;
    price: number | null;
    currency: string | null;
  } | null;
}> {
  const systemPrompt = `You are the backend AI agent for SAPJ (PT Shubham Anzen Pharma Jaya), an active B2B pharmaceutical ingredients importer in Jakarta.
Your task is to analyze an inbound/outbound email and extract structured supplier pricing, sourcing updates, and document certificates.

STRICT DIRECTION RULES:
- SOURCE -> SAPJ: Email from Indian/Chinese/international or local chemical suppliers, manufacturers, Sonal/India office, Aanvi (@anvisourcing) quoting prices or sending documents to SAPJ.
- SAPJ -> CUSTOMER: Outbound quote or message from our sales team (e.g. Zahra, sales@sapharmajaya.co.id, PT Shubham Anzen) quoting prices to an Indonesian customer. THIS MUST BE "NO ACTION" for supplier pricing!
- CUSTOMER -> SAPJ: Inbound enquiry or request from an Indonesian customer asking for a quote or status update.
- INTERNAL: Internal notes, logistics, accounting, newsletters, or chat.

CATEGORIES:
- "PRICE RECEIVED": Supplier or India office is quoting one or more products with concrete prices (INR/kg, USD/kg, CNY/kg, etc.).
- "DOCUMENT RECEIVED": Supplier has sent or attached COA, MSDS, GMP, TDS, SPEC, ISO, DMF, or test report.
- "ALTERNATIVE MAKE": Supplier does not have the requested manufacturer/brand and is offering an alternate manufacturer.
- "NOT AVAILABLE": Supplier states the product is out of stock, NA, discontinued, or unable to quote.
- "SOURCE QUERY / REVERT NEEDED": Sourcing team asks SAPJ for target price, required quantity, specification, or make before quoting.
- "NO ACTION": Outbound quote to customer, customer asking for quote update, delivery/shipping/tracking/AWB/BL, payment/remittance/invoice copy, PO confirmation, OOO/leave, festive greetings, newsletter.
- "NEEDS REVIEW": Sourcing-related email that requires human review because details are ambiguous.

EXTRACTION INVARIANTS:
1. Product x Make: One pricing row per (product x offered make).
2. If supplier replies "NA" or "not available": availability="na", source_price=null.
3. Clean numbers only: "INR 1,250/kg" -> source_price=1250, source_currency="INR".
4. Verbatim excerpt: Include a 1-2 sentence verbatim excerpt from the email body as proof in raw_excerpt.
5. Identify any ACE ERP number (e.g. "ACE ERP: 12345" or "ACE-12345") or Inquiry number ("INQ-26-0027").

Return STRICT JSON:
{
  "direction": "SOURCE -> SAPJ" | "SAPJ -> CUSTOMER" | "CUSTOMER -> SAPJ" | "INTERNAL",
  "category": "PRICE RECEIVED" | "DOCUMENT RECEIVED" | "ALTERNATIVE MAKE" | "NOT AVAILABLE" | "SOURCE QUERY / REVERT NEEDED" | "NO ACTION" | "NEEDS REVIEW",
  "summary": string (max 200 chars),
  "suggested_action": string,
  "confidence": number (0..1),
  "extracted_product": string | null,
  "extracted_make": string | null,
  "extracted_price": number | null,
  "extracted_currency": string | null,
  "extracted_aceerp": string | null,
  "extracted_inquiry_num": string | null,
  "alternative_make": {
    "detected": boolean,
    "requested_make": string | null,
    "offered_make": string | null
  },
  "raw_excerpt": string,
  "pricing_rows": [
    {
      "product_name": string,
      "offered_make": string | null,
      "source_price": number | null,
      "source_currency": "INR" | "USD" | "CNY" | "IDR" | "EUR",
      "quantity": string | null,
      "availability": "available" | "partial" | "na",
      "document_status": "pending" | "received" | "not_required" | "partial",
      "lead_time": string | null,
      "remark": string | null,
      "confidence": number,
      "raw_excerpt": string,
      "grade": string | null,
      "cas": string | null,
      "unit": string | null,
      "specification": string | null,
      "preferred_manufacturer": string | null,
      "required_origin": string | null
    }
  ],
  "documents": [
    {
      "filename": string,
      "document_type": "COA" | "MSDS" | "GMP" | "TDS" | "SPEC" | "COC" | "ISO" | "DMF" | "CATALOGUE" | "PRICE_LIST" | "OTHER",
      "batch_number": string | null,
      "product_name": string | null,
      "make": string | null
    }
  ]
}`;

  const userPrompt = `SUBJECT: ${email.subject}
FROM: ${email.from}
DATE: ${email.date}
ATTACHMENTS: ${JSON.stringify(email.attachments.map(a => ({ name: a.filename, type: a.mimeType, size: a.size })))}

EMAIL BODY:
${email.body.slice(0, 10000)}

Analyze and return JSON.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API failed: ${resp.status} - ${errText}`);
  }

  const data = await resp.json();
  const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");

  const category = (parsed.category as AgentCategory) || "NEEDS REVIEW";
  const direction = (parsed.direction as AgentDirection) || "SOURCE -> SAPJ";

  const rawRows = Array.isArray(parsed.pricing_rows) ? parsed.pricing_rows : [];
  const pricingRows: ParsedPricingRow[] = rawRows.map((r: any) => ({
    product_name: String(r.product_name || parsed.extracted_product || "").slice(0, 200),
    inquiry_number: parsed.extracted_inquiry_num || null,
    aceerp_no: parsed.extracted_aceerp || null,
    offered_make: r.offered_make ? String(r.offered_make).slice(0, 120) : null,
    source_price: typeof r.source_price === "number" ? r.source_price : null,
    source_currency: ["INR", "USD", "CNY", "IDR", "EUR"].includes(r.source_currency) ? r.source_currency : "INR",
    quantity: r.quantity ? String(r.quantity).slice(0, 60) : null,
    availability: ["available", "partial", "na"].includes(r.availability) ? r.availability : "available",
    document_status: ["pending", "received", "not_required", "partial"].includes(r.document_status) ? r.document_status : "pending",
    lead_time: r.lead_time ? String(r.lead_time).slice(0, 120) : null,
    remark: r.remark ? String(r.remark).slice(0, 300) : null,
    confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : (parsed.confidence || 0.8),
    raw_excerpt: String(r.raw_excerpt || parsed.raw_excerpt || "").slice(0, 400),
    grade: r.grade ? String(r.grade).slice(0, 80) : null,
    cas: r.cas ? String(r.cas).slice(0, 30) : null,
    unit: r.unit ? String(r.unit).slice(0, 30) : null,
    specification: r.specification ? String(r.specification).slice(0, 200) : null,
    preferred_manufacturer: r.preferred_manufacturer ? String(r.preferred_manufacturer).slice(0, 120) : null,
    required_origin: r.required_origin ? String(r.required_origin).slice(0, 80) : null,
  }));

  // Detected documents: match attachments with LLM guesses and filename rules
  const detectedDocuments: DetectedDocument[] = email.attachments.map(att => {
    const fname = att.filename.toLowerCase();
    const docMatch = (parsed.documents || []).find((d: any) =>
      d.filename && att.filename.toLowerCase().includes(String(d.filename).toLowerCase())
    );

    let docType: DetectedDocument["documentType"] = docMatch?.document_type || "OTHER";
    if (docType === "OTHER") {
      if (fname.includes("coa") || fname.includes("certificate of analysis")) docType = "COA";
      else if (fname.includes("msds") || fname.includes("sds")) docType = "MSDS";
      else if (fname.includes("gmp")) docType = "GMP";
      else if (fname.includes("tds") || fname.includes("technical data")) docType = "TDS";
      else if (fname.includes("spec")) docType = "SPEC";
      else if (fname.includes("coc")) docType = "COC";
      else if (fname.includes("iso")) docType = "ISO";
      else if (fname.includes("dmf")) docType = "DMF";
      else if (fname.includes("price list") || fname.includes("pricelist")) docType = "PRICE_LIST";
      else if (fname.includes("catalog")) docType = "CATALOGUE";
    }

    const batchNumber = docMatch?.batch_number || null;
    const matchConfidence = (batchNumber && parsed.extracted_product) ? "HIGH" : (parsed.extracted_product ? "MEDIUM" : "LOW");

    return {
      attachmentId: att.attachmentId,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      documentType: docType,
      batchNumber,
      matchStatus: "AVAILABLE",
      matchConfidence,
      matchedProduct: parsed.extracted_product || null,
      matchedMake: parsed.extracted_make || null,
      matchReasons: [
        `Detected as ${docType}`,
        parsed.extracted_product ? `Product: ${parsed.extracted_product}` : "Product unassigned",
        batchNumber ? `Batch: ${batchNumber}` : "No batch in filename/body",
      ],
    };
  });

  const altMakeObj = parsed.alternative_make?.detected ? {
    detected: true,
    requestedMake: parsed.alternative_make.requested_make || null,
    offeredMake: parsed.alternative_make.offered_make || parsed.extracted_make || null,
    price: parsed.extracted_price || (pricingRows[0]?.source_price ?? null),
    currency: parsed.extracted_currency || (pricingRows[0]?.source_currency ?? "INR"),
  } : null;

  return {
    direction,
    category,
    summary: String(parsed.summary || "Supplier email processed.").slice(0, 200),
    suggestedAction: String(parsed.suggested_action || "Review pricing and document options.").slice(0, 200),
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8,
    product: parsed.extracted_product || (pricingRows[0]?.product_name ?? null),
    make: parsed.extracted_make || (pricingRows[0]?.offered_make ?? null),
    price: typeof parsed.extracted_price === "number" ? parsed.extracted_price : (pricingRows[0]?.source_price ?? null),
    currency: parsed.extracted_currency || (pricingRows[0]?.source_currency ?? "INR"),
    extractedAceErp: parsed.extracted_aceerp || null,
    extractedInquiryNum: parsed.extracted_inquiry_num || null,
    pricingRows,
    detectedDocuments,
    rawExcerpt: String(parsed.raw_excerpt || "").slice(0, 400),
    alternativeMake: altMakeObj,
  };
}

// ── MAIN DENO SERVER HANDLER ────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY") || "";

    // 1. Authorization: check User Bearer token OR Service Role OR Cron Secret
    const authHeader = req.headers.get("Authorization") || "";
    const agentSecretHeader = req.headers.get("X-Agent-Secret") || req.headers.get("X-Cron-Secret") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    let isAuthorized = false;
    let callingUserId: string | null = null;

    if (jwt === serviceRoleKey || agentSecretHeader === "sapj-internal-cron-trigger") {
      isAuthorized = true;
    } else if (jwt) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (!userErr && userData?.user) {
        callingUserId = userData.user.id;
        // Verify role
        const adminClient = createClient(supabaseUrl, serviceRoleKey);
        const { data: profile } = await adminClient
          .from("user_profiles")
          .select("role,is_active")
          .eq("id", userData.user.id)
          .maybeSingle();

        const role = String(profile?.role || "").toLowerCase();
        if (profile?.is_active !== false && ["admin", "manager", "sales"].includes(role)) {
          isAuthorized = true;
        }
      }
    }

    if (!isAuthorized) {
      return json({ success: false, code: "UNAUTHORIZED", error: "Valid auth token or service secret required." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as {
      connectionId?: string;
      maxMessages?: number;
      forceReprocess?: boolean;
      forceMessageId?: string;
      scheduled?: boolean;
      scanLast7Days?: boolean;
    };

    const maxMessages = Math.min(Math.max(Number(body.maxMessages) || 25, 1), 50);
    const forceReprocess = body.forceReprocess === true;
    const forceMessageId = body.forceMessageId ? String(body.forceMessageId).trim() : null;

    // 2. Retrieve connected Gmail accounts
    let connections: GmailConnectionSecret[] = [];
    if (body.connectionId) {
      const conn = await getGmailConnectionSecret(adminClient, { connectionId: body.connectionId });
      if (conn) connections = [conn];
    } else if (callingUserId) {
      connections = await listGmailConnectionSecrets(adminClient, { userId: callingUserId, syncEnabled: true });
      if (connections.length === 0) {
        // Fall back to any active connection if admin
        connections = await listGmailConnectionSecrets(adminClient, { syncEnabled: true });
      }
    } else {
      connections = await listGmailConnectionSecrets(adminClient, { syncEnabled: true });
    }

    if (connections.length === 0) {
      return json({
        success: false,
        code: "NO_GMAIL_CONNECTED",
        error: "No active Gmail connections found to scan.",
        scanned: 0,
        pricing: 0,
        documents: 0,
        needs_review: 0,
        no_action: 0,
      }, 200);
    }

    let totalScanned = 0;
    let pricingCount = 0;
    let documentsCount = 0;
    let needsReviewCount = 0;
    let noActionCount = 0;
    const results: ProcessedEmailResult[] = [];

    for (const connection of connections) {
      // Concurrency protection: do not run multiple scans on the same connection concurrently
      if (runningConnections.has(connection.id)) {
        return json({
          success: true,
          status: "already_running",
          message: "A scan is already in progress for this connection. Please wait.",
          scanned: 0,
          pricing: 0,
          documents: 0,
          needs_review: 0,
          no_action: 0,
          last_checked: connection.last_sync || new Date().toISOString(),
          next_check: calculateNextCheckWIB(),
        });
      }

      runningConnections.add(connection.id);

      try {
        const accessToken = await getValidAccessToken(adminClient, connection);

        // Scan strategy: NOT reliant on 'unread'!
        // Uses last_sync timestamp with a 24-hour overlap window, or newer_than:14d on first run, or newer_than:7d on scanLast7Days.
        let gmailQuery = "newer_than:14d";
        if (forceMessageId) {
          gmailQuery = `rfc822msgid:${forceMessageId} OR id:${forceMessageId}`;
        } else if (body.scanLast7Days) {
          gmailQuery = "newer_than:7d";
        } else if (connection.last_sync) {
          const lastSyncMs = new Date(connection.last_sync).getTime();
          if (!Number.isNaN(lastSyncMs)) {
            const overlapSec = Math.max(0, Math.floor((lastSyncMs - 24 * 60 * 60 * 1000) / 1000));
            gmailQuery = `after:${overlapSec}`;
          }
        }

        // 2. Reliable Catch-Up via Gmail Pagination Loop
        // Fetches all matching pages until all messages are retrieved or safe execution limit is reached.
        const messageRefs: Array<{ id: string; threadId: string }> = [];
        let pageToken: string | undefined = undefined;
        let pageCount = 0;
        const maxPages = 10;
        const batchCap = body.maxMessages ? Math.max(Number(body.maxMessages), 25) : 150;

        do {
          pageCount += 1;
          const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
          listUrl.searchParams.set("maxResults", "50");
          listUrl.searchParams.set("q", gmailQuery);
          if (pageToken) {
            listUrl.searchParams.set("pageToken", pageToken);
          }

          const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!listResp.ok) {
            console.error(`Gmail list failed for connection ${connection.id} (page ${pageCount}): ${await listResp.text()}`);
            break;
          }

          const listData = await listResp.json();
          const msgs = (listData.messages || []) as Array<{ id: string; threadId: string }>;
          messageRefs.push(...msgs);

          pageToken = listData.nextPageToken;
        } while (pageToken && messageRefs.length < batchCap && pageCount < maxPages);

        for (const ref of messageRefs) {
          totalScanned += 1;

          // 3. IDEMPOTENCY & CACHE CHECK
          // Check if this message was already processed in kunal_ai_email_reviews
          const { data: existingReview } = await adminClient
            .from("kunal_ai_email_reviews")
            .select("id,ai_type,action_status,product_name,offered_make,source_price,source_currency,raw_result,summary,suggested_action,confidence")
            .eq("gmail_message_id", ref.id)
            .maybeSingle();

          if (existingReview && !forceReprocess) {
            // Previously processed — skip expensive OpenAI re-processing
            const category = existingReview.ai_type as AgentCategory;
            if (category === "PRICE RECEIVED" || category === "ALTERNATIVE MAKE") pricingCount += 1;
            else if (category === "DOCUMENT RECEIVED") documentsCount += 1;
            else if (category === "NEEDS REVIEW" || existingReview.action_status === "needs_manual_link") needsReviewCount += 1;
            else if (category === "NO ACTION") noActionCount += 1;

            results.push({
              messageId: ref.id,
              threadId: ref.threadId,
              subject: "(Previously processed)",
              from: "",
              date: "",
              direction: "SOURCE -> SAPJ",
              category: (existingReview.ai_type as AgentCategory) || "NO ACTION",
              summary: existingReview.summary || "Previously processed email.",
              suggestedAction: existingReview.suggested_action || "",
              confidence: Number(existingReview.confidence) || 0.8,
              product: existingReview.product_name,
              make: existingReview.offered_make,
              price: existingReview.source_price,
              currency: existingReview.source_currency,
              matchedInquiryId: existingReview.matched_inquiry_id || null,
              matchedInquiryNumber: existingReview.raw_result?.matchedInquiryNumber || null,
              aceerpNo: existingReview.raw_result?.aceerpNo || null,
              candidates: existingReview.raw_result?.candidates || [],
              suggestedInquiryId: existingReview.raw_result?.suggestedInquiryId || null,
              needsManualLink: existingReview.action_status === "needs_manual_link",
              alternativeMake: existingReview.raw_result?.alternativeMake || null,
              pricingRows: existingReview.raw_result?.extractionRows || [],
              documents: existingReview.raw_result?.detectedDocuments || [],
              evidence: existingReview.raw_result?.evidence || { sourceQuote: "", matchedSignals: [], why: "Previously cached review." },
              cached: true,
            });
            continue;
          }

          // 4. Fetch full Gmail message payload
          const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`;
          const msgResp = await fetch(msgUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!msgResp.ok) continue;

          const msgData = await msgResp.json();
          const headers = msgData.payload?.headers || [];
          const subject = getHeader(headers, "subject") || "(No Subject)";
          const from = getHeader(headers, "from") || "";
          const toHeader = getHeader(headers, "to") || "";
          const dateStr = getHeader(headers, "date") || (msgData.internalDate ? new Date(Number(msgData.internalDate)).toISOString() : new Date().toISOString());
          const inReplyTo = getHeader(headers, "in-reply-to") || null;
          const { body: bodyText, bodyHtml, attachments } = extractPayload(msgData.payload);

          // 5. Ensure raw email is mirrored in crm_email_inbox with full headers & HTML (idempotent)
          const fromEmail = from.match(/<(.+?)>/)?.[1] || from;
          const fromName = from.replace(/<.+?>/, "").trim();
          await adminClient
            .from("crm_email_inbox")
            .upsert({
              gmail_connection_id: connection.id,
              message_id: ref.id,
              thread_id: ref.threadId,
              subject,
              from_email: fromEmail,
              from_name: fromName,
              to_email: toHeader,
              body: bodyText,
              body_html: bodyHtml || null,
              has_attachments: attachments.length > 0,
              received_date: new Date(dateStr).toISOString(),
              is_processed: true,
            }, { onConflict: "message_id" })
            .catch(() => {});

          // 6. Fast First-Pass Filter (Cheap Deterministic Check)
          const fastFilter = fastFirstPassFilter(subject, from, bodyText);
          if (fastFilter && fastFilter.isNoAction) {
            noActionCount += 1;
            const noActionResult: ProcessedEmailResult = {
              messageId: ref.id,
              threadId: ref.threadId,
              subject,
              from,
              date: dateStr,
              direction: fastFilter.direction,
              category: "NO ACTION",
              summary: fastFilter.reason,
              suggestedAction: "No action required.",
              confidence: 1.0,
              product: null,
              make: null,
              price: null,
              currency: null,
              matchedInquiryId: null,
              matchedInquiryNumber: null,
              aceerpNo: null,
              candidates: [],
              suggestedInquiryId: null,
              needsManualLink: false,
              alternativeMake: null,
              pricingRows: [],
              documents: [],
              evidence: {
                sourceQuote: bodyText.slice(0, 160),
                matchedSignals: [fastFilter.reason],
                why: fastFilter.reason,
              },
            };

            await adminClient
              .from("kunal_ai_email_reviews")
              .upsert({
                gmail_message_id: ref.id,
                gmail_thread_id: ref.threadId,
                from_email: fromEmail,
                subject,
                email_date: new Date(dateStr).toISOString(),
                ai_type: "No Action",
                action_status: "no_action",
                summary: fastFilter.reason,
                suggested_action: "No action required.",
                confidence: 1.0,
                has_attachments: attachments.length > 0,
                raw_result: {
                  fastFiltered: true,
                  direction: fastFilter.direction,
                  reason: fastFilter.reason,
                },
                scanned_by: callingUserId || connection.user_id,
                scanned_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: "gmail_message_id" });

            results.push(noActionResult);
            continue;
          }

          // 7. AI Extraction & Classification via OpenAI
          let aiExtracted;
          if (openaiApiKey) {
            try {
              aiExtracted = await runAiExtraction({
                messageId: ref.id,
                threadId: ref.threadId,
                subject,
                from,
                date: dateStr,
                body: bodyText,
                attachments,
              }, openaiApiKey);
            } catch (aiErr) {
              console.warn(`[sapj-gmail-agent] AI extraction failed for ${ref.id}:`, aiErr);
            }
          }

          // Fallback if OpenAI not configured or failed
          if (!aiExtracted) {
            const hasDoc = attachments.length > 0;
            aiExtracted = {
              direction: "SOURCE -> SAPJ" as AgentDirection,
              category: (hasDoc ? "DOCUMENT RECEIVED" : "NEEDS REVIEW") as AgentCategory,
              summary: "Awaiting manual review.",
              suggestedAction: "Review email content.",
              confidence: 0.5,
              product: null,
              make: null,
              price: null,
              currency: "INR",
              extractedAceErp: extractAceErpReference(`${subject} ${bodyText}`),
              extractedInquiryNum: extractInquiryNumber(`${subject} ${bodyText}`),
              pricingRows: [],
              detectedDocuments: attachments.map(a => ({
                attachmentId: a.attachmentId,
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
                documentType: "OTHER" as const,
                batchNumber: null,
                matchStatus: "AVAILABLE" as const,
                matchConfidence: "LOW" as const,
                matchedProduct: null,
                matchedMake: null,
                matchReasons: ["Fallback document classification"],
              })),
              rawExcerpt: bodyText.slice(0, 200),
              alternativeMake: null,
            };
          }

          // 8. Match against SAPJ (ACE ERP, Thread, Inquiry, Product)
          const matchResult = await matchEmailToInquiry(adminClient, {
            subject,
            body: bodyText,
            from,
            threadId: ref.threadId,
            inReplyTo,
            extractedProduct: aiExtracted.product,
            extractedMake: aiExtracted.make,
            extractedAceErp: aiExtracted.extractedAceErp,
            extractedInquiryNum: aiExtracted.extractedInquiryNum,
          });

          // Check if top candidate suggests an alternative make
          let alternativeMake = aiExtracted.alternativeMake;
          if (!alternativeMake && topCandidateRequestedMake(matchResult.candidates[0], aiExtracted.make)) {
            alternativeMake = {
              detected: true,
              requestedMake: matchResult.candidates[0].supplier_name || matchResult.candidates[0].specification || "Original Make",
              offeredMake: aiExtracted.make,
              price: aiExtracted.price,
              currency: aiExtracted.currency,
            };
          }

          // Normalize category
          let finalCategory: AgentCategory = aiExtracted.category;
          if (aiExtracted.direction === "SAPJ -> CUSTOMER" || aiExtracted.category === "NO ACTION") {
            finalCategory = "NO ACTION";
          } else if (alternativeMake && alternativeMake.detected) {
            finalCategory = "ALTERNATIVE MAKE";
          } else if (aiExtracted.pricingRows.length > 0 && aiExtracted.pricingRows.some(r => r.source_price !== null)) {
            finalCategory = "PRICE RECEIVED";
          } else if (aiExtracted.detectedDocuments.length > 0 && finalCategory !== "PRICE RECEIVED") {
            finalCategory = "DOCUMENT RECEIVED";
          } else if (matchResult.needsManualLink && finalCategory !== "NO ACTION") {
            finalCategory = "NEEDS REVIEW";
          }

          if (finalCategory === "PRICE RECEIVED" || finalCategory === "ALTERNATIVE MAKE") pricingCount += 1;
          else if (finalCategory === "DOCUMENT RECEIVED") documentsCount += 1;
          else if (finalCategory === "NO ACTION") noActionCount += 1;
          else needsReviewCount += 1;

          const actionStatus = finalCategory === "NO ACTION" ? "no_action"
            : matchResult.needsManualLink ? "needs_manual_link"
            : "pending_review";

          const evidence = {
            sourceQuote: aiExtracted.rawExcerpt || bodyText.slice(0, 200),
            matchedSignals: [
              `Direction: ${aiExtracted.direction}`,
              `Category: ${finalCategory}`,
              ...matchResult.matchReasons,
              ...(aiExtracted.product ? [`Product: ${aiExtracted.product}`] : []),
              ...(aiExtracted.make ? [`Make: ${aiExtracted.make}`] : []),
            ],
            why: `Classified as ${finalCategory} with confidence ${(matchResult.confidence * 100).toFixed(0)}%. ${matchResult.matchReasons[0] || ""}`,
          };

          // 9. Persist into kunal_ai_email_reviews
          const reviewRowPayload = {
            gmail_message_id: ref.id,
            gmail_thread_id: ref.threadId,
            from_email: fromEmail,
            subject,
            email_date: new Date(dateStr).toISOString(),
            ai_type: finalCategory,
            action_status: actionStatus,
            product_name: aiExtracted.product,
            offered_make: aiExtracted.make,
            source_price: aiExtracted.price,
            source_currency: aiExtracted.currency,
            matched_inquiry_id: matchResult.suggestedInquiryId,
            confidence: matchResult.confidence,
            summary: aiExtracted.summary,
            suggested_action: aiExtracted.suggestedAction,
            has_attachments: attachments.length > 0,
            scanned_by: callingUserId || connection.user_id,
            scanned_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            raw_result: {
              direction: aiExtracted.direction,
              matchedInquiryNumber: matchResult.matchedInquiryNumber,
              aceerpNo: matchResult.aceerpNo,
              documentType: aiExtracted.detectedDocuments[0]?.documentType || null,
              suggestedInquiryId: matchResult.suggestedInquiryId,
              hasMultipleSimilarCandidates: matchResult.candidates.length > 1,
              candidates: matchResult.candidates,
              extractionRows: aiExtracted.pricingRows,
              detectedDocuments: aiExtracted.detectedDocuments,
              alternativeMake,
              evidence,
              sourceEmail: {
                messageId: ref.id,
                threadId: ref.threadId,
                from,
                fromEmail,
                fromName,
                to: toHeader,
                date: dateStr,
                subject,
                bodyText: bodyText.slice(0, 15000),
                bodyHtml: bodyHtml ? bodyHtml.slice(0, 30000) : null,
                attachments: attachments.map(a => ({
                  attachmentId: a.attachmentId,
                  filename: a.filename,
                  mimeType: a.mimeType,
                  size: a.size,
                })),
              },
              traceability: {
                inReplyTo,
                threadId: ref.threadId,
                aceErp: matchResult.aceerpNo,
                inquiryNumber: matchResult.matchedInquiryNumber,
              },
            },
          };

          await adminClient
            .from("kunal_ai_email_reviews")
            .upsert(reviewRowPayload, { onConflict: "gmail_message_id" });

          // 10. Document Auto-Link (Associate high confidence documents with inquiry)
          if (matchResult.suggestedInquiryId && aiExtracted.detectedDocuments.length > 0) {
            for (const doc of aiExtracted.detectedDocuments) {
              if (doc.matchConfidence === "HIGH") {
                await adminClient
                  .from("crm_product_documents")
                  .upsert({
                    inquiry_id: matchResult.suggestedInquiryId,
                    product_name: aiExtracted.product || matchResult.candidates[0]?.product_name || "Chemical Item",
                    supplier_name: aiExtracted.make || fromName,
                    document_type: doc.documentType,
                    display_file_name: doc.filename,
                    original_file_name: doc.filename,
                    batch_number: doc.batchNumber,
                  }, { onConflict: "inquiry_id,document_type,display_file_name" })
                  .catch(() => {});
              }
            }
          }

          // 11. Preserve Traceability into email_inquiry_links
          if (matchResult.suggestedInquiryId && !matchResult.needsManualLink) {
            await adminClient
              .from("email_inquiry_links")
              .insert({
                gmail_message_id: ref.id,
                gmail_thread_id: ref.threadId,
                inquiry_id: matchResult.suggestedInquiryId,
                link_type: finalCategory === "PRICE RECEIVED" ? "source_reply" : "generic",
                source_reply_parser_run_at: new Date().toISOString(),
                parser_confidence: matchResult.confidence,
                created_by: callingUserId || connection.user_id,
              })
              .catch(() => {});
          }

          results.push({
            messageId: ref.id,
            threadId: ref.threadId,
            subject,
            from,
            date: dateStr,
            direction: aiExtracted.direction,
            category: finalCategory,
            summary: aiExtracted.summary,
            suggestedAction: aiExtracted.suggestedAction,
            confidence: matchResult.confidence,
            product: aiExtracted.product,
            make: aiExtracted.make,
            price: aiExtracted.price,
            currency: aiExtracted.currency,
            matchedInquiryId: matchResult.suggestedInquiryId,
            matchedInquiryNumber: matchResult.matchedInquiryNumber,
            aceerpNo: matchResult.aceerpNo,
            candidates: matchResult.candidates,
            suggestedInquiryId: matchResult.suggestedInquiryId,
            needsManualLink: matchResult.needsManualLink,
            alternativeMake,
            pricingRows: aiExtracted.pricingRows,
            documents: aiExtracted.detectedDocuments,
            evidence,
          });
        }

        // Update connection last_sync timestamp
        await adminClient
          .from("gmail_connections")
          .update({ last_sync: new Date().toISOString() })
          .eq("id", connection.id);

      } catch (connErr) {
        console.error(`Error scanning connection ${connection.id}:`, connErr);
      } finally {
        runningConnections.delete(connection.id);
      }
    }

    const duration = Date.now() - startTime;
    const nowIso = new Date().toISOString();
    const nextCheckIso = calculateNextCheckWIB();

    return json({
      success: true,
      scanned: totalScanned,
      pricing: pricingCount,
      documents: documentsCount,
      needs_review: needsReviewCount,
      no_action: noActionCount,
      last_checked: nowIso,
      next_check: nextCheckIso,
      duration_ms: duration,
      results,
    });
  } catch (error) {
    console.error("[sapj-gmail-agent] Execution failed:", error);
    return json({
      success: false,
      code: "AGENT_EXECUTION_FAILED",
      error: error instanceof Error ? error.message : "Unknown error",
      duration_ms: Date.now() - startTime,
    }, 500);
  }
});

function topCandidateRequestedMake(candidate: CandidateInquiry | null | undefined, offeredMake: string | null): boolean {
  if (!candidate || !offeredMake) return false;
  const requested = candidate.supplier_name || candidate.specification || "";
  if (!requested || requested.trim().length === 0) return false;
  return normalizeProduct(requested) !== normalizeProduct(offeredMake);
}
