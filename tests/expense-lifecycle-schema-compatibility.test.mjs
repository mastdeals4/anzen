import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const service = readFileSync(new URL('../src/services/expensePostingLifecycle.ts', import.meta.url), 'utf8');
const expenseUi = readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');

test('current production schema does not probe the undeployed lifecycle view', () => {
  assert.match(service, /VITE_EFFECTIVE_EXPENSE_LIFECYCLE_VIEW_ENABLED === 'true'/);
  assert.match(service, /LIFECYCLE_VIEW_ENABLED \? 'unknown' : 'missing'/);
  assert.match(service, /if \(lifecycleViewAvailability === 'missing'\) \{[\s\S]*getFallbackExpensePostingStates/);
});

test('PGRST205 is cached and falls back instead of failing the Expenses page', () => {
  assert.match(service, /error\?\.code === 'PGRST205'/);
  assert.match(service, /lifecycleViewAvailability = 'missing';[\s\S]*return getFallbackExpensePostingStates\(ids\)/);
  assert.doesNotMatch(service, /if \(error\) throw error;[\s\S]{0,100}effective_expense_posting_state/);
  assert.match(expenseUi, /const loadedExpenses = await hydrateExpensePostingLifecycle/);
});

test('fallback is bounded and derives state from existing document and journal evidence', () => {
  assert.match(service, /READ_BATCH_SIZE = 75/);
  assert.match(service, /from\('finance_expenses'\)[\s\S]*select\('id,voucher_number,approval_status'\)/);
  assert.match(service, /from\('journal_entries'\)[\s\S]*\.in\('reference_id', batch\)/);
  assert.match(service, /\.in\('reference_number', references\)/);
  assert.match(service, /activeOriginal[\s\S]*effectivePostingState = 'ACTIVE'/);
  assert.match(service, /reversedOriginal && replacement[\s\S]*effectivePostingState = 'REPLACED'/);
  assert.match(service, /reversedOriginal[\s\S]*effectivePostingState = 'REVERSED'/);
  assert.match(service, /approval_status === 'rejected'[\s\S]*effectivePostingState = 'REJECTED'/);
  assert.match(service, /approval_status === 'pending_approval'[\s\S]*effectivePostingState = 'PENDING'/);
});

test('compatibility hotfix is read-only and preserves list, detail, edit and filters', () => {
  assert.doesNotMatch(service, /\.(?:insert|update|delete)\(/);
  assert.match(expenseUi, /setExpenses\(loadedExpenses\)/);
  assert.match(expenseUi, /setViewingExpense\(hydrated\)/);
  assert.match(expenseUi, /const handleEdit = async/);
  assert.match(expenseUi, /approvalFilter/);
  assert.match(expenseUi, /reconFilter/);
});
