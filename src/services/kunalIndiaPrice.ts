/**
 * Kunal Pricing — India inbound mail intelligence service.
 *
 * Thin orchestration layer over existing edge functions and services.
 * Wraps:
 *   - gmail-inbox-list        (list Kunal's recent Gmail)
 *   - gmail-inbox-message     (fetch full body per message)
 *   - classify-sourcing-email (AI classifier, India-focused filter applied client-side)
 *   - parse-source-reply-email via parseSourceReplyEmail() (extract pricing rows)
 *   - saveSourceReplyRow() via sourceReplyParser (persists to crm_inquiry_pricing_options
 *     and updates source_status/document_status — never touches purchase_price / offered_price)
 *
 * Does NOT:
 *   - touch quote_status / price_quoted / quote_sent_at
 *   - touch purchase_price / offered_price on crm_inquiries
 *   - auto-save anything (callers must confirm)
 *   - send any email
 *
 * Internal skill modules (helpers — not a new architecture):
 *   FullEmailReaderSkill          — fetch the full message body/HTML/attachments
 *   EmailRelevanceSkill           — Stage A LLM judge (kunal-relevance-classifier)
 *   EmailClassificationSkill      — Stage B AI extractor + India type mapping
 *   ProductInquiryMatchingSkill   — match the email to a CRM inquiry
 *   PriceExtractionSkill          — parse + save India price rows
 *   DocumentUnderstandingSkill    — recognise COA/MSDS/etc. and save to CRM
 *   PendingActionSkill            — derive Needs-Manual-Link / pending_review / no_action
 *   MemorySkill                   — persist + recall reviews via kunal_ai_email_reviews
 *
 * autoScanKunalInbox() composes these in order:
 *   FullEmailReaderSkill → EmailRelevanceSkill → EmailClassificationSkill →
 *   ProductInquiryMatchingSkill → PendingActionSkill → MemorySkill.
 */

import { supabase } from '../lib/supabase';
import {
  parseSourceReplyEmail,
  saveSourceReplyRow,
  findInquiryCandidatesWithContext,
  AUTO_SELECT_THRESHOLD,
  CANDIDATE_SHOW_THRESHOLD,
  type InquiryCandidate,
  type FindInquiryContext,
  type ParsedSourceRow,
  type SourceType,
} from './sourceReplyParser';

export type IndiaAiType =
  | 'India Price Received'
  | 'India Query / Missing Info'
  | 'Document / Certificate Received'
  | 'Alternative Source / Not Available'
  | 'No Action'
  | 'Needs Review';

export interface KunalGmailThreadMessage {
  messageId: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  date: string;
  snippet: string;
  body?: string;
  bodyHtml?: string;
  bodyText?: string;
  attachments?: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
}

export interface KunalGmailMessage {
  messageId: string;
  threadId: string | null;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  date: string;
  snippet: string;
  body?: string;        // existing plain-text body (kept for backwards compat)
  bodyHtml?: string;    // server-sanitized HTML (new — for Rich View)
  bodyText?: string;    // explicit plain-text body (new — for Plain View fallback)
  hasAttachments: boolean;
  attachments?: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
  /** Full thread when gmail-inbox-message is called with includeThread:true. */
  threadMessages?: KunalGmailThreadMessage[];
}

export interface KunalIndiaReviewRow extends KunalGmailMessage {
  aiType: IndiaAiType;
  product: string | null;
  matchedInquiryNumber: string | null;
  aceerpNo: string | null;
  summary: string;
  suggestedAction: string;
  confidence: number;
  extractedQuestion: string | null;
  documentType: 'COA' | 'MSDS' | 'COC' | 'GMP' | 'ISO' | 'DMF' | 'TDS' | 'SPEC' | 'CATALOGUE' | 'PRICE_LIST' | 'OTHER' | null;
  make: string | null;
  candidates: InquiryCandidate[];
  /** The top-scoring candidate (score >= 0.75). Shown as "Suggested" in UI. Never auto-saved. */
  suggestedInquiryId: string | null;
  /** User must explicitly select before Review & Save. Always null initially. */
  selectedInquiryId: string | null;
  /** True iff selectedInquiryId was set automatically from a clear-winner
   *  candidate (score >= threshold AND gap >= 0.20). Reversible via "Undo" in
   *  the UI. Never triggers an auto-save of prices or documents. */
  autoLinked: boolean;
  reviewed: boolean;
  needsManualLink: boolean;
  /** True iff multiple product-matched active inquiries exist with close scores. */
  hasMultipleSimilarCandidates: boolean;
  /** True iff this Gmail message has a row in kunal_ai_email_reviews. Mailbox
   *  mode shows messages even before they've been analyzed, in which case this
   *  is false and the UI renders an "Unanalyzed" badge. */
  analyzed: boolean;
}

export interface IndiaExtractionRow extends ParsedSourceRow {
  selectedInquiryId: string | null;
  suggestedInquiryId: string | null;
  candidates: InquiryCandidate[];
  saved: boolean;
  saveError: string | null;
  needsManualLink: boolean;
  hasMultipleSimilarCandidates: boolean;
}

const NEEDS_MANUAL_LINK_THRESHOLD = CANDIDATE_SHOW_THRESHOLD; // 0.45 — from sourceReplyParser

// "Actionable" India types — only these get Needs Manual Link treatment when
// no confident inquiry match exists. Everything else (No Action, Needs Review
// without signal) is filed away as no_action so normal mail (delivery
// schedule, follow-ups, payment receipts, newsletters) never shows up under
// Needs Manual Link.
const ACTIONABLE_INDIA_TYPES: ReadonlySet<IndiaAiType> = new Set<IndiaAiType>([
  'India Price Received',
  'Alternative Source / Not Available',
  'Document / Certificate Received',
  'India Query / Missing Info',
]);

// Relevance check — does the email mention pricing / sourcing / document
// signals? If not, it cannot be a Kunal Pricing / Source workflow email and
// must not become Needs Manual Link.
//
// NOTE: `offer` / `quotation` are intentionally NOT standalone signals here.
// Customer / sales reminders ("any update on the offer sent", "request update
// on offer") would otherwise leak into Needs Review just because the word
// "offer" appears. A real India price email will still hit on rate / INR / Rs.
// / ₹ / per kg / /kg / source / make / coa / msds / etc., so dropping `offer`
// from this regex is safe.
const RELEVANCE_RE = /(\b(inr|rs\.?|usd|eur|gbp|cny|idr|rate|price|quote|quoted|make|manufacturer|source|sourced|sourcing|availability|lead\s*time|moq|coa|msds|gmp|iso|dmf|spec|certificate|certif|attachment|not\s*available|alternative|alternate|inquiry|inq[-\s_]?\d|ac\s*erp|aceerp|sonal|india\s*office)\b|₹|\/kg|\/gm|per\s*kg|per\s*gm)/i;

// ── Direction guard ─────────────────────────────────────────────────────────
// Outbound customer quote detector. The LLM relevance classifier is the
// authoritative judge, but if it slips (e.g. "Folic Acid $144/kg + PPN" from
// our own sales team to a customer being tagged as India Price Received) we
// downgrade locally to No Action. This guard ONLY fires when there is strong
// evidence the latest visible email is OUR side quoting a customer — never
// downgrades a legitimate source-side reply.
//
// Strategy: look at From, To, the entire body (capturing signatures /
// forwarded headers / outbound-quote vocabulary). A match requires BOTH
//   (a) our-side identity (sapharmajaya.co.id sender, PT Shubham signature,
//       or a known outbound sales sender) AND
//   (b) outbound-quote vocabulary in the visible body (penawaran / we offer /
//       harga kami / our offer / please find our quotation / quoted to customer).
// Either alone is not enough.
const OUR_SIDE_IDENTITY_RE = /(@sapharmajaya\.co\.id|sapharmajaya|pt\s*shubham\s*anzen|shubham\s*anzen\s*pharma\s*jaya)/i;
const OUTBOUND_QUOTE_PHRASE_RE = /(berikut\s+saya\s+berikan\s+penawaran|penawaran\s+untuk\s+produk|harga\s+kami|kami\s+tawarkan|we\s+(?:are\s+pleased\s+to\s+)?(?:offer|quote)\b|our\s+offer\s+is|please\s+find\s+(?:attached\s+)?our\s+(?:offer|quotation)|kindly\s+find\s+attached\s+our\s+offer|quoted\s+to\s+customer|as\s+discussed\s+our\s+price)/i;

// Source-side identity — if present in From / forwarded-from / Cc, we should
// NOT downgrade even when our-side identity ALSO appears (which is common
// because Aanvi/Sonal forward emails through our company mailbox).
const SOURCE_SIDE_IDENTITY_RE = /(\bsonal\b|\baanvi\b|\banvi\b|@anvisourcing|india\s*office|source\s*team|forwarded\s*from\s*sonal|forwarded\s*from\s*aanvi|forwarded\s*from\s*anvi|supplier\s*rate|purchase\s*price|make\s*[:\-]|manufacturer\s*[:\-])/i;

interface OutboundQuoteContext {
  from: string;
  to: string;
  cc: string;
  body: string;
}

function looksLikeOutboundCustomerQuote(ctx: OutboundQuoteContext): boolean {
  const fromTo = `${ctx.from} ${ctx.to} ${ctx.cc}`;
  const body = ctx.body || '';
  // Trim quoted thread so we judge based on the LATEST visible message, not
  // an old forwarded body that may legitimately be a source price reply.
  const latest = body.split(/\n(?:on\s.+wrote:|-----original message-----|from:\s)/i)[0] || body;
  const hasOurIdentity =
    OUR_SIDE_IDENTITY_RE.test(fromTo) ||
    OUR_SIDE_IDENTITY_RE.test(latest);
  const hasOutboundPhrase = OUTBOUND_QUOTE_PHRASE_RE.test(latest);
  if (!hasOurIdentity || !hasOutboundPhrase) return false;
  // If the SAME visible block also carries clear source-side identity (Sonal /
  // Aanvi forward header, "supplier rate", "make: <x>"), don't downgrade —
  // that's a legitimate India source reply that happens to be forwarded
  // through our company mailbox.
  if (SOURCE_SIDE_IDENTITY_RE.test(latest)) return false;
  return true;
}

export interface KunalRelevance {
  actionable: boolean;
  category: IndiaAiType;
  reason: string;
  confidence: number;
  pricingActionNeeded: boolean;
  documentActionNeeded: boolean;
  extractedProduct: string | null;
  extractedPrice: string | null;
  extractedMake: string | null;
}

// ── Context extraction helpers ──────────────────────────────────────────────

/**
 * Extract forwarded subjects from email body.
 * Gmail prepends "Fwd:" or "FW:" to forwarded message subjects inside the body.
 */
function extractForwardedSubjects(body: string): string[] {
  const re = /(?:Fwd?|FW)\s*:\s*(.+)/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const s = m[1].trim();
    if (s && !matches.includes(s)) matches.push(s);
  }
  return matches;
}

/**
 * Crude extraction of customer/project name from an email subject line.
 * Looks for patterns like:
 *   "Sourcing - ALT 2026 - Product"    → "ALT 2026"
 *   "Re: CustomerName - Product"       → "CustomerName"
 *   "PERMINTAAN 04 MEI 2026"           → "PERMINTAAN"
 */
function extractSubjectContext(subject: string): string | null {
  // "Sourcing - PROJECT - Product"
  const sourcingMatch = subject.match(/Sourcing\s*[-–—]\s*([^-–—]+)/i);
  if (sourcingMatch) return sourcingMatch[1].trim();
  // "Re: CUSTOMER/PROJECT - ..."
  const reMatch = subject.match(/^(?:Re|Fwd?)\s*:\s*([^-–—\n]+)/i);
  if (reMatch) return reMatch[1].trim();
  return null;
}

/**
 * Try to find a customer/company name from email trail.
 * Checks the subject context, then email addresses for known patterns.
 */
function extractCustomerName(args: {
  subject: string;
  body: string;
  fromEmail?: string;
  toEmail?: string;
}): string | null {
  const ctx = extractSubjectContext(args.subject);
  if (ctx) return ctx;

  // Try to find "PT ..." or "CV ..." in the body
  const ptMatch = args.body.match(/\b(?:PT|CV|UD)\s+([A-Z][A-Za-z\s&]+?)(?:\s*[-–—]|\s*$|\s*\n|\s*<)/m);
  if (ptMatch) return `PT ${ptMatch[1].trim()}`;

  return null;
}

/**
 * Build the full FindInquiryContext from a review row + optional extraction result.
 */
function buildMatchContext(row: {
  subject: string;
  body?: string | null;
  bodyText?: string | null;
  from?: string;
  to?: string;
  cc?: string;
  product?: string | null;
  matchedInquiryNumber?: string | null;
  aceerpNo?: string | null;
  make?: string | null;
  threadId?: string | null;
  messageId?: string;
}, extractedProduct?: string | null, extractedInquiryNumber?: string | null, extractedAceerpNo?: string | null): FindInquiryContext {
  const bodyText = row.body || row.bodyText || '';
  const forwardedSubjects = extractForwardedSubjects(bodyText);
  const customerName = extractCustomerName({
    subject: row.subject,
    body: bodyText,
    fromEmail: row.from,
    toEmail: row.to,
  });

  // CAS number (e.g. 50-00-0) from subject/body — boost-only matching signal.
  const casMatch = `${row.subject} ${bodyText}`.match(/\b(\d{2,7}-\d{2}-\d)\b/);
  const cas = casMatch ? casMatch[1] : null;

  return {
    product_name: extractedProduct || row.product || undefined,
    inquiry_number: extractedInquiryNumber || row.matchedInquiryNumber || null,
    aceerp_no: extractedAceerpNo || row.aceerpNo || null,
    emailSubject: row.subject,
    emailBody: bodyText,
    forwardedSubjects: forwardedSubjects.length > 0 ? forwardedSubjects : undefined,
    customerName: customerName || undefined,
    make: row.make || null,
    cas,
    gmailThreadId: row.threadId || null,
    gmailMessageId: row.messageId || null,
  };
}

/**
 * Derive safety flags from scored candidates.
 *
 * - suggestedInquiryId: top candidate id iff score >= 0.75 AND the gap to #2
 *   is at least 0.20 (clear winner). Otherwise null.
 * - hasMultipleSimilarCandidates: true when >=2 candidates have product match
 *   and their scores are within 0.20 of each other.
 * - selectedInquiryId: always null — user must explicitly pick.
 */
function deriveCandidateSafety(candidates: InquiryCandidate[]): {
  suggestedInquiryId: string | null;
  hasMultipleSimilarCandidates: boolean;
} {
  if (candidates.length === 0) {
    return { suggestedInquiryId: null, hasMultipleSimilarCandidates: false };
  }

  const top = candidates[0];
  const second = candidates.length > 1 ? candidates[1] : null;
  const topGap = second ? top.score - second.score : 1.0;
  const isClearWinner = top.score >= AUTO_SELECT_THRESHOLD && topGap >= 0.20;

  // Multiple similar: >=2 candidates with product/reason signal within 0.20 of each other
  const productMatchedCandidates = candidates.filter(
    c => c.reasons.some(r => r.includes('Product') || r.includes('product'))
  );
  const hasMultipleSimilar =
    productMatchedCandidates.length >= 2 &&
    (productMatchedCandidates[0].score - productMatchedCandidates[productMatchedCandidates.length - 1].score) < 0.25;

  return {
    suggestedInquiryId: isClearWinner ? top.id : null,
    hasMultipleSimilarCandidates: hasMultipleSimilar,
  };
}

// ============================================================================
// EmailRelevanceSkill — Stage A (LLM final judge)
// Reads the FULL subject + body and asks gpt-4o-mini via
// kunal-relevance-classifier whether each email requires Kunal pricing action.
// The LLM verdict is authoritative — regex only acts as a cheap pre-filter
// before the LLM call. Non-actionable emails skip the AI extractor and the
// inquiry matcher entirely and are filed as No Action.
// ============================================================================

/**
 * Stage A — LLM relevance judge. Calls kunal-relevance-classifier with the
 * full message body and returns per-message verdicts. Falls back to a
 * conservative No Action verdict on transport / parse errors so junk mail
 * never escalates into Needs Manual Link.
 */
async function llmRelevanceClassify(messages: KunalGmailMessage[]): Promise<Map<string, KunalRelevance>> {
  const out = new Map<string, KunalRelevance>();
  if (messages.length === 0) return out;

  // Cheap pre-filter only: marketing / newsletter / verification-code mail
  // never reaches the LLM. shouldSkipEmail() handles this upstream, so by the
  // time we get here every message deserves an LLM read.
  const payload = messages.map(m => ({
    messageId: m.messageId,
    threadId: m.threadId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
    body: m.body || m.bodyText || m.snippet || '',
    hasAttachments: m.hasAttachments,
    attachments: (m.attachments || []).map(a => ({ filename: a.filename, mimeType: a.mimeType })),
  }));

  let results: Array<any> = [];
  const { data, error } = await supabase.functions.invoke('kunal-relevance-classifier', {
    body: { emails: payload },
  });
  if (error) {
    // Don't silently default to No Action — that would persist wrong status.
    // Let the caller decide (toast in autoScan, error in manual analyze).
    console.error('[kunal-relevance-classifier] invoke error:', error);
    throw new Error(`kunal-relevance-classifier invoke failed: ${error.message || 'unknown'}`);
  }
  if (!data?.success) {
    console.error('[kunal-relevance-classifier] non-success response:', data);
    throw new Error(`kunal-relevance-classifier failed: ${data?.error || data?.code || 'no success flag'}`);
  }
  results = Array.isArray(data.results) ? data.results : [];

  for (const r of results) {
    const id = String(r?.messageId || '');
    if (!id) continue;
    const rawCategory: string = String(r?.category || 'Needs Review');
    const category: IndiaAiType = ([
      'India Price Received',
      'India Query / Missing Info',
      'Document / Certificate Received',
      'Alternative Source / Not Available',
      'No Action',
      'Needs Review',
    ] as IndiaAiType[]).includes(rawCategory as IndiaAiType) ? (rawCategory as IndiaAiType) : 'Needs Review';
    const actionableRaw = typeof r?.actionable === 'boolean' ? r.actionable : category !== 'No Action';
    // Hard invariant: No Action ↔ not actionable. Stops the LLM from producing
    // an inconsistent verdict that the rest of the pipeline can't reason about.
    const actionable = category === 'No Action' ? false : actionableRaw;
    out.set(id, {
      actionable,
      category: actionable ? category : 'No Action',
      reason: String(r?.reason || '').slice(0, 220),
      confidence: typeof r?.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.5,
      pricingActionNeeded: !!r?.pricing_action_needed,
      documentActionNeeded: !!r?.document_action_needed,
      extractedProduct: r?.extracted_product ? String(r.extracted_product) : null,
      extractedPrice: r?.extracted_price ? String(r.extracted_price) : null,
      extractedMake: r?.extracted_make ? String(r.extracted_make) : null,
    });
  }

  // Ensure every input gets a verdict (LLM occasionally drops rows).
  for (const m of messages) {
    if (!out.has(m.messageId)) {
      out.set(m.messageId, {
        actionable: false,
        category: 'No Action',
        reason: 'No verdict returned; defaulted to No Action.',
        confidence: 0.4,
        pricingActionNeeded: false,
        documentActionNeeded: false,
        extractedProduct: null,
        extractedPrice: null,
        extractedMake: null,
      });
    }
  }

  // Direction guard — downgrade outbound customer quotes that the LLM may
  // have wrongly tagged as actionable (e.g. "Folic Acid $144/kg + PPN" from
  // our own sales team to a customer). Runs after every input has a verdict
  // so we never miss one.
  for (const m of messages) {
    const v = out.get(m.messageId);
    if (!v || !v.actionable) continue;
    const isOutbound = looksLikeOutboundCustomerQuote({
      from: m.from || '',
      to: m.to || '',
      cc: m.cc || '',
      body: m.body || m.bodyText || m.snippet || '',
    });
    if (!isOutbound) continue;
    out.set(m.messageId, {
      ...v,
      actionable: false,
      category: 'No Action',
      reason: 'Outbound customer quote from our sales team — not a source-side price reply.',
      pricingActionNeeded: false,
      documentActionNeeded: false,
    });
  }
  return out;
}

// ============================================================================
// FullEmailReaderSkill — Stage 0
// Wraps gmail-inbox-message to retrieve the FULL message body (HTML + text +
// attachments). Classification must always work off the full body, never the
// list snippet, so subsequent skills get the real context.
// ============================================================================

async function readFullMessage(messageId: string, fallback: KunalGmailMessage): Promise<KunalGmailMessage> {
  const { data } = await supabase.functions.invoke('gmail-inbox-message', {
    body: { messageId },
  });
  return {
    ...fallback,
    cc: data?.message?.cc || '',
    body: data?.message?.body || fallback.snippet,
    bodyHtml: data?.message?.bodyHtml || '',
    bodyText: data?.message?.bodyText || data?.message?.body || '',
    attachments: data?.message?.attachments || [],
    hasAttachments: data?.message?.hasAttachments ?? fallback.hasAttachments,
  };
}

// ============================================================================
// (low-level filter helpers)
// ============================================================================

// Mirror SourcingOutbox.shouldSkipEmail — filter clearly non-business mail.
function shouldSkipEmail(m: KunalGmailMessage): boolean {
  const hay = `${m.from} ${m.subject} ${m.snippet} ${m.body || ''}`.toLowerCase();
  return ['google flights', 'bank ', 'newsletter', 'verification code', 'verify your', 'feedback@', 'marketing', 'promotion', 'unsubscribe']
    .some(t => hay.includes(t));
}

// India-priority scoring — prefer Sonal / India senders and pricing keywords.
function indiaPriority(m: KunalGmailMessage): number {
  const hay = `${m.from} ${m.to || ''} ${m.subject} ${m.snippet} ${m.body || ''}`.toLowerCase();
  let score = 0;
  ['sonal', 'india office', 'shubham', 'kunal'].forEach(t => { if (hay.includes(t)) score += 6; });
  ['inr', 'rs.', 'rs ', '₹', '/kg', '/gm', 'per kg', 'india price', 'source price'].forEach(t => { if (hay.includes(t)) score += 4; });
  ['coa', 'msds', 'gmp', 'iso', 'dmf', 'certificate', 'spec sheet'].forEach(t => { if (hay.includes(t)) score += 3; });
  ['inquiry', 'inq-', 'ac erp', 'make', 'manufacturer', 'availability', 'lead time'].forEach(t => { if (hay.includes(t)) score += 2; });
  if (m.hasAttachments) score += 3;
  return score;
}

// ============================================================================
// EmailClassificationSkill — Stage B
// Wraps the existing classify-sourcing-email edge function (AI extractor) and
// maps its 6 sourcing types to the 6 Kunal-specific India types. Only invoked
// on messages that EmailRelevanceSkill marked as actionable.
// ============================================================================

// Map classifier output (6 sourcing types) to the 6 India-specific types Kunal wants.
// If the classifier is unsure ("Needs Review") and the body has no pricing /
// sourcing / document signal, downgrade to "No Action" so normal mail (delivery
// schedule, follow-up, payment) is filed away instead of polluting Kunal's queue.
function mapToIndiaAiType(
  classifierType: string | null | undefined,
  documentType: string | null,
  bodyHay: string,
): IndiaAiType {
  if (classifierType === 'Document / Certificate Received' || (documentType && documentType !== 'OTHER')) {
    return 'Document / Certificate Received';
  }
  if (classifierType === 'Supplier Price Reply') {
    if (/\b(not\s+available|out of stock|n\.?a\.?|cannot offer|alternative|alternate)\b/i.test(bodyHay)) {
      return 'Alternative Source / Not Available';
    }
    return 'India Price Received';
  }
  if (classifierType === 'India Office Query / Revert Needed') {
    return 'India Query / Missing Info';
  }
  if (classifierType === 'General / No Action' || classifierType === 'Customer Inquiry') {
    return 'No Action';
  }
  // Default fall-through: only keep as Needs Review if there is some India signal.
  return RELEVANCE_RE.test(bodyHay) ? 'Needs Review' : 'No Action';
}

export interface ScanOptions {
  query?: string;        // Gmail search string. Defaults to a Sonal/India-focused query.
  maxResults?: number;   // 1..100. Default 25.
}

export interface ScanResult {
  rows: KunalIndiaReviewRow[];
  totalScanned: number;
}

/**
 * Scan Kunal's connected Gmail inbox for India price emails.
 * Returns classified, candidate-matched rows ready for review.
 */
export async function scanKunalIndiaInbox(opts: ScanOptions = {}): Promise<ScanResult> {
  const query = opts.query?.trim() || 'newer_than:30d';
  const maxResults = Math.max(1, Math.min(100, opts.maxResults || 25));

  // 1. List messages
  const { data: listData, error: listErr } = await supabase.functions.invoke('gmail-inbox-list', {
    body: { query, maxResults },
  });
  if (listErr || !listData?.success) {
    const code = listData?.code || '';
    if (code === 'NO_GMAIL_CONNECTED') throw new Error('No Gmail connected. Connect Gmail in Settings first.');
    throw new Error(listData?.error || listErr?.message || 'Could not scan Gmail.');
  }

  const list = ((listData.messages || []) as KunalGmailMessage[]).slice(0, maxResults);
  if (list.length === 0) return { rows: [], totalScanned: 0 };

  // 2. Fetch full bodies in parallel
  const fullMessages = await Promise.all(list.map(async msg => {
    const { data } = await supabase.functions.invoke('gmail-inbox-message', {
      body: { messageId: msg.messageId },
    });
    return {
      ...msg,
      cc: data?.message?.cc || '',
      body: data?.message?.body || msg.snippet,
      bodyHtml: data?.message?.bodyHtml || '',
      bodyText: data?.message?.bodyText || data?.message?.body || '',
      attachments: data?.message?.attachments || [],
      hasAttachments: data?.message?.hasAttachments ?? msg.hasAttachments,
    } as KunalGmailMessage;
  }));

  // 3. Filter and prioritize for India relevance
  const messages = fullMessages
    .filter(m => !shouldSkipEmail(m))
    .sort((a, b) => indiaPriority(b) - indiaPriority(a))
    .slice(0, maxResults);

  if (messages.length === 0) return { rows: [], totalScanned: fullMessages.length };

  // 4a. Stage A — LLM relevance judge over the FULL body. The LLM is the final
  //     authority; only its actionable=true messages reach Stage B / inquiry
  //     matching. Everything else is filed as No Action.
  const relevanceByMessage = await llmRelevanceClassify(messages);
  const actionablePool: KunalGmailMessage[] = [];
  const noActionPool: KunalGmailMessage[] = [];
  for (const m of messages) {
    const r = relevanceByMessage.get(m.messageId)!;
    (r.actionable ? actionablePool : noActionPool).push(m);
  }

  // 4b. Stage B: AI extractor (only on actionable pool).
  const classified: Array<{
    messageId: string;
    aiType?: string;
    product?: string | null;
    matchedInquiryNumber?: string | null;
    aceerpNo?: string | null;
    summary?: string;
    suggestedAction?: string;
    confidence?: number;
    extractedQuestion?: string | null;
    documentType?: 'COA' | 'MSDS' | 'COC' | 'GMP' | 'ISO' | 'DMF' | 'TDS' | 'SPEC' | 'CATALOGUE' | 'PRICE_LIST' | 'OTHER' | null;
    make?: string | null;
    sourceTypeHint?: SourceType;
  }> = [];
  if (actionablePool.length > 0) {
    const { data: classifyData, error: classifyErr } = await supabase.functions.invoke('classify-sourcing-email', {
      body: { emails: actionablePool },
    });
    if (classifyErr || !classifyData?.success) {
      throw new Error(classifyData?.error || classifyErr?.message || 'AI classification failed.');
    }
    classified.push(...((classifyData.results || []) as any[]));
  }
  for (const m of noActionPool) {
    const r = relevanceByMessage.get(m.messageId)!;
    classified.push({
      messageId: m.messageId,
      aiType: 'General / No Action',
      summary: r.reason,
      suggestedAction: 'No Kunal pricing action needed.',
      confidence: r.confidence,
      product: null,
      matchedInquiryNumber: null,
      aceerpNo: null,
      documentType: null,
      make: null,
    });
  }

  // 5. Match candidates per message (only for actionable ones)
  const rows = await Promise.all(messages.map(async msg => {
    const result = classified.find(c => c.messageId === msg.messageId);
    const relevance = relevanceByMessage.get(msg.messageId)!;
    const matchCtx = buildMatchContext(
      msg,
      result?.product || relevance.extractedProduct,
      result?.matchedInquiryNumber || null,
      result?.aceerpNo || null,
    );
    const candidates = relevance.actionable
      ? await findInquiryCandidatesWithContext(matchCtx)
      : [];
    // LLM verdict wins for the final aiType. Stage B's mapping is kept only as
    // a fallback when the LLM verdict is Needs Review and Stage B has a stronger signal.
    const aiType: IndiaAiType = relevance.actionable
      ? (relevance.category !== 'Needs Review'
          ? relevance.category
          : mapToIndiaAiType(result?.aiType, result?.documentType || null, `${msg.subject} ${msg.body || ''}`))
      : 'No Action';
    const confidence = relevance.actionable
      ? (typeof result?.confidence === 'number' ? result.confidence : relevance.confidence)
      : relevance.confidence;
    // Needs Manual Link based on candidate score (not parser confidence).
    // Actionable mail without a confident match OR score below threshold.
    const isActionable = relevance.actionable && ACTIONABLE_INDIA_TYPES.has(aiType);
    const topScore = candidates[0]?.score ?? 0;
    const needsManualLink = isActionable && (!candidates[0] || topScore < CANDIDATE_SHOW_THRESHOLD);
    const safety = deriveCandidateSafety(candidates);
    return {
      ...msg,
      aiType,
      product: result?.product || relevance.extractedProduct || null,
      matchedInquiryNumber: result?.matchedInquiryNumber || candidates[0]?.inquiry_number || null,
      aceerpNo: result?.aceerpNo || candidates[0]?.aceerp_no || null,
      summary: (relevance.actionable ? (result?.summary || msg.snippet) : relevance.reason) || '-',
      suggestedAction: relevance.actionable
        ? (result?.suggestedAction || 'Review this email.')
        : 'No Kunal pricing action needed.',
      confidence,
      extractedQuestion: result?.extractedQuestion || null,
      documentType: result?.documentType || null,
      make: result?.make || relevance.extractedMake || null,
      candidates,
      suggestedInquiryId: safety.suggestedInquiryId,
      selectedInquiryId: safety.suggestedInquiryId, // Part 8: auto-link clear winner (reversible)
      autoLinked: !!safety.suggestedInquiryId,
      reviewed: false,
      needsManualLink,
      hasMultipleSimilarCandidates: safety.hasMultipleSimilarCandidates,
      analyzed: true,
    } as KunalIndiaReviewRow;
  }));

  return { rows, totalScanned: fullMessages.length };
}

// ============================================================================
// PriceExtractionSkill
// Extracts editable price rows from an actionable India price email and saves
// them to crm_inquiry_pricing_options. Never auto-saves; the UI requires a
// Review & Save click.
// ============================================================================

/**
 * Run the parse-source-reply-email extractor on a single review row.
 * Returns editable IndiaExtractionRow[] for the UI to display.
 */
export async function analyzeIndiaPriceEmail(row: KunalIndiaReviewRow): Promise<IndiaExtractionRow[]> {
  const result = await parseSourceReplyEmail({
    emailSubject: row.subject,
    emailBody: row.body || row.snippet,
    fromEmail: row.from,
    receivedAt: row.date,
    gmailMessageId: row.messageId,
    gmailThreadId: row.threadId,
    sourceTypeHint: 'india',
  });
  if (!result.success) throw new Error(result.error || 'Source reply extraction failed.');

  const out = await Promise.all(result.rows.map(async parsed => {
    const matchCtx = buildMatchContext(
      row,
      parsed.product_name || row.product || undefined,
      parsed.inquiry_number || row.matchedInquiryNumber,
      parsed.aceerp_no || row.aceerpNo,
    );
    const candidates = await findInquiryCandidatesWithContext(matchCtx);
    const topScore = candidates[0]?.score ?? 0;
    const safety = deriveCandidateSafety(candidates);
    const needsManualLink = !candidates[0] || topScore < CANDIDATE_SHOW_THRESHOLD;
    // If the user already selected an inquiry in the main section, inherit it.
    // Also keep it if the selected inquiry appears in the candidate list.
    const inheritedId = row.selectedInquiryId &&
      candidates.some(c => c.id === row.selectedInquiryId)
      ? row.selectedInquiryId
      : null;
    return {
      ...parsed,
      selectedInquiryId: inheritedId || safety.suggestedInquiryId || null,
      suggestedInquiryId: safety.suggestedInquiryId,
      candidates,
      saved: false,
      saveError: null,
      needsManualLink,
      hasMultipleSimilarCandidates: safety.hasMultipleSimilarCandidates,
    } as IndiaExtractionRow;
  }));

  return out;
}

export interface SaveOptions {
  actorId: string | null;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
}

/**
 * Save a reviewed India extraction row to crm_inquiry_pricing_options.
 * Delegates to saveSourceReplyRow with source_type='india' — that writer:
 *   - inserts crm_inquiry_pricing_options (is_selected = false)
 *   - updates crm_inquiries.source_status (received/partial/unavailable) + document_status
 *   - keeps kunal_price_status='pending' (Kunal must enter his price manually)
 *   - inserts email_inquiry_links (link_type='source_reply')
 * Never touches purchase_price / offered_price / quote_status.
 */
export async function saveIndiaPriceExtraction(
  row: IndiaExtractionRow,
  opts: SaveOptions,
): Promise<{ ok: boolean; error?: string }> {
  if (!row.selectedInquiryId) return { ok: false, error: 'No inquiry selected — manual link required.' };
  return saveSourceReplyRow({
    inquiryId: row.selectedInquiryId,
    sourceType: 'india',
    row,
    gmailMessageId: opts.gmailMessageId,
    gmailThreadId: opts.gmailThreadId,
    parserConfidence: row.confidence,
    actorId: opts.actorId,
  });
}

// ============================================================================
// DocumentUnderstandingSkill
// Lets Kunal view/download a Gmail attachment, classify it as a doc type
// (COA/MSDS/GMP/ISO/DMF/SPEC/TDS/MHD/COC/OTHER), and persist it to
// crm_product_documents linked to the matched inquiry.
// ============================================================================

export interface FetchAttachmentArgs {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType?: string;
  disposition?: 'inline' | 'attachment';
}

/**
 * Fetch a Gmail attachment as a blob URL for preview or download.
 * Never persists anything — temporary preview only.
 * Caller must URL.revokeObjectURL(url) when done to free memory.
 */
export async function fetchAttachmentBlob(
  args: FetchAttachmentArgs,
): Promise<{ ok: boolean; url?: string; blob?: Blob; error?: string }> {
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) return { ok: false, error: 'Not signed in.' };

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const params = new URLSearchParams({
    messageId: args.messageId,
    attachmentId: args.attachmentId,
    filename: args.filename,
    disposition: args.disposition || 'inline',
  });
  if (args.mimeType) params.set('mimeType', args.mimeType);

  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}/functions/v1/gmail-attachment-view?${params.toString()}`, {
      headers: { Authorization: `Bearer ${session.session.access_token}` },
    });
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error.' };
  }
  if (!resp.ok) {
    let code = `HTTP ${resp.status}`;
    try {
      const errBody = await resp.json();
      code = errBody?.code || errBody?.error || code;
    } catch { /* not JSON */ }
    return { ok: false, error: code };
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  return { ok: true, url, blob };
}

export interface SaveDocumentArgs {
  messageId: string;
  threadId: string | null;
  attachmentId: string;
  originalFileName: string;
  mimeType?: string;
  inquiryId: string;
  productName: string;
  make?: string | null;
  documentType: 'COA' | 'MSDS' | 'MHD' | 'TDS' | 'SPEC' | 'COC' | 'GMP' | 'ISO' | 'DMF' | 'CATALOGUE' | 'PRICE_LIST' | 'OTHER';
  sourceEmailSubject?: string | null;
  displayFileName?: string;
}

/**
 * Save a Gmail attachment to crm-documents bucket and crm_product_documents.
 * Wrapper over gmail-attachment-save edge function. Caller must confirm.
 */
export async function saveIndiaDocument(
  args: SaveDocumentArgs,
): Promise<{ ok: boolean; documentId?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke('gmail-attachment-save', {
    body: args,
  });
  if (error || !data?.success) {
    return { ok: false, error: data?.error || error?.message || 'Document save failed.' };
  }
  return { ok: true, documentId: data?.document?.id };
}

// ============================================================================
// MemorySkill — kunal_ai_email_reviews
// Persistent memory for the auto mailbox. Lets us skip already-scanned
// messages on next open, replay past classifications, and clean up rows that
// were historically mis-tagged before this Stage-A gate existed.
// ============================================================================

export type ReviewActionStatus =
  | 'pending_review'
  | 'price_saved'
  | 'document_saved'
  | 'no_action'
  | 'needs_manual_link';

export interface PersistedReview {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  from_email: string | null;
  subject: string | null;
  email_date: string | null;
  ai_type: IndiaAiType | null;
  product_name: string | null;
  offered_make: string | null;
  source_price: number | null;
  source_currency: string | null;
  matched_inquiry_id: string | null;
  confidence: number | null;
  summary: string | null;
  suggested_action: string | null;
  has_attachments: boolean;
  action_status: ReviewActionStatus;
  raw_result: unknown;
  scanned_at: string;
  updated_at: string;
}

/** Load recently scanned reviews (newest first). */
export async function getRecentReviews(limit = 200): Promise<PersistedReview[]> {
  const { data, error } = await supabase
    .from('kunal_ai_email_reviews')
    .select('*')
    .order('email_date', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data || []) as PersistedReview[];
}

/** Get the set of gmail_message_ids that were already scanned. */
export async function getScannedMessageIds(messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const { data } = await supabase
    .from('kunal_ai_email_reviews')
    .select('gmail_message_id')
    .in('gmail_message_id', messageIds);
  return new Set((data || []).map((r: any) => r.gmail_message_id));
}

/** Persist a freshly classified review row. Idempotent on gmail_message_id. */
export async function upsertReview(row: KunalIndiaReviewRow, actorId: string | null): Promise<void> {
  // action_status priority:
  //   1. 'No Action' aiType => 'no_action' (irrelevant mail must not pile up in queue)
  //   2. actionable + no confident candidate => 'needs_manual_link'
  //   3. otherwise => 'pending_review'
  let action_status: ReviewActionStatus;
  if (row.aiType === 'No Action') action_status = 'no_action';
  else if (row.needsManualLink) action_status = 'needs_manual_link';
  else action_status = 'pending_review';

  const payload = {
    gmail_message_id: row.messageId,
    gmail_thread_id: row.threadId,
    from_email: row.from,
    subject: row.subject,
    email_date: row.date ? new Date(row.date).toISOString() : null,
    ai_type: row.aiType,
    product_name: row.product,
    offered_make: row.make,
    matched_inquiry_id: row.selectedInquiryId,
    confidence: row.confidence,
    summary: row.summary,
    suggested_action: row.suggestedAction,
    has_attachments: row.hasAttachments,
    action_status,
    raw_result: {
      matchedInquiryNumber: row.matchedInquiryNumber,
      aceerpNo: row.aceerpNo,
      documentType: row.documentType,
      extractedQuestion: row.extractedQuestion,
      suggestedInquiryId: row.suggestedInquiryId,
      hasMultipleSimilarCandidates: row.hasMultipleSimilarCandidates,
      candidates: row.candidates.map(c => ({
        id: c.id,
        inquiry_number: c.inquiry_number,
        product_name: c.product_name,
        company_name: c.company_name,
        score: c.score,
        reasons: c.reasons,
        email_subject: c.email_subject,
        mail_subject: c.mail_subject,
      })),
    },
    scanned_by: actorId,
  };
  await supabase
    .from('kunal_ai_email_reviews')
    .upsert(payload, { onConflict: 'gmail_message_id' });
}

/**
 * Cleanup pass — fix the historical mistake where non-actionable emails were
 * persisted with action_status='needs_manual_link'. Any row whose ai_type is
 * NOT in the actionable allowlist is downgraded to ('no_action', 'No Action').
 *
 * Safe to run repeatedly; idempotent. Returns the number of rows updated.
 */
export async function cleanupMisclassifiedReviews(): Promise<{ updated: number }> {
  const { data, error } = await supabase
    .from('kunal_ai_email_reviews')
    .select('id, ai_type')
    .eq('action_status', 'needs_manual_link');
  if (error || !data || data.length === 0) return { updated: 0 };

  const actionable: ReadonlySet<string> = ACTIONABLE_INDIA_TYPES as ReadonlySet<string>;
  const badIds = (data as Array<{ id: string; ai_type: string | null }>)
    .filter(r => !r.ai_type || !actionable.has(r.ai_type))
    .map(r => r.id);

  if (badIds.length === 0) return { updated: 0 };

  const { error: upErr } = await supabase
    .from('kunal_ai_email_reviews')
    .update({ action_status: 'no_action', ai_type: 'No Action' })
    .in('id', badIds);
  if (upErr) return { updated: 0 };
  return { updated: badIds.length };
}

/**
 * LLM-driven re-classification of persisted suspect rows. Targets rows
 * currently filed as needs_manual_link or pending_review whose ai_type is
 * not actionable — fetches the full Gmail body, asks the LLM judge, and
 * downgrades to No Action when actionable=false.
 *
 * Capped at `limit` rows per Rescan All to keep OpenAI cost bounded. Returns
 * the count of rows downgraded. Safe and idempotent.
 */
export async function llmReclassifyPersistedSuspects(limit = 40): Promise<{ updated: number }> {
  const actionableTypes = Array.from(ACTIONABLE_INDIA_TYPES);
  // Pull persisted rows that look suspect: marked needs_manual_link/pending_review
  // and ai_type is not in the actionable allowlist (so they may have been
  // mis-tagged by the older regex-only pipeline).
  const { data: rows, error } = await supabase
    .from('kunal_ai_email_reviews')
    .select('id, gmail_message_id, subject, ai_type, action_status')
    .in('action_status', ['needs_manual_link', 'pending_review'])
    .not('ai_type', 'in', `(${actionableTypes.map(t => `"${t}"`).join(',')})`)
    .order('email_date', { ascending: false })
    .limit(limit);
  if (error || !rows || rows.length === 0) return { updated: 0 };

  // FullEmailReaderSkill — fetch full body for each suspect, then run the LLM.
  const messages: KunalGmailMessage[] = [];
  for (const r of rows as Array<{ id: string; gmail_message_id: string; subject: string | null }>) {
    try {
      const m = await readFullMessage(r.gmail_message_id, {
        messageId: r.gmail_message_id,
        threadId: null,
        from: '',
        subject: r.subject || '',
        date: '',
        snippet: '',
        hasAttachments: false,
      });
      messages.push(m);
    } catch { /* skip unreachable messages */ }
  }
  if (messages.length === 0) return { updated: 0 };

  const verdicts = await llmRelevanceClassify(messages);
  const idByMessageId = new Map((rows as Array<{ id: string; gmail_message_id: string }>).map(r => [r.gmail_message_id, r.id]));

  const downgradeIds: string[] = [];
  for (const [messageId, v] of verdicts.entries()) {
    if (!v.actionable) {
      const id = idByMessageId.get(messageId);
      if (id) downgradeIds.push(id);
    }
  }
  if (downgradeIds.length === 0) return { updated: 0 };

  const { error: upErr } = await supabase
    .from('kunal_ai_email_reviews')
    .update({ action_status: 'no_action', ai_type: 'No Action' })
    .in('id', downgradeIds);
  if (upErr) return { updated: 0 };
  return { updated: downgradeIds.length };
}

/** Update review action status (price_saved / document_saved / no_action / needs_manual_link). */
export async function updateReviewStatus(
  gmailMessageId: string,
  next: ReviewActionStatus,
  patch?: { matched_inquiry_id?: string | null; source_price?: number | null; source_currency?: string | null; offered_make?: string | null },
): Promise<void> {
  await supabase
    .from('kunal_ai_email_reviews')
    .update({ action_status: next, ...(patch || {}) })
    .eq('gmail_message_id', gmailMessageId);
}

/** Hydrate persisted reviews back into in-memory KunalIndiaReviewRow shape for the queue UI. */
export function hydrateReviewAsRow(p: PersistedReview, fullMessage: Partial<KunalGmailMessage> | null): KunalIndiaReviewRow {
  const raw = (p.raw_result || {}) as any;
  return {
    messageId: p.gmail_message_id,
    threadId: p.gmail_thread_id,
    from: p.from_email || '',
    subject: p.subject || '(No Subject)',
    date: p.email_date || '',
    snippet: p.summary || '',
    body: fullMessage?.body,
    bodyHtml: fullMessage?.bodyHtml,
    bodyText: fullMessage?.bodyText,
    hasAttachments: p.has_attachments,
    attachments: fullMessage?.attachments,
    aiType: (p.ai_type as IndiaAiType) || 'Needs Review',
    product: p.product_name,
    matchedInquiryNumber: raw.matchedInquiryNumber || null,
    aceerpNo: raw.aceerpNo || null,
    summary: p.summary || '-',
    suggestedAction: p.suggested_action || 'Review this email.',
    confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
    extractedQuestion: raw.extractedQuestion || null,
    documentType: raw.documentType || null,
    make: p.offered_make,
    candidates: Array.isArray(raw.candidates) ? raw.candidates.map((c: any) => ({
      id: c.id,
      inquiry_number: c.inquiry_number,
      aceerp_no: '',
      product_name: c.product_name,
      specification: null,
      company_name: c.company_name || '',
      source_status: '',
      score: typeof c.score === 'number' ? c.score : 0,
      reasons: Array.isArray(c.reasons) ? c.reasons : [],
      email_subject: c.email_subject || null,
      mail_subject: c.mail_subject || null,
    })) : [],
    suggestedInquiryId: raw.suggestedInquiryId || null,
    // Restore a persisted auto/manual link so it survives reload; still fully
    // reversible in the UI. Only restore when it matches a known candidate.
    selectedInquiryId: (p.matched_inquiry_id && (Array.isArray(raw.candidates) ? raw.candidates.some((c: any) => c.id === p.matched_inquiry_id) : false))
      ? p.matched_inquiry_id : null,
    autoLinked: !!(p.matched_inquiry_id && p.matched_inquiry_id === (raw.suggestedInquiryId || null)),
    reviewed: p.action_status !== 'pending_review' && p.action_status !== 'needs_manual_link',
    // No Action rows can never be Needs Manual Link, even if matched_inquiry_id is null.
    needsManualLink: p.action_status === 'needs_manual_link' && p.ai_type !== 'No Action',
    hasMultipleSimilarCandidates: !!raw.hasMultipleSimilarCandidates,
    analyzed: true,
  };
}

// ============================================================================
// Orchestrator
// Composes the skill modules in order:
//   MemorySkill (cleanup) → FullEmailReaderSkill → EmailRelevanceSkill →
//   EmailClassificationSkill → ProductInquiryMatchingSkill →
//   PendingActionSkill → MemorySkill (persist).
// ============================================================================

/**
 * Auto-mailbox scan: fetch recent Gmail, skip messages already in
 * kunal_ai_email_reviews unless force=true, classify only the new ones,
 * persist the new reviews, and return the merged in-memory list.
 */
export async function autoScanKunalInbox(opts: {
  query?: string;
  maxResults?: number;
  force?: boolean;
  actorId: string | null;
}): Promise<ScanResult & { cleanedUp: number }> {
  const query = opts.query?.trim() || 'newer_than:30d';
  const maxResults = Math.max(1, Math.min(100, opts.maxResults || 50));

  // Force = clean up historically mis-tagged rows AND ask the LLM to re-judge
  // suspect persisted rows (the older regex-only pipeline let normal delivery /
  // shipping / customer mail end up in Needs Manual Link). Both passes are
  // idempotent.
  let cleanedUp = 0;
  if (opts.force) {
    try {
      const r1 = await cleanupMisclassifiedReviews();
      cleanedUp += r1.updated;
    } catch { /* non-critical */ }
    try {
      const r2 = await llmReclassifyPersistedSuspects(40);
      cleanedUp += r2.updated;
    } catch { /* non-critical */ }
  }

  const { data: listData, error: listErr } = await supabase.functions.invoke('gmail-inbox-list', {
    body: { query, maxResults },
  });
  if (listErr || !listData?.success) {
    const code = listData?.code || '';
    if (code === 'NO_GMAIL_CONNECTED') throw new Error('No Gmail connected. Connect Gmail in Settings first.');
    throw new Error(listData?.error || listErr?.message || 'Could not scan Gmail.');
  }
  const list = ((listData.messages || []) as KunalGmailMessage[]).slice(0, maxResults);
  if (list.length === 0) return { rows: [], totalScanned: 0, cleanedUp };

  // Skip already-scanned messages unless force=true.
  const allIds = list.map(m => m.messageId);
  const alreadyScanned = opts.force ? new Set<string>() : await getScannedMessageIds(allIds);
  const toFetch = list.filter(m => !alreadyScanned.has(m.messageId));

  // 1. For unprocessed messages, fetch full bodies + classify.
  let freshRows: KunalIndiaReviewRow[] = [];
  if (toFetch.length > 0) {
    // FullEmailReaderSkill: pull the entire message body/HTML/attachments for
    // every candidate before any classification happens.
    const fullMessages = await Promise.all(toFetch.map(msg => readFullMessage(msg.messageId, msg)));

    const filtered = fullMessages
      .filter(m => !_shouldSkipEmail(m))
      .sort((a, b) => _indiaPriority(b) - _indiaPriority(a));

    if (filtered.length > 0) {
      // EmailRelevanceSkill (Stage A) — LLM final judge over the FULL body.
      // gpt-4o-mini reads each email end-to-end and decides whether Kunal
      // needs to take a pricing action. Its verdict is authoritative; regex
      // never overrides it. Only actionable=true mail reaches Stage B and the
      // inquiry matcher.
      const relevanceByMessage = await llmRelevanceClassify(filtered);
      const actionablePool: KunalGmailMessage[] = [];
      const noActionPool: KunalGmailMessage[] = [];
      for (const m of filtered) {
        const r = relevanceByMessage.get(m.messageId)!;
        (r.actionable ? actionablePool : noActionPool).push(m);
      }

      // EmailClassificationSkill (Stage B): AI extractor — only actionable mail.
      const classified: Array<any> = [];
      if (actionablePool.length > 0) {
        const { data: classifyData, error: classifyErr } = await supabase.functions.invoke('classify-sourcing-email', {
          body: { emails: actionablePool },
        });
        if (classifyErr || !classifyData?.success) {
          throw new Error(classifyData?.error || classifyErr?.message || 'AI classification failed.');
        }
        classified.push(...((classifyData.results || []) as Array<any>));
      }
      // Synthesize No Action results for messages that failed Stage A — they
      // never touch the AI extractor at all.
      for (const m of noActionPool) {
        const r = relevanceByMessage.get(m.messageId)!;
        classified.push({
          messageId: m.messageId,
          aiType: 'General / No Action',
          summary: r.reason,
          suggestedAction: 'No Kunal pricing action needed.',
          confidence: r.confidence,
          product: null,
          matchedInquiryNumber: null,
          aceerpNo: null,
          documentType: null,
          make: null,
        });
      }

      freshRows = await Promise.all(filtered.map(async msg => {
        const result = classified.find(c => c.messageId === msg.messageId);
        const relevance = relevanceByMessage.get(msg.messageId)!;
        // ProductInquiryMatchingSkill: only run for LLM-actionable messages.
        // No Action mail must never surface under any pricing tracker card.
        const matchCtx = buildMatchContext(
          msg,
          result?.product || relevance.extractedProduct,
          result?.matchedInquiryNumber || null,
          result?.aceerpNo || null,
        );
        const candidates = relevance.actionable
          ? await findInquiryCandidatesWithContext(matchCtx)
          : [];
        // LLM verdict is authoritative for actionability and category. Stage B's
        // mapping is only used when the LLM said actionable=true but landed on
        // Needs Review — in that case Stage B may have a more specific signal.
        const aiType: IndiaAiType = relevance.actionable
          ? (relevance.category !== 'Needs Review'
              ? relevance.category
              : _mapToIndiaAiType(result?.aiType, result?.documentType || null, `${msg.subject} ${msg.body || ''}`))
          : 'No Action';
        const confidence = relevance.actionable
          ? (typeof result?.confidence === 'number' ? result.confidence : relevance.confidence)
          : relevance.confidence;
        // PendingActionSkill: Needs Manual Link when no candidate or score below threshold.
        const isActionable = relevance.actionable && ACTIONABLE_INDIA_TYPES.has(aiType);
        const topScore = candidates[0]?.score ?? 0;
        const needsManualLink = isActionable && (!candidates[0] || topScore < CANDIDATE_SHOW_THRESHOLD);
        const safety = deriveCandidateSafety(candidates);
        return {
          ...msg,
          aiType,
          product: result?.product || relevance.extractedProduct || null,
          matchedInquiryNumber: result?.matchedInquiryNumber || candidates[0]?.inquiry_number || null,
          aceerpNo: result?.aceerpNo || candidates[0]?.aceerp_no || null,
          summary: (relevance.actionable ? (result?.summary || msg.snippet) : relevance.reason) || '-',
          suggestedAction: relevance.actionable
            ? (result?.suggestedAction || 'Review this email.')
            : 'No Kunal pricing action needed.',
          confidence,
          extractedQuestion: result?.extractedQuestion || null,
          documentType: result?.documentType || null,
          make: result?.make || relevance.extractedMake || null,
          candidates,
          suggestedInquiryId: safety.suggestedInquiryId,
          selectedInquiryId: safety.suggestedInquiryId, // Part 8: auto-link clear winner (reversible)
          autoLinked: !!safety.suggestedInquiryId,
          reviewed: false,
          needsManualLink,
          hasMultipleSimilarCandidates: safety.hasMultipleSimilarCandidates,
          analyzed: true,
        } as KunalIndiaReviewRow;
      }));

      // MemorySkill: persist new reviews so future Refresh Gmail calls skip them.
      await Promise.all(freshRows.map(r => upsertReview(r, opts.actorId).catch(() => {})));
    }
  }

  // 2. Re-hydrate ALL reviews now in the queue table so the UI shows the full mailbox.
  const persisted = await getRecentReviews(Math.max(maxResults, 200));
  const freshByMessage = new Map(freshRows.map(r => [r.messageId, r]));
  const merged: KunalIndiaReviewRow[] = persisted.map(p => freshByMessage.get(p.gmail_message_id) || hydrateReviewAsRow(p, null));

  return { rows: merged, totalScanned: list.length, cleanedUp };
}

// ============================================================================
// Mailbox-first loader (the entry point the UI uses by default).
// Lists recent Gmail inbox messages exactly like CRM does, then joins with
// kunal_ai_email_reviews so each row carries its AI status if known.
// Does NOT invoke the LLM — that only happens on explicit Analyze / Rescan.
// ============================================================================

export interface LoadMailboxResult {
  rows: KunalIndiaReviewRow[];
  totalScanned: number;
  emailAddress: string | null;
}

/**
 * MailboxSkill: load the live Gmail inbox and join with persisted AI reviews.
 * Mirrors what CRM Email Inbox shows, but enriched with AI status from
 * kunal_ai_email_reviews. Never calls OpenAI; safe to run on every Refresh.
 */
export async function loadGmailMailbox(opts: {
  query?: string;
  maxResults?: number;
} = {}): Promise<LoadMailboxResult> {
  const query = (opts.query?.trim()) || 'in:inbox';
  const maxResults = Math.max(1, Math.min(100, opts.maxResults || 50));

  const { data: listData, error: listErr } = await supabase.functions.invoke('gmail-inbox-list', {
    body: { query, maxResults },
  });
  if (listErr) throw new Error(`gmail-inbox-list invoke failed: ${listErr.message || 'unknown'}`);
  if (!listData?.success) {
    if (listData?.code === 'NO_GMAIL_CONNECTED') throw new Error('No Gmail connected. Connect Gmail in Settings first.');
    throw new Error(listData?.error || listData?.code || 'gmail-inbox-list failed');
  }
  const list = ((listData.messages || []) as KunalGmailMessage[]).slice(0, maxResults);
  if (list.length === 0) return { rows: [], totalScanned: 0, emailAddress: listData.emailAddress || null };

  // Look up existing reviews so we can show AI status alongside the mailbox.
  const ids = list.map(m => m.messageId);
  const { data: reviewsData } = await supabase
    .from('kunal_ai_email_reviews')
    .select('*')
    .in('gmail_message_id', ids);
  const reviewsById = new Map<string, PersistedReview>((reviewsData || []).map((r: any) => [r.gmail_message_id, r as PersistedReview]));

  const rows: KunalIndiaReviewRow[] = list.map(msg => {
    const review = reviewsById.get(msg.messageId);
    if (review) {
      // Use persisted classification, but preserve the live Gmail-list fields
      // (from / to / subject / date / snippet / hasAttachments) so the mailbox
      // header is correct even if the review row is stale.
      const base = hydrateReviewAsRow(review, msg);
      return {
        ...base,
        from: msg.from || base.from,
        to: msg.to || base.to,
        subject: msg.subject || base.subject,
        date: msg.date || base.date,
        snippet: msg.snippet || base.snippet,
        hasAttachments: msg.hasAttachments,
      };
    }
    // Unanalyzed Gmail message — shown immediately, like a real mailbox.
    return {
      ...msg,
      aiType: 'Needs Review',
      product: null,
      matchedInquiryNumber: null,
      aceerpNo: null,
      summary: msg.snippet || '-',
      suggestedAction: 'Click Analyze This Email to classify.',
      confidence: 0,
      extractedQuestion: null,
      documentType: null,
      make: null,
      candidates: [],
      suggestedInquiryId: null,
      selectedInquiryId: null,
      autoLinked: false,
      reviewed: false,
      needsManualLink: false,
      hasMultipleSimilarCandidates: false,
      analyzed: false,
    } as KunalIndiaReviewRow;
  });

  return { rows, totalScanned: list.length, emailAddress: listData.emailAddress || null };
}

/**
 * AnalyzeSkill: run the LLM relevance judge on the given Gmail messages and
 * persist results. Used by both "Analyze This Email" (single) and "Rescan All"
 * (visible mailbox messages). Errors from the classifier propagate up so the
 * UI can surface them — we never silently mark messages as No Action here.
 *
 * The caller is responsible for showing a toast on throw. On success it
 * returns the freshly built rows; the UI should merge them into its state.
 */
export async function analyzeMessages(
  messages: KunalGmailMessage[],
  actorId: string | null,
): Promise<KunalIndiaReviewRow[]> {
  if (messages.length === 0) return [];

  // Pull full bodies in parallel so the LLM sees the real content.
  const full = await Promise.all(messages.map(m => (
    (m.body || m.bodyHtml) ? Promise.resolve(m) : readFullMessage(m.messageId, m)
  )));

  // Stage A: LLM judge over full bodies. Throws on transport / parse failure.
  const verdicts = await llmRelevanceClassify(full);

  // Stage B: extractor only on actionable mail.
  const actionablePool = full.filter(m => verdicts.get(m.messageId)?.actionable);
  const classified: Array<any> = [];
  if (actionablePool.length > 0) {
    const { data: classifyData, error: classifyErr } = await supabase.functions.invoke('classify-sourcing-email', {
      body: { emails: actionablePool },
    });
    if (classifyErr || !classifyData?.success) {
      throw new Error(classifyData?.error || classifyErr?.message || 'AI extractor failed.');
    }
    classified.push(...((classifyData.results || []) as any[]));
  }
  // Synthesize No Action results for the rest.
  for (const m of full) {
    if (verdicts.get(m.messageId)?.actionable) continue;
    const v = verdicts.get(m.messageId)!;
    classified.push({
      messageId: m.messageId,
      aiType: 'General / No Action',
      summary: v.reason,
      suggestedAction: 'No Kunal pricing action needed.',
      confidence: v.confidence,
      product: null,
      matchedInquiryNumber: null,
      aceerpNo: null,
      documentType: null,
      make: null,
    });
  }

  const rows: KunalIndiaReviewRow[] = await Promise.all(full.map(async msg => {
    const result = classified.find(c => c.messageId === msg.messageId);
    const v = verdicts.get(msg.messageId)!;
    const matchCtx = buildMatchContext(
      msg,
      result?.product || v.extractedProduct,
      result?.matchedInquiryNumber || null,
      result?.aceerpNo || null,
    );
    const candidates = v.actionable
      ? await findInquiryCandidatesWithContext(matchCtx)
      : [];
    const aiType: IndiaAiType = v.actionable
      ? (v.category !== 'Needs Review'
          ? v.category
          : mapToIndiaAiType(result?.aiType, result?.documentType || null, `${msg.subject} ${msg.body || ''}`))
      : 'No Action';
    const confidence = v.actionable
      ? (typeof result?.confidence === 'number' ? result.confidence : v.confidence)
      : v.confidence;
    const isActionable = v.actionable && ACTIONABLE_INDIA_TYPES.has(aiType);
    const topScore = candidates[0]?.score ?? 0;
    const needsManualLink = isActionable && (!candidates[0] || topScore < CANDIDATE_SHOW_THRESHOLD);
    const safety = deriveCandidateSafety(candidates);
    return {
      ...msg,
      aiType,
      product: result?.product || v.extractedProduct || null,
      matchedInquiryNumber: result?.matchedInquiryNumber || candidates[0]?.inquiry_number || null,
      aceerpNo: result?.aceerpNo || candidates[0]?.aceerp_no || null,
      summary: (v.actionable ? (result?.summary || msg.snippet) : v.reason) || '-',
      suggestedAction: v.actionable
        ? (result?.suggestedAction || 'Review this email.')
        : 'No Kunal pricing action needed.',
      confidence,
      extractedQuestion: result?.extractedQuestion || null,
      documentType: result?.documentType || null,
      make: result?.make || v.extractedMake || null,
      candidates,
      suggestedInquiryId: safety.suggestedInquiryId,
      selectedInquiryId: safety.suggestedInquiryId, // Part 8: auto-link clear winner (reversible)
      autoLinked: !!safety.suggestedInquiryId,
      reviewed: false,
      needsManualLink,
      hasMultipleSimilarCandidates: safety.hasMultipleSimilarCandidates,
      analyzed: true,
    } as KunalIndiaReviewRow;
  }));

  await Promise.all(rows.map(r => upsertReview(r, actorId).catch(() => {})));
  return rows;
}

// Re-export the internal helpers so the in-file references type-check.
// (Originals are not exported in the rest of this module.)
const _shouldSkipEmail = (m: KunalGmailMessage): boolean => {
  const hay = `${m.from} ${m.subject} ${m.snippet} ${m.body || ''}`.toLowerCase();
  return ['google flights', 'bank ', 'newsletter', 'verification code', 'verify your', 'feedback@', 'marketing', 'promotion', 'unsubscribe']
    .some(t => hay.includes(t));
};
const _indiaPriority = (m: KunalGmailMessage): number => {
  const hay = `${m.from} ${m.to || ''} ${m.subject} ${m.snippet} ${m.body || ''}`.toLowerCase();
  let score = 0;
  ['sonal', 'india office', 'shubham', 'kunal', 'aanvi', 'anvi'].forEach(t => { if (hay.includes(t)) score += 6; });
  ['inr', 'rs.', 'rs ', '₹', '/kg', '/gm', 'per kg', 'india price', 'source price'].forEach(t => { if (hay.includes(t)) score += 4; });
  ['coa', 'msds', 'gmp', 'iso', 'dmf', 'certificate', 'spec sheet'].forEach(t => { if (hay.includes(t)) score += 3; });
  ['inquiry', 'inq-', 'ac erp', 'make', 'manufacturer', 'availability', 'lead time', 'sourcing', 'permintaan', 'npd', 'alt', 'reform'].forEach(t => { if (hay.includes(t)) score += 2; });
  if (m.hasAttachments) score += 3;
  return score;
};
const _mapToIndiaAiType = (
  classifierType: string | null | undefined,
  documentType: string | null,
  bodyHay: string,
): IndiaAiType => {
  if (classifierType === 'Document / Certificate Received' || (documentType && documentType !== 'OTHER')) {
    return 'Document / Certificate Received';
  }
  if (classifierType === 'Supplier Price Reply') {
    if (/\b(not\s+available|out of stock|n\.?a\.?|cannot offer|alternative|alternate)\b/i.test(bodyHay)) {
      return 'Alternative Source / Not Available';
    }
    return 'India Price Received';
  }
  if (classifierType === 'India Office Query / Revert Needed') {
    return 'India Query / Missing Info';
  }
  if (classifierType === 'General / No Action' || classifierType === 'Customer Inquiry') {
    return 'No Action';
  }
  // Default fall-through: only keep as Needs Review if there is some India signal.
  return RELEVANCE_RE.test(bodyHay) ? 'Needs Review' : 'No Action';
};
