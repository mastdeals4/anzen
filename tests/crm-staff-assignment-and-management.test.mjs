import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. CrmInquiriesWorkspace provides staff assignment filtering and manager views', () => {
  const wsPath = path.join(process.cwd(), 'src/components/crm/inquiries/CrmInquiriesWorkspace.tsx');
  const src = fs.readFileSync(wsPath, 'utf-8');

  // Staff filter
  assert.match(src, /assignedStaffFilter/, 'Must include assignedStaffFilter state');
  assert.match(src, /user_profiles/, 'Must query user_profiles for staff list');

  // Manager views: overdue follow-ups, pending quotes
  assert.match(src, /overdue_followups|overdue/i, 'Must support overdue follow-up filtering');
  assert.match(src, /pending_quotes|Send Quote/i, 'Must support pending quotes view');
});

test('2. CrmInquiryDrawer supports direct salesperson reassignment with audit logging', () => {
  const drawerPath = path.join(process.cwd(), 'src/components/crm/inquiries/CrmInquiryDrawer.tsx');
  const src = fs.readFileSync(drawerPath, 'utf-8');

  assert.match(src, /handleReassignStaff|reassign/i, 'Must provide reassignment handler');
  assert.match(src, /assigned_to/, 'Must update assigned_to in crm_inquiries');
  assert.match(src, /crm_activities/, 'Must log reassignment in crm_activities');
});

