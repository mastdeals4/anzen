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
// 1. Frontend source audit: no unauthorized cross-user loop invocations
// ============================================================================
test('1. Frontend notifications.ts implements role-based recipient resolution and prevents cross-user spam', () => {
  // Must have resolveNotificationRecipients
  assert.match(notificationsTs, /async function resolveNotificationRecipients\(targetRoles:\s*string\[\]\)/);
  
  // Must restrict regular users to only self
  assert.match(notificationsTs, /if \(targetRoles\.includes\(caller\.role\)\) \{\s*return \[caller\.userId\];\s*\}/);

  // Must guard createNotification client-side against non-admin cross-user notifications
  assert.match(notificationsTs, /if \(params\.userId !== caller\.userId && !\[['"]admin['"],\s*['"]manager['"]\]\.includes\(caller\.role\)\) \{\s*return;\s*\}/);

  // Periodic checkers must use recipientIds instead of querying and notifying all users
  assert.match(notificationsTs, /const recipientIds = await resolveNotificationRecipients\(\['admin', 'warehouse'\]\);/);
  assert.match(notificationsTs, /const recipientIds = await resolveNotificationRecipients\(\['admin', 'warehouse', 'sales'\]\);/);
  assert.match(notificationsTs, /const recipientIds = await resolveNotificationRecipients\(\['admin', 'sales'\]\);/);
  assert.match(notificationsTs, /const recipientIds = await resolveNotificationRecipients\(\['sales', 'warehouse', 'admin', 'manager'\]\);/);

  // Tax notifications check must only execute for authorized roles
  assert.match(notificationsTs, /if \(!caller \|\| !\[['"]admin['"],\s*['"]manager['"],\s*['"]accounts['"]\]\.includes\(caller\.role\)\) return;/);
});

// ============================================================================
// 2. Database function audit: upsert_notification handles cross-user attempts gracefully
// ============================================================================
test('2. Live upsert_notification definition returns false on unauthorized cross-user notification instead of raising exception', () => {
  const rows = runDbScript(`
    SELECT prosrc FROM pg_proc WHERE proname = 'upsert_notification';
  `);
  assert.ok(rows.length > 0, 'upsert_notification function must exist');
  const prosrc = rows[0].prosrc;

  // Must NOT raise exception 'Unauthorized to send notifications to other users'
  assert.doesNotMatch(prosrc, /RAISE EXCEPTION 'Unauthorized to send notifications to other users'/i);

  // Must check caller vs target and gracefully return false for non-admin/manager
  assert.match(prosrc, /v_caller != p_user_id/);
  assert.match(prosrc, /RETURN false;/);
});

// ============================================================================
// 3. Functional DB test: simulate non-admin caller notifying another user
// ============================================================================
test('3. Simulated non-admin cross-user notification returns false without throwing error', () => {
  // Test via anonymous DO block or SQL function call simulating auth context
  const rows = runDbScript(`
    DO $$
    DECLARE
      v_res boolean;
      v_user_a uuid := '00000000-0000-0000-0000-000000000001';
      v_user_b uuid := '00000000-0000-0000-0000-000000000002';
    BEGIN
      -- Simulate request.jwt.claim.sub = user_a
      PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

      -- Calling upsert_notification for user_b from user_a (neither is admin)
      v_res := public.upsert_notification(
        v_user_b,
        'low_stock',
        'Test Alert',
        'Test Message'
      );

      -- Result must be false (denied), and crucially MUST NOT RAISE AN EXCEPTION
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
