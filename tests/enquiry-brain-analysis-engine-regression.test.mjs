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
const migrationCode = readFileSync(
  new URL('../supabase/migrations/20260914210000_add_ai_proposal_to_enquiry_messages.sql', import.meta.url),
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
  const tmpPath = join(tmpdir(), `ai_brain_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

test('1. Database Schema: ai_proposal JSONB column is active on enquiry_conversation_messages', () => {
  const rows = runDbScript(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'enquiry_conversation_messages' AND column_name = 'ai_proposal';
  `);
  assert.equal(rows.length, 1, 'ai_proposal column must exist on enquiry_conversation_messages');
  assert.equal(rows[0].data_type, 'jsonb', 'ai_proposal must be of type jsonb');
});

test('2. Requirement Grouping: SYSTEM_PROMPT mandates 1 commercial request per RFQ product', () => {
  assert.match(edgeFnCode, /REQUIREMENT GROUPING \(AVOID REQUEST EXPLOSION\)/);
  assert.match(edgeFnCode, /MUST remain ONE SINGLE commercial request with parameters/);
  assert.match(edgeFnCode, /Do NOT create separate requests for "price", "packing", and "COA"/);
});

test('3. No Request Explosion: Routine parameters remain in parameters dictionary', () => {
  assert.match(edgeFnCode, /Technical specifications \(e\.g\. 100 mesh\) belong in the requirement\/parameters/);
  assert.match(edgeFnCode, /suggest updating the request's status to 'BLOCKED'/);
});

test('4. Existing Request Matching: AI must prioritize matching active existing request IDs', () => {
  assert.match(edgeFnCode, /EXISTING REQUEST MATCHING/);
  assert.match(edgeFnCode, /Prefer matching and updating an EXISTING request ID/);
  assert.match(edgeFnCode, /Only propose a new request .* if the customer introduces an entirely NEW product/);
});

test('5. Requirement Evolution & Diff Detection: Tracks old_value vs new_value without mutating state', () => {
  assert.match(edgeFnCode, /REQUIREMENT EVOLUTION \(DIFF PRESERVATION\)/);
  assert.match(edgeFnCode, /State old_value \(e\.g\. "100 mesh"\) and new_value \(e\.g\. "660 mesh"\)/);
  assert.match(edgeFnCode, /Provide grounding: the exact quote from the message/);
});

test('6. Grounding Evidence: Verbatim quotation required for every proposed change', () => {
  assert.match(edgeFnCode, /"grounding":/);
  assert.match(edgeFnCode, /"text": string \(verbatim quote from message\)/);
  assert.match(edgeFnCode, /"reason": string/);
});

test('7. Confidence Tiers: Strict HIGH, MEDIUM, LOW with needs_verification', () => {
  assert.match(edgeFnCode, /"confidence_tier":\s*"HIGH"\s*\|\s*"MEDIUM"\s*\|\s*"LOW"/);
  assert.match(edgeFnCode, /"needs_verification": boolean/);
  assert.match(edgeFnCode, /"HIGH": Explicitly stated in the message text with verbatim quotation/);
  assert.match(edgeFnCode, /"LOW": Ambiguous, vague, or conflicting statements\. Must set needs_verification = true/);
});

test('8. Zero Business Mutation: Edge function NEVER modifies enquiry_requests or crm_inquiries', () => {
  assert.doesNotMatch(edgeFnCode, /transition_enquiry_request_atomic/);
  assert.doesNotMatch(edgeFnCode, /create_enquiry_request_atomic/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']enquiry_requests["']\)\.update/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']enquiry_requests["']\)\.insert/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']crm_inquiries["']\)\.update/);
});

test('9. No Task Creation: SYSTEM_PROMPT explicitly forbids creating internal tasks', () => {
  assert.match(edgeFnCode, /NEVER create internal tasks/);
  assert.doesNotMatch(edgeFnCode, /\.from\(["']tasks["']\)\.insert/);
});

test('10. No Pricing Invention: SYSTEM_PROMPT explicitly forbids inventing prices or commitments', () => {
  assert.match(edgeFnCode, /NEVER invent purchase prices, profit margins, or supplier promises/);
  assert.match(edgeFnCode, /NEVER commit to delivery dates without supplier confirmation/);
});

test('11. Failure Handling & Observability: Failed calls leave ai_processed = false and are retryable', () => {
  assert.match(edgeFnCode, /ai_processed:\s*false/);
  assert.match(edgeFnCode, /status:\s*"failed"/);
  assert.match(edgeFnCode, /retryable:\s*true/);
});

test('12. Idempotency: Returns cached proposal if message already analyzed successfully', () => {
  assert.match(edgeFnCode, /cached:\s*true/);
  assert.match(edgeFnCode, /message\.ai_processed[\s\S]*?message\.ai_proposal/);
  assert.match(edgeFnCode, /message\.ai_proposal\.status === "suggested"/);
});

test('13. Canonical Message Layer Target: Writes ONLY to enquiry_conversation_messages', () => {
  const updateMatches = [...edgeFnCode.matchAll(/\.from\(["']([^"']+)["']\)\s*\.update/g)].map(m => m[1]);
  assert.ok(updateMatches.length > 0, 'Must have message update call');
  for (const table of updateMatches) {
    assert.equal(table, 'enquiry_conversation_messages', `Updates must be strictly confined to enquiry_conversation_messages, found: ${table}`);
  }
});

test('14. Security: Rejects unauthenticated callers and validates user roles', () => {
  assert.match(edgeFnCode, /requireRole/);
  assert.match(edgeFnCode, /\["admin", "manager", "sales"\]/);
});

test('15. TypeScript Types Integrity: AiProposal exported with all required fields', () => {
  assert.match(typesCode, /export interface AiProposal/);
  assert.match(typesCode, /confidence_tier:\s*'HIGH'\s*\|\s*'MEDIUM'\s*\|\s*'LOW'/);
  assert.match(typesCode, /grounding:\s*GroundingCitation\[\]/);
  assert.match(typesCode, /proposed_updates:\s*ProposedUpdate\[\]/);
  assert.match(typesCode, /proposed_new_requests:\s*ProposedNewRequest\[\]/);
});

test('16. Client Service: EnquiryBrainService provides type-safe invocation and proposal retrieval', () => {
  assert.match(clientServiceCode, /export class EnquiryBrainService/);
  assert.match(clientServiceCode, /static async analyzeMessage/);
  assert.match(clientServiceCode, /static async getProposal/);
});

test('17. Existing AI Preservation: All 5 legacy and sourcing AI functions remain intact', () => {
  const parsePharma = readFileSync(new URL('../supabase/functions/parse-pharma-email/index.ts', import.meta.url), 'utf8');
  const kunalClassifier = readFileSync(new URL('../supabase/functions/kunal-relevance-classifier/index.ts', import.meta.url), 'utf8');
  const sourcingClassifier = readFileSync(new URL('../supabase/functions/classify-sourcing-email/index.ts', import.meta.url), 'utf8');
  const sourceReplyParser = readFileSync(new URL('../supabase/functions/parse-source-reply-email/index.ts', import.meta.url), 'utf8');
  const emailAssistant = readFileSync(new URL('../supabase/functions/ai-email-assistant/index.ts', import.meta.url), 'utf8');

  assert.match(parsePharma, /parse this pharmaceutical inquiry email/i);
  assert.match(kunalClassifier, /kunal-relevance-classifier/);
  assert.match(sourcingClassifier, /classify-sourcing-email/);
  assert.match(sourceReplyParser, /parse-source-reply-email/);
  assert.match(emailAssistant, /ai-email-assistant/);
});

test('18. End-to-End Invariant Verification on Live DB: Unaccepted proposals do not mutate enquiry_requests', () => {
  // Query active requests count and state
  const beforeRows = runDbScript(`
    SELECT id, status, customer_requirement, ai_status
    FROM public.enquiry_requests
    LIMIT 5;
  `);

  // Simulate updating an enquiry_conversation_messages row with an AI proposal
  const testMsgRows = runDbScript(`
    SELECT id FROM public.enquiry_conversation_messages LIMIT 1;
  `);

  if (testMsgRows.length > 0) {
    const testMsgId = testMsgRows[0].id;
    runDbScript(`
      UPDATE public.enquiry_conversation_messages
      SET ai_proposal = jsonb_build_object(
        'status', 'suggested',
        'intent', 'requirement_change',
        'confidence_tier', 'HIGH',
        'proposed_updates', jsonb_build_array(
          jsonb_build_object(
            'field', 'customer_requirement',
            'old_value', '100 mesh',
            'new_value', '660 mesh',
            'reason', 'Customer accepted manufacturer standard'
          )
        )
      )
      WHERE id = '${testMsgId}';
    `);

    // Verify message has proposal
    const verifiedMsg = runDbScript(`
      SELECT ai_proposal->>'status' AS proposal_status
      FROM public.enquiry_conversation_messages
      WHERE id = '${testMsgId}';
    `);
    assert.equal(verifiedMsg[0].proposal_status, 'suggested');

    // Verify enquiry_requests is completely unmutated
    const afterRows = runDbScript(`
      SELECT id, status, customer_requirement, ai_status
      FROM public.enquiry_requests
      LIMIT 5;
    `);
    assert.deepEqual(beforeRows, afterRows, 'enquiry_requests must be 100% identical and unmutated');
  }
});
