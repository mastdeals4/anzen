import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);

test('Expense submission locks synchronously before first await', () => {
  assert.match(source, /const handleSubmit = async \(e: React\.FormEvent\) => \{\s*e\.preventDefault\(\);\s*if \(isSubmittingRef\.current\) return;\s*isSubmittingRef\.current = true;\s*setIsSubmitting\(true\);/);
});

test('Save button is disabled immediately and displays saving indicator during submission', () => {
  assert.match(source, /<button\s+type="submit"\s+form="expense-form"\s+disabled=\{isSubmitting\}/);
  assert.match(source, /\{isSubmitting \? \(\s*<span className="flex items-center gap-1\.5">\s*<Loader2 className="w-4 h-4 animate-spin" \/>\s*\{editingExpense \? 'Updating\.\.\.' : 'Saving\.\.\.'\}\s*<\/span>\s*\) : \(\s*`\$\{editingExpense \? 'Update' : 'Save'\} Expense`\s*\)\}/);
});

test('Form blocks Enter-key duplicate submission while submission is in-flight', () => {
  assert.match(source, /onKeyDown=\{\(e\) => \{\s*if \(e\.key === 'Enter' && \(e\.target as HTMLElement\)\.tagName !== 'TEXTAREA'\) \{\s*if \(isSubmittingRef\.current\) \{\s*e\.preventDefault\(\);\s*\}\s*\}\s*\}\}/);
});

test('Form lock is restored upon validation failure and in finally block', () => {
  // Checks that early validation returns reset isSubmittingRef and isSubmitting
  assert.match(source, /isSubmittingRef\.current = false;\s*setIsSubmitting\(false\);\s*return;/);
  // Checks finally block resets submission lock
  assert.match(source, /\} finally \{\s*isSubmittingRef\.current = false;\s*setIsSubmitting\(false\);\s*\}/);
});

test('Retry after network timeout preserves in-flight expense ID to prevent duplicates', () => {
  assert.match(source, /const expenseToSaveId = inFlightExpenseIdRef\.current \|\| null;\s*const newExpenseId = await saveFinanceExpense\(expenseToSaveId, newExpensePayload\);\s*inFlightExpenseIdRef\.current = newExpenseId;/);
  assert.match(source, /inFlightExpenseIdRef\.current = null;/);
});

test('Editing existing expense updates the existing record ID', () => {
  assert.match(source, /await saveFinanceExpense\(editingExpense\.id, expenseData\);/);
});
