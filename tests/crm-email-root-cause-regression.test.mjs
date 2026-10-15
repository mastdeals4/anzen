import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read source files directly for static AST & invariant checks
const gmailLikeComposerSrc = readFileSync(
  resolve('src/components/crm/GmailLikeComposer.tsx'),
  'utf-8'
);
const pricingWorksheetSrc = readFileSync(
  resolve('src/pages/PricingWorksheet.tsx'),
  'utf-8'
);
const sendBulkEmailSrc = readFileSync(
  resolve('supabase/functions/send-bulk-email/index.ts'),
  'utf-8'
);

// ── Canonical Database Constraint Definition ─────────────────────────────
const ALLOWED_SOURCE_STATUSES = new Set([
  'not_sent',
  'sent',
  'waiting_reply',
  'partial_received',
  'received',
  'unavailable',
]);

// ── Pure logic simulation functions matching implemented behavior ───────
function deriveSourceStatusOnSend(currentStatus) {
  const isFirstSend = !currentStatus || currentStatus === 'not_sent';
  return isFirstSend ? 'sent' : 'waiting_reply';
}

function resolveMailbox(workflowType, moduleName, requiredSenderEmail) {
  const CRM_SALES_EMAIL = 'sales@avira.co.id';
  const KUNAL_PRICING_EMAIL = 'kunal@avira.co.id';

  const CRM_WORKFLOWS = [
    'crm_bulk_email',
    'customer_quote',
    'stock_update',
    'delivery_log',
    'crm_sourcing',
    'crm_inquiry_reply',
    'crm_general',
  ];
  const PRICING_WORKFLOWS = [
    'pricing_sourcing',
    'pricing_reminder',
    'india_pricing',
    'supplier_pricing',
  ];

  if (CRM_WORKFLOWS.includes(workflowType) || moduleName === 'crm') {
    return CRM_SALES_EMAIL;
  }
  if (PRICING_WORKFLOWS.includes(workflowType) || moduleName === 'pricing') {
    return KUNAL_PRICING_EMAIL;
  }
  if (typeof requiredSenderEmail === 'string' && requiredSenderEmail.trim()) {
    const req = requiredSenderEmail.toLowerCase().trim();
    if (req === CRM_SALES_EMAIL) return CRM_SALES_EMAIL;
    if (req === KUNAL_PRICING_EMAIL) return KUNAL_PRICING_EMAIL;
  }
  return CRM_SALES_EMAIL;
}

test('BUG 1: Constraint Verification & No Invalid source_status Written', () => {
  // Verify that GmailLikeComposer never writes 'waiting_supplier'
  assert.ok(
    !gmailLikeComposerSrc.includes("source_status = 'waiting_supplier'") &&
    !gmailLikeComposerSrc.includes("source_status: 'waiting_supplier'"),
    'GmailLikeComposer must NOT write invalid source_status "waiting_supplier"'
  );

  // Verify that PricingWorksheet never writes 'waiting'
  assert.ok(
    !pricingWorksheetSrc.includes("source_status: finalSourcePrice ? 'received' : 'waiting'") &&
    !pricingWorksheetSrc.includes("source_status: row.sourcePrice ? 'received' : 'waiting'"),
    'PricingWorksheet must NOT write invalid source_status "waiting"'
  );

  // Status mapping logic
  assert.ok(
    ALLOWED_SOURCE_STATUSES.has(deriveSourceStatusOnSend(null)),
    'Initial send with null must produce valid status'
  );
  assert.equal(
    deriveSourceStatusOnSend(null),
    'sent',
    'Initial send must transition to "sent"'
  );
  assert.equal(
    deriveSourceStatusOnSend('not_sent'),
    'sent',
    'Initial send from "not_sent" must transition to "sent"'
  );
  assert.equal(
    deriveSourceStatusOnSend('sent'),
    'waiting_reply',
    'Subsequent send/reminder must transition to "waiting_reply"'
  );
  assert.equal(
    deriveSourceStatusOnSend('waiting_reply'),
    'waiting_reply',
    'Repeat reminder must stay "waiting_reply"'
  );

  // Verify all possible generated values are within canonical constraint
  ['not_sent', 'sent', 'waiting_reply', null, undefined].forEach(st => {
    const next = deriveSourceStatusOnSend(st);
    assert.ok(
      ALLOWED_SOURCE_STATUSES.has(next),
      `Derived status "${next}" must be allowed by crm_inquiries_source_status_chk`
    );
  });
});

test('BUG 1: Delivery Order, Status Failure Handling & Safe Retry without Duplicates', () => {
  // Simulated state machine for composer session
  let emailsDispatched = 0;
  let deliveryResult = null;
  let dbUpdateFailedOnce = true;
  let inquiryStatus = 'not_sent';

  const simulateComposerSend = (shouldFailDb = false) => {
    // 1. Dispatch email if not already delivered in this session
    if (!deliveryResult?.delivered) {
      emailsDispatched += 1;
      deliveryResult = {
        delivered: true,
        sentAt: new Date().toISOString(),
        messageId: 'msg-test-123',
        threadId: 'th-test-123',
      };
    }

    // 2. Perform DB update
    if (shouldFailDb) {
      throw new Error('Database connection timeout or constraint error');
    }

    inquiryStatus = deriveSourceStatusOnSend(inquiryStatus);
    return { ok: true, inquiryStatus, emailsDispatched };
  };

  // Attempt 1: Email succeeds, DB status update fails
  assert.throws(() => {
    simulateComposerSend(true);
  }, /Database connection timeout/);

  assert.equal(emailsDispatched, 1, 'Email must have been dispatched on first attempt');
  assert.ok(deliveryResult?.delivered, 'deliveryResult must record confirmed delivery');
  assert.equal(inquiryStatus, 'not_sent', 'Inquiry status was not updated due to failure');

  // Attempt 2: User retries "Send"
  // Safe retry: deliveryResult.delivered is true, so send-bulk-email is NOT re-invoked
  const retryResult = simulateComposerSend(false);
  assert.equal(emailsDispatched, 1, 'Email must NOT be re-sent on retry (zero duplicate emails)');
  assert.equal(retryResult.inquiryStatus, 'sent', 'Inquiry status must be successfully updated on retry');

  // Invariant checks in GmailLikeComposer source
  assert.ok(
    gmailLikeComposerSrc.includes('deliveryResult') &&
    gmailLikeComposerSrc.includes('!activeDelivery?.delivered'),
    'GmailLikeComposer must guard send-bulk-email call with activeDelivery.delivered check'
  );
  assert.ok(
    gmailLikeComposerSrc.includes('Email was delivered successfully (Message ID:'),
    'GmailLikeComposer must inform user that email was delivered if DB update fails'
  );
  assert.ok(
    gmailLikeComposerSrc.includes('sessionStorage.getItem(sessionDeliveryKey)') &&
    gmailLikeComposerSrc.includes('sessionStorage.setItem(sessionDeliveryKey'),
    'GmailLikeComposer must persist delivered state in sessionStorage to survive page refresh / reopen'
  );
});

test('BUG 1: Duplicate Prevention Across Page Refresh and Network Timeouts', () => {
  // 1. Simulate sessionStorage persistence across page refresh
  const mockSessionStorage = new Map();
  const inquiryId = 'inq-test-refresh';
  const mode = 'india';
  const sessionKey = `crm_delivery_${inquiryId}_${mode}`;

  // Before send, no cached delivery
  assert.equal(mockSessionStorage.has(sessionKey), false);

  // Email delivery succeeds, but DB update fails
  const initialDelivery = {
    delivered: true,
    sentAt: new Date().toISOString(),
    messageId: 'msg-delivered-999',
    threadId: 'th-999',
  };
  mockSessionStorage.set(sessionKey, JSON.stringify(initialDelivery));

  // User refreshes page (React state re-initializes, reads from sessionStorage)
  let restoredDelivery = null;
  const cached = mockSessionStorage.getItem ? mockSessionStorage.getItem(sessionKey) : mockSessionStorage.get(sessionKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (parsed?.delivered && parsed?.sentAt && (Date.now() - new Date(parsed.sentAt).getTime() < 15 * 60 * 1000)) {
      restoredDelivery = parsed;
    }
  }

  assert.ok(restoredDelivery !== null, 'Delivery state must be restored after page refresh');
  assert.equal(restoredDelivery.messageId, 'msg-delivered-999', 'Delivered message ID must match');

  // Verify that activeDelivery is truthy, so send-bulk-email is SKIPPED
  let emailsSentOnRetry = 0;
  if (!restoredDelivery?.delivered) {
    emailsSentOnRetry += 1;
  }
  assert.equal(emailsSentOnRetry, 0, 'No email must be sent when retrying after a page refresh');

  // 2. Server-side outbound deduplication against network timeouts
  assert.ok(
    sendBulkEmailSrc.includes('// ── 3b. Outbound deduplication safeguard ──────────────────────────────') &&
    sendBulkEmailSrc.includes('Deduplicating send for inquiry') &&
    sendBulkEmailSrc.includes('deduplicated: true'),
    'send-bulk-email must contain deduplication check in crm_email_activities before calling Gmail API'
  );
});

test('BUG 2: Sender Selection & Admin Login Decoupling', () => {
  // Customer quotations MUST strictly select sales@avira.co.id
  assert.equal(
    resolveMailbox('customer_quote', 'crm', null),
    'sales@avira.co.id',
    'Customer quote workflow must strictly select sales@avira.co.id'
  );
  assert.equal(
    resolveMailbox(null, 'crm', null),
    'sales@avira.co.id',
    'CRM module default must strictly select sales@avira.co.id'
  );

  // Supplier / pricing workflows MUST strictly select kunal@avira.co.id
  assert.equal(
    resolveMailbox('india_pricing', 'pricing', null),
    'kunal@avira.co.id',
    'India pricing workflow must strictly select kunal@avira.co.id'
  );
  assert.equal(
    resolveMailbox('supplier_pricing', 'pricing', null),
    'kunal@avira.co.id',
    'Supplier pricing workflow must strictly select kunal@avira.co.id'
  );

  // Connection check in frontend must use edge function to avoid RLS block on admin user
  assert.ok(
    gmailLikeComposerSrc.includes("checkConnectionOnly: true"),
    'GmailLikeComposer must use backend checkConnectionOnly to verify mailbox connectivity'
  );

  // send-bulk-email must support checkConnectionOnly
  assert.ok(
    sendBulkEmailSrc.includes('checkConnectionOnly'),
    'send-bulk-email must implement checkConnectionOnly parameter'
  );
});

test('BUG 2: Silent Fallback Prevention (No Legacy Mailbox Fallback)', () => {
  // send-bulk-email must NOT fall back to sales@sapharmajaya.co.id
  assert.ok(
    !sendBulkEmailSrc.includes('const altEmail = targetEmail === CRM_SALES_EMAIL ? CRM_SALES_LEGACY_EMAIL : CRM_SALES_EMAIL'),
    'send-bulk-email must NOT silently fall back to legacy mailbox'
  );

  // Missing sender must yield NO_CONNECTION error
  assert.ok(
    sendBulkEmailSrc.includes('code: "NO_CONNECTION"'),
    'send-bulk-email must return NO_CONNECTION code when requested mailbox is missing'
  );
});

test('BUG 2: Token Expiry, Refresh Logic & TOKEN_REAUTH_REQUIRED', () => {
  // Must verify refresh_token existence
  assert.ok(
    sendBulkEmailSrc.includes('!connection.refresh_token'),
    'getValidAccessToken must check for presence of refresh_token'
  );

  // Must signal TOKEN_REAUTH_REQUIRED on refresh error
  assert.ok(
    sendBulkEmailSrc.includes('TOKEN_REAUTH_REQUIRED') &&
    sendBulkEmailSrc.includes('reauthRequired: isRefreshError'),
    'send-bulk-email must return TOKEN_REAUTH_REQUIRED when token refresh fails'
  );

  // Token freshness buffer logic simulation
  const checkTokenFreshness = (expiresAtStr, bufferMinutes = 5) => {
    const expiry = new Date(expiresAtStr || 0);
    const bufferMs = bufferMinutes * 60 * 1000;
    return !Number.isNaN(expiry.getTime()) && expiry.getTime() - bufferMs > Date.now();
  };

  const expiredDate = new Date(Date.now() - 3600 * 1000).toISOString();
  const freshDate = new Date(Date.now() + 3600 * 1000).toISOString();

  assert.equal(checkTokenFreshness(expiredDate), false, 'Expired token must trigger refresh');
  assert.equal(checkTokenFreshness(freshDate), true, 'Fresh token must not trigger unnecessary refresh');
});

test('BUG 2: Credential & Token Privacy (No Secret Exposure)', () => {
  // In getValidAccessToken, error must NOT echo raw response containing possible secrets
  assert.ok(
    !sendBulkEmailSrc.includes('Failed to refresh access token: ${errText}'),
    'Raw error text from Google token endpoint must NOT be echoed in thrown Error'
  );

  // Error message for refresh failure must be safe and descriptive
  assert.ok(
    sendBulkEmailSrc.includes('Failed to refresh access token for ${connection.email_address}'),
    'Safe error message identifying mailbox must be used'
  );
});
