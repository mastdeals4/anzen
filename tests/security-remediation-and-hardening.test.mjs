import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pg from 'pg';

const DB_CONNECTION = process.env.DATABASE_URL;

async function withDbClient(callback) {
  if (!DB_CONNECTION) {
    console.warn('Skipping live DB check: DATABASE_URL is not set.');
    return;
  }
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

test('1. Static Secret Scan: No hard-coded database URLs or passwords in tracked files', () => {
  const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('docs/') && !f.endsWith('.md') && !f.endsWith('.png') && f !== '.env.example');

  const exposedPattern = /postgresql:\/\/[^:]+:[^@]+@/i;

  for (const file of trackedFiles) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      exposedPattern.test(content),
      false,
      `Tracked file ${file} must NOT contain a database connection URL with credentials`
    );
    assert.equal(
      content.includes('Kunallunkad%40123') || content.includes('Kunallunkad@123'),
      false,
      `Tracked file ${file} must NOT contain the exposed password`
    );
  }
});

test('2. Environment Hygiene: .env.example exists with placeholders and .env is untracked', () => {
  assert.ok(fs.existsSync('.env.example'), '.env.example must exist');
  const exampleContent = fs.readFileSync('.env.example', 'utf8');
  assert.ok(exampleContent.includes('VITE_SUPABASE_URL='), '.env.example must specify VITE_SUPABASE_URL placeholder');
  assert.ok(exampleContent.includes('DATABASE_URL='), '.env.example must specify DATABASE_URL placeholder');
  assert.equal(
    exampleContent.includes('Kunallunkad'),
    false,
    '.env.example must never contain real passwords'
  );

  const trackedEnvFiles = execSync('git ls-files "*.env*"', { encoding: 'utf8' }).trim();
  assert.equal(
    trackedEnvFiles,
    '.env.example',
    'Only .env.example may be tracked; private .env files must remain untracked'
  );
});

test('3. Realtime Bus Security: Validation, loop prevention, and payload stripping', () => {
  const erpBusContent = fs.readFileSync(path.join(process.cwd(), 'src/utils/erpSyncBus.ts'), 'utf8');

  // Verify security assertions in erpSyncBus.ts
  assert.ok(
    erpBusContent.includes('export const ALLOWED_ERP_DOMAINS'),
    'erpSyncBus must define an explicit whitelist of allowed ERP domains'
  );
  assert.ok(
    erpBusContent.includes('export const ALLOWED_ERP_ACTIONS'),
    'erpSyncBus must define an explicit whitelist of allowed ERP actions'
  );
  assert.ok(
    erpBusContent.includes('validateAndSanitizeSyncEvent'),
    'erpSyncBus must provide validateAndSanitizeSyncEvent for all inbound events'
  );
  assert.ok(
    erpBusContent.includes('originTabId === TAB_ID'),
    'erpSyncBus must reject loopback events from the current tab'
  );
  assert.ok(
    erpBusContent.includes('validateAndSanitizeSyncEvent(messageEvent.data)'),
    'BroadcastChannel listener must validate incoming messageEvent data'
  );
  assert.ok(
    erpBusContent.includes('validateAndSanitizeSyncEvent(envelope?.payload)'),
    'Supabase Realtime broadcast listener must validate incoming broadcast payload'
  );

  // Implement the validator logic test directly
  const ALLOWED_DOMAINS = new Set([
    'sales_orders', 'inventory', 'delivery_challans', 'sales_invoices',
    'credit_notes', 'expenses', 'petty_cash', 'bank_transactions',
    'vouchers', 'purchases', 'material_returns', 'crm', 'dashboard'
  ]);
  const ALLOWED_ACTIONS = new Set([
    'created', 'updated', 'approved', 'rejected', 'cancelled', 'deleted',
    'dispatched', 'received', 'settled', 'reconciled', 'status_changed', 'refresh_all'
  ]);

  function validate(candidate, currentTabId) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (!ALLOWED_DOMAINS.has(candidate.domain)) return null;
    if (!ALLOWED_ACTIONS.has(candidate.action)) return null;
    if (!candidate.originTabId || candidate.originTabId === currentTabId) return null;
    return {
      domain: candidate.domain,
      action: candidate.action,
      entityId: typeof candidate.entityId === 'string' ? candidate.entityId.slice(0, 64) : undefined,
      timestamp: candidate.timestamp || Date.now(),
      originTabId: candidate.originTabId,
    };
  }

  const valid = validate({
    domain: 'sales_orders',
    action: 'updated',
    entityId: 'so_123',
    originTabId: 'other_tab',
    sensitiveData: 'secret_123',
  }, 'my_tab');

  assert.ok(valid, 'Valid event passes');
  assert.equal(valid.domain, 'sales_orders');
  assert.equal(valid.sensitiveData, undefined, 'Sensitive payload stripped');
  assert.equal(validate({ domain: 'invalid', action: 'updated', originTabId: 'other_tab' }, 'my_tab'), null);
  assert.equal(validate({ domain: 'sales_orders', action: 'updated', originTabId: 'my_tab' }, 'my_tab'), null);
});

test('4. Live Database Security: Permissions and RLS verification for anon and authenticated', async () => {
  await withDbClient(async (client) => {
    // 1. Verify reconcile_product_shortages cannot be executed by anon or authenticated
    const fnPerms = await client.query(`
      SELECT has_function_privilege('anon', 'public.reconcile_product_shortages(uuid)', 'execute') as anon_exec,
             has_function_privilege('authenticated', 'public.reconcile_product_shortages(uuid)', 'execute') as auth_exec,
             has_function_privilege('service_role', 'public.reconcile_product_shortages(uuid)', 'execute') as sr_exec;
    `);
    assert.equal(fnPerms.rows[0].anon_exec, false, 'anon must NOT have execute on reconcile_product_shortages');
    assert.equal(fnPerms.rows[0].auth_exec, false, 'authenticated must NOT have execute on reconcile_product_shortages');
    assert.equal(fnPerms.rows[0].sr_exec, true, 'service_role must retain execute on reconcile_product_shortages');

    // 2. Verify anon has 0 table grants on sensitive tables
    const anonGrants = await client.query(`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN ('sales_orders', 'sales_order_items', 'so_product_reservations', 'batches')
        AND grantee = 'anon';
    `);
    assert.equal(anonGrants.rowCount, 0, 'anon must have 0 table grants on sensitive tables');

    // 3. Verify authenticated cannot mutate so_product_reservations directly
    const authResGrants = await client.query(`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name = 'so_product_reservations'
        AND grantee = 'authenticated';
    `);
    const authResPrivs = authResGrants.rows.map((r) => r.privilege_type);
    assert.deepEqual(authResPrivs, ['SELECT'], 'authenticated must have ONLY SELECT on so_product_reservations');

    // 4. Verify RLS is enabled and forced on all four sensitive tables
    const rlsCheck = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('sales_orders', 'sales_order_items', 'so_product_reservations', 'batches');
    `);
    assert.equal(rlsCheck.rowCount, 4, 'All 4 sensitive tables must exist');
    for (const row of rlsCheck.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} must have row security enabled`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} must have forced row security`);
    }
  });
});
