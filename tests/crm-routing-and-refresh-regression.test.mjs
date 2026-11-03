import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. CRM.tsx uses react-router-dom navigation hooks for URL as source of truth', () => {
  const crmPath = path.join(process.cwd(), 'src/pages/CRM.tsx');
  assert.ok(fs.existsSync(crmPath), 'src/pages/CRM.tsx must exist');
  const crmSrc = fs.readFileSync(crmPath, 'utf-8');

  assert.match(crmSrc, /useLocation/, 'CRM.tsx must use useLocation');
  assert.match(crmSrc, /useNavigate/, 'CRM.tsx must use useNavigate');
  assert.match(crmSrc, /useSearchParams/, 'CRM.tsx must use useSearchParams');
});

test('2. CRM.tsx resolves active tab from URL pathname and query parameter', () => {
  const crmPath = path.join(process.cwd(), 'src/pages/CRM.tsx');
  const crmSrc = fs.readFileSync(crmPath, 'utf-8');

  // Must support both path-based (/crm/customers) and query-based (?tab=customers)
  assert.match(crmSrc, /customers|inquiries|bulk_email|control-center|documents/);
  assert.match(crmSrc, /resolveActiveTabFromUrl|activeTabFromUrl/, 'Must implement URL tab resolution helper');
});

test('3. CRM.tsx supports deep-linking and refresh retention for Inquiry and Customer drawers', () => {
  const crmPath = path.join(process.cwd(), 'src/pages/CRM.tsx');
  const crmSrc = fs.readFileSync(crmPath, 'utf-8');

  assert.match(crmSrc, /inquiryId/, 'Must support inquiryId in URL');
  assert.match(crmSrc, /customerId/, 'Must support customerId in URL');
});

test('4. CrmBulkEmailWorkspace supports subtab URL retention (Sent/History, Recipients, Templates)', () => {
  const bulkPath = path.join(process.cwd(), 'src/components/crm/bulk-email/CrmBulkEmailWorkspace.tsx');
  assert.ok(fs.existsSync(bulkPath), 'CrmBulkEmailWorkspace.tsx must exist');
  const bulkSrc = fs.readFileSync(bulkPath, 'utf-8');

  assert.match(bulkSrc, /useSearchParams/, 'CrmBulkEmailWorkspace must use useSearchParams');
  assert.match(bulkSrc, /subtab/, 'Must read/write subtab in searchParams');
});

test('5. CrmOmnichannelInbox supports conversationId and channel filter URL retention', () => {
  const inboxPath = path.join(process.cwd(), 'src/components/crm/inbox/CrmOmnichannelInbox.tsx');
  assert.ok(fs.existsSync(inboxPath), 'CrmOmnichannelInbox.tsx must exist');
  const inboxSrc = fs.readFileSync(inboxPath, 'utf-8');

  assert.match(inboxSrc, /useSearchParams/, 'CrmOmnichannelInbox must use useSearchParams');
  assert.match(inboxSrc, /conversationId/, 'Must read/write conversationId in searchParams');
});

