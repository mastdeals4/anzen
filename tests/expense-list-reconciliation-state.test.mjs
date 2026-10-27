import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculateExpenseReconciliation } from '../src/utils/taxCalculations.ts';

const source = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');

test('expense list derives reconciliation state from calculateExpenseReconciliation', () => {
  assert.match(source, /calculateExpenseReconciliation\(expense\)/);
  assert.match(source, /const isPartiallyReconciled = recon\.isPartiallyReconciled/);
  assert.match(source, /const isReconciled = recon\.isFullyReconciled/);
});

test('expense list keeps neutral, yellow partial, and green full link states', () => {
  assert.match(source, /bg-yellow-100 text-yellow-700/);
  assert.match(source, /bg-green-100 text-green-700/);
  assert.match(source, /bg-amber-100 text-amber-700/);
});

test('reconciliation calculation covers unlinked, partial, and fully reconciled', () => {
  const unlinked = calculateExpenseReconciliation({ amount: 1000000, bank_statement_lines: [] });
  assert.equal(unlinked.isFullyReconciled, false);
  assert.equal(unlinked.isPartiallyReconciled, false);

  const partial = calculateExpenseReconciliation({ amount: 1000000, bank_statement_lines: [{ allocation_amount: 400000 }] });
  assert.equal(partial.isFullyReconciled, false);
  assert.equal(partial.isPartiallyReconciled, true);

  const full = calculateExpenseReconciliation({ amount: 1000000, paid_amount: 1000000, bank_statement_lines: [{ allocation_amount: 1000000 }] });
  assert.equal(full.isFullyReconciled, true);
  assert.equal(full.isPartiallyReconciled, false);
});
