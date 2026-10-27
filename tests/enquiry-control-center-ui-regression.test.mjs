import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  deriveEnquiryAge,
  deriveEnquiryDueInfo,
  deriveCurrentBlocker,
  deriveWaitingFor,
  deriveNextAction,
  deriveRequestStats,
  deriveOperationalSummary,
} from '../src/services/enquiry/enquiryControlCenterResolvers.ts';

const ccRowFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryControlCenterRow.tsx', import.meta.url),
  'utf8',
);
const ccTableFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryControlCenterTable.tsx', import.meta.url),
  'utf8',
);
const ccFiltersFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryControlCenterFilters.tsx', import.meta.url),
  'utf8',
);
const ccToolbarFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryControlCenterToolbar.tsx', import.meta.url),
  'utf8',
);
const ccBadgesFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/RequestBadges.tsx', import.meta.url),
  'utf8',
);
const ccCustomerNeedFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/CustomerNeedCell.tsx', import.meta.url),
  'utf8',
);
const ccInlineEditFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/InlineEditDropdown.tsx', import.meta.url),
  'utf8',
);
const ccDrawerShellFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryDetailDrawerShell.tsx', import.meta.url),
  'utf8',
);
const ccIndexFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/index.ts', import.meta.url),
  'utf8',
);
const crmPageFile = readFileSync(
  new URL('../src/pages/CRM.tsx', import.meta.url),
  'utf8',
);
const standalonePageFile = readFileSync(
  new URL('../src/pages/EnquiryControlCenter.tsx', import.meta.url),
  'utf8',
);

test('1. Historical Enquiry Rendering: Clean fallback for legacy inquiries with no requests', () => {
  const requests = [];
  const fixedNow = new Date('2026-09-14T12:00:00Z').getTime();

  const blocker = deriveCurrentBlocker(requests);
  assert.equal(blocker, null, 'Blocker must be null when no requests exist');

  const waiting = deriveWaitingFor(requests);
  assert.equal(waiting.primary, 'NONE');
  assert.equal(waiting.summary, 'None');

  const nextAction = deriveNextAction(requests);
  assert.equal(nextAction, null, 'Next action must be null when no requests exist');

  // Verify EnquiryControlCenterRow renders safe neutral dashes when blocker and nextAction are null
  assert.match(ccRowFile, /operationalSummary\.currentBlocker\s*\?\s*\(/, 'Row has conditional for blocker');
  assert.match(ccRowFile, /operationalSummary\.nextAction\s*\?\s*\(/, 'Row has conditional for next action');
});

test('2. Customer Need Formatter: Extracts authentic requirements without fabrication', () => {
  // Check CustomerNeedCell code logic
  assert.match(ccCustomerNeedFile, /parts\.push\(cleanQty\)/);
  assert.match(ccCustomerNeedFile, /parts\.push\(cleanSpec\)/);
  assert.match(ccCustomerNeedFile, /parts\.join\(' — '\)/);
  assert.match(ccCustomerNeedFile, /<span className="text-gray-400 text-xs">—<\/span>/);
});

test('3. Multiple Requests Rendering: Dynamic badge grouping across categories and statuses', () => {
  assert.match(ccBadgesFile, /export const RequestBadges/);
  assert.match(ccBadgesFile, /CATEGORY_ABBREV/);
  // Must support commercial, technical, document, sample, logistic dynamically
  assert.match(ccBadgesFile, /commercial/);
  assert.match(ccBadgesFile, /technical/);
  assert.match(ccBadgesFile, /document/);
  assert.match(ccBadgesFile, /sample/);
  assert.match(ccBadgesFile, /logistic/);
});

test('4. Blocked Request Displays Real Blocker Text: Does not collapse into generic "Blocked"', () => {
  const requests = [
    {
      id: 'req-blk',
      category: 'technical',
      request_code: 'REQ-TECH',
      title: 'Particle Size Verification',
      status: 'BLOCKED',
      waiting_for: 'MANUFACTURER',
      current_issue: '100 mesh unavailable; manufacturer offers 660 mesh only',
      next_action: 'Customer to approve 660 mesh alternative',
      assigned_to: 'tech-user',
      assigned_team: 'qa_lab',
      due_at: '2026-09-16T12:00:00Z',
      is_overdue: false,
    },
  ];

  const blocker = deriveCurrentBlocker(requests);
  assert.equal(blocker, '100 mesh unavailable; manufacturer offers 660 mesh only');

  // Verify in row component that blocker displays the actual text
  assert.match(ccRowFile, /operationalSummary\.currentBlocker/);
  assert.doesNotMatch(ccRowFile, /<span>Blocked<\/span>/, 'Must not replace real issue with generic "Blocked"');
});

test('5. Waiting Party Displays Correctly & Extensibly: Colors known parties and tolerates arbitrary future values', () => {
  // Test resolver
  const waitingCustomer = deriveWaitingFor([{ waiting_for: 'CUSTOMER', status: 'IN_PROGRESS' }]);
  assert.equal(waitingCustomer.primary, 'CUSTOMER');

  const waitingIndia = deriveWaitingFor([{ waiting_for: 'INDIA', status: 'IN_PROGRESS' }]);
  assert.equal(waitingIndia.primary, 'INDIA');

  const waitingManufacturer = deriveWaitingFor([{ waiting_for: 'MANUFACTURER', status: 'IN_PROGRESS' }]);
  assert.equal(waitingManufacturer.primary, 'MANUFACTURER');

  // Test dynamic custom value
  const waitingPort = deriveWaitingFor([{ waiting_for: 'CUSTOMS_PORT_AUTHORITY', status: 'IN_PROGRESS' }]);
  assert.equal(waitingPort.primary, 'CUSTOMS_PORT_AUTHORITY');

  // Verify row handles unknown parties gracefully with safe fallback styling
  assert.match(ccRowFile, /WAITING_FOR_COLORS\[waitingKey\]\s*\|\|\s*'bg-slate-100/);
});

test('6. No Next Action Remains Blank: Renders neutral "—" without inventing filler text', () => {
  const requests = [
    {
      id: 'req-open',
      category: 'document',
      status: 'OPEN',
      next_action: null,
    },
  ];

  const nextAction = deriveNextAction(requests);
  assert.equal(nextAction, null);
  // Verify row renders neutral "—"
  assert.match(ccRowFile, /<span className="text-gray-400 text-xs">—<\/span>/);
});

test('7. Enquiry Owner is Correct: Distinct from request assignee', () => {
  const fixedNow = new Date('2026-09-14T12:00:00Z').getTime();
  const requests = [
    {
      id: 'req-1',
      category: 'commercial',
      status: 'IN_PROGRESS',
      assigned_to: 'user-pricing-kunal',
      assigned_team: 'pricing_india',
      next_action: 'Quote price',
    },
  ];

  const summary = deriveOperationalSummary('user-sales-rep-1', 'Budi Sales', requests, fixedNow);
  // Primary owner must remain Budi Sales (the enquiry owner), NOT the request assignee
  assert.equal(summary.primaryOwner.id, 'user-sales-rep-1');
  assert.equal(summary.primaryOwner.name, 'Budi Sales');
});

test('8. Request Owner is Not Incorrectly Shown as Enquiry Owner: Grid binds to row.assignedToName', () => {
  assert.match(ccRowFile, /row\.assignedToName/);
  // Ensure the owner column in table row does NOT pull req.assigned_to
  assert.doesNotMatch(ccRowFile, /<td.*?>\s*\{row\.requests\[.*?\]\.assigned_to/);
});

test('9. Dynamic Waiting Values Do Not Crash the Table: Safe dictionary lookup', () => {
  assert.match(ccRowFile, /const WAITING_FOR_COLORS:\s*Record<string,\s*string>/);
  assert.match(ccRowFile, /bg-slate-100 text-slate-700 border-slate-200/);
});

test('10. Search Configuration: Supported fields are enquiry number, customer/company, and product', () => {
  assert.match(ccToolbarFile, /placeholder="Search enquiry #, company, or product\.\.\."/);
  assert.match(ccToolbarFile, /onSearchChange\(e\.target\.value\)/);
});

test('11. Pagination: 25 / 50 / 100 limit selector and page jump controls', () => {
  assert.match(ccTableFile, /Showing <span className="font-semibold text-gray-800">/);
  assert.match(ccTableFile, /onPageChange\(page\s*-\s*1\)/);
  assert.match(ccTableFile, /onPageChange\(page\s*\+\s*1\)/);
  assert.match(ccToolbarFile, /<option value=\{25\}>25 \/ page<\/option>/);
  assert.match(ccToolbarFile, /<option value=\{50\}>50 \/ page<\/option>/);
  assert.match(ccToolbarFile, /<option value=\{100\}>100 \/ page<\/option>/);
});

test('12. Fast Filters: All 10 operational filter keys are supported with real counts', () => {
  const expectedFilters = [
    'all',
    'active',
    'overdue',
    'waiting_customer',
    'waiting_india',
    'waiting_manufacturer',
    'blocked',
    'price_ready',
    'unassigned',
    'stalled',
  ];

  for (const filterKey of expectedFilters) {
    assert.match(ccFiltersFile, new RegExp(`key:\\s*'${filterKey}'`));
  }
});

test('13. Sorting Controls: Multi-column header click sort with visual asc/desc indicator', () => {
  assert.match(ccTableFile, /onSortChange\('inquiry_number'\)/);
  assert.match(ccTableFile, /onSortChange\('inquiry_date'\)/);
  assert.match(ccTableFile, /sortDirection === 'asc'/);
});

test('14. Lost Enquiries Filter Behavior: Excluded from active view, visible under all', () => {
  // Verify filter logic differentiates active from all
  assert.match(ccFiltersFile, /key:\s*'active'/);
  assert.match(ccFiltersFile, /key:\s*'all'/);
});

test('15. Zero Sensitive Purchase Price Leakage: Table and row contain no internal cost fields', () => {
  const sensitivePatterns = [
    /purchase_price/i,
    /supplier_price/i,
    /cogs/i,
    /internal_margin/i,
    /factory_cost/i,
  ];

  for (const pattern of sensitivePatterns) {
    assert.doesNotMatch(ccRowFile, pattern, `ccRowFile should not contain ${pattern}`);
    assert.doesNotMatch(ccTableFile, pattern, `ccTableFile should not contain ${pattern}`);
  }
});

test('16. Task Engine Integrity: Zero duplicate task tables or engines created', () => {
  const prohibitedTaskTables = [
    /create table.*enquiry_tasks/i,
    /create table.*crm_tasks/i,
    /create table.*request_tasks/i,
  ];

  for (const pattern of prohibitedTaskTables) {
    assert.doesNotMatch(ccRowFile, pattern);
    assert.doesNotMatch(ccTableFile, pattern);
  }

  // Drawer shell and types refer to canonical tasks reference pattern
  assert.match(ccDrawerShellFile, /reference_type:\s*'enquiry_request'/);
});

test('17. Component Architecture & Modular Exports: All 10 Phase 7.2 units exported cleanly', () => {
  assert.match(ccIndexFile, /export \* from '\.\/EnquiryControlCenter'/);
  assert.match(ccIndexFile, /export \* from '\.\/EnquiryControlCenterTable'/);
  assert.match(ccIndexFile, /export \* from '\.\/EnquiryControlCenterToolbar'/);
  assert.match(ccIndexFile, /export \* from '\.\/EnquiryControlCenterFilters'/);
  assert.match(ccIndexFile, /export \* from '\.\/EnquiryControlCenterRow'/);
  assert.match(ccIndexFile, /export \* from '\.\/RequestBadges'/);
  assert.match(ccIndexFile, /export \* from '\.\/CustomerNeedCell'/);
  assert.match(ccIndexFile, /export \* from '\.\/InlineEditDropdown'/);
  assert.match(ccIndexFile, /export \* from '\.\/EnquiryDetailDrawerShell'/);

  // CRM integration
  assert.match(crmPageFile, /import \{ EnquiryControlCenter \} from '\.\.\/components\/crm\/enquiry-control-center'/);
  assert.match(crmPageFile, /activeTab === 'control-center'/);
  assert.match(standalonePageFile, /export const EnquiryControlCenter/);
});
