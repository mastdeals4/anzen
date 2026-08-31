import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260831220000_fix_expense_payables_realtime_linkage.sql', import.meta.url),
  'utf8',
);
const payables = fs.readFileSync(
  new URL('../src/components/finance/PayablesManager.tsx', import.meta.url),
  'utf8',
);

assert.match(migration, /fe\.approval_status = 'approved'/);
assert.match(migration, /effective_posting_state IN \('ACTIVE', 'REPLACED'\)/);
assert.match(migration, /coa\.code = '2110'/);
assert.match(migration, /fe\.supplier_id IS NOT NULL OR fe\.staff_id IS NOT NULL/);
assert.doesNotMatch(migration, /JOIN public\.supplier_payables_view/);
assert.doesNotMatch(migration, /COALESCE\(fe\.paid_amount/);

assert.match(migration, /FROM public\.voucher_allocations va/);
assert.match(migration, /FROM public\.bank_statement_allocations a/);
assert.match(migration, /NOT EXISTS \([\s\S]*bank_statement_allocations/);
assert.match(migration, /LEAST\([\s\S]*allocated_paid_amount[\s\S]*payable_amount/);
assert.match(migration, /payable_amount > p\.current_paid_amount \+ 0\.01/);

for (const table of [
  'finance_expenses',
  'voucher_allocations',
  'bank_statement_allocations',
  'bank_statement_lines',
  'purchase_invoices',
]) {
  assert.match(payables, new RegExp(`table: '${table}'`));
}
assert.match(payables, /bill\.supplier_name \|\| bill\.staff_name/);

console.log('expense payables real-time linkage regression checks passed');
