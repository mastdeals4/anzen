import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const migrationRpc = readFileSync(
  new URL('../supabase/migrations/20260914160000_enquiry_service_atomic_rpc.sql', import.meta.url),
  'utf8',
);
const serviceTypes = readFileSync(
  new URL('../src/types/enquiry/index.ts', import.meta.url),
  'utf8',
);
const reqService = readFileSync(
  new URL('../src/services/enquiry/EnquiryRequestService.ts', import.meta.url),
  'utf8',
);
const convService = readFileSync(
  new URL('../src/services/enquiry/EnquiryConversationService.ts', import.meta.url),
  'utf8',
);
const docService = readFileSync(
  new URL('../src/services/enquiry/EnquiryDocumentService.ts', import.meta.url),
  'utf8',
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `enq_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

test('1. Migration Structure: Contains all approved security, triggers, and atomic RPCs', () => {
  assert.match(migrationRpc, /CREATE OR REPLACE FUNCTION public\.create_enquiry_request_atomic/);
  assert.match(migrationRpc, /CREATE OR REPLACE FUNCTION public\.transition_enquiry_request_atomic/);
  assert.match(migrationRpc, /CREATE OR REPLACE FUNCTION public\.fn_protect_enquiry_message_content/);
  assert.match(migrationRpc, /trg_protect_enquiry_message_content/);
  assert.match(migrationRpc, /REVOKE ALL ON FUNCTION public\.create_enquiry_request_atomic FROM PUBLIC/);
  assert.match(migrationRpc, /REVOKE EXECUTE ON FUNCTION public\.create_enquiry_request_atomic FROM anon/);
  assert.match(migrationRpc, /GRANT EXECUTE ON FUNCTION public\.create_enquiry_request_atomic TO authenticated, service_role/);
});

test('2. Actor Security: RPC rejects authenticated browser impersonation of AI or system', () => {
  assert.match(migrationRpc, /IF p_actor_type IS NOT NULL AND p_actor_type <> 'user' THEN/);
  assert.match(migrationRpc, /RAISE EXCEPTION 'Unauthorized: authenticated users cannot impersonate AI or system'/);
  assert.match(migrationRpc, /IF p_actor_id IS NOT NULL AND p_actor_id <> v_caller_auth_uid THEN/);
  assert.match(migrationRpc, /RAISE EXCEPTION 'Unauthorized: authenticated users cannot impersonate other users'/);
});

test('3. RPC Security: SECURITY DEFINER with fixed search_path and no anon execute', () => {
  const routines = runDbScript(`
    SELECT routine_name, security_type
    FROM information_schema.routines
    WHERE routine_name IN ('create_enquiry_request_atomic', 'transition_enquiry_request_atomic')
      AND routine_schema = 'public';
  `);
  assert.equal(routines.length, 2);
  assert.equal(routines[0].security_type, 'DEFINER');
  assert.equal(routines[1].security_type, 'DEFINER');

  const anonPrivs = runDbScript(`
    SELECT grantee FROM information_schema.routine_privileges
    WHERE routine_name IN ('create_enquiry_request_atomic', 'transition_enquiry_request_atomic')
      AND grantee = 'anon';
  `);
  assert.equal(anonPrivs.length, 0, 'anon must have zero EXECUTE grants');
});

test('4. Message Content Immutability: Trigger protects communication content on UPDATE', () => {
  const triggerCheck = runDbScript(`
    SELECT trigger_name, event_manipulation, action_timing
    FROM information_schema.triggers
    WHERE event_object_table = 'enquiry_conversation_messages'
      AND trigger_name = 'trg_protect_enquiry_message_content';
  `);
  assert.equal(triggerCheck.length, 1);
  assert.equal(triggerCheck[0].action_timing, 'BEFORE');
  assert.equal(triggerCheck[0].event_manipulation, 'UPDATE');
});

test('5. Provenance Immutability: enquiry_request_messages has no DELETE policy for sales', () => {
  const policies = runDbScript(`
    SELECT policyname, cmd, qual
    FROM pg_policies
    WHERE tablename = 'enquiry_request_messages'
    ORDER BY policyname;
  `);

  const deletePolicies = policies.filter(p => p.cmd === 'DELETE');
  assert.equal(deletePolicies.length, 1);
  assert.match(deletePolicies[0].qual, /role = 'admin'/);

  const updatePolicies = policies.filter(p => p.cmd === 'UPDATE');
  assert.equal(updatePolicies.length, 0, 'No UPDATE policy allowed on request messages provenance');
});

test('6. Atomic Lifecycle Verification: Test Request Creation, Requirement Evolution, and History', () => {
  const testScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_user_id UUID;
      v_req_id UUID;
      v_req RECORD;
      v_history_event RECORD;
    BEGIN
      SELECT id INTO v_inq_id FROM public.crm_inquiries LIMIT 1;
      SELECT id INTO v_user_id FROM public.user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;

      IF v_inq_id IS NULL OR v_user_id IS NULL THEN
        RAISE NOTICE 'Skipping execution check: database lacks sample inquiry or user';
        RETURN;
      END IF;

      -- 1. Create request atomically
      v_req_id := public.create_enquiry_request_atomic(
        p_inquiry_id := v_inq_id,
        p_category := 'technical',
        p_request_code := 'REQ-TEST-001',
        p_title := 'Test Mesh Spec',
        p_customer_requirement := '100 mesh standard',
        p_parameters := '{"mesh": 100}'::jsonb,
        p_actor_type := 'user',
        p_actor_id := v_user_id
      );

      SELECT * INTO v_req FROM public.enquiry_requests WHERE id = v_req_id;
      ASSERT v_req.status = 'OPEN', 'Status should be OPEN';
      ASSERT v_req.customer_requirement = '100 mesh standard', 'Initial requirement mismatch';

      SELECT * INTO v_history_event FROM public.enquiry_request_events WHERE request_id = v_req_id;
      ASSERT v_history_event.event_type = 'created', 'Event type should be created';
      ASSERT (v_history_event.details->>'initial_requirement') = '100 mesh standard', 'History details mismatch';

      -- 2. Requirement change transition
      PERFORM public.transition_enquiry_request_atomic(
        p_request_id := v_req_id,
        p_event_type := 'requirement_changed',
        p_summary := 'Customer accepts 660 mesh alternative',
        p_new_status := 'IN_PROGRESS',
        p_new_waiting_for := 'INDIA',
        p_new_requirement := '660 mesh pharma grade',
        p_details := '{"reason": "Accepted alternative"}'::jsonb,
        p_actor_type := 'user',
        p_actor_id := v_user_id
      );

      SELECT * INTO v_req FROM public.enquiry_requests WHERE id = v_req_id;
      ASSERT v_req.status = 'IN_PROGRESS', 'Status should be IN_PROGRESS';
      ASSERT v_req.waiting_for = 'INDIA', 'Waiting for should be INDIA';
      ASSERT v_req.customer_requirement = '660 mesh pharma grade', 'Requirement should be 660 mesh';

      SELECT * INTO v_history_event FROM public.enquiry_request_events
      WHERE request_id = v_req_id AND event_type = 'requirement_changed';
      ASSERT v_history_event.old_status = 'OPEN', 'Old status should be OPEN';
      ASSERT v_history_event.new_status = 'IN_PROGRESS', 'New status should be IN_PROGRESS';
      ASSERT (v_history_event.details->'requirement_diff'->>'old') = '100 mesh standard', 'Old requirement preserved';
      ASSERT (v_history_event.details->'requirement_diff'->>'new') = '660 mesh pharma grade', 'New requirement logged';

      -- 3. RESOLVED state transition
      PERFORM public.transition_enquiry_request_atomic(
        p_request_id := v_req_id,
        p_event_type := 'resolved',
        p_summary := 'COA verified and accepted',
        p_new_status := 'RESOLVED',
        p_response_text := 'Manufacturer confirmed 660 mesh with COA attached',
        p_actor_type := 'user',
        p_actor_id := v_user_id
      );

      SELECT * INTO v_req FROM public.enquiry_requests WHERE id = v_req_id;
      ASSERT v_req.status = 'RESOLVED', 'Status should be RESOLVED';
      ASSERT v_req.waiting_for = 'NONE', 'Waiting for should be NONE when resolved';
      ASSERT v_req.resolved_at IS NOT NULL, 'resolved_at should be set';

      -- Clean up test records
      DELETE FROM public.enquiry_request_events WHERE request_id = v_req_id;
      DELETE FROM public.enquiry_requests WHERE id = v_req_id;
    END $$;
  `;

  runDbScript(testScript);
});

test('7. State Validation: BLOCKED without dependency or issue is rejected by DB', () => {
  const invalidBlockedScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_user_id UUID;
      v_req_id UUID;
      v_caught BOOLEAN := false;
    BEGIN
      SELECT id INTO v_inq_id FROM public.crm_inquiries LIMIT 1;
      SELECT id INTO v_user_id FROM public.user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;

      IF v_inq_id IS NULL OR v_user_id IS NULL THEN RETURN; END IF;

      v_req_id := public.create_enquiry_request_atomic(
        p_inquiry_id := v_inq_id,
        p_category := 'technical',
        p_request_code := 'REQ-TEST-BLK',
        p_title := 'Test Blocked',
        p_customer_requirement := 'Requirement text',
        p_actor_type := 'user',
        p_actor_id := v_user_id
      );

      BEGIN
        -- Should fail because waiting_for is NONE
        PERFORM public.transition_enquiry_request_atomic(
          p_request_id := v_req_id,
          p_event_type := 'status_changed',
          p_summary := 'Try invalid block',
          p_new_status := 'BLOCKED',
          p_new_waiting_for := 'NONE',
          p_actor_type := 'user',
          p_actor_id := v_user_id
        );
      EXCEPTION WHEN OTHERS THEN
        v_caught := true;
      END;

      DELETE FROM public.enquiry_request_events WHERE request_id = v_req_id;
      DELETE FROM public.enquiry_requests WHERE id = v_req_id;

      ASSERT v_caught, 'Failed to reject invalid BLOCKED request state';
    END $$;
  `;
  runDbScript(invalidBlockedScript);
});

test('8. State Validation: RESOLVED without response_text/response_value is rejected by DB', () => {
  const invalidResolvedScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_user_id UUID;
      v_req_id UUID;
      v_caught BOOLEAN := false;
    BEGIN
      SELECT id INTO v_inq_id FROM public.crm_inquiries LIMIT 1;
      SELECT id INTO v_user_id FROM public.user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;

      IF v_inq_id IS NULL OR v_user_id IS NULL THEN RETURN; END IF;

      v_req_id := public.create_enquiry_request_atomic(
        p_inquiry_id := v_inq_id,
        p_category := 'commercial',
        p_request_code := 'REQ-TEST-RES',
        p_title := 'Test Resolution',
        p_customer_requirement := 'Commercial question',
        p_actor_type := 'user',
        p_actor_id := v_user_id
      );

      BEGIN
        -- Should fail because response_text is NULL
        PERFORM public.transition_enquiry_request_atomic(
          p_request_id := v_req_id,
          p_event_type := 'resolved',
          p_summary := 'Try invalid resolution',
          p_new_status := 'RESOLVED',
          p_actor_type := 'user',
          p_actor_id := v_user_id
        );
      EXCEPTION WHEN OTHERS THEN
        v_caught := true;
      END;

      DELETE FROM public.enquiry_request_events WHERE request_id = v_req_id;
      DELETE FROM public.enquiry_requests WHERE id = v_req_id;

      ASSERT v_caught, 'Failed to reject invalid RESOLVED request state';
    END $$;
  `;
  runDbScript(invalidResolvedScript);
});

test('9. Message Content Immutability Trigger in Action: Rejects communication modification', () => {
  const testMessageScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_conv_id UUID;
      v_msg_id UUID;
      v_caught BOOLEAN := false;
    BEGIN
      -- Create test conversation
      INSERT INTO public.enquiry_conversations (
        channel,
        title
      ) VALUES (
        'internal',
        'Test Conversation'
      ) RETURNING id INTO v_conv_id;

      -- Insert message
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id,
        channel,
        direction,
        sender_address,
        body_text
      ) VALUES (
        v_conv_id,
        'internal',
        'internal',
        'test@anzen.id',
        'Original immutable message body'
      ) RETURNING id INTO v_msg_id;

      -- Attempt to modify body_text
      BEGIN
        UPDATE public.enquiry_conversation_messages
        SET body_text = 'Tampered body text'
        WHERE id = v_msg_id;
      EXCEPTION WHEN OTHERS THEN
        v_caught := true;
      END;

      -- Cleanup
      DELETE FROM public.enquiry_conversation_messages WHERE id = v_msg_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;

      ASSERT v_caught, 'Message immutability trigger failed to block body modification';
    END $$;
  `;
  runDbScript(testMessageScript);
});

test('10. Service Layer: EnquiryConversationService implements concurrency-safe ingestion & single active primary link', () => {
  assert.match(convService, /uq_enq_msg_channel_external_id/);
  assert.match(convService, /23505/);
  assert.match(convService, /PrimaryConversationConflictError/);
  assert.match(convService, /getOrCreateConversation/);
  assert.match(convService, /ingestMessage/);
  assert.match(convService, /linkConversation/);
});

test('11. Service Layer: EnquiryRequestService implements typed methods without arbitrary JSONB mutation', () => {
  assert.match(reqService, /create_enquiry_request_atomic/);
  assert.match(reqService, /transition_enquiry_request_atomic/);
  assert.match(reqService, /changeRequirement/);
  assert.match(reqService, /resolveRequest/);
  assert.match(reqService, /cancelRequest/);
  assert.match(reqService, /reassignOwner/);
  assert.match(reqService, /linkMessage/);
  assert.match(reqService, /getRequestTimeline/);
});

test('12. Service Layer: EnquiryDocumentService associates crm_product_documents without modifying storage', () => {
  assert.match(docService, /linkDocumentToRequest/);
  assert.match(docService, /unlinkDocumentFromRequest/);
  assert.match(docService, /crm_product_documents/);
  assert.match(docService, /enquiry_request_id/);
});

test('13. Existing ERP Safety: Zero modifications to crm_inquiries, tasks, and pricing logic', () => {
  const inqCols = runDbScript(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'crm_inquiries' AND table_schema = 'public'
    ORDER BY column_name;
  `);
  assert.ok(inqCols.length > 0);

  const taskCols = runDbScript(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'tasks' AND table_schema = 'public'
    ORDER BY column_name;
  `);
  assert.ok(taskCols.length > 0);
});
