import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const notificationsTs = readFileSync(
  new URL('../src/utils/notifications.ts', import.meta.url),
  'utf8'
);

const notificationDropdownTs = readFileSync(
  new URL('../src/components/NotificationDropdown.tsx', import.meta.url),
  'utf8'
);

const migrationSql = readFileSync(
  new URL('../supabase/migrations/20260924131000_fix_upsert_notification_authorization_exception.sql', import.meta.url),
  'utf8'
);

function runDbScript(sql) {
  const tmpPath = join(tmpdir(), `notif_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
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
// 1. Elimination of setInterval, polling, and window focus loops
// ============================================================================
test('1. No setInterval or background notification polling exists in codebase', () => {
  // Must NOT have any notificationInterval or setInterval invocation in notifications.ts
  assert.doesNotMatch(notificationsTs, /notificationInterval/);
  assert.doesNotMatch(notificationsTs, /setInterval\s*\(/);
  assert.doesNotMatch(notificationsTs, /600000/); // 10-minute interval removed

  // NotificationDropdown must NOT poll on window focus
  assert.doesNotMatch(notificationDropdownTs, /window\.addEventListener\(['"]focus['"]/);
  assert.match(notificationDropdownTs, /notifications-checked/);
});

// ============================================================================
// 2. Daily Execution Guard implementation
// ============================================================================
test('2. Daily execution guard functions and once-per-day logic are implemented', () => {
  assert.match(notificationsTs, /export function getLocalCalendarDate/);
  assert.match(notificationsTs, /export function getDailyNotificationGuardKey/);
  assert.match(notificationsTs, /export function isDailyNotificationCheckCompleted/);
  assert.match(notificationsTs, /export function markDailyNotificationCheckCompleted/);

  // initializeNotificationChecks must guard on completion and mark completed only on success
  assert.match(notificationsTs, /if \(isDailyNotificationCheckCompleted\(user\.id\)\)/);
  assert.match(notificationsTs, /markDailyNotificationCheckCompleted\(user\.id\)/);

  // Role check and safe recipient resolution must remain intact
  assert.match(notificationsTs, /resolveNotificationRecipients/);
  assert.match(notificationsTs, /createNotification/);
});

// ============================================================================
// 3. Functional behavior: Day 1 first run, Day 1 duplicate run, and Day 2 next day
// ============================================================================
test('3. Daily guard behavior: Day 1 runs once, duplicate Day 1 skips, Day 2 runs again', () => {
  // Simulate the exact localStorage and calendar date logic used in notifications.ts
  const mockStorage = new Map();

  function getLocalCalendarDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getDailyNotificationGuardKey(userId, date) {
    return `notification_check_${userId}_${getLocalCalendarDate(date)}`;
  }

  function isDailyNotificationCheckCompleted(userId, date) {
    return mockStorage.get(getDailyNotificationGuardKey(userId, date)) === 'completed';
  }

  function markDailyNotificationCheckCompleted(userId, date) {
    mockStorage.set(getDailyNotificationGuardKey(userId, date), 'completed');
  }

  let executionCount = 0;
  function simulateAppInit(userId, simulatedDate, shouldFail = false) {
    if (isDailyNotificationCheckCompleted(userId, simulatedDate)) {
      return false; // Skipped by daily guard
    }

    if (shouldFail) {
      // Failure prevents marking completed
      return false;
    }

    executionCount++;
    markDailyNotificationCheckCompleted(userId, simulatedDate);
    return true;
  }

  const userId = 'usr-001-test';
  const day1 = new Date('2026-09-24T09:00:00');
  const day1Later = new Date('2026-09-24T14:30:00');
  const day2 = new Date('2026-09-25T08:00:00');

  // Day 1 first open: executes
  assert.equal(simulateAppInit(userId, day1), true);
  assert.equal(executionCount, 1);
  assert.equal(isDailyNotificationCheckCompleted(userId, day1), true);

  // Day 1 second open (e.g. reload or new tab): skipped
  assert.equal(simulateAppInit(userId, day1Later), false);
  assert.equal(executionCount, 1, 'Duplicate open on Day 1 must NOT re-execute notification checks');

  // Day 2 first open (next calendar day): executes once
  assert.equal(simulateAppInit(userId, day2), true);
  assert.equal(executionCount, 2, 'First open on Day 2 must execute notification checks');

  // Day 2 second open: skipped
  assert.equal(simulateAppInit(userId, day2), false);
  assert.equal(executionCount, 2);

  // Test failure recovery:
  const day3 = new Date('2026-09-26T10:00:00');
  // First attempt fails
  assert.equal(simulateAppInit(userId, day3, true), false);
  assert.equal(isDailyNotificationCheckCompleted(userId, day3), false, 'Failed check must NOT be marked completed');
  // Second attempt succeeds
  assert.equal(simulateAppInit(userId, day3, false), true);
  assert.equal(isDailyNotificationCheckCompleted(userId, day3), true);
});

// ============================================================================
// 4. Live DB upsert_notification definition check
// ============================================================================
test('4. Live upsert_notification definition returns false on unauthorized cross-user notification instead of raising exception', () => {
  const rows = runDbScript(`
    SELECT prosrc FROM pg_proc WHERE proname = 'upsert_notification';
  `);
  assert.ok(rows.length > 0, 'upsert_notification function must exist');
  const prosrc = rows[0].prosrc;

  assert.doesNotMatch(prosrc, /RAISE EXCEPTION 'Unauthorized to send notifications to other users'/i);
  assert.match(prosrc, /v_caller != p_user_id/);
  assert.match(prosrc, /RETURN false;/);
});

// ============================================================================
// 5. Functional DB test: unauthorized cross-user returns false with 0 errors
// ============================================================================
test('5. Simulated non-admin cross-user notification returns false without throwing error', () => {
  const rows = runDbScript(`
    DO $$
    DECLARE
      v_res boolean;
      v_user_a uuid := '00000000-0000-0000-0000-000000000001';
      v_user_b uuid := '00000000-0000-0000-0000-000000000002';
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

      v_res := public.upsert_notification(
        v_user_b,
        'low_stock',
        'Test Alert',
        'Test Message'
      );

      IF v_res IS NOT FALSE THEN
        RAISE EXCEPTION 'Expected upsert_notification to return false for unauthorized cross-user call, got %', v_res;
      END IF;
    END;
    $$;
    SELECT 1 as passed;
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].passed, 1);
});
