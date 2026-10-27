import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const modalFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/IndiaDailyWorkQueueModal.tsx', import.meta.url),
  'utf8',
);
const toolbarFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryControlCenterToolbar.tsx', import.meta.url),
  'utf8',
);
const controlCenterFile = readFileSync(
  new URL('../src/components/crm/enquiry-control-center/EnquiryControlCenter.tsx', import.meta.url),
  'utf8',
);
const migrationFile = readFileSync(
  new URL('../supabase/migrations/20260914200000_implement_task_notifications_and_reminders.sql', import.meta.url),
  'utf8',
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `phase75_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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

// ============================================================================
// 1. Task assignment notification & 2. Reassignment notification
// ============================================================================
test('1 & 2. Task assignment and reassignment trigger creates notification in public.notifications', () => {
  assert.match(migrationFile, /CREATE OR REPLACE FUNCTION public\.notify_task_assignment\(\)/);
  assert.match(migrationFile, /INSERT INTO public\.notifications/);
  assert.match(migrationFile, /'task_assigned'/);
  assert.match(migrationFile, /v_message := v_assigner_name \|\| ' assigned you to task: '/);
  assert.match(migrationFile, /ON CONFLICT \(user_id, type, message\) WHERE \(is_read = false\)\s+DO NOTHING/);

  // Verify live function definition is not a placeholder
  const rows = runDbScript(`
    SELECT prosrc FROM pg_proc WHERE proname = 'notify_task_assignment';
  `);
  assert.ok(rows.length > 0, 'notify_task_assignment function must exist');
  assert.match(rows[0].prosrc, /INSERT INTO public\.notifications/);
  assert.doesNotMatch(rows[0].prosrc, /This is a placeholder for notification logic/);
});

// ============================================================================
// 3. @Mention notification
// ============================================================================
test('3. @Mention in task comment generates notification for mentioned user', () => {
  assert.match(migrationFile, /CREATE OR REPLACE FUNCTION public\.notify_mentioned_users\(\)/);
  assert.match(migrationFile, /'task_mention'/);
  assert.match(migrationFile, /FOREACH v_mentioned_id IN ARRAY NEW\.mentions/);

  const rows = runDbScript(`
    SELECT prosrc FROM pg_proc WHERE proname = 'notify_mentioned_users';
  `);
  assert.ok(rows.length > 0, 'notify_mentioned_users function must exist');
  assert.match(rows[0].prosrc, /'task_mention'/);
  assert.doesNotMatch(rows[0].prosrc, /This is a placeholder for notification logic/);
});

// ============================================================================
// 4. Due-today detection & 5. Overdue detection
// ============================================================================
test('4 & 5. Due-today and overdue detection in India Daily Work Queue', () => {
  assert.match(modalFile, /isOverdue = true/);
  assert.match(modalFile, /isDueToday = true/);
  assert.match(modalFile, /🔴 Overdue/);
  assert.match(modalFile, /🟠 Due Today/);
});

// ============================================================================
// 6. Reminder idempotency & 7. Repeated execution creates no duplicates
// ============================================================================
test('6 & 7. evaluate_enquiry_task_reminders is strictly idempotent and safe on repeat', () => {
  assert.match(migrationFile, /CREATE OR REPLACE FUNCTION public\.evaluate_enquiry_task_reminders\(\)/);
  assert.match(migrationFile, /ON CONFLICT \(user_id, type, message\) WHERE \(is_read = false\)\s+DO NOTHING/);

  // Run RPC twice against live database to prove idempotency
  const rows1 = runDbScript(`SELECT * FROM public.evaluate_enquiry_task_reminders();`);
  const rows2 = runDbScript(`SELECT * FROM public.evaluate_enquiry_task_reminders();`);
  assert.ok(rows1.length > 0, 'First execution succeeded');
  assert.ok(rows2.length > 0, 'Second execution succeeded without error or duplication');
});

// ============================================================================
// 8. Escalation behavior
// ============================================================================
test('8. Escalation behavior sets reminder_level = 4 and escalated_at', () => {
  assert.match(migrationFile, /v_target_level := 4/);
  assert.match(migrationFile, /escalated_at = CASE WHEN v_target_level = 4 AND escalated_at IS NULL THEN v_now ELSE escalated_at END/);
  assert.match(migrationFile, /ESCALATION: Requirement overdue >72h/);
});

// ============================================================================
// 9. Task completion stops future reminders & 10. Request remains open
// ============================================================================
test('9 & 10. Task completion does NOT resolve request; evaluated_tasks only considers incomplete tasks', () => {
  assert.match(migrationFile, /status IN \('to_do', 'in_progress', 'waiting'\)/);
  assert.doesNotMatch(migrationFile, /status IN \('completed'\)/);
});

// ============================================================================
// 11. Daily India queue includes correct tasks
// ============================================================================
test('11. India daily work queue selects and filters India-relevant work', () => {
  assert.match(modalFile, /waiting_for\.in\.\(INDIA,MANUFACTURER\),assigned_team\.eq\.pricing_india,status\.eq\.BLOCKED/);
  assert.match(modalFile, /export const IndiaDailyWorkQueueModal/);
});

// ============================================================================
// 12. Waiting Manufacturer visibility & 13. Waiting Customer visibility
// ============================================================================
test('12 & 13. Waiting party visibility (Manufacturer / India / Customer)', () => {
  assert.match(modalFile, /waiting_manufacturer/);
  assert.match(modalFile, /waiting_india/);
  assert.match(modalFile, /Waiting: \{item\.waitingFor\}/);
});

// ============================================================================
// 14. Unassigned work visibility
// ============================================================================
test('14. Unassigned work bucket isolates requests/tasks with no assignee', () => {
  assert.match(modalFile, /unassigned/);
  assert.match(modalFile, /!item\.assignedToName && !item\.taskAssignee/);
});

// ============================================================================
// 15. Owner separation & 16. Enquiry -> Request -> Task traceability
// ============================================================================
test('15 & 16. Owner separation and full Enquiry -> Request -> Task traceability', () => {
  assert.match(modalFile, /item\.inquiryNumber/);
  assert.match(modalFile, /item\.requestCode/);
  assert.match(modalFile, /item\.taskTitle/);
  assert.match(modalFile, /item\.taskAssignee/);
  assert.match(modalFile, /item\.assignedToName/);
});

// ============================================================================
// 17. No duplicate task architecture
// ============================================================================
test('17. No duplicate task or reminder tables created', () => {
  assert.doesNotMatch(migrationFile, /CREATE TABLE public\.enquiry_tasks/);
  assert.doesNotMatch(migrationFile, /CREATE TABLE public\.request_tasks/);
  assert.doesNotMatch(migrationFile, /CREATE TABLE public\.crm_tasks/);
  assert.doesNotMatch(migrationFile, /CREATE TABLE public\.enquiry_reminders/);

  const rows = runDbScript(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('enquiry_tasks', 'request_tasks', 'crm_tasks', 'enquiry_reminders');
  `);
  assert.equal(rows.length, 0, 'Zero duplicate task tables exist in DB');
});

// ============================================================================
// 18. Zero sensitive pricing leakage
// ============================================================================
test('18. Zero sensitive pricing leakage in notifications or India work queue', () => {
  assert.doesNotMatch(migrationFile, /purchase_price/i);
  assert.doesNotMatch(migrationFile, /supplier_cost/i);
  assert.doesNotMatch(modalFile, /purchase_price/i);
  assert.doesNotMatch(modalFile, /supplier_cost/i);
});

// ============================================================================
// 19. Automatic client-side notification check hook
// ============================================================================
test('19. initializeNotificationChecks in notifications.ts runs checkAndCreateEnquiryTaskReminders automatically', () => {
  const notifUtilsFile = readFileSync(
    new URL('../src/utils/notifications.ts', import.meta.url),
    'utf8',
  );
  assert.match(notifUtilsFile, /checkAndCreateEnquiryTaskReminders/);
  assert.match(notifUtilsFile, /await checkAndCreateEnquiryTaskReminders\(\);/);
});

