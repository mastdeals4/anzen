import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const importInfoSrc = readFileSync(
  resolve('src/components/ImportInfo.tsx'),
  'utf-8'
);
const sendBulkEmailSrc = readFileSync(
  resolve('supabase/functions/send-bulk-email/index.ts'),
  'utf-8'
);
const processCampaignSrc = readFileSync(
  resolve('supabase/functions/process-bulk-email-campaign/index.ts'),
  'utf-8'
);
const gmailInboxListSrc = readFileSync(
  resolve('supabase/functions/gmail-inbox-list/index.ts'),
  'utf-8'
);
const gmailInboxMessageSrc = readFileSync(
  resolve('supabase/functions/gmail-inbox-message/index.ts'),
  'utf-8'
);
const bulkComposerSrc = readFileSync(
  resolve('src/components/crm/BulkEmailComposer.tsx'),
  'utf-8'
);
const omnichannelInboxSrc = readFileSync(
  resolve('src/components/crm/inbox/CrmOmnichannelInbox.tsx'),
  'utf-8'
);
const gmailLikeComposerSrc = readFileSync(
  resolve('src/components/crm/GmailLikeComposer.tsx'),
  'utf-8'
);
const inquiryDrawerSrc = readFileSync(
  resolve('src/components/crm/inquiries/CrmInquiryDrawer.tsx'),
  'utf-8'
);
const internalReplyModalSrc = readFileSync(
  resolve('src/components/crm/KunalInternalReplyModal.tsx'),
  'utf-8'
);
const customerQuoteModalSrc = readFileSync(
  resolve('src/components/crm/KunalCustomerQuoteModal.tsx'),
  'utf-8'
);
const priceRequestDetailSrc = readFileSync(
  resolve('src/pages/PriceRequestDetail.tsx'),
  'utf-8'
);
const sourcingOutboxSrc = readFileSync(
  resolve('src/pages/SourcingOutbox.tsx'),
  'utf-8'
);
const pricingEmailSrc = readFileSync(
  resolve('src/services/pricingEmail.ts'),
  'utf-8'
);
const kunalIndiaPriceSrc = readFileSync(
  resolve('src/services/kunalIndiaPrice.ts'),
  'utf-8'
);

test('1. Import Data — Server-Side Pagination & Page Size Configuration', () => {
  // 1. Default page size: 200
  assert.ok(
    importInfoSrc.includes('DEFAULT_PAGE_SIZE = 200'),
    'ImportInfo must have DEFAULT_PAGE_SIZE = 200'
  );
  assert.ok(
    importInfoSrc.includes('PAGE_SIZE_OPTIONS = [100, 200, 500]'),
    'ImportInfo page size options must be exactly 100, 200, 500'
  );
  assert.ok(
    importInfoSrc.includes('Math.min(500, Math.max(100, newSize))'),
    'ImportInfo must enforce maximum page size of 500'
  );

  // 2. Supabase server-side query pagination via range()
  assert.ok(
    importInfoSrc.includes("q.range(pg * ps, (pg + 1) * ps - 1)"),
    'ImportInfo must paginate using Supabase database range query'
  );
  assert.ok(
    importInfoSrc.includes("select('id,date,hs_code,product_name,quantity,unit,unit_rate,currency,total_usd,origin,destination,exporter,importer,type', { count: 'exact' })"),
    'ImportInfo must request exact server-side count without fetching all rows'
  );

  // 3. Recalculation of total pages and records counter
  assert.ok(
    importInfoSrc.includes('Math.max(1, Math.ceil(total / pageSize))'),
    'Total pages must dynamically recalculate as ceil(total / pageSize)'
  );
  assert.ok(
    importInfoSrc.includes('Showing') && importInfoSrc.includes('records'),
    'Table header must display "Showing X–Y of Z records"'
  );
});

test('2. Import Data — Database-Level Date Filter (Year, Month, Custom, Combined)', () => {
  // Uses existing import_data.date column without schema change
  assert.ok(
    importInfoSrc.includes("q = q.gte('date', fromDate)"),
    "Date filter must query import_data.date >= fromDate at the database level"
  );
  assert.ok(
    importInfoSrc.includes("q = q.lte('date', toDate)"),
    "Date filter must query import_data.date <= toDate at the database level"
  );

  // Quick filters: 2026, August 2026, This Year, This Month, Last Month, All Dates
  assert.ok(
    importInfoSrc.includes("preset === '2026'") &&
    importInfoSrc.includes("from: '2026-01-01', to: '2026-12-31'"),
    '2026 filter must resolve to 2026-01-01 through 2026-12-31'
  );
  assert.ok(
    importInfoSrc.includes("preset === 'august_2026'") &&
    importInfoSrc.includes("from: '2026-08-01', to: '2026-08-31'"),
    'August 2026 filter must resolve to 2026-08-01 through 2026-08-31'
  );
  assert.ok(
    importInfoSrc.includes("handleDatePreset('this_year')") &&
    importInfoSrc.includes("handleDatePreset('this_month')") &&
    importInfoSrc.includes("handleDatePreset('last_month')"),
    'Must provide quick presets for This Year, This Month, and Last Month'
  );

  // Custom date range and dropdowns
  assert.ok(
    importInfoSrc.includes('YEARS = [') && importInfoSrc.includes('MONTH_OPTIONS = ['),
    'Must have Year dropdown and Month dropdown'
  );
  assert.ok(
    importInfoSrc.includes('handleApplyCustomDate'),
    'Must support custom date range with From Date, To Date and Apply'
  );

  // Combined product filter and active date chip
  assert.ok(
    importInfoSrc.includes("q = q.ilike(f.field as string, `%${f.value.trim()}%`)"),
    'Date filter must work concurrently with product / field filters'
  );
  assert.ok(
    importInfoSrc.includes('hasActiveDateFilter') && importInfoSrc.includes('handleClearDate'),
    'Must display active date filter chip with clear button'
  );
});

test('3. CRM Sender Architecture — Strict Purpose-Based Separation & Fallback Prevention', () => {
  // send-bulk-email backend
  assert.ok(
    sendBulkEmailSrc.includes('CRM_SALES_EMAIL = "sales@sapharmajaya.co.id"') &&
    sendBulkEmailSrc.includes('KUNAL_PRICING_EMAIL = "kunal@avira.co.id"'),
    'send-bulk-email must define fixed email identities'
  );

  assert.ok(
    sendBulkEmailSrc.includes('STRICT_ACCOUNT_ROLE_VIOLATION'),
    'send-bulk-email must strictly reject cross-use with STRICT_ACCOUNT_ROLE_VIOLATION'
  );

  // Verify that CRM workflows default to CRM_SALES_EMAIL and Pricing workflows to KUNAL_PRICING_EMAIL
  assert.ok(
    sendBulkEmailSrc.includes('if (CRM_WORKFLOWS.includes(workflowType) || module === "crm")') &&
    sendBulkEmailSrc.includes('targetEmail = CRM_SALES_EMAIL;'),
    'CRM workflows must strictly target sales@sapharmajaya.co.id'
  );

  assert.ok(
    sendBulkEmailSrc.includes('else if (PRICING_WORKFLOWS.includes(workflowType) || module === "pricing")') &&
    sendBulkEmailSrc.includes('targetEmail = KUNAL_PRICING_EMAIL;'),
    'Pricing workflows must strictly target kunal@avira.co.id'
  );

  // Decoupled from user session: query gmail_connections by target email directly
  assert.ok(
    sendBulkEmailSrc.includes(".from(\"gmail_connections\")") &&
    sendBulkEmailSrc.includes(".ilike(\"email_address\", targetEmail)"),
    'Connection must be queried by targetEmail, never blindly by auth user ID'
  );

  // Bulk campaign processor uses CRM sales email
  assert.ok(
    processCampaignSrc.includes('sales@sapharmajaya.co.id'),
    'process-bulk-email-campaign must explicitly use sales@sapharmajaya.co.id'
  );

  // Gmail Inbox endpoints route by account
  assert.ok(
    gmailInboxListSrc.includes('sales@sapharmajaya.co.id') &&
    gmailInboxListSrc.includes('kunal@avira.co.id'),
    'gmail-inbox-list must separate CRM and Pricing mailboxes'
  );
  assert.ok(
    gmailInboxMessageSrc.includes('sales@sapharmajaya.co.id') &&
    gmailInboxMessageSrc.includes('kunal@avira.co.id'),
    'gmail-inbox-message must separate CRM and Pricing mailboxes'
  );
});

test('4. CRM Frontend Senders & Non-Editable UI Indicators', () => {
  // Bulk Email Composer & Campaign Processor
  assert.ok(
    bulkComposerSrc.includes('Sending from: sales@sapharmajaya.co.id'),
    'BulkEmailComposer must show non-editable indicator for sales@sapharmajaya.co.id'
  );
  assert.ok(
    bulkComposerSrc.includes("ilike('email_address', 'sales@sapharmajaya.co.id')"),
    'BulkEmailComposer must verify connection to sales@sapharmajaya.co.id'
  );
  assert.ok(
    processCampaignSrc.includes('requiredSenderEmail: "sales@sapharmajaya.co.id"'),
    'process-bulk-email-campaign must explicitly send from sales@sapharmajaya.co.id'
  );

  // Omnichannel CRM Inbox
  assert.ok(
    omnichannelInboxSrc.includes('Sending from: sales@sapharmajaya.co.id'),
    'CrmOmnichannelInbox must show non-editable indicator for sales@sapharmajaya.co.id'
  );
  assert.ok(
    omnichannelInboxSrc.includes("requiredSenderEmail: 'sales@sapharmajaya.co.id'"),
    'CrmOmnichannelInbox replies must send from sales@sapharmajaya.co.id'
  );

  // Gmail-like Composer
  assert.ok(
    gmailLikeComposerSrc.includes('sales@sapharmajaya.co.id'),
    'GmailLikeComposer must use sales@sapharmajaya.co.id for CRM'
  );

  // CRM Inquiry Drawer
  assert.ok(
    inquiryDrawerSrc.includes('Sending from: sales@sapharmajaya.co.id'),
    'CrmInquiryDrawer must show indicator for sales@sapharmajaya.co.id'
  );
  assert.ok(
    inquiryDrawerSrc.includes("requiredSenderEmail: 'sales@sapharmajaya.co.id'"),
    'CrmInquiryDrawer must send from sales@sapharmajaya.co.id'
  );

  // Kunal Internal Reply Modal
  assert.ok(
    internalReplyModalSrc.includes('Sending from: sales@sapharmajaya.co.id'),
    'KunalInternalReplyModal must show indicator for sales@sapharmajaya.co.id'
  );
  assert.ok(
    internalReplyModalSrc.includes("requiredSenderEmail: 'sales@sapharmajaya.co.id'"),
    'KunalInternalReplyModal must send from sales@sapharmajaya.co.id'
  );

  // CRM Sourcing Outbox
  assert.ok(
    sourcingOutboxSrc.includes('Sending from: sales@sapharmajaya.co.id'),
    'SourcingOutbox must show indicator for sales@sapharmajaya.co.id'
  );
  assert.ok(
    sourcingOutboxSrc.includes("requiredSenderEmail: 'sales@sapharmajaya.co.id'"),
    'SourcingOutbox must send from sales@sapharmajaya.co.id'
  );

  // Customer Quote Modal
  assert.ok(
    customerQuoteModalSrc.includes('Sending from: sales@sapharmajaya.co.id'),
    'KunalCustomerQuoteModal must show indicator for sales@sapharmajaya.co.id'
  );
  assert.ok(
    customerQuoteModalSrc.includes("requiredSenderEmail: 'sales@sapharmajaya.co.id'"),
    'KunalCustomerQuoteModal must send from sales@sapharmajaya.co.id'
  );
});

test('5. Kunal Pricing Sender Architecture & Inbox Isolation', () => {
  // PriceRequestDetail supplier requests & reminders
  assert.ok(
    priceRequestDetailSrc.includes('Sending from: kunal@avira.co.id'),
    'PriceRequestDetail must show indicator for kunal@avira.co.id on supplier sourcing and reminders'
  );
  assert.ok(
    priceRequestDetailSrc.includes("requiredSenderEmail: 'kunal@avira.co.id'"),
    'PriceRequestDetail must explicitly pass kunal@avira.co.id for sourcing requests and reminders'
  );
  assert.ok(
    priceRequestDetailSrc.includes("requiredSenderEmail: 'sales@sapharmajaya.co.id'"),
    'PriceRequestDetail customer quotes must use sales@sapharmajaya.co.id'
  );

  // Kunal India Pricing service inbox isolation
  assert.ok(
    kunalIndiaPriceSrc.includes("account: 'pricing'") &&
    kunalIndiaPriceSrc.includes("emailAddress: 'kunal@avira.co.id'"),
    'kunalIndiaPrice must query the pricing account mailbox (kunal@avira.co.id)'
  );

  // pricingEmail service
  assert.ok(
    pricingEmailSrc.includes("targetSender = req.requiredSenderEmail || (isCrm ? 'sales@sapharmajaya.co.id' : 'kunal@avira.co.id')"),
    'pricingEmail must route to sales@sapharmajaya.co.id for CRM/customer quote and kunal@avira.co.id for pricing'
  );
});
