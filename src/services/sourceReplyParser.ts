import { supabase } from '../lib/supabase';

/**
 * Client wrapper around the parse-source-reply-email Edge Function.
 *
 * Review-first: the response is ONLY the AI's suggested rows. The frontend
 * shows them in an editable modal and writes to the database only after
 * user confirmation. No tokens are ever fetched in the browser.
 */

export type SourceType = 'india' | 'china' | 'local';

export interface ParsedSourceRow {
  product_name: string;
  inquiry_number: string | null;
  aceerp_no: string | null;
  offered_make: string | null;
  source_price: number | null;
  source_currency: string;
  quantity: string | null;
  availability: 'available' | 'partial' | 'na';
  document_status: 'pending' | 'received' | 'not_required' | 'partial';
  lead_time: string | null;
  remark: string | null;
  confidence: number;
  raw_excerpt: string;
  // Part 4 — product/body extraction (nullable; no dedicated DB column yet, so
  // these are folded into `remark` on save and editable in the review grid).
  grade?: string | null;
  cas?: string | null;
  unit?: string | null;
  specification?: string | null;
  preferred_manufacturer?: string | null;
  required_origin?: string | null;
}

export interface ParseSourceReplyResult {
  success: boolean;
  source_type: SourceType;
  rows: ParsedSourceRow[];
  fromEmail?: string;
  fromName?: string;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  error?: string;
  code?: string;
}

export interface ParseSourceReplyRequest {
  emailSubject: string;
  emailBody: string;
  fromEmail?: string;
  fromName?: string;
  receivedAt?: string;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  sourceTypeHint?: SourceType;
}

export async function parseSourceReplyEmail(req: ParseSourceReplyRequest): Promise<ParseSourceReplyResult> {
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) {
    return { success: false, source_type: req.sourceTypeHint || 'india', rows: [], error: 'Not signed in', code: 'NO_SESSION' };
  }
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-source-reply-email`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.session.access_token}`,
      },
      body: JSON.stringify(req),
    });
    const data = await resp.json();
    return data as ParseSourceReplyResult;
  } catch (err) {
    return {
      success: false,
      source_type: req.sourceTypeHint || 'india',
      rows: [],
      error: err instanceof Error ? err.message : 'Network error',
      code: 'NETWORK',
    };
  }
}

/**
 * Save accepted rows: writes crm_inquiry_pricing_options + updates parent
 * crm_inquiries status + logs email_inquiry_links. Best-effort link rows.
 */
export interface SaveSourceReplyArgs {
  inquiryId: string;
  sourceType: SourceType;
  row: ParsedSourceRow;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  parserConfidence?: number | null;
  actorId?: string | null;
}

export async function saveSourceReplyRow(args: SaveSourceReplyArgs): Promise<{ ok: boolean; error?: string }> {
  const { inquiryId, sourceType, row, gmailMessageId, gmailThreadId, parserConfidence, actorId } = args;

  // 1. Insert pricing option (NOT marked selected — Kunal picks one later)
  // Part 4 fields have no dedicated columns yet, so fold any present ones into
  // the remark alongside lead time (backward-compatible, no schema change).
  const extraBits = [
    row.remark,
    row.lead_time ? `Lead time: ${row.lead_time}` : null,
    row.grade ? `Grade: ${row.grade}` : null,
    row.cas ? `CAS: ${row.cas}` : null,
    row.unit ? `Unit: ${row.unit}` : null,
    row.specification ? `Spec: ${row.specification}` : null,
    row.preferred_manufacturer ? `Preferred mfr: ${row.preferred_manufacturer}` : null,
    row.required_origin ? `Origin: ${row.required_origin}` : null,
  ].filter(Boolean);
  const { error: optErr } = await supabase
    .from('crm_inquiry_pricing_options')
    .insert({
      inquiry_id:      inquiryId,
      source_type:     sourceType,
      offered_make:    row.offered_make,
      source_price:    row.source_price,
      source_currency: row.source_currency,
      availability:    row.availability,
      document_status: row.document_status,
      remark:          extraBits.join(' · ') || null,
      is_selected:     false,
      confidence:      row.confidence,
      created_by:      actorId || null,
    });
  if (optErr) return { ok: false, error: optErr.message };

  // 2. Sync parent inquiry status (do NOT change purchase/offered prices)
  // Bump source_status to 'partial_received' if any row is NA or partial,
  // otherwise to 'received' (the caller can override after all rows save).
  const nextStatus: 'partial_received' | 'received' | 'unavailable' =
    row.availability === 'na' ? 'unavailable'
    : row.availability === 'partial' ? 'partial_received'
    : 'received';

  const docMap: Record<string, string> = {
    'received': 'received',
    'pending': 'pending',
    'partial': 'partial',
    'not_required': 'not_required',
  };

  await supabase.from('crm_inquiries').update({
    source_status: nextStatus,
    document_status: docMap[row.document_status] || 'pending',
    kunal_price_status: 'pending',           // explicitly stay pending
    updated_at: new Date().toISOString(),
  }).eq('id', inquiryId);

  // 3. Best-effort email_inquiry_links row
  if (gmailMessageId || gmailThreadId) {
    await Promise.resolve(supabase.from('email_inquiry_links').insert({
      gmail_message_id: gmailMessageId || null,
      gmail_thread_id:  gmailThreadId  || null,
      inquiry_id:       inquiryId,
      link_type:        'source_reply',
      source_reply_parser_run_at: new Date().toISOString(),
      parser_confidence: typeof parserConfidence === 'number' ? parserConfidence : row.confidence,
      created_by: actorId || null,
    })).catch(() => { /* non-critical */ });
  }

  return { ok: true };
}

/**
 * Find candidate CRM inquiries that might match a parsed row.
 *
 * Multi-signal scoring: product name, inquiry number, AC ERP#, email subject/body
 * overlap, customer name, make, qty, recency, and already-linked Gmail threads.
 *
 * Used by the review modal and Kunal AI to suggest the inquiry the user
 * should bind the row to.
 */

// ── Product name normalisation ──────────────────────────────────────────────

function normalizeProduct(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

const GRADE_WORDS = /\b(USP|BP|IP|EP|JP|NF|FCC|PHARMA\s*GRADE|FOOD\s*GRADE|FEED\s*GRADE|TECHNICAL\s*GRADE|INDUSTRIAL\s*GRADE)\b/gi;

function stripGrade(name: string): string {
  return name.replace(GRADE_WORDS, '').replace(/\s+/g, ' ').trim();
}

function productsMatch(a: string, b: string): { exact: boolean; fuzzy: boolean } {
  const na = normalizeProduct(a);
  const nb = normalizeProduct(b);
  const exact = na === nb;
  const fuzzy = !exact && (stripGrade(na) === stripGrade(nb) || na.includes(nb) || nb.includes(na));
  return { exact, fuzzy };
}

function textContainsWord(hay: string, word: string): boolean {
  return hay.toUpperCase().includes(word.toUpperCase());
}

/**
 * Extract CAS registry numbers (e.g. 50-00-0) from free text.
 * Anchored regex avoids matching arbitrary hyphenated digit runs; used only as
 * a scoring boost, never as a sole match signal.
 */
const CAS_RE = /\b(\d{2,7}-\d{2}-\d)\b/g;

function extractCasNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const matches = text.match(CAS_RE);
  if (matches) for (const m of matches) out.add(m.trim());
  return Array.from(out);
}

// ── Candidate types ─────────────────────────────────────────────────────────

export interface InquiryCandidate {
  id: string;
  inquiry_number: string;
  aceerp_no: string | null;
  product_name: string;
  specification: string | null;
  company_name: string;
  source_status: string;
  /** 0–1 composite score. */
  score: number;
  /** Human-readable reason labels for the score. */
  reasons: string[];
  email_subject?: string | null;
  mail_subject?: string | null;
  quantity?: string | null;
  created_at?: string | null;
}

export interface FindInquiryContext {
  /** Product name extracted from email / parser. */
  product_name?: string;
  /** INQ number found in email body or subject. */
  inquiry_number?: string | null;
  /** AC ERP# found in email body or subject. */
  aceerp_no?: string | null;
  /** Current email subject line. */
  emailSubject?: string;
  /** Full plain-text body of the email. */
  emailBody?: string;
  /** Forwarded / nested subjects extracted from the body. */
  forwardedSubjects?: string[];
  /** The sender's email address. */
  senderEmail?: string;
  /** Customer or company name extracted from the email trail. */
  customerName?: string;
  /** Offered make/manufacturer mentioned in the email. */
  make?: string | null;
  /** CAS number extracted from the email (matched against specification/product text). */
  cas?: string | null;
  /** Quantity mentioned in the email. */
  qty?: string | null;
  /** Gmail thread id — scored higher if already linked to an inquiry. */
  gmailThreadId?: string | null;
  /** Gmail message id — scored higher if already linked to an inquiry. */
  gmailMessageId?: string | null;
}

// ── Scoring constants ───────────────────────────────────────────────────────

const SCORE_MAX = 160;

const WEIGHTS = {
  INQ_EXACT:         50,
  ACERP_EXACT:       40,
  PRODUCT_EXACT:     45,
  PRODUCT_FUZZY:     25,
  PRODUCT_ILIKE:     10,
  CAS_MATCH:         40,
  SUBJECT_HAS_PRODUCT: 15,
  BODY_HAS_PRODUCT:  10,
  CUSTOMER_IN_EMAIL: 15,
  SUBJECT_OVERLAP:   10,
  QTY_OVERLAP:        5,
  MAKE_OVERLAP:       5,
  RECENT:             5,
  THREAD_LINKED:     15,
};

// ── Confidence thresholds ───────────────────────────────────────────────────

/** Score >= AUTO_SELECT → auto-select the top candidate in the UI. */
export const AUTO_SELECT_THRESHOLD = 0.75;
/** Score >= CANDIDATE_SHOW → show as a candidate with reasons. */
export const CANDIDATE_SHOW_THRESHOLD = 0.45;
/** Below CANDIDATE_SHOW_THRESHOLD → Needs Manual Link. */

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Find and score candidate CRM inquiries using every available signal.
 *
 * Returns at most 10 candidates, sorted by score descending, each with a
 * `score` (0–1) and `reasons` array suitable for UI chips.
 */
export async function findInquiryCandidatesWithContext(
  ctx: FindInquiryContext,
): Promise<InquiryCandidate[]> {
  const hay = [
    ctx.emailSubject || '',
    ...(ctx.forwardedSubjects || []),
    ctx.emailBody || '',
  ].join(' ');
  const hayLower = hay.toLowerCase();

  // ── 1. Gather candidates from multiple sources ─────────────────────────
  const all = new Map<string, InquiryCandidate & { _raw: any }>();

  const addFromRows = (rows: any[]) => {
    for (const r of rows) {
      if (!all.has(r.id)) {
        all.set(r.id, {
          id: r.id,
          inquiry_number: r.inquiry_number,
          aceerp_no: r.aceerp_no || null,
          product_name: r.product_name,
          specification: r.specification || null,
          company_name: r.company_name,
          source_status: r.source_status || '',
          score: 0,
          reasons: [],
          email_subject: r.email_subject || null,
          mail_subject: r.mail_subject || null,
          quantity: r.quantity || null,
          created_at: r.created_at || null,
          _raw: r,
        });
      }
    }
  };

  // 1a. Exact INQ number match — strongest signal
  if (ctx.inquiry_number) {
    const { data } = await supabase
      .from('crm_inquiries')
      .select('id,inquiry_number,aceerp_no,product_name,specification,company_name,source_status,email_subject,mail_subject,quantity,created_at')
      .eq('inquiry_number', ctx.inquiry_number)
      .limit(5);
    if (data) addFromRows(data);
  }

  // 1b. Exact AC ERP# match
  if (ctx.aceerp_no) {
    const { data } = await supabase
      .from('crm_inquiries')
      .select('id,inquiry_number,aceerp_no,product_name,specification,company_name,source_status,email_subject,mail_subject,quantity,created_at')
      .eq('aceerp_no', ctx.aceerp_no)
      .limit(5);
    if (data) addFromRows(data);
  }

  // 1c. ILIKE product name — cast a wide net across active inquiries
  if (ctx.product_name) {
    const term = ctx.product_name.split(/\s+/).slice(0, 4).join(' ');
    const { data } = await supabase
      .from('crm_inquiries')
      .select('id,inquiry_number,aceerp_no,product_name,specification,company_name,source_status,email_subject,mail_subject,quantity,created_at')
      .ilike('product_name', `%${term}%`)
      .in('pipeline_status', ['new','in_progress','follow_up'])
      .order('created_at', { ascending: false })
      .limit(20);
    if (data) addFromRows(data);
  }

  // 1d. Also try the stripped-grade product for a second ILIKE pass
  if (ctx.product_name) {
    const stripped = stripGrade(ctx.product_name);
    if (stripped && stripped !== ctx.product_name.trim().toUpperCase()) {
      const term = stripped.split(/\s+/).slice(0, 4).join(' ');
      const { data } = await supabase
        .from('crm_inquiries')
        .select('id,inquiry_number,aceerp_no,product_name,specification,company_name,source_status,email_subject,mail_subject,quantity,created_at')
        .ilike('product_name', `%${term}%`)
        .in('pipeline_status', ['new','in_progress','follow_up'])
        .order('created_at', { ascending: false })
        .limit(20);
      if (data) addFromRows(data);
    }
  }

  // 1e. Customer name ILIKE on company_name — if we extracted one
  if (ctx.customerName && ctx.customerName.length >= 3) {
    const { data } = await supabase
      .from('crm_inquiries')
      .select('id,inquiry_number,aceerp_no,product_name,specification,company_name,source_status,email_subject,mail_subject,quantity,created_at')
      .ilike('company_name', `%${ctx.customerName}%`)
      .in('pipeline_status', ['new','in_progress','follow_up'])
      .order('created_at', { ascending: false })
      .limit(10);
    if (data) addFromRows(data);
  }

  // ── 2. Pre-fetch already-linked threads ───────────────────────────────
  let linkedInquiryIds = new Set<string>();
  if (ctx.gmailThreadId || ctx.gmailMessageId) {
    const cond = ctx.gmailThreadId
      ? `gmail_thread_id.eq.${ctx.gmailThreadId}`
      : `gmail_message_id.eq.${ctx.gmailMessageId}`;
    // Simple or filter isn't directly supported, so use two queries if both present.
    const filters: string[] = [];
    if (ctx.gmailThreadId) filters.push(`gmail_thread_id.eq.${ctx.gmailThreadId}`);
    if (ctx.gmailMessageId) filters.push(`gmail_message_id.eq.${ctx.gmailMessageId}`);
    const { data: links } = await supabase
      .from('email_inquiry_links')
      .select('inquiry_id')
      .or(filters.join(','));
    if (links) linkedInquiryIds = new Set(links.map((l: any) => l.inquiry_id));
  }

  // ── 3. Score every candidate ──────────────────────────────────────────
  const candidates = Array.from(all.values());

  for (const c of candidates) {
    const reasons: string[] = [];
    let raw = 0;

    // INQ exact match
    if (ctx.inquiry_number && c.inquiry_number === ctx.inquiry_number) {
      raw += WEIGHTS.INQ_EXACT;
      reasons.push('INQ exact');
    }

    // AC ERP exact match
    if (ctx.aceerp_no && c.aceerp_no && c.aceerp_no === ctx.aceerp_no) {
      raw += WEIGHTS.ACERP_EXACT;
      reasons.push('AC ERP exact');
    }

    // Product name matching
    if (ctx.product_name) {
      const pm = productsMatch(c.product_name, ctx.product_name);
      if (pm.exact) {
        raw += WEIGHTS.PRODUCT_EXACT;
        reasons.push('Product exact');
      } else if (pm.fuzzy) {
        raw += WEIGHTS.PRODUCT_FUZZY;
        reasons.push('Product match');
      } else {
        // Already found via ILIKE, but give a small baseline
        raw += WEIGHTS.PRODUCT_ILIKE;
      }
    }

    // CAS number match — boost only. Compare the email's CAS against any CAS
    // found in the candidate's specification or product name text.
    if (ctx.cas) {
      const candidateCas = extractCasNumbers(`${c.product_name || ''} ${c.specification || ''}`);
      if (candidateCas.includes(ctx.cas)) {
        raw += WEIGHTS.CAS_MATCH;
        reasons.push('CAS match');
      }
    }

    // Email subject contains the product name
    if (ctx.product_name && ctx.emailSubject && textContainsWord(ctx.emailSubject, ctx.product_name)) {
      raw += WEIGHTS.SUBJECT_HAS_PRODUCT;
      reasons.push('Subject → product');
    }

    // Forwarded subjects contain product name
    const productName = ctx.product_name;
    if (productName && ctx.forwardedSubjects?.some(s => textContainsWord(s, productName))) {
      raw += WEIGHTS.SUBJECT_HAS_PRODUCT;
      if (!reasons.includes('Subject → product')) reasons.push('Fwd subject → product');
    }

    // Email body contains the product name
    if (ctx.product_name && ctx.emailBody && textContainsWord(ctx.emailBody, ctx.product_name)) {
      raw += WEIGHTS.BODY_HAS_PRODUCT;
      reasons.push('Body → product');
    }

    // Customer name appears in email hay
    if (ctx.customerName && ctx.customerName.length >= 3) {
      const cName = ctx.customerName.toLowerCase();
      if (hayLower.includes(cName)) {
        // Even stronger if it matches the inquiry's company_name
        const inquiryCompany = c.company_name.toLowerCase();
        if (inquiryCompany.includes(cName) || cName.includes(inquiryCompany.split(' ')[0])) {
          raw += WEIGHTS.CUSTOMER_IN_EMAIL;
          reasons.push('Customer match');
        }
      }
    }

    // Subject / project overlap — inquiry email_subject vs current email subject
    const inquirySubject = c.email_subject || c.mail_subject || '';
    if (inquirySubject && ctx.emailSubject) {
      const iWords = new Set(inquirySubject.toUpperCase().split(/\s+/).filter((w: string) => w.length > 2));
      const eWords = ctx.emailSubject.toUpperCase().split(/\s+/).filter((w: string) => w.length > 2);
      const overlap = eWords.filter((w: string) => iWords.has(w)).length;
      if (overlap >= 2) {
        raw += WEIGHTS.SUBJECT_OVERLAP;
        reasons.push('Subject overlap');
      }
    }

    // Quantity overlap (partial — just checks if any numeric part matches)
    if (ctx.qty && c.quantity) {
      const qNums: string[] = ctx.qty.match(/\d+/g) ?? [];
      const cNums: string[] = c.quantity.match(/\d+/g) ?? [];
      if (qNums.some(n => cNums.includes(n))) {
        raw += WEIGHTS.QTY_OVERLAP;
        reasons.push('Qty overlap');
      }
    }

    // Make overlap
    if (ctx.make && c._raw?.supplier_name && textContainsWord(c._raw.supplier_name, ctx.make)) {
      raw += WEIGHTS.MAKE_OVERLAP;
      reasons.push('Make match');
    }

    // Recent inquiry
    if (c.created_at) {
      const ageDays = (Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 45) {
        raw += WEIGHTS.RECENT;
        reasons.push('Recent');
      }
    }

    // Already linked to this thread/message
    if (linkedInquiryIds.has(c.id)) {
      raw += WEIGHTS.THREAD_LINKED;
      reasons.push('Linked thread');
    }

    c.score = Math.min(raw / SCORE_MAX, 1.0);
    c.reasons = reasons;
    delete (c as any)._raw;
  }

  // ── 4. Sort, dedupe, return ───────────────────────────────────────────
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10);
}

/**
 * Simple backward-compatible wrapper. For richer matching, callers should use
 * findInquiryCandidatesWithContext directly.
 */
export async function findInquiryCandidates(hint: {
  inquiry_number?: string | null;
  aceerp_no?: string | null;
  product_name?: string;
  cas?: string | null;
}): Promise<InquiryCandidate[]> {
  return findInquiryCandidatesWithContext({
    product_name: hint.product_name,
    inquiry_number: hint.inquiry_number,
    aceerp_no: hint.aceerp_no,
    cas: hint.cas,
  });
}
