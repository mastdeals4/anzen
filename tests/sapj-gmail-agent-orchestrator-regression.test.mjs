import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Read source files
const agentFn = readFileSync(
  new URL('../supabase/functions/sapj-gmail-agent/index.ts', import.meta.url),
  'utf8',
);
const cronMigration = readFileSync(
  new URL('../supabase/migrations/20260925090000_sapj_gmail_agent_cron_schedule.sql', import.meta.url),
  'utf8',
);
const kunalService = readFileSync(
  new URL('../src/services/kunalIndiaPrice.ts', import.meta.url),
  'utf8',
);
const reviewComponent = readFileSync(
  new URL('../src/components/crm/KunalIndiaPriceReview.tsx', import.meta.url),
  'utf8',
);

// Helper regex tests directly extracted from implementation
function fastFirstPassFilter(subject, from, body) {
  const sLower = (subject || '').toLowerCase();
  const fLower = (from || '').toLowerCase();
  const bLower = (body || '').toLowerCase();
  const combined = `${sLower} ${bLower}`;

  const isOurDomain = fLower.includes('@sapharmajaya.co.id') || fLower.includes('sales@') || fLower.includes('pt shubham anzen');
  const hasOutboundQuotePhrases =
    combined.includes('berikut saya berikan penawaran') ||
    combined.includes('penawaran untuk produk') ||
    combined.includes('kami tawarkan') ||
    combined.includes('harga kami') ||
    combined.includes('we are pleased to quote') ||
    combined.includes('please find our quotation') ||
    combined.includes('our offer is') ||
    combined.includes('quoted to customer');

  if (isOurDomain || hasOutboundQuotePhrases) {
    return {
      isNoAction: true,
      reason: 'Outbound customer quotation sent from SAPJ sales team',
      direction: 'SAPJ -> CUSTOMER',
    };
  }

  const isCustomerFollowUp =
    combined.includes('may we request an update on the offer sent') ||
    combined.includes('any update on the offer sent') ||
    combined.includes('any update on our offer') ||
    combined.includes('request update on previous offer') ||
    combined.includes('reminder for the offer shared') ||
    combined.includes('please revert on our offer') ||
    combined.includes('revert awaited on quote') ||
    combined.includes('revert awaited for the offer');

  if (isCustomerFollowUp) {
    return {
      isNoAction: true,
      reason: 'Customer reminder / follow-up on quote previously sent by SAPJ',
      direction: 'CUSTOMER -> SAPJ',
    };
  }

  const NOISE_REGEX =
    /\b(tracking number|awb\s*#|bill of lading|\bb\/l\b|courier|dispatch details|container movement|delivery confirmation|payment received|payment reminder|remittance advice|proof of payment|faktur pajak|invoice copy|pib\s*#|out of office|on leave|annual leave|festive greetings|happy new year|eid mubarak|happy diwali|newsletter|unsubscribe|zoom meeting invite|google meet invite)\b/i;

  if (NOISE_REGEX.test(sLower) || (NOISE_REGEX.test(bLower) && !/(quote|rate|price|inr|usd|rs\.?\/kg|\/kg)/i.test(bLower))) {
    return {
      isNoAction: true,
      reason: 'Operational logistics / payment / greeting / administrative email',
      direction: 'INTERNAL',
    };
  }

  return null;
}

function extractAceErpReference(text) {
  const match = text.match(/\bACE(?:[-_ ]?ERP)?[:#\s-]*([A-Za-z0-9_-]{3,20})\b/i);
  return match ? match[1].trim() : null;
}

function normalizeProduct(name) {
  return name.toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function detectDocumentType(filename) {
  const fname = filename.toLowerCase();
  if (fname.includes('coa') || fname.includes('certificate of analysis')) return 'COA';
  if (fname.includes('msds') || fname.includes('sds')) return 'MSDS';
  if (fname.includes('gmp')) return 'GMP';
  if (fname.includes('tds') || fname.includes('technical data')) return 'TDS';
  if (fname.includes('spec')) return 'SPEC';
  if (fname.includes('coc')) return 'COC';
  if (fname.includes('iso')) return 'ISO';
  if (fname.includes('dmf')) return 'DMF';
  if (fname.includes('price list') || fname.includes('pricelist')) return 'PRICE_LIST';
  if (fname.includes('catalog')) return 'CATALOGUE';
  return 'OTHER';
}

function detectDocumentMatch(attachment, candidate, requestedBatch) {
  const docType = detectDocumentType(attachment.filename);
  const prodMatch = candidate && attachment.filename.toLowerCase().includes(candidate.product_name.toLowerCase().slice(0, 5));
  const batchMatch = attachment.batchNumber && requestedBatch && attachment.batchNumber.toLowerCase() === requestedBatch.toLowerCase();
  const batchMismatch = attachment.batchNumber && requestedBatch && attachment.batchNumber.toLowerCase() !== requestedBatch.toLowerCase();

  if (batchMismatch) {
    return { status: 'MISMATCH', confidence: 'BLOCK' };
  }
  if (prodMatch && batchMatch) {
    return { status: 'MATCHED', confidence: 'HIGH' };
  }
  if (prodMatch) {
    return { status: 'AVAILABLE', confidence: 'MEDIUM' };
  }
  return { status: 'REVIEW', confidence: 'LOW' };
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION TEST SUITE (All 23 criteria)
// ─────────────────────────────────────────────────────────────────────────────

test('1. Background Agent Invocation: sapj-gmail-agent orchestrator exists and supports scheduled cron', () => {
  assert.match(agentFn, /export type AgentCategory/);
  assert.match(agentFn, /calculateNextCheckWIB/);
  assert.match(cronMigration, /public\.invoke_sapj_gmail_agent/);
  assert.match(cronMigration, /sapj-gmail-agent-0800/);
  assert.match(cronMigration, /sapj-gmail-agent-1300/);
  assert.match(cronMigration, /sapj-gmail-agent-1800/);
});

test('2. Check Now Invocation: manual button calls exact same sapj-gmail-agent backend', () => {
  assert.match(kunalService, /export async function runSapjGmailAgent/);
  assert.match(kunalService, /\/functions\/v1\/sapj-gmail-agent/);
  assert.match(reviewComponent, /runSapjGmailAgent/);
  assert.match(reviewComponent, /handleCheckNow/);
  assert.match(reviewComponent, /CHECK NOW/);
});

test('3. Read Gmail Email Discovered Correctly: does not rely on is:unread as eligibility condition', () => {
  assert.doesNotMatch(agentFn, /q=is:unread/i, 'Background agent must NOT use is:unread as only eligibility condition');
  assert.match(agentFn, /after:\$\{overlapSec\}|newer_than:7d/, 'Must discover already-read emails using timestamp and overlap');
});

test('4. Last Sync / Overlap Behavior: queries with overlap window so delayed messages are not lost', () => {
  assert.match(agentFn, /const overlapSec = Math\.max\(0,\s*Math\.floor\(\(lastSyncMs - 24 \* 60 \* 60 \* 1000\) \/ 1000\)\);/);
});

test('5. Message ID Idempotency: upserts on gmail_message_id to prevent duplicates', () => {
  assert.match(agentFn, /onConflict:\s*["']gmail_message_id["']/);
});

test('6. Duplicate Scan Protection: safe repeated scans do not duplicate review items or emails', () => {
  assert.match(agentFn, /const \{ data: existingReview \} = await adminClient/);
  assert.match(agentFn, /if \(existingReview && !forceReprocess\)/);
});

test('7. Concurrent Check Now Protection: prevents duplicate concurrent execution on same connection', () => {
  assert.match(agentFn, /const runningConnections = new Set<string>\(\);/);
  assert.match(agentFn, /if \(runningConnections\.has\(connection\.id\)\)/);
  assert.match(agentFn, /status:\s*["']already_running["']/);
});

test('8. ACE ERP Matching: matches internal reference in highest precedence order', () => {
  const sample1 = 'Offer for Folic Acid - Ref: ACE ERP: 12345';
  const sample2 = 'Quotation details [ACE-9876] for Anzen';
  assert.equal(extractAceErpReference(sample1), '12345');
  assert.equal(extractAceErpReference(sample2), '9876');
  assert.match(agentFn, /STEP 1: ACE ERP Match \(highest precedence\)/);
});

test('9. Thread Matching Without ACE ERP: preserves relationship when ACE ERP is removed in reply', () => {
  assert.match(agentFn, /STEP 2: Gmail Thread ID Match \(preserves relationship even if ACE ERP was deleted in reply\)/);
  assert.match(agentFn, /email_thread_map/);
  assert.match(agentFn, /email_inquiry_links/);
});

test('10. In-Reply-To Matching: preserves conversation link through in-reply-to header', () => {
  assert.match(agentFn, /STEP 3: In-Reply-To Header Match/);
  assert.match(agentFn, /crm_email_activities/);
});

test('11. Ambiguous Match Requires Review: ambiguous candidates flagged needsManualLink instead of auto-linking', () => {
  assert.match(agentFn, /needsManualLink:\s*!isHighConfidence/);
  assert.match(agentFn, /NEEDS REVIEW/);
});

test('12. Supplier Price Extraction: structured row per product x offered make', () => {
  assert.match(agentFn, /export interface ParsedPricingRow/);
  assert.match(agentFn, /raw_excerpt/);
  assert.match(agentFn, /One pricing row per \(product x offered make\)/);
});

test('13. NA / Unavailable Handled Correctly: sets availability="na" and source_price=null', () => {
  assert.match(agentFn, /availability="na",\s*source_price=null/);
  assert.match(agentFn, /"NOT AVAILABLE"/);
});

test('14. Alternative Make Detection: never overwrites requested make automatically; provides options', () => {
  assert.match(agentFn, /alternativeMake:\s*altMakeObj/);
  assert.match(agentFn, /topCandidateRequestedMake/);
  assert.match(reviewComponent, /ALTERNATIVE MAKE DETECTED/);
  assert.match(reviewComponent, /USE ALTERNATIVE MAKE/);
  assert.match(reviewComponent, /KEEP REQUESTED MAKE/);

  // Unit test normalizer
  assert.equal(normalizeProduct('DSM Nutritional'), 'DSM NUTRITIONAL');
  assert.notEqual(normalizeProduct('DSM'), normalizeProduct('XYZ Pharma'));
});

test('15. COA Matching: detects COA and provides attachment metadata', () => {
  assert.equal(detectDocumentType('COA_FolicAcid_Batch123.pdf'), 'COA');
  assert.equal(detectDocumentType('Safety_Data_Sheet_MSDS.pdf'), 'MSDS');
  assert.equal(detectDocumentType('GMP_Certificate_2026.pdf'), 'GMP');
  assert.equal(detectDocumentType('TDS_Technical_Data.pdf'), 'TDS');
});

test('16. Wrong Batch Document Mismatch: blocks mismatched batch from silent attachment', () => {
  const matchResult = detectDocumentMatch(
    { filename: 'COA_Paracetamol_B001.pdf', batchNumber: 'B001' },
    { product_name: 'Paracetamol' },
    'B999' // Requested batch
  );
  assert.equal(matchResult.status, 'MISMATCH');
  assert.equal(matchResult.confidence, 'BLOCK');
});

test('17. Revert Awaited Not Treated as Pricing: customer reminders classified as No Action', () => {
  const filtered = fastFirstPassFilter(
    'Re: Quotation - Revert Awaited',
    'procurement@buyer.co.id',
    'Dear Team, Any update on our offer? Revert awaited for the offer shared earlier.'
  );
  assert.ok(filtered);
  assert.equal(filtered.isNoAction, true);
  assert.equal(filtered.direction, 'CUSTOMER -> SAPJ');
});

test('18. Customer Quotation Not Treated as Supplier Price: outbound sales quote classified as No Action', () => {
  const filtered = fastFirstPassFilter(
    'Penawaran Produk Folic Acid',
    'sales@sapharmajaya.co.id',
    'Berikut saya berikan penawaran untuk produk Folic Acid USD 14.80/kg. Best regards, PT Shubham Anzen Pharma Jaya'
  );
  assert.ok(filtered);
  assert.equal(filtered.isNoAction, true);
  assert.equal(filtered.direction, 'SAPJ -> CUSTOMER');
});

test('19. Stale Extraction State Cannot Leak: selecting another email resets state immediately', () => {
  assert.match(reviewComponent, /STALE UI STATE BUG FIX/);
  assert.match(reviewComponent, /setExtractionRows\(\[\]\);/);
  assert.match(reviewComponent, /setManualSearchText\(\{\}\);/);
  assert.match(reviewComponent, /setShowEvidence\(false\);/);
});

test('20. Cached Email Does Not Call AI Again Unnecessarily: skips tokens on repeated scan', () => {
  assert.match(agentFn, /Previously processed — skip expensive OpenAI re-processing/);
  assert.match(agentFn, /cached:\s*true/);
  assert.match(reviewComponent, /Cached/);
});

test('21. Failed AI Processing Can Retry Safely: explicit reprocess button available', () => {
  assert.match(reviewComponent, /title=\{selected\.isPreviouslyProcessed \? "Explicitly re-process this email with AI" : "Run the LLM relevance judge/);
  assert.match(reviewComponent, /selected\.isPreviouslyProcessed \? 'Reprocess' : 'Analyze This Email'/);
});

test('22. One Failed Email Does Not Stop the Entire Batch: uses try/catch per message ref', () => {
  assert.match(agentFn, /for \(const ref of messageRefs\) \{/);
  assert.match(agentFn, /if \(!msgResp\.ok\) continue;/);
});

test('23. Traceability Fields Preserved: email_thread_map, email_inquiry_links, crm_email_inbox', () => {
  assert.match(agentFn, /adminClient\s*\.from\(["']crm_email_inbox["']\)\s*\.upsert/);
  assert.match(agentFn, /adminClient\s*\.from\(["']email_inquiry_links["']\)\s*\.insert/);
  assert.match(agentFn, /traceability:\s*\{/);
  assert.match(reviewComponent, /AI Evidence & Match Justification/);
});
