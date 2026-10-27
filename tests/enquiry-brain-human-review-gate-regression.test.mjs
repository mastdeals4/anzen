import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync, exec } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const drawerCode = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryDetailDrawer.tsx', import.meta.url),
  'utf8'
);
const cardCode = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/AiUnderstandingCard.tsx', import.meta.url),
  'utf8'
);
const modalCode = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EditAiProposalModal.tsx', import.meta.url),
  'utf8'
);
const brainServiceCode = readFileSync(
  new URL('../src/services/enquiry/EnquiryBrainService.ts', import.meta.url),
  'utf8'
);
const typesCode = readFileSync(
  new URL('../src/types/enquiry/conversation.types.ts', import.meta.url),
  'utf8'
);
const hardeningRpcCode = readFileSync(
  new URL('../supabase/migrations/20260914220000_enquiry_brain_review_gate_hardening.sql', import.meta.url),
  'utf8'
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `ai_gate_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmpPath, sql, 'utf8');
  try {
    const cmd = `npx supabase db query --linked --file "${tmpPath}"`;
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const jsonStart = output.indexOf('{');
    if (jsonStart === -1) {
      throw new Error(`No JSON found in output: ${output}`);
    }
    const jsonEnd = output.lastIndexOf('}');
    const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
    return parsed.rows || [];
  } catch (err) {
    const msg = err.stderr || err.stdout || err.message;
    throw new Error(`Database query failed: ${msg}`);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

function runDbScriptAsync(sql) {
  return new Promise((resolve) => {
    const tmpPath = join(tmpdir(), `ai_gate_async_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
    writeFileSync(tmpPath, sql, 'utf8');
    const cmd = `npx supabase db query --linked --file "${tmpPath}"`;
    exec(cmd, { encoding: 'utf8' }, (err, stdout, stderr) => {
      try { unlinkSync(tmpPath); } catch {}
      if (err) {
        resolve({ success: false, error: (stderr || '') + '\n' + (stdout || '') + '\n' + err.message });
      } else {
        try {
          const jsonStart = stdout.indexOf('{');
          const jsonEnd = stdout.lastIndexOf('}');
          const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
          resolve({ success: true, rows: parsed.rows || [] });
        } catch (parseErr) {
          resolve({ success: false, error: stdout });
        }
      }
    });
  });
}

test('1. Drawer Integration: Suggested proposal appears in drawer when status === suggested', () => {
  assert.match(drawerCode, /m\.ai_proposal && m\.ai_proposal\.status === 'suggested'/);
  assert.match(drawerCode, /<AiUnderstandingCard/);
  assert.match(drawerCode, /pendingAiProposals\.map/);
});

test('2. HIGH Evidence Confidence UX: Renders "Grounded in message" badge with 1-click Accept', () => {
  assert.match(cardCode, /isHigh[\s\S]*?Grounded in message/);
  assert.match(cardCode, /bg-emerald-600 hover:bg-emerald-700/);
});

test('3. LOW Confidence UX: Renders "Needs verification" and prompts confirmation/verification', () => {
  assert.match(cardCode, /Needs verification/);
  assert.match(cardCode, /Low confidence or ambiguous text\. Please click/);
  assert.match(cardCode, /This AI proposal has LOW confidence or ambiguous text/);
});

test('4. Accept Updates via accept_enquiry_brain_proposal_atomic RPC with transactional stale protection', () => {
  assert.match(brainServiceCode, /supabase\.rpc\('accept_enquiry_brain_proposal_atomic'/);
  assert.match(brainServiceCode, /p_message_id:\s*messageId/);
  assert.match(brainServiceCode, /p_inquiry_id:\s*inquiryId/);
  assert.match(hardeningRpcCode, /CREATE OR REPLACE FUNCTION public\.accept_enquiry_brain_proposal_atomic/);
  assert.match(hardeningRpcCode, /FOR UPDATE/);
});

test('5. Event Audit Trail: Immutable enquiry_request_events record is appended', () => {
  assert.match(hardeningRpcCode, /INSERT INTO public\.enquiry_request_events/);
  assert.match(hardeningRpcCode, /'decision',\s*'accepted'/);
  assert.match(hardeningRpcCode, /'original_proposal'/);
});

test('6. Event Identifies Human Approver: actor_type = user and actor_id = user.id', () => {
  assert.match(brainServiceCode, /p_actor_type:\s*'user'/);
  assert.match(brainServiceCode, /p_actor_id:\s*user\.id/);
  assert.match(hardeningRpcCode, /v_effective_actor_type := 'user'/);
  assert.match(hardeningRpcCode, /v_effective_actor_id := v_caller_auth_uid/);
});

test('7. Edit Applies Human-Corrected Values: Saves edited fields via atomic RPC and records status = edited', () => {
  assert.match(brainServiceCode, /supabase\.rpc\('edit_enquiry_brain_proposal_atomic'/);
  assert.match(brainServiceCode, /p_edited_values:\s*editedValues/);
  assert.match(hardeningRpcCode, /CREATE OR REPLACE FUNCTION public\.edit_enquiry_brain_proposal_atomic/);
  assert.match(hardeningRpcCode, /ai_status = 'edited'/);
});

test('8. Original AI Proposal Preserved: original_proposal snapshot is preserved across all states', () => {
  assert.match(hardeningRpcCode, /'original_proposal',\s*v_proposal/);
  assert.match(typesCode, /original_proposal\?:\s*Record<string,\s*unknown>\s*\|\s*null/);
});

test('9. Dismiss Changes No Business State: Atomic dismiss mutates zero requests, inquiries, or tasks', () => {
  assert.match(brainServiceCode, /supabase\.rpc\('dismiss_enquiry_brain_proposal_atomic'/);
  const dismissSection = hardeningRpcCode.slice(hardeningRpcCode.indexOf('CREATE OR REPLACE FUNCTION public.dismiss_enquiry_brain_proposal_atomic'));
  assert.doesNotMatch(dismissSection, /INSERT INTO public\.enquiry_requests/);
  assert.doesNotMatch(dismissSection, /UPDATE public\.enquiry_requests/);
  assert.doesNotMatch(dismissSection, /UPDATE public\.crm_inquiries/);
  assert.doesNotMatch(dismissSection, /INSERT INTO public\.tasks/);
});

test('10. New-Request Proposals: Created only through atomic RPC on human approval, zero tasks', () => {
  assert.match(hardeningRpcCode, /v_proposal \? 'proposed_new_requests'/);
  assert.match(hardeningRpcCode, /INSERT INTO public\.enquiry_requests/);
  assert.doesNotMatch(hardeningRpcCode, /INSERT INTO public\.tasks/);
});

test('11. No Automatic Task Creation: Accept never calls task creation functions or inserts into tasks', () => {
  assert.doesNotMatch(brainServiceCode, /\.from\(['"]tasks['"]\)\.insert/);
  assert.doesNotMatch(cardCode, /createTask/i);
  assert.doesNotMatch(hardeningRpcCode, /INSERT INTO public\.tasks/);
});

test('12. Stale Proposal Protection: Database RPC raises STALE_PROPOSAL and UI displays friendly alert', () => {
  assert.match(hardeningRpcCode, /RAISE EXCEPTION 'STALE_PROPOSAL:/);
  assert.match(brainServiceCode, /STALE_PROPOSAL/);
  assert.match(brainServiceCode, /Request changed since this AI suggestion was created\. Please review again\./);
  assert.match(cardCode, /Cannot Apply Suggestion:/);
});

test('13. Concurrency Idempotency: Single-claim lock rejects duplicate accept operations', () => {
  assert.match(hardeningRpcCode, /RAISE EXCEPTION 'PROPOSAL_ALREADY_PROCESSED:/);
  assert.match(brainServiceCode, /PROPOSAL_ALREADY_PROCESSED/);
  assert.match(brainServiceCode, /AI proposal has already been processed\./);
});

test('14. Anti-Spoofing Security: Server-side RPC rejects browser attempts to impersonate AI or other users', () => {
  assert.match(hardeningRpcCode, /IF p_actor_type IS NOT NULL AND p_actor_type <> 'user' THEN/);
  assert.match(hardeningRpcCode, /RAISE EXCEPTION 'Unauthorized: authenticated users cannot impersonate AI or system'/);
  assert.match(hardeningRpcCode, /IF p_actor_id IS NOT NULL AND p_actor_id <> v_caller_auth_uid THEN/);
});

test('15. Commercial Pricing Protection: Zero pricing inputs or mutation in AI review card or modal', () => {
  assert.doesNotMatch(cardCode, /purchase_price/);
  assert.doesNotMatch(cardCode, /offered_price/);
  assert.doesNotMatch(modalCode, /purchase_price/);
  assert.doesNotMatch(modalCode, /offered_price/);
});

test('16. Preservation of crm_inquiries: Neither Accept nor Dismiss mutates crm_inquiries table', () => {
  assert.doesNotMatch(brainServiceCode, /\.from\(['"]crm_inquiries['"]\)\.update/);
  assert.doesNotMatch(hardeningRpcCode, /UPDATE public\.crm_inquiries/);
});

test('17. Existing AI Systems Untouched: All legacy and sourcing AI functions remain intact', () => {
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

test('18. Live DB Test: Freshness race condition is rejected inside the database transaction', () => {
  const setupSql = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_conv_id UUID;
      v_msg_id UUID;
      v_req_id UUID;
      v_proposal JSONB;
    BEGIN
      -- Create test inquiry
      INSERT INTO public.crm_inquiries (inquiry_number, product_name, company_name, contact_person, quantity)
      VALUES ('INQ-TEST-RACE-' || floor(random()*1000)::text, 'Test Product', 'Race Corp', 'Alice', '500 KG')
      RETURNING id INTO v_inq_id;

      -- Create test conversation
      INSERT INTO public.enquiry_conversations (title, channel)
      VALUES ('Freshness Conv', 'email')
      RETURNING id INTO v_conv_id;

      -- Create target request with 100 mesh
      INSERT INTO public.enquiry_requests (
        inquiry_id, category, request_code, title, customer_requirement, status, waiting_for
      ) VALUES (
        v_inq_id, 'technical', 'REQ-RACE-' || floor(random()*1000)::text, 'Mesh Req', 'Initial 100 mesh', 'OPEN', 'CUSTOMER'
      ) RETURNING id INTO v_req_id;

      -- Build proposal expecting 'Initial 100 mesh'
      v_proposal := jsonb_build_object(
        'status', 'suggested',
        'intent', 'requirement_change',
        'confidence_tier', 'HIGH',
        'summary', 'Change to 660 mesh',
        'proposed_updates', jsonb_build_array(
          jsonb_build_object(
            'request_id', v_req_id,
            'field', 'customer_requirement',
            'old_value', 'Initial 100 mesh',
            'new_value', 'Proposed 660 mesh',
            'reason', 'Customer requested standard mesh'
          )
        )
      );

      -- Insert message with proposal
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, sender_address, subject, body_text, ai_proposal
      ) VALUES (
        v_conv_id, 'email', 'inbound', 'alice@race.com', 'Mesh Update', '660 mesh is ok', v_proposal
      ) RETURNING id INTO v_msg_id;

      -- Simulate concurrent human change: another user updates requirement to 200 mesh!
      UPDATE public.enquiry_requests
      SET customer_requirement = 'Modified 200 mesh by human'
      WHERE id = v_req_id;

      -- Now attempt to accept the proposal via atomic RPC; it MUST raise STALE_PROPOSAL!
      BEGIN
        PERFORM public.accept_enquiry_brain_proposal_atomic(
          p_message_id := v_msg_id,
          p_inquiry_id := v_inq_id,
          p_expected_values := NULL,
          p_actor_type := 'system',
          p_actor_id := NULL
        );
        RAISE EXCEPTION 'TEST_FAILED: Atomic accept should have failed with STALE_PROPOSAL';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%STALE_PROPOSAL%' THEN
          RAISE EXCEPTION 'Unexpected error: %', SQLERRM;
        END IF;
      END;

      -- Verify that the newer human change is preserved (NOT overwritten with 660 mesh)
      IF NOT EXISTS (
        SELECT 1 FROM public.enquiry_requests
        WHERE id = v_req_id AND customer_requirement = 'Modified 200 mesh by human'
      ) THEN
        RAISE EXCEPTION 'TEST_FAILED: Human change was overwritten!';
      END IF;

      -- Verify that proposal was NOT accepted
      IF NOT EXISTS (
        SELECT 1 FROM public.enquiry_conversation_messages
        WHERE id = v_msg_id AND ai_proposal->>'status' = 'suggested'
      ) THEN
        RAISE EXCEPTION 'TEST_FAILED: Proposal status changed despite transaction failure!';
      END IF;

      -- Clean up test records
      DELETE FROM public.enquiry_conversation_messages WHERE id = v_msg_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
      DELETE FROM public.enquiry_requests WHERE id = v_req_id;
      DELETE FROM public.crm_inquiries WHERE id = v_inq_id;
    END;
    $$;
    SELECT 'FRESHNESS_RACE_PASSED' AS result;
  `;

  const rows = runDbScript(setupSql);
  assert.equal(rows[0].result, 'FRESHNESS_RACE_PASSED');
});

test('19. Live DB Test: Concurrent new-request Accept idempotency (exactly one request created)', () => {
  const setupSql = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_conv_id UUID;
      v_msg_id UUID;
      v_proposal JSONB;
      v_req_count INT;
      v_event_count INT;
      v_second_failed BOOLEAN := false;
    BEGIN
      -- Create test inquiry
      INSERT INTO public.crm_inquiries (inquiry_number, product_name, company_name, contact_person, quantity)
      VALUES ('INQ-CONCUR-' || floor(random()*1000)::text, 'Test Product', 'Idempotent Corp', 'Bob', '500 KG')
      RETURNING id INTO v_inq_id;

      -- Create test conversation
      INSERT INTO public.enquiry_conversations (title, channel)
      VALUES ('Concurrency Conv', 'email')
      RETURNING id INTO v_conv_id;

      -- Proposal with proposed_new_requests
      v_proposal := jsonb_build_object(
        'status', 'suggested',
        'intent', 'new_request',
        'confidence_tier', 'HIGH',
        'summary', 'New technical inquiry for 660 mesh',
        'proposed_new_requests', jsonb_build_array(
          jsonb_build_object(
            'category', 'technical',
            'title', 'Sample Request for 660 Mesh',
            'customer_requirement', '660 mesh sample, 500g',
            'parameters', jsonb_build_object('sample_size', '500g'),
            'waiting_for', 'INTERNAL',
            'assigned_team', 'sales',
            'reason', 'Customer requested sample'
          )
        )
      );

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, sender_address, subject, body_text, ai_proposal
      ) VALUES (
        v_conv_id, 'email', 'inbound', 'bob@idem.com', 'Sample Request', 'Need 500g sample', v_proposal
      ) RETURNING id INTO v_msg_id;

      -- Operation 1: First Accept -> MUST succeed
      PERFORM public.accept_enquiry_brain_proposal_atomic(
        p_message_id := v_msg_id,
        p_inquiry_id := v_inq_id,
        p_expected_values := NULL,
        p_actor_type := 'system',
        p_actor_id := NULL
      );

      -- Operation 2: Concurrent/duplicate Accept -> MUST fail with PROPOSAL_ALREADY_PROCESSED
      BEGIN
        PERFORM public.accept_enquiry_brain_proposal_atomic(
          p_message_id := v_msg_id,
          p_inquiry_id := v_inq_id,
          p_expected_values := NULL,
          p_actor_type := 'system',
          p_actor_id := NULL
        );
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%PROPOSAL_ALREADY_PROCESSED%' THEN
          v_second_failed := true;
        ELSE
          RAISE EXCEPTION 'Unexpected error on second accept: %', SQLERRM;
        END IF;
      END;

      IF NOT v_second_failed THEN
        RAISE EXCEPTION 'TEST_FAILED: Second accept did not raise PROPOSAL_ALREADY_PROCESSED!';
      END IF;

      -- Verify exactly ONE enquiry_request exists
      SELECT count(*) INTO v_req_count
      FROM public.enquiry_requests
      WHERE source_message_id = v_msg_id;

      IF v_req_count <> 1 THEN
        RAISE EXCEPTION 'TEST_FAILED: Expected exactly 1 enquiry_request, found %', v_req_count;
      END IF;

      -- Verify exactly ONE created event exists
      SELECT count(*) INTO v_event_count
      FROM public.enquiry_request_events
      WHERE source_message_id = v_msg_id AND event_type = 'created';

      IF v_event_count <> 1 THEN
        RAISE EXCEPTION 'TEST_FAILED: Expected exactly 1 created event, found %', v_event_count;
      END IF;

      -- Verify proposal ends in terminal accepted state
      IF NOT EXISTS (
        SELECT 1 FROM public.enquiry_conversation_messages
        WHERE id = v_msg_id AND ai_proposal->>'status' = 'accepted'
      ) THEN
        RAISE EXCEPTION 'TEST_FAILED: Message proposal status is not accepted!';
      END IF;

      -- Clean up test records
      DELETE FROM public.enquiry_request_messages WHERE message_id = v_msg_id;
      DELETE FROM public.enquiry_request_events WHERE source_message_id = v_msg_id;
      DELETE FROM public.enquiry_requests WHERE source_message_id = v_msg_id;
      DELETE FROM public.enquiry_conversation_messages WHERE id = v_msg_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
      DELETE FROM public.crm_inquiries WHERE id = v_inq_id;
    END;
    $$;
    SELECT 'CONCURRENCY_IDEMPOTENCY_PASSED' AS result;
  `;

  const rows = runDbScript(setupSql);
  assert.equal(rows[0].result, 'CONCURRENCY_IDEMPOTENCY_PASSED');
});

test('20. Live DB Test: Original AI proposal preservation across Accept, Edit, and Dismiss', () => {
  const setupSql = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_conv_id UUID;
      v_msg1_id UUID;
      v_msg2_id UUID;
      v_msg3_id UUID;
      v_req_id UUID;
      v_proposal JSONB;
      v_stored_proposal JSONB;
    BEGIN
      -- Create test inquiry and conversation
      INSERT INTO public.crm_inquiries (inquiry_number, product_name, company_name, contact_person, quantity)
      VALUES ('INQ-PRES-' || floor(random()*1000)::text, 'Test Product', 'Preserve Corp', 'Carol', '500 KG')
      RETURNING id INTO v_inq_id;

      INSERT INTO public.enquiry_conversations (title, channel)
      VALUES ('Preservation Conv', 'email')
      RETURNING id INTO v_conv_id;

      INSERT INTO public.enquiry_requests (
        inquiry_id, category, request_code, title, customer_requirement, status, waiting_for
      ) VALUES (
        v_inq_id, 'commercial', 'REQ-PRES-' || floor(random()*1000)::text, 'Price Req', '1000 KG mesh', 'OPEN', 'INDIA'
      ) RETURNING id INTO v_req_id;

      v_proposal := jsonb_build_object(
        'status', 'suggested',
        'intent', 'customer_decision',
        'confidence_tier', 'HIGH',
        'summary', 'Customer approves mesh',
        'proposed_updates', jsonb_build_array(
          jsonb_build_object(
            'request_id', v_req_id,
            'field', 'status',
            'old_value', 'OPEN',
            'new_value', 'RESOLVED',
            'reason', 'Customer approved'
          )
        )
      );

      -- 1. ACCEPT: message 1
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, sender_address, subject, body_text, ai_proposal
      ) VALUES (
        v_conv_id, 'email', 'inbound', 'carol@pres.com', 'Sub 1', 'Text 1', v_proposal
      ) RETURNING id INTO v_msg1_id;

      PERFORM public.accept_enquiry_brain_proposal_atomic(
        p_message_id := v_msg1_id,
        p_inquiry_id := v_inq_id,
        p_actor_type := 'system'
      );

      SELECT ai_proposal INTO v_stored_proposal
      FROM public.enquiry_conversation_messages WHERE id = v_msg1_id;

      IF v_stored_proposal->>'status' <> 'accepted'
         OR v_stored_proposal->'original_proposal'->>'summary' <> 'Customer approves mesh' THEN
        RAISE EXCEPTION 'TEST_FAILED: Accept did not preserve original proposal snapshot!';
      END IF;

      -- 2. EDIT: message 2
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, sender_address, subject, body_text, ai_proposal
      ) VALUES (
        v_conv_id, 'email', 'inbound', 'carol@pres.com', 'Sub 2', 'Text 2', v_proposal
      ) RETURNING id INTO v_msg2_id;

      PERFORM public.edit_enquiry_brain_proposal_atomic(
        p_message_id := v_msg2_id,
        p_inquiry_id := v_inq_id,
        p_edited_values := jsonb_build_object(
          'target_request_id', v_req_id,
          'customer_requirement', 'Human-adjusted 1500 KG mesh',
          'summary', 'Human-adjusted summary'
        ),
        p_actor_type := 'system'
      );

      SELECT ai_proposal INTO v_stored_proposal
      FROM public.enquiry_conversation_messages WHERE id = v_msg2_id;

      IF v_stored_proposal->>'status' <> 'edited'
         OR v_stored_proposal->'original_proposal'->>'summary' <> 'Customer approves mesh'
         OR v_stored_proposal->'edited_values'->>'customer_requirement' <> 'Human-adjusted 1500 KG mesh' THEN
        RAISE EXCEPTION 'TEST_FAILED: Edit did not preserve original proposal and edited values!';
      END IF;

      -- 3. DISMISS: message 3
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, sender_address, subject, body_text, ai_proposal
      ) VALUES (
        v_conv_id, 'email', 'inbound', 'carol@pres.com', 'Sub 3', 'Text 3', v_proposal
      ) RETURNING id INTO v_msg3_id;

      PERFORM public.dismiss_enquiry_brain_proposal_atomic(
        p_message_id := v_msg3_id,
        p_actor_type := 'system'
      );

      SELECT ai_proposal INTO v_stored_proposal
      FROM public.enquiry_conversation_messages WHERE id = v_msg3_id;

      IF v_stored_proposal->>'status' <> 'dismissed'
         OR v_stored_proposal->'original_proposal'->>'summary' <> 'Customer approves mesh' THEN
        RAISE EXCEPTION 'TEST_FAILED: Dismiss did not preserve original proposal snapshot!';
      END IF;

      -- Clean up
      DELETE FROM public.enquiry_request_messages WHERE message_id IN (v_msg1_id, v_msg2_id, v_msg3_id);
      DELETE FROM public.enquiry_request_events WHERE source_message_id IN (v_msg1_id, v_msg2_id, v_msg3_id);
      DELETE FROM public.enquiry_conversation_messages WHERE id IN (v_msg1_id, v_msg2_id, v_msg3_id);
      DELETE FROM public.enquiry_requests WHERE id = v_req_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
      DELETE FROM public.crm_inquiries WHERE id = v_inq_id;
    END;
    $$;
    SELECT 'PRESERVATION_ALL_PASSED' AS result;
  `;

  const rows = runDbScript(setupSql);
  assert.equal(rows[0].result, 'PRESERVATION_ALL_PASSED');
});

test('21. Real Concurrent Integration Test: Two simultaneous DB sessions racing for the same proposed_new_request', async () => {
  const setupSql = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_conv_id UUID;
      v_msg_id UUID;
      v_proposal JSONB;
    BEGIN
      INSERT INTO public.crm_inquiries (inquiry_number, product_name, company_name, contact_person, quantity)
      VALUES ('INQ-RACE-' || floor(random()*1000)::text, 'Test Product', 'Concurrent Corp', 'Dave', '500 KG')
      RETURNING id INTO v_inq_id;

      INSERT INTO public.enquiry_conversations (title, channel)
      VALUES ('Concurrent Race Conv', 'email')
      RETURNING id INTO v_conv_id;

      v_proposal := jsonb_build_object(
        'status', 'suggested',
        'intent', 'new_request',
        'confidence_tier', 'HIGH',
        'summary', 'New concurrent proposal',
        'proposed_new_requests', jsonb_build_array(
          jsonb_build_object(
            'category', 'commercial',
            'title', 'Concurrent Request 660 Mesh',
            'customer_requirement', '660 mesh 500 KG',
            'parameters', jsonb_build_object('mesh', 660),
            'waiting_for', 'INTERNAL',
            'assigned_team', 'sales',
            'reason', 'Customer requested quotation'
          )
        )
      );

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, sender_address, subject, body_text, ai_proposal
      ) VALUES (
        v_conv_id, 'email', 'inbound', 'dave@race.com', 'RFQ 660 mesh', 'Quote 660 mesh please', v_proposal
      ) RETURNING id INTO v_msg_id;

      CREATE TEMP TABLE IF NOT EXISTS temp_race_ids (msg_id UUID, inq_id UUID);
      DELETE FROM temp_race_ids;
      INSERT INTO temp_race_ids VALUES (v_msg_id, v_inq_id);
    END;
    $$;
    SELECT msg_id, inq_id FROM temp_race_ids;
  `;

  const rows = runDbScript(setupSql);
  assert.ok(rows.length > 0 && rows[0].msg_id, 'Setup must return created IDs');
  const { msg_id, inq_id } = rows[0];

  const querySql = `
    SET request.jwt.claim.role = 'service_role';
    SELECT public.accept_enquiry_brain_proposal_atomic(
      p_message_id := '${msg_id}',
      p_inquiry_id := '${inq_id}',
      p_expected_values := NULL,
      p_actor_type := 'system',
      p_actor_id := NULL
    ) AS result;
  `;

  // Launch Session A and Session B simultaneously
  const [resA, resB] = await Promise.all([
    runDbScriptAsync(querySql),
    runDbScriptAsync(querySql),
  ]);

  // Exactly ONE succeeds
  const successCount = (resA.success ? 1 : 0) + (resB.success ? 1 : 0);
  assert.equal(successCount, 1, 'Exactly one concurrent session must succeed');

  // The other receives PROPOSAL_ALREADY_PROCESSED
  const failedRes = !resA.success ? resA : resB;
  assert.match(
    failedRes.error,
    /PROPOSAL_ALREADY_PROCESSED/,
    'Losing session must be rejected with PROPOSAL_ALREADY_PROCESSED'
  );

  // Verify database invariants
  const verifySql = `
    SELECT
      (SELECT count(*) FROM public.enquiry_requests WHERE source_message_id = '${msg_id}') AS req_count,
      (SELECT count(*) FROM public.enquiry_request_events WHERE source_message_id = '${msg_id}' AND event_type = 'created') AS event_count,
      (SELECT ai_proposal->>'status' FROM public.enquiry_conversation_messages WHERE id = '${msg_id}') AS proposal_status,
      (SELECT count(*) FROM public.tasks WHERE reference_id IN (SELECT id FROM public.enquiry_requests WHERE source_message_id = '${msg_id}')) AS task_count;
  `;
  const verifyRows = runDbScript(verifySql);
  assert.equal(Number(verifyRows[0].req_count), 1, 'Exactly ONE enquiry_requests row created');
  assert.equal(Number(verifyRows[0].event_count), 1, 'Exactly ONE created enquiry_request_event exists');
  assert.equal(verifyRows[0].proposal_status, 'accepted', 'Proposal ends in terminal accepted state');
  assert.equal(Number(verifyRows[0].task_count), 0, 'Zero tasks created');

  // Clean up
  runDbScript(`
    DELETE FROM public.enquiry_request_messages WHERE message_id = '${msg_id}';
    DELETE FROM public.enquiry_request_events WHERE source_message_id = '${msg_id}';
    DELETE FROM public.enquiry_requests WHERE source_message_id = '${msg_id}';
    DELETE FROM public.enquiry_conversation_messages WHERE id = '${msg_id}';
    DELETE FROM public.enquiry_conversations WHERE id IN (SELECT conversation_id FROM public.enquiry_conversation_messages WHERE id = '${msg_id}');
    DELETE FROM public.crm_inquiries WHERE id = '${inq_id}';
  `);
});

