import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');

test('expense list derives reconciliation state from allocated amounts', () => {
  assert.match(source, /const reconciledAmount = \(expense\.bank_statement_lines \|\| \[\]\)\.reduce/);
  assert.match(source, /const isPartiallyReconciled = reconciledAmount > 0\.01/);
  assert.match(source, /const isReconciled = reconciledAmount >= reconciliationTotal - 0\.01/);
});

test('expense list keeps neutral, yellow partial, and green full link states', () => {
  assert.match(source, /bg-yellow-100 text-yellow-700/);
  assert.match(source, /Partially linked/);
  assert.match(source, /bg-green-100 text-green-700/);
  assert.match(source, /title="Unlinked"/);
});

test('amount classification covers unlinked, partial, and fully linked', () => {
  const state = (total, paid) => paid <= 0.01 ? 'unlinked' : paid >= total - 0.01 ? 'fully linked' : 'partially linked';
  assert.equal(state(22715358, 0), 'unlinked');
  assert.equal(state(22715358, 37148), 'partially linked');
  assert.equal(state(22715358, 22715358), 'fully linked');
});
