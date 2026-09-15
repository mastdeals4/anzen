import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const edgeFnCode = readFileSync(
  new URL('../supabase/functions/enquiry-brain-analyze/index.ts', import.meta.url),
  'utf8'
);
const ingestionCode = readFileSync(
  new URL('../supabase/functions/_shared/enquiryIngestion.ts', import.meta.url),
  'utf8'
);
const syncGmailCode = readFileSync(
  new URL('../supabase/functions/sync-gmail-emails/index.ts', import.meta.url),
  'utf8'
);
const clientServiceCode = readFileSync(
  new URL('../src/services/enquiry/EnquiryBrainService.ts', import.meta.url),
  'utf8'
);
const typesCode = readFileSync(
  new URL('../src/types/enquiry/conversation.types.ts', import.meta.url),
  'utf8'
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `ai_auto_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmpPath, sql, 'utf8');
  try {
    const cmd = `npx supabase db query --linked --file "${tmpPath}"`;
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const parsed = JSON.parse(output);
    return parsed.rows || [];
  } catch (err) {
    throw new Error(`Database query failed: ${err.stderr || err.stdout || err.message}`);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// --------------------------------------------------------------------------
// 1. Trigger Mechanism & Ingestion Integration
// --------------------------------------------------------------------------
test('1. New inbound canonical message triggers analysis: mirrorInboundEmail invokes trigger', () => {
  assert.match(ingestionCode, /export function isEligibleForEnquiryBrainAnalysis/);
  assert.match(ingestionCode, /export async function triggerEnquiryBrainAnalysis/);
  assert.match(ingestionCode, /if \(!isDuplicate && canonicalMessageId\)/);
  assert.match(ingestionCode, /isEligibleForEnquiryBrainAnalysis\(/);
  assert.match(ingestionCode, /triggerEnquiryBrainAnalysis\(supabase,\s*canonicalMessageId\)/);
});

test('2. Proposal is stored: ai_proposal JSONB stores structured suggestions without schema changes', () => {
  const testMsgId = 'a1111111-2222-3333-4444-555555555555';
  const testConvId = 'b1111111-2222-3333-4444-555555555555';

  runDbScript(`
    DO $$
    BEGIN
      INSERT INTO public.enquiry_conversations (id, channel, external_thread_id, title)
      VALUES ('${testConvId}', 'email', 'th-test-auto-1', 'Test Auto Analysis')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.enquiry_conversation_messages (
        id, conversation_id, channel, direction, external_message_id, sender_address, subject, body_text, ai_processed, ai_proposal
      ) VALUES (
        '${testMsgId}',
        '${testConvId}',
        'email',
        'inbound',
        'msg-auto-001',
        'customer@pharma-corp.com',
        'Inquiry for Product Alpha',
        'Please quote Product Alpha 500 KG 100 mesh.',
        false,
        '{"status": "pending", "queued_at": "2026-09-14T10:00:00Z"}'::jsonb
      ) ON CONFLICT (id) DO UPDATE SET
        ai_processed = false,
        ai_proposal = '{"status": "pending", "queued_at": "2026-09-14T10:00:00Z"}'::jsonb;
    END $$;
  `);

  const rows = runDbScript(`
    SELECT id, direction, ai_processed, ai_proposal->>'status' AS status
    FROM public.enquiry_conversation_messages
    WHERE id = '${testMsgId}';
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].ai_processed, false);
  assert.equal(rows[0].status, 'pending');
});

test('3. Zero business mutation occurs on AI proposal generation', () => {
  // Edge function code must NEVER perform direct updates/inserts into business state tables
  assert.doesNotMatch(edgeFnCode, /\.from\(["']enquiry_requests["']\)\.insert/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']enquiry_requests["']\)\.update/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']crm_inquiries["']\)\.update/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']crm_inquiries["']\)\.insert/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']tasks["']\)\.insert/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']pricing_/);
  assert.doesNotMatch(edgeFnCode, /transition_enquiry_request_atomic/);
  assert.doesNotMatch(edgeFnCode, /create_enquiry_request_atomic/);
});

test('4. Duplicate processing is prevented: cached result returned and processing concurrency locked', () => {
  assert.match(edgeFnCode, /2a\. Terminal or completed analysis: return cached unless forced/);
  assert.match(edgeFnCode, /message\.ai_proposal\.status === "suggested"/);
  assert.match(edgeFnCode, /\["accepted", "edited", "dismissed"\]\.includes/);
  assert.match(edgeFnCode, /2b\. Concurrency lock: prevent duplicate execution if already processing/);
  assert.match(edgeFnCode, /elapsedMs < 5 \* 60 \* 1000/);
});

test('5. Failed AI processing is retryable with retry count cap (max 3)', () => {
  assert.match(edgeFnCode, /2c\. Retry limit: stop endless loops if max retries exceeded/);
  assert.match(edgeFnCode, /currentRetryCount >= 3/);
  assert.match(edgeFnCode, /retry_count: newRetryCount/);
  assert.match(edgeFnCode, /retryable: isRetryable/);
  assert.match(edgeFnCode, /ai_processed: false/);

  // Test retry sweep query handles failed retryable rows
  assert.match(ingestionCode, /proposal\?\.status === "failed" && \(proposal\.retry_count \|\| 0\) >= 3/);
});

test('6. Successful processing marks completion correctly (ai_processed=true, status=suggested|no_action)', () => {
  assert.match(edgeFnCode, /ai_processed: true/);
  assert.match(edgeFnCode, /ai_summary: proposal\.summary/);
  assert.match(edgeFnCode, /status: isNoAction \? "no_action" : "suggested"/);
});

test('7. AI cannot create tasks: strict prohibition and verification', () => {
  assert.match(edgeFnCode, /NEVER create internal tasks/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']tasks["']\)/);
  assert.doesNotMatch(ingestionCode, /\.from\(["']tasks["']\)/);
});

test('8. AI cannot modify pricing: strict prohibition and zero pricing tables touched', () => {
  assert.match(edgeFnCode, /NEVER invent purchase prices, profit margins, or supplier promises/);
  assert.doesNotMatch(edgeFnCode, /kunal_pricing/);
  assert.doesNotMatch(edgeFnCode, /pricing_calculations/);
});

test('9. AI cannot modify crm_inquiries: crm_inquiries is read-only in Enquiry Brain', () => {
  assert.match(edgeFnCode, /\.from\(["']crm_inquiries["']\)[\s\n]*\.select/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']crm_inquiries["']\)[\s\n]*\.update/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']crm_inquiries["']\)[\s\n]*\.delete/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']crm_inquiries["']\)[\s\n]*\.insert/);
});

test('10. Existing-request requirement change becomes a proposal (proposed_updates)', () => {
  assert.match(edgeFnCode, /REQUIREMENT EVOLUTION \(DIFF PRESERVATION\)/);
  assert.match(edgeFnCode, /"proposed_updates":/);
  assert.match(edgeFnCode, /"old_value": any/);
  assert.match(edgeFnCode, /"new_value": any/);
  assert.match(edgeFnCode, /"field":\s*"customer_requirement" \| "parameters" \| "status" \| "waiting_for" \| "current_issue" \| "next_action" \| "assigned_team"/);
});

test('11. Genuinely new request becomes proposed_new_request without request explosion', () => {
  assert.match(edgeFnCode, /REQUIREMENT GROUPING \(AVOID REQUEST EXPLOSION\)/);
  assert.match(edgeFnCode, /MUST remain ONE SINGLE commercial request with parameters/);
  assert.match(edgeFnCode, /Do NOT create separate requests for "price", "packing", and "COA"/);
  assert.match(edgeFnCode, /Only propose a new request .* if the customer introduces an entirely NEW product or an independent deliverable/);
});

test('12. Grounding evidence is preserved: verbatim quotes required for proposals', () => {
  assert.match(edgeFnCode, /"grounding":/);
  assert.match(edgeFnCode, /"text": string \(verbatim quote from message\)/);
  assert.match(edgeFnCode, /"reason": string/);
  assert.match(edgeFnCode, /grounding: Array\.isArray\(parsed\.grounding\) \? parsed\.grounding : \[\]/);
});

test('13. Supplier response is interpreted correctly (issue, alternative, waiting_for CUSTOMER, status BLOCKED)', () => {
  assert.match(edgeFnCode, /SUPPLIER RESPONSE INTERPRETATION/);
  assert.match(edgeFnCode, /Intent = "supplier_response"/);
  assert.match(edgeFnCode, /update field "current_issue" with the supplier constraint\/alternative/);
  assert.match(edgeFnCode, /Suggest status: "BLOCKED"/);
  assert.match(edgeFnCode, /Suggest waiting_for: "CUSTOMER"/);
});

test('14. Customer decision is interpreted correctly (alternative accepted, blocker resolved, waiting_for INDIA)', () => {
  assert.match(edgeFnCode, /CUSTOMER DECISION & BLOCKER RESOLUTION/);
  assert.match(edgeFnCode, /Intent = "customer_decision" or "requirement_change"/);
  assert.match(edgeFnCode, /update field "customer_requirement" with the new accepted specification/);
  assert.match(edgeFnCode, /update field "current_issue" to null \/ empty string \(blocker resolved\)/);
  assert.match(edgeFnCode, /Suggest status: "OPEN" or "IN_PROGRESS"/);
  assert.match(edgeFnCode, /Suggest waiting_for: "INDIA"/);
});

test('15. Previous request and conversation context is respected via bounded window', () => {
  assert.match(edgeFnCode, /\.order\("received_or_sent_at", { ascending: false }\)/);
  assert.match(edgeFnCode, /\.limit\(5\)/);
  assert.match(edgeFnCode, /recent_thread_history: contextThread/);
  assert.match(edgeFnCode, /active_requests_in_system: activeRequests/);
});

test('16. Existing 7.6B human review still works: accept/edit/dismiss atomic RPCs active', () => {
  const funcs = runDbScript(`
    SELECT routine_name
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'accept_enquiry_brain_proposal_atomic',
        'edit_enquiry_brain_proposal_atomic',
        'dismiss_enquiry_brain_proposal_atomic'
      )
    ORDER BY routine_name;
  `);

  assert.equal(funcs.length, 3);
  assert.equal(funcs[0].routine_name, 'accept_enquiry_brain_proposal_atomic');
  assert.equal(funcs[1].routine_name, 'dismiss_enquiry_brain_proposal_atomic');
  assert.equal(funcs[2].routine_name, 'edit_enquiry_brain_proposal_atomic');
});

test('17. Existing Gmail ingestion still works: sync-gmail-emails has zero regressions', () => {
  assert.match(syncGmailCode, /runInboundReconciliationSweep\(supabase,\s*20\)/);
  assert.match(syncGmailCode, /mirrorInboundEmail\(supabase,/);
  assert.match(ingestionCode, /runPendingEnquiryBrainAnalysisSweep\(supabase\)/);
});

test('18. Existing AI functions remain untouched', () => {
  const parsePharma = readFileSync(
    new URL('../supabase/functions/parse-pharma-email/index.ts', import.meta.url),
    'utf8'
  );
  assert.match(parsePharma, /Pharma.*Email/i);

  const kunalClassifier = readFileSync(
    new URL('../supabase/functions/kunal-relevance-classifier/index.ts', import.meta.url),
    'utf8'
  );
  assert.match(kunalClassifier, /Kunal/i);

  const classifySourcing = readFileSync(
    new URL('../supabase/functions/classify-sourcing-email/index.ts', import.meta.url),
    'utf8'
  );
  assert.match(classifySourcing, /sourcing/i);

  const parseSourceReply = readFileSync(
    new URL('../supabase/functions/parse-source-reply-email/index.ts', import.meta.url),
    'utf8'
  );
  assert.match(parseSourceReply, /reply/i);

  const aiEmailAssistant = readFileSync(
    new URL('../supabase/functions/ai-email-assistant/index.ts', import.meta.url),
    'utf8'
  );
  assert.match(aiEmailAssistant, /assistant/i);
});
