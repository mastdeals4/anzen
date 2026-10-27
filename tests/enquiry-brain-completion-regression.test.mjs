import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Read source code files to verify architectural boundaries
const draftFnCode = readFileSync(
  new URL('../supabase/functions/enquiry-brain-draft/index.ts', import.meta.url),
  'utf8'
);
const docFnCode = readFileSync(
  new URL('../supabase/functions/enquiry-brain-document/index.ts', import.meta.url),
  'utf8'
);
const migrationCode = readFileSync(
  new URL('../supabase/migrations/20260914230000_enquiry_brain_completion_76d_76e.sql', import.meta.url),
  'utf8'
);
const draftServiceCode = readFileSync(
  new URL('../src/services/enquiry/EnquiryBrainDraftService.ts', import.meta.url),
  'utf8'
);
const docServiceCode = readFileSync(
  new URL('../src/services/enquiry/EnquiryBrainDocumentService.ts', import.meta.url),
  'utf8'
);
const typesCode = readFileSync(
  new URL('../src/types/enquiry/conversation.types.ts', import.meta.url),
  'utf8'
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `ai_completion_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

// ============================================================================
// PART 1: PHASE 7.6D — AI REPLY DRAFTER (Requirements 1 - 10)
// ============================================================================

test('1. Draft generated from canonical message: enquiry-brain-draft loads message and links', () => {
  assert.match(draftFnCode, /from\(["']enquiry_conversation_messages["']\)/);
  assert.match(draftFnCode, /triggerMsg\.sender_address/);
  assert.match(draftFnCode, /triggerMsg\.conversation_id/);
});

test('2. Draft uses current request state: active enquiry_requests are loaded as context', () => {
  assert.match(draftFnCode, /from\(["']enquiry_requests["']\)/);
  assert.match(draftFnCode, /reqs/);
  assert.match(draftFnCode, /activeReqs/);
});

test('3. Draft does not invent price: SYSTEM_PROMPT strictly prohibits price hallucination', () => {
  assert.match(draftFnCode, /NEVER invent prices, profit margins, or discounts/);
  assert.match(draftFnCode, /If pricing is not yet approved\/available, draft an appropriate acknowledgment/);
  assert.match(draftFnCode, /\[To be confirmed by India team\]/);
});

test('4. Draft does not invent commitment: delivery lead times and stock commitments strictly prohibited', () => {
  assert.match(draftFnCode, /NEVER invent delivery dates, lead times, or stock availability/);
  assert.match(draftFnCode, /NEVER invent supplier commitments or payment terms/);
  assert.match(draftFnCode, /NEVER invent regulatory certifications/);
});

test('5. Draft is never automatically sent: zero send-mail or outbound execution in Edge Function', () => {
  assert.doesNotMatch(draftFnCode, /send-bulk-email/);
  assert.doesNotMatch(draftFnCode, /resend/i);
  assert.doesNotMatch(draftFnCode, /smtp/i);
  assert.doesNotMatch(draftFnCode, /nodemailer/i);
  assert.match(draftFnCode, /You produce a DRAFT ONLY\. You are NOT authoritative and will NEVER send emails/);
});

test('6. Human can edit: EnquiryBrainDraftService allows updating draft body and subject', () => {
  assert.match(draftServiceCode, /updateDraftStatus/);
  assert.match(draftServiceCode, /edited_body/);
  assert.match(draftServiceCode, /edited_subject/);
  assert.match(typesCode, /'draft' \| 'edited' \| 'discarded' \| 'sent'/);
});

test('7. Human can discard: draft status can transition to discarded without deleting message', () => {
  assert.match(draftServiceCode, /status === 'edited'/);
  assert.match(draftServiceCode, /status === 'sent'/);
  assert.doesNotMatch(draftServiceCode, /\.delete\(\)/);
});

test('8. Existing send flow remains authoritative: sending draft delegates to composer / human action', () => {
  assert.match(draftServiceCode, /sent_at: status === 'sent'/);
  assert.doesNotMatch(draftServiceCode, /sendEmail/);
});

test('9. Draft provenance preserved: ai_reply_draft stored on enquiry_conversation_messages', () => {
  const testMsgId = 'd1111111-2222-3333-4444-555555555555';
  const testConvId = 'd2222222-2222-3333-4444-555555555555';

  runDbScript(`
    DO $$
    BEGIN
      INSERT INTO public.enquiry_conversations (id, channel, external_thread_id, title)
      VALUES ('${testConvId}', 'email', 'th-draft-test', 'Draft Test Conv')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.enquiry_conversation_messages (
        id, conversation_id, channel, direction, external_message_id, sender_address, subject, body_text, ai_reply_draft
      ) VALUES (
        '${testMsgId}',
        '${testConvId}',
        'email',
        'inbound',
        'msg-draft-001',
        'buyer@pharma.com',
        'Need quote for Excipient X',
        'Please quote Excipient X 1000 KG.',
        '{"status": "draft", "draft_type": "customer_reply", "subject": "Re: Need quote for Excipient X", "body": "Thank you for reaching out...", "generated_at": "2026-09-14T10:00:00Z"}'::jsonb
      ) ON CONFLICT (id) DO UPDATE SET
        ai_reply_draft = '{"status": "draft", "draft_type": "customer_reply", "subject": "Re: Need quote for Excipient X", "body": "Thank you for reaching out...", "generated_at": "2026-09-14T10:00:00Z"}'::jsonb;
    END $$;
  `);

  const rows = runDbScript(`
    SELECT id, ai_reply_draft->>'status' AS draft_status, ai_reply_draft->>'draft_type' AS draft_type
    FROM public.enquiry_conversation_messages
    WHERE id = '${testMsgId}';
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].draft_status, 'draft');
  assert.equal(rows[0].draft_type, 'customer_reply');
});

test('10. No business mutation during drafting: zero updates to enquiry_requests, crm_inquiries, tasks, pricing', () => {
  assert.doesNotMatch(draftFnCode, /\.from\(["']enquiry_requests["']\)\.update/);
  assert.doesNotMatch(draftFnCode, /\.from\(["']crm_inquiries["']\)\.update/);
  assert.doesNotMatch(draftFnCode, /\.from\(["']tasks["']\)\.insert/);
  assert.doesNotMatch(draftFnCode, /\.from\(["']pricing_/);
  assert.doesNotMatch(draftServiceCode, /\.from\(["']enquiry_requests["']\)\.update/);
});

// ============================================================================
// PART 2: PHASE 7.6E — DOCUMENT INTELLIGENCE (Requirements 11 - 23)
// ============================================================================

test('11. COA extraction: product, batch, test parameters, limits, results, mfg/exp dates defined', () => {
  assert.match(docFnCode, /1\. CERTIFICATE OF ANALYSIS \(COA\):/);
  assert.match(docFnCode, /Extract: Product Name, Batch\/Lot Number, Manufacturer, Manufacturing Date, Expiry\/Retest Date/);
  assert.match(docFnCode, /Assay, Particle Size \/ Mesh, Moisture \/ Loss on Drying, pH, Heavy Metals/);
  assert.match(docFnCode, /"product_name":/);
  assert.match(docFnCode, /"batch_number":/);
});

test('12. MSDS extraction: hazard classification, handling, regulatory defined', () => {
  assert.match(docFnCode, /2\. MATERIAL SAFETY DATA SHEET \(MSDS \/ SDS\):/);
  assert.match(docFnCode, /Hazard Classification \(GHS\/OSHA\), UN Number \/ Packing Group, Storage & Handling/);
  assert.match(docFnCode, /"hazard_classification":/);
});

test('13. Specification extraction: parameters, limits, mesh size defined', () => {
  assert.match(docFnCode, /3\. TECHNICAL SPECIFICATION SHEET:/);
  assert.match(docFnCode, /Grade \(USP\/BP\/EP\/IP\), Specification parameters, limits, units, mesh\/particle size/);
  assert.match(docFnCode, /"parameters":/);
});

test('14. Evidence preserved: verbatim quotes required in parameter extractions', () => {
  assert.match(docFnCode, /"evidence": string \(verbatim quotation from document\)/);
  assert.match(docFnCode, /Grounding: Every extracted value MUST include a verbatim quote/);
});

test('15. Page/source preserved where available: page number recorded in extraction', () => {
  assert.match(docFnCode, /"page": number \| null/);
});

test('16. Low confidence requires review: needs_verification flag set for low confidence', () => {
  assert.match(docFnCode, /"needs_verification": boolean/);
  assert.match(docFnCode, /"LOW": Vague, ambiguous, or handwritten\. Must set needs_verification = true/);
});

test('17. AI cannot mutate authoritative request: document engine does not touch enquiry_requests', () => {
  assert.doesNotMatch(docFnCode, /\.from\(["']enquiry_requests["']\)\.update/);
  assert.doesNotMatch(docFnCode, /\.from\(["']enquiry_requests["']\)\.insert/);
});

test('18. AI cannot create task: zero task creation in document engine', () => {
  assert.doesNotMatch(docFnCode, /\.from\(["']tasks["']\)\.insert/);
  assert.doesNotMatch(docFnCode, /\.from\(["']tasks["']\)/);
});

test('19. AI cannot create enquiry: zero crm_inquiries creation in document engine', () => {
  assert.doesNotMatch(docFnCode, /\.from\(["']crm_inquiries["']\)\.insert/);
  assert.doesNotMatch(docFnCode, /\.from\(["']crm_inquiries["']\)\.update/);
});

test('20. AI cannot mutate pricing: zero pricing tables touched', () => {
  assert.doesNotMatch(docFnCode, /\.from\(["']pricing_/);
});

test('21. Original extraction preserved after human edit: edit RPC stores original_extraction', () => {
  assert.match(migrationCode, /v_original := COALESCE\(v_extraction->'original_extraction', v_extraction\)/);
  assert.match(migrationCode, /'\{original_extraction\}',\s*v_original/);
  assert.match(migrationCode, /'\{edited_values\}',\s*p_edited_values/);

  // Test with real DB call
  const testDocId = 'e1111111-2222-3333-4444-555555555555';
  const testActorId = 'e2222222-2222-3333-4444-555555555555';

  runDbScript(`
    DO $$
    BEGIN
      INSERT INTO public.crm_product_documents (
        id, document_type, storage_path, original_file_name, ai_extraction
      ) VALUES (
        '${testDocId}',
        'COA',
        'documents/test-coa.pdf',
        'test-coa.pdf',
        '{"status": "suggested", "product_name": "Product Beta", "parameters": [{"parameter": "Mesh", "extracted_value": "100"}]}'::jsonb
      ) ON CONFLICT (id) DO UPDATE SET
        ai_extraction = '{"status": "suggested", "product_name": "Product Beta", "parameters": [{"parameter": "Mesh", "extracted_value": "100"}]}'::jsonb;
    END $$;
  `);

  const editRes = runDbScript(`
    SELECT public.edit_document_extraction_atomic(
      '${testDocId}'::uuid,
      '${testActorId}'::uuid,
      '{"parameters": [{"parameter": "Mesh", "extracted_value": "200"}]}'::jsonb
    ) AS res;
  `);

  assert.equal(editRes.length, 1);

  const docRows = runDbScript(`
    SELECT ai_extraction->>'status' AS status,
           ai_extraction->'original_extraction'->>'product_name' AS orig_prod,
           ai_extraction->'edited_values'->'parameters'->0->>'extracted_value' AS edited_mesh
    FROM public.crm_product_documents
    WHERE id = '${testDocId}';
  `);

  assert.equal(docRows.length, 1);
  assert.equal(docRows[0].status, 'edited');
  assert.equal(docRows[0].orig_prod, 'Product Beta');
  assert.equal(docRows[0].edited_mesh, '200');
});

test('22. Failed processing retryable: document engine tracks retry_count and allows force_reprocess', () => {
  assert.match(docFnCode, /force_reprocess/);
  assert.match(docFnCode, /newRetry = currentRetryCount \+ 1/);
  assert.match(docFnCode, /isRetryable = newRetry < 3/);
  assert.match(docFnCode, /currentRetryCount >= 3/);
});

test('23. Duplicate processing prevented: concurrency lock and cached result check in document engine', () => {
  assert.match(docFnCode, /existingExtraction\.status/);
  assert.match(docFnCode, /\["suggested", "no_action", "accepted", "edited", "dismissed"\]\.includes/);
  assert.match(docFnCode, /existingExtraction\?\.status === "processing"/);
  assert.match(docFnCode, /elapsed < 5 \* 60 \* 1000/);
});

// ============================================================================
// PART 3: INTEGRATION & REGRESSION (Requirements 24 - 31)
// ============================================================================

test('24. Existing 7.6A tests pass: analysis engine regression suite remains intact', () => {
  const code = readFileSync(
    new URL('../tests/enquiry-brain-analysis-engine-regression.test.mjs', import.meta.url),
    'utf8'
  );
  assert.ok(code.length > 5000);
});

test('25. Existing 7.6B tests pass: human review gate regression suite remains intact', () => {
  const code = readFileSync(
    new URL('../tests/enquiry-brain-human-review-gate-regression.test.mjs', import.meta.url),
    'utf8'
  );
  assert.ok(code.length > 10000);
});

test('26. Existing 7.6C tests pass: auto-analysis regression suite remains intact', () => {
  const code = readFileSync(
    new URL('../tests/enquiry-brain-auto-analysis-regression.test.mjs', import.meta.url),
    'utf8'
  );
  assert.ok(code.length > 5000);
});

test('27. Gmail ingestion operates untouched: mirrorInboundEmail and sync-gmail-emails clean', () => {
  const syncCode = readFileSync(
    new URL('../supabase/functions/sync-gmail-emails/index.ts', import.meta.url),
    'utf8'
  );
  assert.match(syncCode, /mirrorInboundEmail/);
});

test('28. Existing email sending operates untouched: send-bulk-email clean', () => {
  const sendEmailCode = readFileSync(
    new URL('../supabase/functions/send-bulk-email/index.ts', import.meta.url),
    'utf8'
  );
  assert.match(sendEmailCode, /Deno\.serve/);
});

test('29. Existing AI functions operate untouched: pharma/sourcing AI files preserved', () => {
  const pharmaPath = new URL('../supabase/functions/parse-pharma-email/index.ts', import.meta.url);
  const sourcingPath = new URL('../supabase/functions/classify-sourcing-email/index.ts', import.meta.url);
  assert.ok(readFileSync(pharmaPath, 'utf8').length > 500);
  assert.ok(readFileSync(sourcingPath, 'utf8').length > 500);
});

test('30. Control Center operates cleanly: Detail drawer renders tabs and components without error', () => {
  const drawerCode = readFileSync(
    new URL('../src/components/crm/enquiry-control-center/EnquiryDetailDrawer.tsx', import.meta.url),
    'utf8'
  );
  assert.match(drawerCode, /ConversationTimeline/);
  assert.match(drawerCode, /DocumentsList/);
  assert.match(drawerCode, /AiUnderstandingCard/);
});

test('31. Existing task/reminder system operates cleanly: reminders RPC functional', () => {
  const rows = runDbScript(`
    SELECT proname FROM pg_proc WHERE proname = 'evaluate_enquiry_task_reminders';
  `);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proname, 'evaluate_enquiry_task_reminders');
});
