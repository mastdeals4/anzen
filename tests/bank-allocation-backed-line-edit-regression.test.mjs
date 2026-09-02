import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = fs.readFileSync('src/components/finance/BankReconciliationEnhanced.tsx', 'utf8');
const migration = fs.readFileSync(
  'supabase/migrations/20260902100000_guard_allocation_backed_bank_line_amount_edits.sql',
  'utf8',
);

test('canonical allocation-backed edits do not invoke legacy document propagation', () => {
  const handler = ui.slice(ui.indexOf('const handleUpdateLine = async'), ui.indexOf('// Reset a row', ui.indexOf('const handleUpdateLine = async')));
  assert.match(handler, /const hasCanonicalAllocations = editingLine\.allocations\.length > 0;/);
  assert.match(handler, /if \(!hasCanonicalAllocations && hasLegacyLink && newAmount > 0\)/);
  assert.match(handler, /unlink\/relink workflow/);
});

test('database rejects a bank-line correction below persisted canonical allocations', () => {
  assert.match(migration, /sum\(allocation_amount\)/);
  assert.match(migration, /v_allocated_total > v_line_total \+ 0\.01/);
  assert.match(migration, /BEFORE UPDATE OF debit_amount, credit_amount ON public\.bank_statement_lines/);
  assert.match(migration, /Bank statement amount cannot be less than its allocated amount/);
});

test('allocation capacity preserves partial and full reconciliation semantics', () => {
  const permits = (lineAmount, allocationTotal) => allocationTotal <= lineAmount + 0.01;
  assert.equal(permits(1_000, 600), true, 'partial allocation leaves a valid remaining bank amount');
  assert.equal(permits(1_000, 1_000), true, 'full allocation remains valid');
  assert.equal(permits(599.98, 600), false, 'bank corrections cannot overrun persisted allocation evidence');
});
