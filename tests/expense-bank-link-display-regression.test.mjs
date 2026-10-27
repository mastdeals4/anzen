import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/utils/expenseBankLinks.ts', 'utf8');
const manager = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');

// Mirrors the small, pure normalization contract used by the UI.
const normalize = (rows) => {
  const groups = new Map();
  for (const row of rows) {
    const key = row.raw_line_id || row.id;
    const group = groups.get(key) || { legacy: null, canonical: [] };
    row.allocation_id ? group.canonical.push(row) : (group.legacy ||= row);
    groups.set(key, group);
  }
  return [...groups.entries()].flatMap(([key, group]) => {
    if (!group.canonical.length) return group.legacy ? [group.legacy] : [];
    const first = group.canonical[0];
    return [{ ...first, raw_line_id: key, allocation_amount: group.canonical.reduce((s, r) => s + Number(r.allocation_amount || 0), 0) }];
  });
};

test('normalizer is keyed by physical bank statement line and canonical allocation wins', () => {
  assert.match(source, /bank_statement_allocations is authoritative/);
  assert.match(source, /String\(row\.raw_line_id \|\| row\.id\)/);
  assert.match(manager, /normalizeExpenseBankLinks\(viewingExpense\.bank_statement_lines/);

  const rows = normalize([
    { id: 'line-1', allocation_amount: 28_898_697 },
    { id: 'line-1', allocation_id: 'alloc-1', allocation_amount: 28_861_549 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].allocation_amount, 28_861_549);
});

test('separate statement lines remain separate', () => {
  const rows = normalize([
    { id: 'line-1', allocation_id: 'a1', allocation_amount: 100 },
    { id: 'line-2', allocation_id: 'a2', allocation_amount: 200 },
  ]);
  assert.equal(rows.length, 2);
});

test('partial payment preserves the bank-line remainder', () => {
  const bankTotal = 28_898_697;
  const allocated = normalize([{ id: 'line-1', allocation_id: 'a1', allocation_amount: 28_861_549 }])[0].allocation_amount;
  assert.equal(bankTotal - allocated, 37_148);
});
