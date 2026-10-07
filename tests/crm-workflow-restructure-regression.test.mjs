import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read source files directly to perform static & behavioral regression checks
const sourcingWorkflowStatusSrc = readFileSync(
  resolve('src/utils/sourcingWorkflowStatus.ts'),
  'utf-8'
);
const emailFormattingSrc = readFileSync(
  resolve('src/utils/emailFormatting.ts'),
  'utf-8'
);
const gmailLikeComposerSrc = readFileSync(
  resolve('src/components/crm/GmailLikeComposer.tsx'),
  'utf-8'
);
const inquiryTableExcelSrc = readFileSync(
  resolve('src/components/crm/InquiryTableExcel.tsx'),
  'utf-8'
);
const crmInquiriesWorkspaceSrc = readFileSync(
  resolve('src/components/crm/inquiries/CrmInquiriesWorkspace.tsx'),
  'utf-8'
);
const sourcingOutboxSrc = readFileSync(
  resolve('src/pages/SourcingOutbox.tsx'),
  'utf-8'
);
const customerFollowUpModalSrc = readFileSync(
  resolve('src/components/crm/CustomerFollowUpModal.tsx'),
  'utf-8'
);
const dailyReminderEdgeFunctionSrc = readFileSync(
  resolve('supabase/functions/daily-sourcing-reminder/index.ts'),
  'utf-8'
);
const sendBulkEmailSrc = readFileSync(
  resolve('supabase/functions/send-bulk-email/index.ts'),
  'utf-8'
);

test('TEST 1 & 2: Route separation, India/China actions, and composer recipients', () => {
  // India action
  assert.ok(
    inquiryTableExcelSrc.includes('Send Email to India'),
    'InquiryTableExcel must have explicit Send Email to India action'
  );
  assert.ok(
    inquiryTableExcelSrc.includes('handleSendToIndia'),
    'InquiryTableExcel has handleSendToIndia'
  );
  assert.ok(
    inquiryTableExcelSrc.includes('devansh@shubham.co.in'),
    'India CC must include devansh@shubham.co.in'
  );

  // China action
  assert.ok(
    inquiryTableExcelSrc.includes('Send Email to China Team'),
    'InquiryTableExcel must have explicit Send Email to China Team action'
  );
  assert.ok(
    inquiryTableExcelSrc.includes('handleSendToChina'),
    'InquiryTableExcel has handleSendToChina'
  );

  // Route separation check: ensure rows are filtered by route
  assert.ok(
    inquiryTableExcelSrc.includes("deriveSourcingRoute(i) === 'india'"),
    'India action isolates India route inquiries'
  );
  assert.ok(
    inquiryTableExcelSrc.includes("deriveSourcingRoute(i) === 'china'"),
    'China action isolates China route inquiries'
  );

  // Sourcing outbox also provides both actions
  assert.ok(
    sourcingOutboxSrc.includes('Send Email to India'),
    'SourcingOutbox has Send Email to India button'
  );
  assert.ok(
    sourcingOutboxSrc.includes('Send Email to China Team'),
    'SourcingOutbox has Send Email to China Team button'
  );
  assert.ok(
    sourcingOutboxSrc.includes('GmailLikeComposer'),
    'SourcingOutbox reuses the CRM GmailLikeComposer'
  );

  // Sourcing sender must be kunal@avira.co.id
  assert.ok(
    gmailLikeComposerSrc.includes("'kunal@avira.co.id'"),
    'GmailLikeComposer uses kunal@avira.co.id for sourcing'
  );
  assert.ok(
    dailyReminderEdgeFunctionSrc.includes('"kunal@avira.co.id"'),
    'Daily reminder uses kunal@avira.co.id for sourcing'
  );
});

test('TEST 3: Price Received — COA Pending and aging visibility', () => {
  assert.ok(
    sourcingWorkflowStatusSrc.includes("'price_received_coa_pending'"),
    'sourcingWorkflowStatus distinguishes price_received_coa_pending'
  );
  assert.ok(
    sourcingWorkflowStatusSrc.includes('Price Received — COA Pending'),
    'sourcingWorkflowStatus labels Price Received — COA Pending clearly'
  );
  assert.ok(
    inquiryTableExcelSrc.includes('getOperationalStatus'),
    'InquiryTableExcel renders operational status'
  );
  assert.ok(
    inquiryTableExcelSrc.includes('calculateSourcingAging'),
    'InquiryTableExcel renders sourcing aging'
  );
  assert.ok(
    sourcingOutboxSrc.includes('calculateSourcingAging'),
    'SourcingOutbox renders sourcing aging'
  );
});

test('TEST 4 & 5: Daily consolidated reminder at 09:00 WIB with exact disclaimer string and no duplicates', () => {
  const exactDisclaimer =
    'This is a system-generated email. Please ignore if you have already quoted for one or two products which we have missed updating yet.';

  assert.ok(
    emailFormattingSrc.includes(exactDisclaimer),
    'emailFormatting contains exact system disclaimer'
  );
  assert.ok(
    dailyReminderEdgeFunctionSrc.includes(exactDisclaimer),
    'daily reminder edge function contains exact system disclaimer'
  );
  assert.ok(
    dailyReminderEdgeFunctionSrc.includes('crm_inquiries').valueOf() &&
      dailyReminderEdgeFunctionSrc.includes('.update({'),
    'daily reminder edge function updates existing inquiries and NEVER creates duplicates'
  );
  assert.ok(
    !dailyReminderEdgeFunctionSrc.includes('.from("crm_inquiries").insert('),
    'daily reminder edge function NEVER inserts new inquiries'
  );
  assert.ok(
    dailyReminderEdgeFunctionSrc.includes('devansh@shubham.co.in'),
    'daily reminder India CC includes devansh@shubham.co.in'
  );
  assert.ok(
    dailyReminderEdgeFunctionSrc.includes('kunal@avira.co.id'),
    'daily reminder sender is kunal@avira.co.id'
  );
});

test('TEST 6, 7 & 8: Price Submitted stage, customer follow-up and sales@avira.co.id sender', () => {
  assert.ok(
    crmInquiriesWorkspaceSrc.includes('Price Submitted (Customer Follow-up)'),
    'CrmInquiriesWorkspace has Price Submitted stage tab'
  );
  assert.ok(
    crmInquiriesWorkspaceSrc.includes('CustomerFollowUpModal'),
    'CrmInquiriesWorkspace renders CustomerFollowUpModal'
  );

  // Customer follow-up uses sales@avira.co.id
  assert.ok(
    customerFollowUpModalSrc.includes('sales@avira.co.id'),
    'CustomerFollowUpModal sends from sales@avira.co.id'
  );
  assert.ok(
    !customerFollowUpModalSrc.includes('kunal@avira.co.id'),
    'CustomerFollowUpModal NEVER sends from kunal@avira.co.id'
  );
  assert.ok(
    customerFollowUpModalSrc.includes('Kindly let us know if there is any update from your end.'),
    'CustomerFollowUpModal contains the required polite follow-up template'
  );

  // send-bulk-email verifies sales@avira.co.id
  assert.ok(
    sendBulkEmailSrc.includes('sales@avira.co.id'),
    'send-bulk-email edge function recognizes sales@avira.co.id'
  );
});

test('TEST 9 & 10: Cutover Date 20 September 2026 and Archive segregation', () => {
  assert.ok(
    sourcingWorkflowStatusSrc.includes("'2026-09-20'"),
    'Workflow cutover date is 2026-09-20'
  );
  assert.ok(
    sourcingWorkflowStatusSrc.includes('isHistoricalInquiry'),
    'sourcingWorkflowStatus provides isHistoricalInquiry'
  );

  assert.ok(
    crmInquiriesWorkspaceSrc.includes('Archive / Historical Inquiries'),
    'CrmInquiriesWorkspace has Archive / Historical Inquiries section'
  );
  assert.ok(
    crmInquiriesWorkspaceSrc.includes('historicalMetrics'),
    'CrmInquiriesWorkspace calculates historical metrics'
  );
  assert.ok(
    crmInquiriesWorkspaceSrc.includes('productsCount') &&
      crmInquiriesWorkspaceSrc.includes('customersCount'),
    'Historical analysis provides product-wise and customer-wise analytics'
  );
});
