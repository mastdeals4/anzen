import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260904100000_guard_import_broker_pph_sync.sql', 'utf8');
const canonical = fs.readFileSync('supabase/migrations/20260830138000_fix_import_broker_approval_trigger_order.sql', 'utf8');

test('generic PPh synchronizer skips import-broker expenses', () => {
  assert.match(migration, /IF NEW\.expense_category = 'import_broker' THEN\s+RETURN NEW;/);
  assert.doesNotMatch(migration, /UPDATE public\.finance_expenses|DELETE FROM public\.(journal_entries|journal_entry_lines)/);
});

test('customs broker retains exactly one canonical posting trigger', () => {
  assert.match(canonical, /post_customs_broker_canonical/);
  assert.match(migration, /PPh Ditahan%/);
  assert.match(migration, /expense_category = 'import_broker'/);
});

test('non-broker PPh synchronization logic remains present', () => {
  assert.match(migration, /fn_pph_payable_account_id\(NEW\.pph_code_id\)/);
  assert.match(migration, /INSERT INTO journal_entry_lines/);
});
