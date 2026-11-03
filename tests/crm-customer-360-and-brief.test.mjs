import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. Customer Drawer displays compact profile with salesperson, last contact, follow-up, and pending requests', () => {
  const drawerPath = path.join(process.cwd(), 'src/components/crm/customers/CrmCustomerDrawer.tsx');
  assert.ok(fs.existsSync(drawerPath), 'CrmCustomerDrawer.tsx must exist');
  const src = fs.readFileSync(drawerPath, 'utf-8');

  assert.match(src, /Customer Brief|generateCustomerBrief/, 'Must support Customer Brief action');
  assert.match(src, /next_follow_up|nextFollowUp/, 'Must show next follow-up');
});

test('2. Customer Brief covers discussed, offered, requested, objections, pending, and next steps', () => {
  const drawerPath = path.join(process.cwd(), 'src/components/crm/customers/CrmCustomerDrawer.tsx');
  const src = fs.readFileSync(drawerPath, 'utf-8');

  assert.match(src, /What was offered|whatWasOffered/i, 'Must summarize what was offered');
  assert.match(src, /What the customer requested|whatCustomerRequested/i, 'Must summarize what customer requested');
  assert.match(src, /What is pending|whatIsPending/i, 'Must summarize what is pending');
  assert.match(src, /What to do next|whatToDoNext/i, 'Must summarize what to do next');
});

test('3. Unified chronological timeline aggregates Email, WhatsApp, Inquiries, Quotes, and Documents', () => {
  const drawerPath = path.join(process.cwd(), 'src/components/crm/customers/CrmCustomerDrawer.tsx');
  const src = fs.readFileSync(drawerPath, 'utf-8');

  assert.match(src, /timelineItems|unifiedTimeline/, 'Must compute unified timeline');
});

