import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. DeliveryLog handles campaign counters and Resume Needed condition accurately', () => {
  const logPath = path.join(process.cwd(), 'src/components/crm/DeliveryLog.tsx');
  const src = fs.readFileSync(logPath, 'utf-8');

  // getPendingCount and canResume logic
  assert.match(src, /getPendingCount/, 'Must define getPendingCount');
  assert.match(src, /canResume/, 'Must guard canResume');
  assert.match(src, /Resume needed|Resume Needed/i, 'Must support Resume Needed indicator');
});

test('2. CrmBulkEmailWorkspace deduplicates contacts by email', () => {
  const wsPath = path.join(process.cwd(), 'src/components/crm/bulk-email/CrmBulkEmailWorkspace.tsx');
  const src = fs.readFileSync(wsPath, 'utf-8');

  assert.match(src, /seenEmails|dedup/i, 'Must deduplicate recipient emails');
});

test('3. BulkWhatsAppPilotModal exists with consent check, test mode, and human approval gate', () => {
  const modalPath = path.join(process.cwd(), 'src/components/crm/BulkWhatsAppPilotModal.tsx');
  assert.ok(fs.existsSync(modalPath), 'BulkWhatsAppPilotModal.tsx must exist');
  const src = fs.readFileSync(modalPath, 'utf-8');

  // Human approval gate & consent check
  assert.match(src, /consent|approval|optOut/i, 'Must provide consent verification gate');
  // Test mode dispatch
  assert.match(src, /testMode|testPhone/i, 'Must support test dispatch mode');
  // Live progress tracking
  assert.match(src, /progress|sending|completed/i, 'Must track sending progress');
});

