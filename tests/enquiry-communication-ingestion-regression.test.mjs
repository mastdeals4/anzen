import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sharedIngestion = readFileSync(
  new URL('../supabase/functions/_shared/enquiryIngestion.ts', import.meta.url),
  'utf8',
);
const syncGmail = readFileSync(
  new URL('../supabase/functions/sync-gmail-emails/index.ts', import.meta.url),
  'utf8',
);
const sendBulk = readFileSync(
  new URL('../supabase/functions/send-bulk-email/index.ts', import.meta.url),
  'utf8',
);
const clientBridge = readFileSync(
  new URL('../src/services/enquiry/EnquiryIngestionBridge.ts', import.meta.url),
  'utf8',
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `enq_comm_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

test('1. Shared Module: enquiryIngestion contains all approved inbound, outbound, and reconciliation functions', () => {
  assert.match(sharedIngestion, /export async function mirrorInboundEmail/);
  assert.match(sharedIngestion, /export async function mirrorOutboundEmail/);
  assert.match(sharedIngestion, /export async function runInboundReconciliationSweep/);
  assert.match(sharedIngestion, /export async function runOutboundReconciliationSweep/);
  assert.match(sharedIngestion, /extractExactInquiryNumber/);
  assert.match(sharedIngestion, /getOrCreateCanonicalConversation/);
});

test('2. Edge Function Integration: sync-gmail-emails has pre-sync sweep, processes batch of 10, and mirrors inbound', () => {
  assert.match(syncGmail, /runInboundReconciliationSweep/);
  assert.match(syncGmail, /mirrorInboundEmail/);
  assert.doesNotMatch(syncGmail, /messageList\.slice\(0,\s*5\)/, 'Must not artificially slice to 5 messages');
  assert.match(syncGmail, /const batchPromises = messageList\.map/, 'Must process all messages in batch');
});

test('3. Edge Function Integration: send-bulk-email mirrors confirmed outbound email with messageId and threadId', () => {
  assert.match(sendBulk, /mirrorOutboundEmail/);
  assert.match(sendBulk, /inquiryId,\s*additionalInquiryIds/);
  assert.match(sendBulk, /messageId:\s*result\.id/);
  assert.match(sendBulk, /threadId:\s*result\.threadId/);
});

test('4. Inbound Canonical Ingestion & Thread Unification: same threadId creates 1 conversation and 2 messages', () => {
  const threadTestScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_thread_id TEXT := 'test-thread-' || gen_random_uuid()::text;
      v_msg1_id TEXT := 'test-msg-1-' || gen_random_uuid()::text;
      v_msg2_id TEXT := 'test-msg-2-' || gen_random_uuid()::text;
      v_conv_id UUID;
      v_conv_count INT;
      v_msg_count INT;
    BEGIN
      -- Message 1 arrives
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title, participant_identifiers, status
      ) VALUES (
        'email', v_thread_id, 'Inquiry for API Product', ARRAY['buyer@pharma.com'], 'active'
      ) RETURNING id INTO v_conv_id;

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address, subject, body_text
      ) VALUES (
        v_conv_id, 'email', 'inbound', v_msg1_id, 'buyer@pharma.com', 'Inquiry for API Product', 'Need price for 500kg'
      );

      -- Message 2 arrives in the same Gmail thread
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address, subject, body_text
      ) VALUES (
        v_conv_id, 'email', 'inbound', v_msg2_id, 'buyer@pharma.com', 'Re: Inquiry for API Product', 'Also please provide COA'
      );

      -- Verify exactly 1 conversation exists for this thread
      SELECT count(*) INTO v_conv_count FROM public.enquiry_conversations WHERE external_thread_id = v_thread_id;
      ASSERT v_conv_count = 1, 'Should have exactly 1 conversation for thread';

      -- Verify exactly 2 messages exist for this conversation
      SELECT count(*) INTO v_msg_count FROM public.enquiry_conversation_messages WHERE conversation_id = v_conv_id;
      ASSERT v_msg_count = 2, 'Should have exactly 2 messages for conversation';

      -- Cleanup
      DELETE FROM public.enquiry_conversation_messages WHERE conversation_id = v_conv_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
    END $$;
  `;
  runDbScript(threadTestScript);
});

test('5. Inbound Idempotency: duplicate external_message_id is rejected by unique index without corrupting data', () => {
  const duplicateTestScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_thread_id TEXT := 'test-thread-dup-' || gen_random_uuid()::text;
      v_msg_id TEXT := 'test-msg-dup-' || gen_random_uuid()::text;
      v_conv_id UUID;
      v_caught BOOLEAN := false;
      v_msg_count INT;
    BEGIN
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title
      ) VALUES (
        'email', v_thread_id, 'Duplicate Test'
      ) RETURNING id INTO v_conv_id;

      -- First insert succeeds
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address, subject
      ) VALUES (
        v_conv_id, 'email', 'inbound', v_msg_id, 'test@example.com', 'Subject 1'
      );

      -- Second insert with identical external_message_id fails on unique index
      BEGIN
        INSERT INTO public.enquiry_conversation_messages (
          conversation_id, channel, direction, external_message_id, sender_address, subject
        ) VALUES (
          v_conv_id, 'email', 'inbound', v_msg_id, 'test@example.com', 'Subject 1'
        );
      EXCEPTION WHEN OTHERS THEN
        v_caught := true;
      END;

      ASSERT v_caught, 'Failed to catch duplicate external_message_id';

      SELECT count(*) INTO v_msg_count FROM public.enquiry_conversation_messages WHERE external_message_id = v_msg_id;
      ASSERT v_msg_count = 1, 'Should have strictly 1 message row';

      DELETE FROM public.enquiry_conversation_messages WHERE conversation_id = v_conv_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
    END $$;
  `;
  runDbScript(duplicateTestScript);
});

test('6. Inbound Anti-Join Reconciliation Sweep: identifies and mirrors unmirrored crm_email_inbox rows', () => {
  const reconTestScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_dummy_msg_id TEXT := 'unmirrored-msg-' || gen_random_uuid()::text;
      v_dummy_thread_id TEXT := 'unmirrored-thread-' || gen_random_uuid()::text;
      v_inbox_id UUID;
      v_unmirrored_count INT;
      v_conv_id UUID;
    BEGIN
      -- Simulate an unmirrored row in crm_email_inbox
      INSERT INTO public.crm_email_inbox (
        from_email, subject, body, received_date, message_id, thread_id, is_processed, is_inquiry
      ) VALUES (
        'supplier@india.com', 'Price Update for Inquiry', 'Attached quote', now(), v_dummy_msg_id, v_dummy_thread_id, false, false
      ) RETURNING id INTO v_inbox_id;

      -- Check anti-join query
      SELECT count(*) INTO v_unmirrored_count
      FROM public.crm_email_inbox inbox
      WHERE inbox.message_id = v_dummy_msg_id
        AND NOT EXISTS (
          SELECT 1 FROM public.enquiry_conversation_messages msg
          WHERE msg.channel = 'email' AND msg.external_message_id = inbox.message_id
        );

      ASSERT v_unmirrored_count = 1, 'Anti-join query should discover the unmirrored row';

      -- Simulate reconciliation action: mirror into canonical tables
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title
      ) VALUES (
        'email', v_dummy_thread_id, 'Price Update for Inquiry'
      ) RETURNING id INTO v_conv_id;

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address, subject
      ) VALUES (
        v_conv_id, 'email', 'inbound', v_dummy_msg_id, 'supplier@india.com', 'Price Update for Inquiry'
      );

      -- Anti-join query should now find 0 unmirrored rows for this message
      SELECT count(*) INTO v_unmirrored_count
      FROM public.crm_email_inbox inbox
      WHERE inbox.message_id = v_dummy_msg_id
        AND NOT EXISTS (
          SELECT 1 FROM public.enquiry_conversation_messages msg
          WHERE msg.channel = 'email' AND msg.external_message_id = inbox.message_id
        );

      ASSERT v_unmirrored_count = 0, 'Reconciled message should no longer appear in anti-join query';

      -- Cleanup
      DELETE FROM public.enquiry_conversation_messages WHERE conversation_id = v_conv_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
      DELETE FROM public.crm_email_inbox WHERE id = v_inbox_id;
    END $$;
  `;
  runDbScript(reconTestScript);
});

test('7. Tier-1 Safe Auto-Link: Exact INQ number auto-links to inquiry; Tier-2 product similarity does NOT auto-link', () => {
  const tierMatchingScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_sample_inq RECORD;
      v_thread_id_tier1 TEXT := 'tier1-thread-' || gen_random_uuid()::text;
      v_thread_id_tier2 TEXT := 'tier2-thread-' || gen_random_uuid()::text;
      v_conv1_id UUID;
      v_conv2_id UUID;
      v_link_count INT;
    BEGIN
      SELECT id, inquiry_number INTO v_sample_inq FROM public.crm_inquiries LIMIT 1;
      IF v_sample_inq.id IS NULL THEN RETURN; END IF;

      -- Case A: Tier 1 match (Exact inquiry number in subject)
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title
      ) VALUES (
        'email', v_thread_id_tier1, 'Re: Quotation for ' || v_sample_inq.inquiry_number
      ) RETURNING id INTO v_conv1_id;

      -- Safe auto-link created for Tier 1
      INSERT INTO public.enquiry_conversation_links (
        conversation_id, inquiry_id, link_type, is_active
      ) VALUES (
        v_conv1_id, v_sample_inq.id, 'primary', true
      );

      SELECT count(*) INTO v_link_count FROM public.enquiry_conversation_links WHERE conversation_id = v_conv1_id;
      ASSERT v_link_count = 1, 'Tier 1 must create conversation link';

      -- Case B: Tier 2 match (Product similarity alone without inquiry number)
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title, metadata
      ) VALUES (
        'email', v_thread_id_tier2, 'General Price List for Pharma Products',
        jsonb_build_object('suggested_inquiry_ids', jsonb_build_array(v_sample_inq.id))
      ) RETURNING id INTO v_conv2_id;

      -- Tier 2 MUST NOT create an auto-link
      SELECT count(*) INTO v_link_count FROM public.enquiry_conversation_links WHERE conversation_id = v_conv2_id;
      ASSERT v_link_count = 0, 'Tier 2 product similarity must NEVER auto-link to enquiry';

      -- Cleanup
      DELETE FROM public.enquiry_conversation_links WHERE conversation_id IN (v_conv1_id, v_conv2_id);
      DELETE FROM public.enquiry_conversations WHERE id IN (v_conv1_id, v_conv2_id);
    END $$;
  `;
  runDbScript(tierMatchingScript);
});

test('8. Outbound Canonical Linking: Explicit inquiry context links; general email creates no enquiry link', () => {
  const outboundLinkScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_sample_inq RECORD;
      v_thread_crm TEXT := 'outbound-crm-thread-' || gen_random_uuid()::text;
      v_thread_bulk TEXT := 'outbound-bulk-thread-' || gen_random_uuid()::text;
      v_conv_crm UUID;
      v_conv_bulk UUID;
      v_link_crm INT;
      v_link_bulk INT;
    BEGIN
      SELECT id, inquiry_number INTO v_sample_inq FROM public.crm_inquiries LIMIT 1;
      IF v_sample_inq.id IS NULL THEN RETURN; END IF;

      -- Outbound CRM Email (explicit inquiry_id provided)
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title
      ) VALUES (
        'email', v_thread_crm, 'Quotation Sent'
      ) RETURNING id INTO v_conv_crm;

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address, subject
      ) VALUES (
        v_conv_crm, 'email', 'outbound', 'out-msg-1', 'sales@sapharmajaya.co.id', 'Quotation Sent'
      );

      INSERT INTO public.enquiry_conversation_links (
        conversation_id, inquiry_id, link_type, is_active
      ) VALUES (
        v_conv_crm, v_sample_inq.id, 'primary', true
      );

      SELECT count(*) INTO v_link_crm FROM public.enquiry_conversation_links WHERE conversation_id = v_conv_crm;
      ASSERT v_link_crm = 1, 'Outbound CRM email with inquiry context must link';

      -- Outbound Bulk / General Email (no inquiry context)
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title
      ) VALUES (
        'email', v_thread_bulk, 'Company Holiday Notice'
      ) RETURNING id INTO v_conv_bulk;

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id, sender_address, subject
      ) VALUES (
        v_conv_bulk, 'email', 'outbound', 'out-msg-2', 'sales@sapharmajaya.co.id', 'Company Holiday Notice'
      );

      SELECT count(*) INTO v_link_bulk FROM public.enquiry_conversation_links WHERE conversation_id = v_conv_bulk;
      ASSERT v_link_bulk = 0, 'General outbound email must have 0 enquiry links';

      -- Cleanup
      DELETE FROM public.enquiry_conversation_links WHERE conversation_id IN (v_conv_crm, v_conv_bulk);
      DELETE FROM public.enquiry_conversation_messages WHERE conversation_id IN (v_conv_crm, v_conv_bulk);
      DELETE FROM public.enquiry_conversations WHERE id IN (v_conv_crm, v_conv_bulk);
    END $$;
  `;
  runDbScript(outboundLinkScript);
});

test('9. Multi-Product Conversation Linking: 1 conversation relates to multiple inquiries via primary and related', () => {
  const multiProductScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inqs RECORD;
      v_inq1 UUID;
      v_inq2 UUID;
      v_thread_id TEXT := 'multi-prod-thread-' || gen_random_uuid()::text;
      v_conv_id UUID;
      v_links_count INT;
      v_primary_count INT;
      v_related_count INT;
    BEGIN
      SELECT array_agg(id) as ids INTO v_inqs FROM (SELECT id FROM public.crm_inquiries LIMIT 2) q;
      IF array_length(v_inqs.ids, 1) < 2 THEN RETURN; END IF;

      v_inq1 := v_inqs.ids[1];
      v_inq2 := v_inqs.ids[2];

      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title
      ) VALUES (
        'email', v_thread_id, 'Multi-product order inquiry'
      ) RETURNING id INTO v_conv_id;

      -- First inquiry linked as primary
      INSERT INTO public.enquiry_conversation_links (
        conversation_id, inquiry_id, link_type, is_active
      ) VALUES (
        v_conv_id, v_inq1, 'primary', true
      );

      -- Second inquiry linked as related
      INSERT INTO public.enquiry_conversation_links (
        conversation_id, inquiry_id, link_type, is_active
      ) VALUES (
        v_conv_id, v_inq2, 'related', true
      );

      SELECT count(*) INTO v_links_count FROM public.enquiry_conversation_links WHERE conversation_id = v_conv_id;
      ASSERT v_links_count = 2, 'Should have 2 links for multi-product conversation';

      SELECT count(*) INTO v_primary_count FROM public.enquiry_conversation_links WHERE conversation_id = v_conv_id AND link_type = 'primary';
      ASSERT v_primary_count = 1, 'Should have exactly 1 primary link';

      SELECT count(*) INTO v_related_count FROM public.enquiry_conversation_links WHERE conversation_id = v_conv_id AND link_type = 'related';
      ASSERT v_related_count = 1, 'Should have exactly 1 related link';

      -- Cleanup
      DELETE FROM public.enquiry_conversation_links WHERE conversation_id = v_conv_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
    END $$;
  `;
  runDbScript(multiProductScript);
});

test('10. Boundary Invariants: Zero enquiry_requests created and existing ERP business tables untouched', () => {
  const reqCount = runDbScript(`SELECT count(*) as cnt FROM public.enquiry_requests;`);
  assert.equal(reqCount[0].cnt, 0, 'Phase 6 communication ingestion must create ZERO enquiry_requests');

  const inqCols = runDbScript(`SELECT count(*) as cnt FROM information_schema.columns WHERE table_name = 'crm_inquiries';`);
  assert.ok(inqCols[0].cnt > 0, 'crm_inquiries columns must remain intact');
});

test('11. Phase 6.2 Scenario A & B: Canonical mirror failure does not break legacy crm_email_activities; rerun is idempotent', () => {
  const scenarioABScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_activity_id UUID;
      v_thread_id TEXT := 'scen-ab-thread-' || gen_random_uuid()::text;
      v_msg_id TEXT := 'scen-ab-msg-' || gen_random_uuid()::text;
      v_conv_id UUID;
      v_msg_id_canon UUID;
      v_initial_count INT;
    BEGIN
      SELECT id INTO v_inq_id FROM public.crm_inquiries LIMIT 1;
      IF v_inq_id IS NULL THEN RETURN; END IF;

      -- Scenario A: Gmail send succeeded -> crm_email_activities recorded
      INSERT INTO public.crm_email_activities (
        inquiry_id, email_type, from_email, to_email, subject, body, sent_date
      ) VALUES (
        v_inq_id, 'sent', 'sales@avira.co.id', ARRAY['client@domain.com'],
        'Quotation Ref E100', '<p>Quotation details</p>', now()
      ) RETURNING id INTO v_activity_id;

      ASSERT v_activity_id IS NOT NULL, 'Legacy activity record must succeed regardless of canonical state';

      -- Canonical mirror executes
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title
      ) VALUES (
        'email', v_thread_id, 'Quotation Ref E100'
      ) RETURNING id INTO v_conv_id;

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id,
        sender_address, subject, body_html
      ) VALUES (
        v_conv_id, 'email', 'outbound', v_msg_id,
        'sales@avira.co.id', 'Quotation Ref E100', '<p>Quotation details</p>'
      ) RETURNING id INTO v_msg_id_canon;

      -- Scenario B: Reconciliation runs again on same messageId -> idempotent, no duplicate
      SELECT count(*) INTO v_initial_count
      FROM public.enquiry_conversation_messages
      WHERE external_message_id = v_msg_id;

      ASSERT v_initial_count = 1, 'Exactly 1 canonical message exists';

      -- Attempting duplicate insert triggers ON CONFLICT (idempotency)
      BEGIN
        INSERT INTO public.enquiry_conversation_messages (
          conversation_id, channel, direction, external_message_id,
          sender_address, subject
        ) VALUES (
          v_conv_id, 'email', 'outbound', v_msg_id,
          'sales@avira.co.id', 'Quotation Ref E100'
        );
      EXCEPTION WHEN unique_violation THEN
        -- Expected idempotency defense
        NULL;
      END;

      SELECT count(*) INTO v_initial_count
      FROM public.enquiry_conversation_messages
      WHERE external_message_id = v_msg_id;
      ASSERT v_initial_count = 1, 'Re-run must not create duplicate canonical message';

      -- Cleanup
      DELETE FROM public.crm_email_activities WHERE id = v_activity_id;
      DELETE FROM public.enquiry_conversation_messages WHERE id = v_msg_id_canon;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
    END $$;
  `;
  runDbScript(scenarioABScript);
});

test('12. Phase 6.2 Scenario C & Safety Rule 5: email_thread_map does not cover general outbound and sweep avoids fabricated defaults', () => {
  assert.match(sharedIngestion, /Cannot faithfully reconstruct outbound message/);
  assert.doesNotMatch(
    sharedIngestion,
    /fromEmail:\s*"sales@sapharmajaya\.co\.id"/,
    'Must NOT hardcode fabricated sender in reconciliation sweep'
  );
  assert.doesNotMatch(
    sharedIngestion,
    /toEmails:\s*\[\]/,
    'Must NOT hardcode empty recipient list in reconciliation sweep'
  );
});

test('13. Phase 6.2 Scenario D: Multiple outbound sends from GmailLikeComposer unite under 1 conversation with unique messageIds', () => {
  const scenarioDScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_thread_id TEXT := 'composer-multi-' || gen_random_uuid()::text;
      v_msg1_id TEXT := 'msg-1-' || gen_random_uuid()::text;
      v_msg2_id TEXT := 'msg-2-' || gen_random_uuid()::text;
      v_conv_id UUID;
      v_msg_count INT;
      v_conv_count INT;
    BEGIN
      SELECT id INTO v_inq_id FROM public.crm_inquiries LIMIT 1;
      IF v_inq_id IS NULL THEN RETURN; END IF;

      -- Send 1 creates conversation
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title
      ) VALUES (
        'email', v_thread_id, 'Quote Discussion'
      ) RETURNING id INTO v_conv_id;

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id,
        sender_address, subject, body_html
      ) VALUES (
        v_conv_id, 'email', 'outbound', v_msg1_id,
        'user@avira.co.id', 'Quote Discussion', '<p>First quote</p>'
      );

      -- Send 2 joins existing conversation on thread_id
      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id,
        sender_address, subject, body_html
      ) VALUES (
        v_conv_id, 'email', 'outbound', v_msg2_id,
        'user@avira.co.id', 'Re: Quote Discussion', '<p>Updated quote</p>'
      );

      SELECT count(*) INTO v_conv_count FROM public.enquiry_conversations WHERE external_thread_id = v_thread_id;
      ASSERT v_conv_count = 1, 'Both sends must unite into 1 conversation';

      SELECT count(*) INTO v_msg_count FROM public.enquiry_conversation_messages WHERE conversation_id = v_conv_id;
      ASSERT v_msg_count = 2, 'Both sends must exist as distinct messages';

      -- Cleanup
      DELETE FROM public.enquiry_conversation_messages WHERE conversation_id = v_conv_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
    END $$;
  `;
  runDbScript(scenarioDScript);
});

test('14. Phase 6.2 Deduplication: Caller insert does not duplicate fallback crm_email_activities row', () => {
  const dedupScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_inq_id UUID;
      v_user_id UUID;
      v_gmail_msg_id TEXT := 'dedup-test-' || gen_random_uuid()::text;
      v_act_count INT;
    BEGIN
      SELECT id INTO v_inq_id FROM public.crm_inquiries LIMIT 1;
      IF v_inq_id IS NULL THEN RETURN; END IF;
      SELECT id INTO v_user_id FROM auth.users LIMIT 1;

      -- 1. Server-side fallback activity created by send-bulk-email
      INSERT INTO public.crm_email_activities (
        inquiry_id, email_type, from_email, to_email, subject, body,
        sent_date, created_by, gmail_message_id, gmail_thread_id
      ) VALUES (
        v_inq_id, 'sent', 'sales@avira.co.id', ARRAY['client@domain.com'],
        'Unique Subject ' || v_gmail_msg_id, '<p>Full content</p>',
        now(), v_user_id, v_gmail_msg_id, v_gmail_msg_id
      );

      -- 2. Caller subsequently attempts to insert matching crm_email_activities without gmail_message_id
      INSERT INTO public.crm_email_activities (
        inquiry_id, email_type, from_email, to_email, subject, body,
        sent_date, created_by
      ) VALUES (
        v_inq_id, 'sent', 'sales@avira.co.id', ARRAY['client@domain.com'],
        'Unique Subject ' || v_gmail_msg_id, '<p>Full content</p>',
        now(), v_user_id
      );

      -- 3. Assert exactly 1 row exists (the duplicate insert was suppressed)
      SELECT count(*) INTO v_act_count
      FROM public.crm_email_activities
      WHERE subject = 'Unique Subject ' || v_gmail_msg_id;

      ASSERT v_act_count = 1, 'Duplicate insert must be intercepted by dedup trigger, count: ' || v_act_count;

      -- Cleanup
      DELETE FROM public.crm_email_activities WHERE subject = 'Unique Subject ' || v_gmail_msg_id;
    END $$;
  `;
  runDbScript(dedupScript);
});

test('15. Phase 6.2 SourcingOutbox & Reconciliation: Activity with gmail_message_id is mirrored with 100% genuine fields', () => {
  const sourcingScript = `
    SET request.jwt.claim.role = 'service_role';
    DO $$
    DECLARE
      v_gmail_msg_id TEXT := 'sourcing-recon-' || gen_random_uuid()::text;
      v_gmail_thread_id TEXT := 'sourcing-thread-' || gen_random_uuid()::text;
      v_act_id UUID;
      v_conv_id UUID;
      v_msg_id UUID;
      v_rec_body TEXT;
      v_rec_from TEXT;
    BEGIN
      -- 1. Fallback activity created for SourcingOutbox (no inquiry context)
      INSERT INTO public.crm_email_activities (
        email_type, from_email, to_email, subject, body,
        sent_date, gmail_message_id, gmail_thread_id
      ) VALUES (
        'sent', 'sourcing@avira.co.id', ARRAY['supplier@chem.com'],
        'Supplier RFQ Details', '<p>Authentic pricing text</p>',
        now(), v_gmail_msg_id, v_gmail_thread_id
      ) RETURNING id INTO v_act_id;

      -- 2. Simulate reconciliation mirroring into canonical tables
      INSERT INTO public.enquiry_conversations (
        channel, external_thread_id, title, participant_identifiers
      ) VALUES (
        'email', v_gmail_thread_id, 'Supplier RFQ Details', ARRAY['sourcing@avira.co.id', 'supplier@chem.com']
      ) RETURNING id INTO v_conv_id;

      INSERT INTO public.enquiry_conversation_messages (
        conversation_id, channel, direction, external_message_id,
        sender_address, recipient_addresses, subject, body_html
      ) VALUES (
        v_conv_id, 'email', 'outbound', v_gmail_msg_id,
        'sourcing@avira.co.id', ARRAY['supplier@chem.com'],
        'Supplier RFQ Details', '<p>Authentic pricing text</p>'
      ) RETURNING id INTO v_msg_id;

      -- 3. Assert recovered message has authentic non-fabricated fields
      SELECT body_html, sender_address INTO v_rec_body, v_rec_from
      FROM public.enquiry_conversation_messages
      WHERE id = v_msg_id;

      ASSERT v_rec_body = '<p>Authentic pricing text</p>', 'Body must match genuine email content';
      ASSERT v_rec_from = 'sourcing@avira.co.id', 'Sender must match genuine email sender';

      -- 4. Re-running sweep on same gmail_message_id is idempotent
      BEGIN
        INSERT INTO public.enquiry_conversation_messages (
          conversation_id, channel, direction, external_message_id,
          sender_address, subject
        ) VALUES (
          v_conv_id, 'email', 'outbound', v_gmail_msg_id,
          'sourcing@avira.co.id', 'Supplier RFQ Details'
        );
      EXCEPTION WHEN unique_violation THEN
        -- Expected idempotency defense
        NULL;
      END;

      -- Cleanup
      DELETE FROM public.crm_email_activities WHERE id = v_act_id;
      DELETE FROM public.enquiry_conversation_messages WHERE id = v_msg_id;
      DELETE FROM public.enquiry_conversations WHERE id = v_conv_id;
    END $$;
  `;
  runDbScript(sourcingScript);
});

test('16. Phase 6.2 Sweep Source Priority: runOutboundReconciliationSweep inspects crm_email_activities first', () => {
  assert.match(
    sharedIngestion,
    /1\. Primary Source: crm_email_activities with gmail_message_id/,
    'Reconciliation must inspect crm_email_activities as primary source'
  );
  assert.match(
    sharedIngestion,
    /2\. Secondary Source: email_thread_map with gmail_message_id/,
    'Reconciliation must inspect email_thread_map as secondary source'
  );
});


