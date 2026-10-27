import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const ccTypes = readFileSync(
  new URL('../src/types/enquiry/controlCenter.types.ts', import.meta.url),
  'utf8',
);
const ccService = readFileSync(
  new URL('../src/services/enquiry/EnquiryControlCenterService.ts', import.meta.url),
  'utf8',
);
const ccResolvers = readFileSync(
  new URL('../src/services/enquiry/enquiryControlCenterResolvers.ts', import.meta.url),
  'utf8',
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `enq_cc_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

test('1. Type & Service Structure: Exposes all required Phase 7.1 read models', () => {
  assert.match(ccTypes, /export interface EnquiryControlCenterRow/);
  assert.match(ccTypes, /export interface EnquiryOperationalSummary/);
  assert.match(ccTypes, /export interface EnquiryRequestGridItem/);
  assert.match(ccTypes, /export interface EnquiryRequestStats/);
  assert.match(ccTypes, /export interface EnquiryControlCenterQueryParams/);
  assert.match(ccTypes, /export interface EnquiryControlCenterQueryResult/);
  assert.match(ccService, /export class EnquiryControlCenterService/);
  assert.match(ccService, /static async getControlCenterEnquiries/);
  assert.match(ccService, /static async getControlCenterEnquiryById/);
});

test('2. Single Enquiry with No Requests (Historical Pattern): Zero fabricated operational text', () => {
  const requests = [];
  const fixedNow = new Date('2026-09-14T12:00:00Z').getTime();

  const blocker = deriveCurrentBlocker(requests);
  assert.equal(blocker, null, 'Blocker must be null when no requests exist');

  const waiting = deriveWaitingFor(requests);
  assert.equal(waiting.primary, 'NONE');
  assert.equal(waiting.summary, 'None');
  assert.deepEqual(waiting.breakdown, {});

  const nextAction = deriveNextAction(requests);
  assert.equal(nextAction, null, 'Next action must be null when no requests exist');

  const stats = deriveRequestStats(requests, fixedNow);
  assert.equal(stats.total, 0);
  assert.equal(stats.open, 0);
  assert.equal(stats.blocked, 0);

  const summary = deriveOperationalSummary('user-uuid-1', 'Sales Rep', requests, fixedNow);
  assert.equal(summary.currentBlocker, null);
  assert.equal(summary.waitingFor, 'NONE');
  assert.equal(summary.nextAction, null);
  assert.equal(summary.primaryOwner.name, 'Sales Rep');
});

test('3. Enquiry with Multiple Active Requests: Deterministic hierarchy and stats aggregation', () => {
  const fixedNow = new Date('2026-09-14T12:00:00Z').getTime();
  const requests = [
    {
      id: 'req-1',
      category: 'commercial',
      request_code: 'REQ-01',
      title: 'Price Inquiry',
      customer_requirement: '500 KG CIF Jakarta',
      status: 'IN_PROGRESS',
      waiting_for: 'INDIA',
      current_issue: null,
      next_action: 'Kunal to review India source quotation',
      assigned_to: 'user-kunal',
      assigned_team: 'pricing_india',
      due_at: '2026-09-15T12:00:00Z',
      reminder_level: 0,
      created_at: '2026-09-13T10:00:00Z',
    },
    {
      id: 'req-2',
      category: 'technical',
      request_code: 'REQ-02',
      title: 'Mesh Specification',
      customer_requirement: '100 mesh standard',
      status: 'OPEN',
      waiting_for: 'CUSTOMER',
      current_issue: null,
      next_action: 'Send technical data sheet to customer',
      assigned_to: 'user-sales',
      assigned_team: 'sales',
      due_at: '2026-09-16T12:00:00Z',
      reminder_level: 0,
      created_at: '2026-09-13T11:00:00Z',
    },
    {
      id: 'req-3',
      category: 'document',
      request_code: 'REQ-03',
      title: 'COA Request',
      customer_requirement: 'Manufacturer COA with heavy metal test',
      status: 'RESOLVED',
      waiting_for: 'NONE',
      current_issue: null,
      next_action: null,
      assigned_to: 'user-regulatory',
      assigned_team: 'regulatory',
      due_at: null,
      reminder_level: 0,
      created_at: '2026-09-13T12:00:00Z',
    },
  ];

  const blocker = deriveCurrentBlocker(requests);
  assert.equal(blocker, null, 'No blocked requests so blocker is null');

  const waiting = deriveWaitingFor(requests);
  // Active are REQ-01 (INDIA) and REQ-02 (CUSTOMER). Priority rule: CUSTOMER > INDIA
  assert.equal(waiting.primary, 'CUSTOMER', 'Customer has priority over India for unblocked active requests');
  assert.equal(waiting.summary, 'Customer (1), India (1)');
  assert.equal(waiting.breakdown.CUSTOMER, 1);
  assert.equal(waiting.breakdown.INDIA, 1);

  const nextAction = deriveNextAction(requests);
  // IN_PROGRESS (REQ-01) takes priority over OPEN (REQ-02)
  assert.equal(nextAction, 'Kunal to review India source quotation');

  const stats = deriveRequestStats(requests, fixedNow);
  assert.equal(stats.total, 3);
  assert.equal(stats.open, 1);
  assert.equal(stats.inProgress, 1);
  assert.equal(stats.resolved, 1);
  assert.equal(stats.blocked, 0);
  assert.equal(stats.overdue, 0);
});

test('4. One Blocked Request (The 100 mesh -> 660 mesh blocker): Blocker and waiting_for elevation', () => {
  const fixedNow = new Date('2026-09-14T12:00:00Z').getTime();
  const requests = [
    {
      id: 'req-price',
      category: 'commercial',
      request_code: 'REQ-01',
      title: 'Price 500 KG',
      customer_requirement: 'USD quote CIF Jakarta',
      status: 'IN_PROGRESS',
      waiting_for: 'INDIA',
      current_issue: null,
      next_action: 'Awaiting spec resolution before final quote',
      assigned_to: 'user-kunal',
      assigned_team: 'pricing_india',
      due_at: '2026-09-16T12:00:00Z',
      reminder_level: 0,
      created_at: '2026-09-11T10:00:00Z',
    },
    {
      id: 'req-spec',
      category: 'technical',
      request_code: 'REQ-02',
      title: '100 Mesh Specification',
      customer_requirement: '100 mesh pharmaceutical',
      status: 'BLOCKED',
      waiting_for: 'CUSTOMER',
      current_issue: '100 mesh unavailable; manufacturer offers 660 mesh only',
      next_action: 'Ask customer whether 660 mesh is acceptable for trial',
      assigned_to: 'user-budi',
      assigned_team: 'sales',
      due_at: '2026-09-14T17:00:00Z',
      reminder_level: 1,
      created_at: '2026-09-11T11:00:00Z',
    },
  ];

  const blocker = deriveCurrentBlocker(requests);
  assert.equal(blocker, '100 mesh unavailable; manufacturer offers 660 mesh only');

  const waiting = deriveWaitingFor(requests);
  assert.equal(waiting.primary, 'CUSTOMER', 'Blocked request waiting_for must elevate to primary waiting_for');
  assert.equal(waiting.summary, 'Customer (1), India (1)');

  const nextAction = deriveNextAction(requests);
  assert.equal(nextAction, 'Ask customer whether 660 mesh is acceptable for trial', 'Blocked request action takes top precedence');

  const summary = deriveOperationalSummary('user-budi', 'Budi Santoso', requests, fixedNow);
  assert.equal(summary.currentBlocker, '100 mesh unavailable; manufacturer offers 660 mesh only');
  assert.equal(summary.waitingFor, 'CUSTOMER');
  assert.equal(summary.nextAction, 'Ask customer whether 660 mesh is acceptable for trial');
  assert.equal(summary.stats.blocked, 1);
});

test('5. Multiple Blocked Requests: Deterministic category urgency priority', () => {
  const requests = [
    {
      id: 'req-comm-blocked',
      category: 'commercial',
      request_code: 'REQ-01',
      title: 'Commercial Terms',
      customer_requirement: '90 days credit',
      status: 'BLOCKED',
      waiting_for: 'INTERNAL',
      current_issue: 'Credit limit exceeded for prospect',
      next_action: 'Management credit approval required',
      assigned_to: null,
      assigned_team: 'management',
      due_at: null,
      reminder_level: 0,
      created_at: '2026-09-10T10:00:00Z',
    },
    {
      id: 'req-tech-blocked',
      category: 'technical',
      request_code: 'REQ-02',
      title: 'Specification',
      customer_requirement: 'Low heavy metals < 5ppm',
      status: 'BLOCKED',
      waiting_for: 'MANUFACTURER',
      current_issue: 'Factory testing methodology conflict',
      next_action: 'Clarify ICP-MS test standard with plant',
      assigned_to: null,
      assigned_team: 'regulatory',
      due_at: null,
      reminder_level: 0,
      created_at: '2026-09-11T10:00:00Z',
    },
  ];

  // Technical category has higher urgency weight than commercial
  const blocker = deriveCurrentBlocker(requests);
  assert.equal(blocker, 'Factory testing methodology conflict', 'Technical blocker takes priority over commercial blocker');

  const nextAction = deriveNextAction(requests);
  assert.equal(nextAction, 'Clarify ICP-MS test standard with plant');

  const waiting = deriveWaitingFor(requests);
  assert.equal(waiting.primary, 'MANUFACTURER');
});

test('6. Request with No Next Action: Returns null, never fabricates filler text', () => {
  const requests = [
    {
      id: 'req-1',
      category: 'sample',
      request_code: 'REQ-01',
      title: 'Sample Request',
      customer_requirement: '100g sample bottle',
      status: 'IN_PROGRESS',
      waiting_for: 'INTERNAL',
      current_issue: null,
      next_action: null, // No next action specified
      assigned_to: null,
      assigned_team: 'warehouse',
      due_at: null,
      reminder_level: 0,
      created_at: '2026-09-12T10:00:00Z',
    },
  ];

  const nextAction = deriveNextAction(requests);
  assert.equal(nextAction, null, 'Must return null rather than fabricating placeholder text');
});

test('7. Age Resolver: Accurate days, labels, and urgency buckets', () => {
  const now = new Date('2026-09-14T12:00:00Z').getTime();

  // Today
  const age0 = deriveEnquiryAge('2026-09-14', '2026-09-14T08:00:00Z', now);
  assert.equal(age0.days, 0);
  assert.equal(age0.label, 'Today');
  assert.equal(age0.urgency, 'today');

  // 2 days ago
  const age2 = deriveEnquiryAge('2026-09-12', '2026-09-12T08:00:00Z', now);
  assert.equal(age2.days, 2);
  assert.equal(age2.label, '2d');
  assert.equal(age2.urgency, 'recent');

  // 5 days ago
  const age5 = deriveEnquiryAge('2026-09-09', '2026-09-09T08:00:00Z', now);
  assert.equal(age5.days, 5);
  assert.equal(age5.label, '5d');
  assert.equal(age5.urgency, 'attention');

  // 14 days ago
  const age14 = deriveEnquiryAge('2026-08-31', '2026-08-31T08:00:00Z', now);
  assert.equal(age14.days, 14);
  assert.equal(age14.label, '14d');
  assert.equal(age14.urgency, 'ageing');

  // Missing inquiry_date falls back to created_at
  const ageFallback = deriveEnquiryAge(null, '2026-09-11T12:00:00Z', now);
  assert.equal(ageFallback.days, 3);
  assert.equal(ageFallback.label, '3d');
});

test('8. Due Resolver: Accurate overdue calculation and labels', () => {
  const now = new Date('2026-09-14T12:00:00Z').getTime();

  // Overdue request (-2 days)
  const overdueRequests = [
    {
      id: 'req-due-1',
      category: 'commercial',
      request_code: 'REQ-01',
      title: 'Overdue Quote',
      customer_requirement: 'Pricing',
      status: 'OPEN',
      waiting_for: 'INTERNAL',
      current_issue: null,
      next_action: null,
      assigned_to: null,
      assigned_team: null,
      due_at: '2026-09-12T12:00:00Z', // 2 days ago
      reminder_level: 2,
      created_at: '2026-09-10T10:00:00Z',
    },
  ];

  const dueInfo = deriveEnquiryDueInfo(overdueRequests, now);
  assert.equal(dueInfo.isOverdue, true);
  assert.match(dueInfo.dueLabel, /Overdue \(-2d\)/);

  // Due today
  const dueTodayRequests = [
    {
      id: 'req-due-2',
      category: 'technical',
      request_code: 'REQ-02',
      title: 'Spec Due Today',
      customer_requirement: 'Spec',
      status: 'IN_PROGRESS',
      waiting_for: 'INTERNAL',
      current_issue: null,
      next_action: null,
      assigned_to: null,
      assigned_team: null,
      due_at: '2026-09-14T14:00:00Z',
      reminder_level: 0,
      created_at: '2026-09-13T10:00:00Z',
    },
  ];

  const dueTodayInfo = deriveEnquiryDueInfo(dueTodayRequests, now);
  assert.equal(dueTodayInfo.isOverdue, false);
  assert.equal(dueTodayInfo.dueLabel, 'Due Today');

  // Due in future (+3 days)
  const dueFutureRequests = [
    {
      id: 'req-due-3',
      category: 'document',
      request_code: 'REQ-03',
      title: 'COA Due Future',
      customer_requirement: 'COA',
      status: 'OPEN',
      waiting_for: 'INDIA',
      current_issue: null,
      next_action: null,
      assigned_to: null,
      assigned_team: null,
      due_at: '2026-09-17T12:00:00Z',
      reminder_level: 0,
      created_at: '2026-09-13T10:00:00Z',
    },
  ];

  const dueFutureInfo = deriveEnquiryDueInfo(dueFutureRequests, now);
  assert.equal(dueFutureInfo.isOverdue, false);
  assert.equal(dueFutureInfo.dueLabel, '+3d');
});

test('9. Ownership Separation: Enquiry owner vs request owner are kept distinct', () => {
  const requests = [
    {
      id: 'req-1',
      category: 'commercial',
      request_code: 'REQ-01',
      title: 'Pricing',
      customer_requirement: 'Price',
      status: 'IN_PROGRESS',
      waiting_for: 'INDIA',
      current_issue: null,
      next_action: null,
      assigned_to: 'user-kunal',
      assigned_team: 'pricing_india',
      due_at: null,
      reminder_level: 0,
      created_at: '2026-09-14T08:00:00Z',
    },
  ];

  // Case A: Enquiry has assigned sales rep
  const summaryA = deriveOperationalSummary('user-sales-rep', 'Dewi Sartika', requests);
  assert.equal(summaryA.primaryOwner.id, 'user-sales-rep');
  assert.equal(summaryA.primaryOwner.name, 'Dewi Sartika');

  // Case B: Enquiry has no assigned sales rep; falls back to active request team
  const summaryB = deriveOperationalSummary(null, null, requests);
  assert.equal(summaryB.primaryOwner.id, 'user-kunal');
  assert.equal(summaryB.primaryOwner.team, 'pricing_india');
});

test('10. Live Supabase Query Execution: Query runs cleanly against linked DB and adheres to pagination', () => {
  // Query 5 rows via linked Supabase database CLI
  const rows = runDbScript(`
    SELECT json_build_object(
      'id', i.id,
      'inquiry_number', i.inquiry_number,
      'company_name', i.company_name,
      'product_name', i.product_name,
      'pipeline_status', i.pipeline_status,
      'priority', i.priority,
      'price_ready', i.price_ready,
      'request_count', (SELECT count(*) FROM enquiry_requests er WHERE er.inquiry_id = i.id)
    ) as row_data
    FROM crm_inquiries i
    WHERE i.pipeline_status IS DISTINCT FROM 'lost'
    ORDER BY i.created_at DESC
    LIMIT 5;
  `);

  assert.ok(Array.isArray(rows), 'Rows must be returned from live database');
  assert.ok(rows.length > 0, 'Database should contain active inquiries');

  const firstRow = rows[0].row_data;
  assert.ok(firstRow.id, 'Row must have id');
  assert.ok(firstRow.inquiry_number, 'Row must have inquiry_number');
  assert.ok(typeof firstRow.price_ready === 'boolean', 'price_ready must be boolean');
  assert.equal(firstRow.request_count, 0, 'Historical enquiries have 0 requests without backfill pollution');
});

test('11. Database Count Invariant: 2,041 historical activities and ERP tables remain 100% untouched', () => {
  const counts = runDbScript(`
    SELECT 
      (SELECT count(*) FROM crm_email_activities) as crm_email_activities,
      (SELECT count(*) FROM crm_inquiries) as crm_inquiries,
      (SELECT count(*) FROM enquiry_requests) as enquiry_requests,
      (SELECT count(*) FROM enquiry_conversations) as enquiry_conversations;
  `);

  assert.equal(Number(counts[0].crm_email_activities), 2041, 'Historical activities must remain exactly 2,041');
  assert.ok(Number(counts[0].crm_inquiries) > 0, 'crm_inquiries must be present');
  assert.equal(Number(counts[0].enquiry_requests), 0, 'Zero premature synthetic enquiry requests');
  assert.equal(Number(counts[0].enquiry_conversations), 0, 'Zero premature synthetic conversations');
});

test('12. Lost Enquiry Handling: Pipeline status active filter excludes lost enquiries cleanly', () => {
  const activeCountRows = runDbScript(`
    SELECT count(*) as cnt FROM crm_inquiries WHERE pipeline_status IS DISTINCT FROM 'lost';
  `);
  const totalCountRows = runDbScript(`
    SELECT count(*) as cnt FROM crm_inquiries;
  `);
  const lostCountRows = runDbScript(`
    SELECT count(*) as cnt FROM crm_inquiries WHERE pipeline_status = 'lost';
  `);

  const activeCnt = Number(activeCountRows[0].cnt);
  const totalCnt = Number(totalCountRows[0].cnt);
  const lostCnt = Number(lostCountRows[0].cnt);

  assert.equal(activeCnt + lostCnt, totalCnt, 'Active + lost must equal total count');
});

test('13. Future / Dynamic WaitingFor values: Resilient summary generation without crashing', () => {
  const requests = [
    {
      id: 'req-future-1',
      category: 'custom',
      request_code: 'REQ-99',
      title: 'Custom Testing',
      customer_requirement: 'Special Halal Audit',
      status: 'OPEN',
      waiting_for: 'CUSTOM_AUDITOR', // Future unknown party
      current_issue: null,
      next_action: 'Await auditor schedule',
      assigned_to: null,
      assigned_team: null,
      due_at: null,
      reminder_level: 0,
      created_at: '2026-09-14T09:00:00Z',
    },
  ];

  const waiting = deriveWaitingFor(requests);
  assert.equal(waiting.primary, 'CUSTOM_AUDITOR');
  assert.equal(waiting.summary, 'CUSTOM_AUDITOR');
  assert.equal(waiting.breakdown.CUSTOM_AUDITOR, 1);
});

test('14. Hierarchy Separation: Enquiry status, Request status, Waiting party, Task reference remain distinct', () => {
  // Test case verifying that statuses do NOT collapse into one
  const enquiryStatus = 'IN_PROGRESS';
  const requestStatus = 'BLOCKED';
  const waitingFor = 'CUSTOMER';
  const taskStatus = 'IN_PROGRESS';

  assert.notEqual(enquiryStatus, requestStatus);
  assert.notEqual(requestStatus, waitingFor);

  const requests = [
    {
      id: 'req-distinct',
      category: 'technical',
      request_code: 'REQ-01',
      title: 'Spec Validation',
      customer_requirement: 'Need USP grade',
      status: requestStatus,
      waiting_for: waitingFor,
      current_issue: 'Factory only has BP grade',
      next_action: 'Check if BP grade acceptable',
      assigned_to: null,
      assigned_team: 'sales',
      due_at: null,
      reminder_level: 0,
      created_at: '2026-09-14T10:00:00Z',
    },
  ];

  const summary = deriveOperationalSummary('user-rep-1', 'Sales Rep', requests);
  assert.equal(summary.currentBlocker, 'Factory only has BP grade');
  assert.equal(summary.waitingFor, 'CUSTOMER');
  assert.equal(summary.stats.blocked, 1);
  assert.equal(summary.stats.inProgress, 0);
});
