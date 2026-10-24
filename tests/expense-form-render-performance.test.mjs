import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);

test('Expense filtering is memoized and does not depend on form field state', () => {
  assert.match(source, /const filteredExpenses = useMemo\(\(\) => expenses\.filter\(\(exp\) => \{/);
  assert.match(source, /\[\s*expenses,\s*lifecycleFilter,\s*filterType,\s*expenseCategories,\s*categoryFilter,\s*supplierFilter,\s*reconFilter,\s*approvalFilter,\s*normalizedSearch,\s*\]\);/);
  assert.doesNotMatch(source.match(/const filteredExpenses = useMemo\([\s\S]*?\n  \]\);/)?.[0] || '', /formData|modalOpen/);
});

test('Expense sorting is memoized and uses stable accountant-priority callback', () => {
  assert.match(source, /const accountantPriorityRank = useCallback\(\(exp: FinanceExpense\): number => \{/);
  assert.match(source, /const sortedExpenses = useMemo\(\(\) => \[\.\.\.filteredExpenses\]\.sort\(\(a, b\) => \{/);
  assert.match(source, /\[filteredExpenses, sortConfig, expenseCategories, accountantPriorityRank\]\);/);
});

test('Expense rows are not mapped while the new/edit modal is open', () => {
  const table = source.indexOf('<tbody className="divide-y divide-gray-100">');
  const placeholder = source.indexOf('Expense editor open', table);
  const rows = source.indexOf('sortedExpenses.map((expense) => {', table);
  assert.ok(table >= 0, 'Expense tbody should exist');
  assert.ok(placeholder > table && placeholder < rows, 'Modal-open placeholder should be before expensive row mapping');
  assert.ok(source.slice(table, rows).includes(') : modalOpen ? ('), 'Modal state must short-circuit the row map');
});

test('Expense total calculation is skipped while modal is open', () => {
  assert.match(source, /\{!modalOpen && !loading && sortedExpenses\.length > 0 && \(/);
});
