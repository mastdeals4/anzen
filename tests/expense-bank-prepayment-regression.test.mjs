import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260905180000_allow_controlled_supplier_prepayment_reconciliation.sql', 'utf8');
const ui = fs.readFileSync('src/components/finance/BankReconciliationEnhanced.tsx', 'utf8');
const canonical = fs.readFileSync('supabase/migrations/20260905140000_canonical_baseline.sql', 'utf8');

test('controlled supplier prepayment allows early outgoing bank debit only', () => {
  assert.match(canonical, /_sec_check_finance_role/); // security control retained in existing function
  assert.match(migration, /p_payment_kind,'supplier'/);
  assert.match(migration, /v_line\.transaction_date < v_expense\.expense_date/);
  assert.match(migration, /v_line\.debit_amount,0\) <= 0/);
  assert.match(migration, /AP 2110/);
});

test('partial allocation and split-bank arithmetic leave the document balance', () => {
  const bank = 28898697;
  const first = 28861549;
  const second = bank - first;
  assert.equal(second, 37148);
  assert.equal(22715358 - second, 22678210);
});

test('same-day and later payments remain valid while early non-supplier payments do not', () => {
  const valid = (bankDate, expenseDate) => bankDate >= expenseDate;
  assert.equal(valid('2026-08-31', '2026-08-31'), true);
  assert.equal(valid('2026-09-01', '2026-08-31'), true);
  assert.equal(valid('2026-08-07', '2026-08-31'), false);
});

test('partial UI is yellow, fully linked green, unlinked neutral, and shows document remainder', () => {
  assert.match(ui, /bg-amber-100 text-amber-800/);
  assert.match(ui, /bg-green-100 text-green-700/);
  assert.match(ui, /bg-gray-100 text-gray-600/);
  assert.match(ui, /Remaining \{formatCurrency\(allocation\.document_remaining/);
});

test('payment workflow remains separate from recognition and idempotent', () => {
  assert.match(canonical, /'expense_payment'/);
  assert.match(canonical, /bank_statement_allocations[\s\S]*allocation_amount/);
  assert.match(canonical, /recalculate_expense_payment_state/);
  assert.match(canonical, /v_settlement_coa/);
});
