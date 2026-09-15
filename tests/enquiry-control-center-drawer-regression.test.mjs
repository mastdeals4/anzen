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

const drawerFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryDetailDrawer.tsx', import.meta.url),
  'utf8',
);
const requestCardFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/RequestCard.tsx', import.meta.url),
  'utf8',
);
const createTaskModalFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/CreateTaskFromRequestModal.tsx', import.meta.url),
  'utf8',
);
const editReqModalFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EditRequestRequirementModal.tsx', import.meta.url),
  'utf8',
);
const transitionModalFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/TransitionRequestStateModal.tsx', import.meta.url),
  'utf8',
);
const createReqModalFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/CreateEnquiryRequestModal.tsx', import.meta.url),
  'utf8',
);
const migrationFile = readFileSync(
  new URL('../supabase/migrations/20260914183000_add_enquiry_request_to_tasks_reference_type.sql', import.meta.url),
  'utf8',
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `drawer_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

test('1. Opening Enquiry Drawer: Component receives and displays complete enquiry header', () => {
  assert.match(drawerFile, /export const EnquiryDetailDrawer/);
  assert.match(drawerFile, /activeEnquiry\.inquiryNumber/);
  assert.match(drawerFile, /activeEnquiry\.inquiryDate/);
  assert.match(drawerFile, /customer\.companyName/);
  assert.match(drawerFile, /activeEnquiry\.pipelineStatus/);
});

test('2. Enquiry with Zero Requests: Clean neutral empty state rendered without fabricating data', () => {
  assert.match(drawerFile, /No structured customer requirements recorded yet for this enquiry\./);
  assert.match(drawerFile, /Add First Requirement/);
});

test('3. Enquiry with Multiple Requests: Renders all requests dynamically without hardcoded categories', () => {
  assert.match(drawerFile, /requests\.map\(req => \(/);
  assert.match(drawerFile, /<RequestCard/);
  // Must not have hardcoded static category grids like Price / COA / Sample tabs
  assert.doesNotMatch(drawerFile, /<div id="price-request-section">/);
  assert.doesNotMatch(drawerFile, /<div id="coa-request-section">/);
});

test('4. Request Owner Display: Clearly displays assigned team and user per request', () => {
  assert.match(requestCardFile, /Team:\s*<strong>\{request\.assigned_team\}<\/strong>/);
  assert.match(requestCardFile, /request\.assigned_team/);
});

test('5. Existing Linked Task Display: Lists internal tasks under each request with metadata', () => {
  assert.match(requestCardFile, /Linked Execution Tasks \(\{linkedTasks\.length\}\)/);
  assert.match(requestCardFile, /task\.title/);
  assert.match(requestCardFile, /task\.priority/);
  assert.match(requestCardFile, /task\.status\.replace\('_', ' '\)/);
  assert.match(requestCardFile, /onOpenTaskModal\(task\.id\)/);
});

test('6. Create Task From Request: Opens modal to dispatch internal action to canonical tasks', () => {
  assert.match(createTaskModalFile, /export const CreateTaskFromRequestModal/);
  assert.match(createTaskModalFile, /Create Task for Request:\s*\$\{request\.request_code\}/);
});

test('7. Correct reference_type: Tasks table insert specifies reference_type = "enquiry_request"', () => {
  assert.match(createTaskModalFile, /reference_type:\s*'enquiry_request'/);
  assert.match(migrationFile, /'enquiry_request'/);
});

test('8. Correct reference_id: Tasks table insert specifies reference_id = request.id', () => {
  assert.match(createTaskModalFile, /reference_id:\s*request\.id/);
});

test('9. Enquiry ID Preserved: Tasks table insert retains inquiry_id link', () => {
  assert.match(createTaskModalFile, /inquiry_id:\s*inquiryId/);
});

test('10. Task Assignment: Supports assignment via canonical task_assignments table', () => {
  assert.match(createTaskModalFile, /\.from\('task_assignments'\)\s*\.insert\(assignments\)/);
  assert.match(createTaskModalFile, /assigned_users:\s*selectedUserIds/);
});

test('11. Task Completion Does NOT Resolve Request: Hard rule enforced in DB & UI architecture', () => {
  // Check UI notice
  assert.match(requestCardFile, /Completing internal tasks does not automatically satisfy this customer requirement\./);

  // Live DB test: Insert request, insert linked task, complete task, verify request status is unchanged
  const setupSql = `
    DO $$
    DECLARE
      v_inq_id UUID;
      v_user_id UUID;
      v_req_id UUID;
      v_task_id UUID;
      v_req_status TEXT;
    BEGIN
      SELECT id INTO v_inq_id FROM public.crm_inquiries LIMIT 1;
      SELECT id INTO v_user_id FROM public.user_profiles LIMIT 1;
      
      -- 1. Create enquiry request
      INSERT INTO public.enquiry_requests (
        inquiry_id, category, request_code, title, customer_requirement, status, waiting_for
      ) VALUES (
        v_inq_id, 'document', 'REQ-TEST-COA', 'COA Verification', 'Official COA required for batch analysis', 'IN_PROGRESS', 'MANUFACTURER'
      ) RETURNING id INTO v_req_id;

      -- 2. Create linked task in canonical tasks table
      INSERT INTO public.tasks (
        title, deadline, priority, status, created_by, inquiry_id, reference_type, reference_id
      ) VALUES (
        'Obtain COA from factory', NOW() + INTERVAL '2 days', 'medium', 'to_do',
        v_user_id, v_inq_id, 'enquiry_request', v_req_id
      ) RETURNING id INTO v_task_id;

      -- 3. Complete the task
      UPDATE public.tasks
      SET status = 'completed', completed_at = NOW()
      WHERE id = v_task_id;

      -- 4. Check that enquiry request status is STILL 'IN_PROGRESS' (never auto-resolved)
      SELECT status INTO v_req_status FROM public.enquiry_requests WHERE id = v_req_id;
      IF v_req_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Request was incorrectly modified by task completion: %', v_req_status;
      END IF;

      -- Cleanup
      DELETE FROM public.tasks WHERE id = v_task_id;
      DELETE FROM public.enquiry_requests WHERE id = v_req_id;
    END $$;
    SELECT 1 AS success;
  `;

  const rows = runDbScript(setupSql);
  assert.equal(rows[0]?.success, 1, 'Task completion must leave enquiry request status unchanged');
});

test('12. Request Resolution Remains Separate: Explicit business resolution required', () => {
  assert.match(transitionModalFile, /EnquiryRequestService\.resolveRequest/);
  assert.match(transitionModalFile, /response_text:\s*responseText\.trim\(\)/);
  assert.match(transitionModalFile, /Business Requirement Resolution/);
});

test('13. Request Requirement Change Creates History: Auditable append-only event recorded', () => {
  assert.match(editReqModalFile, /EnquiryRequestService\.changeRequirement/);
  assert.match(editReqModalFile, /Audited Requirement Evolution/);
});

test('14. Waiting For Change Remains Auditable: Atomic RPC records state changes', () => {
  assert.match(transitionModalFile, /EnquiryRequestService\.transitionState/);
  assert.match(transitionModalFile, /new_waiting_for:\s*waitingFor/);
});

test('15. Multiple Tasks on One Request: Groups all linked tasks under request', () => {
  assert.match(drawerFile, /linkedTasksByRequestId\[req\.id\]/);
  assert.match(requestCardFile, /linkedTasks\.map\(task =>/);
});

test('16. Multiple Requests on One Enquiry: Dynamically rendered without layout collision', () => {
  assert.match(drawerFile, /requests\.map\(req =>/);
  assert.match(drawerFile, /Customer Requirements & Execution \(\{requests\.length\}\)/);
});

test('17. Owner Separation: Enquiry Owner vs Request Owner vs Task Assignee remain strictly distinct', () => {
  assert.match(drawerFile, /Enquiry Owner:[\s\S]*?\{activeEnquiry\.assignedToName/);
  assert.match(requestCardFile, /task\.assignee_names/);
});

test('18. Blocker & Next Action Refresh: Operational summary updates on mutation', () => {
  assert.match(drawerFile, /refreshEnquiryData/);
  assert.match(drawerFile, /EnquiryControlCenterService\.getControlCenterEnquiryById/);
  assert.match(drawerFile, /operationalSummary\.currentBlocker/);
  assert.match(drawerFile, /operationalSummary\.nextAction/);
});

test('19. No Fabricated Data: Clean fallback states when no blocker or next action exist', () => {
  assert.match(drawerFile, /No active blocker recorded\./);
});

test('20. Zero Duplicate Task Architecture: Exclusively uses canonical public.tasks', () => {
  const prohibitedPatterns = [
    /create table.*enquiry_tasks/i,
    /create table.*request_tasks/i,
    /create table.*crm_tasks/i,
    /from\('enquiry_tasks'\)/,
    /from\('request_tasks'\)/,
  ];

  for (const pattern of prohibitedPatterns) {
    assert.doesNotMatch(drawerFile, pattern);
    assert.doesNotMatch(requestCardFile, pattern);
    assert.doesNotMatch(createTaskModalFile, pattern);
  }

  assert.match(createTaskModalFile, /\.from\('tasks'\)/);
  assert.match(drawerFile, /\.from\('tasks'\)/);
});

test('21. Zero Sensitive Pricing Leakage: Purchase price and supplier cost omitted from drawer', () => {
  const sensitivePatterns = [
    /purchase_price/i,
    /supplier_cost/i,
    /internal_margin/i,
    /factory_cost/i,
  ];

  for (const pattern of sensitivePatterns) {
    assert.doesNotMatch(drawerFile, pattern);
    assert.doesNotMatch(requestCardFile, pattern);
  }
});
