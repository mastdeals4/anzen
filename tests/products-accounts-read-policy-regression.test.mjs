import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const selectPolicy = readFileSync(
  new URL('../supabase/migrations/20260902030000_allow_accounts_read_products.sql', import.meta.url),
  'utf8',
);
const writePolicies = readFileSync(
  new URL('../supabase/migrations/20260213023724_fix_products_rls_allow_warehouse_role.sql', import.meta.url),
  'utf8',
);

test('active Accounts users have read-only product-master access', () => {
  assert.match(selectPolicy, /ON public\.products[\s\S]*FOR SELECT[\s\S]*TO authenticated/);
  assert.match(selectPolicy, /up\.is_active = true/);
  assert.match(selectPolicy, /up\.role IN \('admin', 'accounts', 'sales', 'warehouse', 'auditor_ca'\)/);
  assert.doesNotMatch(selectPolicy, /FOR (?:INSERT|UPDATE|DELETE)/);
  assert.match(writePolicies, /FOR INSERT[\s\S]*role IN \('admin', 'sales', 'warehouse'\)/);
  assert.match(writePolicies, /FOR UPDATE[\s\S]*role IN \('admin', 'sales', 'warehouse'\)/);
  assert.doesNotMatch(writePolicies, /role IN \([^)]*'accounts'/);
});
