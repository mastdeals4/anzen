import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260825090000_phase5b_safe_historical_repair_context.sql', import.meta.url),
  'utf8',
);

// Read-only architectural regression checks: this migration is a command
// definition, not a data repair.
assert.match(migration, /BEGIN;[\s\S]*COMMIT;/);
assert.match(migration, /execute_historical_finance_repair/);
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.execute_historical_finance_repair[\s\S]*TO authenticated,service_role/);
assert.match(migration, /role='admin'/);
assert.match(migration, /FOR UPDATE/);
assert.match(migration, /idempotency_key text NOT NULL UNIQUE/);
assert.match(migration, /Duplicate cash event/);
assert.match(migration, /Unexpected journal change/);
assert.match(migration, /Missing posted source journal\/evidence/);
assert.match(migration, /historical_repair_context_active/);
assert.match(migration, /recalculate_expense_payment_state\(p_expense_id uuid\)[\s\S]*historical_repair_context_active\(\)/);
assert.match(migration, /Existing recognition journals are immutable/);
assert.match(migration, /create_cash_correction/);
assert.match(migration, /generate_journal_entry_number/);
assert.match(migration, /Actual bank payment/);
for (const type of ['expense', 'payment', 'receipt', 'tax_payment', 'fund_transfer', 'petty_cash']) {
  assert.match(migration, new RegExp(`'${type}'`), `document type ${type} must be supported`);
}
assert.match(migration, /p_allocation_amount>v_bank_amount\+0\.01/); // partial/split allocations
assert.doesNotMatch(migration, /DISABLE TRIGGER ALL|ALTER TABLE[\s\S]*DISABLE TRIGGER/);
assert.match(migration, /bank_statement_allocations[\s\S]*FOR UPDATE/);

for (const forbidden of ['EXP/26-26/115', 'EXP/26-26/113', 'EXP/26-26/139', 'EXP/26/177', 'EXP/26/178']) {
  assert.equal(migration.includes(forbidden), false, `migration must not name ${forbidden}`);
}

console.log('phase5b safe historical repair checks passed');
