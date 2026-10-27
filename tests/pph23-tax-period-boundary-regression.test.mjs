import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../supabase/migrations/20260905190000_fix_pph23_tax_period_basis.sql', import.meta.url), 'utf8');
const register = readFileSync(new URL('../src/components/finance/tax/PphRegisterPanel.tsx', import.meta.url), 'utf8');

test('PPh period fallback uses expense date, never due date', () => {
  assert.match(migration, /fe\.pph_tax_period_id IS NULL AND fe\.expense_date BETWEEN/);
  assert.doesNotMatch(migration, /COALESCE\(fe\.due_date\s*,\s*fe\.expense_date\) BETWEEN/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_expense_pph_period_date/);
  assert.match(migration, /SELECT fe\.expense_date/);
});

test('August 2026 PPh23 boundary totals all three August expenses', () => {
  // The live regression fixtures are 66,000 + 106,000 + 140,000.
  assert.equal(66000 + 106000 + 140000, 312000);
  assert.match(migration, /CREATE OR REPLACE VIEW public\.vw_canonical_tax_period_amounts/);
  assert.match(migration, /fn_pph_authoritative_source_total\(tp\.id\)/);
  assert.match(register, /expense\.expense_date/);
  assert.doesNotMatch(register, /due_date \?\? expense\.expense_date/);
});

test('reporting-only migration does not post or alter journals/account 2132', () => {
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+public\.journal/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.journal/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+public\.journal/i);
  assert.doesNotMatch(migration, /2132/);
});
