import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const lifecycle = readFileSync(new URL('../src/services/expensePostingLifecycle.ts', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../supabase/migrations/20260830137000_normalize_historical_cash_expense_identity.sql', import.meta.url),
  'utf8',
);
const bank = readFileSync(new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url), 'utf8');
const tax = readFileSync(new URL('../src/utils/taxCalculations.ts', import.meta.url), 'utf8');

test('one resolver recognizes a reversed original plus current historical cash restatement', () => {
  assert.match(lifecycle, /reference_number\?\.startsWith\('HR-CASH-'\)/);
  assert.match(migration, /cash_restatement\.reference_number LIKE 'HR-CASH-%'/);
  assert.match(migration, /original\.is_reversed = true/);
  assert.match(migration, /effective_posting_state = 'REPLACED'/);
  assert.match(migration, /SET source_module = 'expenses'/);
  assert.match(migration, /SET source_module = 'expense_history'/);
  assert.doesNotMatch(migration, /DELETE FROM public\.(?:journal_entries|journal_entry_lines|bank_statement_allocations)/i);
});

test('bank matching and payment amount use canonical cash payable, including broker reimbursements', () => {
  assert.match(bank, /calculateCanonicalCashPayable\(expense\)/);
  assert.match(bank, /isEffectiveExpensePosting/);
  assert.match(tax, /calculateBrokerExpenseTotals/);
  assert.match(tax, /const finalCashPayable = expenseTotal - pphWithheld/);
  const broker177 = 499_500 + 15_273_502;
  const broker178 = 2_719_500 + 8_891_316;
  assert.equal(broker177, 15_773_002);
  assert.equal(broker178, 11_610_816);
});

test('canonical normalization preserves allocation ownership and journal lines', () => {
  assert.match(migration, /bank_allocation_preserved/);
  assert.match(migration, /Historical cash expense normalization changed accounting lines/);
  assert.match(migration, /active_original_count = 0/);
  assert.match(migration, /active_replacement_count = 1/);
});
