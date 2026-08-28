import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260830130000_restore_simple_expense_bank_workflow.sql', import.meta.url),
  'utf8',
);
const allocationValidationMigration = readFileSync(
  new URL('../supabase/migrations/20260830131000_validate_expense_allocation_after_rebuild.sql', import.meta.url),
  'utf8',
);
const rebuildBeforeAllocationMigration = readFileSync(
  new URL('../supabase/migrations/20260830132000_rebuild_expense_journal_before_bank_allocation.sql', import.meta.url),
  'utf8',
);
const approvedEditMigration = readFileSync(
  new URL('../supabase/migrations/20260830110000_atomic_approved_expense_edit.sql', import.meta.url),
  'utf8',
);
const expenseUi = readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');
const bankUi = readFileSync(new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url), 'utf8');
const commands = readFileSync(new URL('../src/services/financeCommands.ts', import.meta.url), 'utf8');

test('new expense without a bank line remains a pending document with no posting call', () => {
  assert.match(expenseUi, /selectedBankTransactionId[\s\S]*saveAndLinkFinanceExpense/);
  assert.match(expenseUi, /:[\s\n]*await saveFinanceExpense\(null, newExpensePayload\)/);
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public\.auto_post_expense_accounting/);
  assert.match(migration, /v_expense_id := public\.save_finance_expense/);
  assert.ok(
    migration.indexOf('v_expense_id := public.save_finance_expense')
      < migration.indexOf('PERFORM public.approve_finance_expense'),
  );
});

test('bank selection atomically saves, posts through existing trigger, and allocates', () => {
  assert.match(commands, /saveAndLinkFinanceExpense[\s\S]*save_and_link_finance_expense_atomic/);
  assert.match(migration, /PERFORM public\.approve_finance_expense/);
  assert.match(migration, /PERFORM public\.link_bank_statement_line/);
  assert.match(migration, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(migration, /Expense bank link requires exactly one active effective journal/);
  assert.match(migration, /Expense bank link did not preserve exactly one canonical allocation/);
  assert.doesNotMatch(expenseUi, /Expense recorded, but the bank allocation was not created/);
  assert.doesNotMatch(expenseUi, /Expense updated, but the bank allocation was not created/);
  assert.match(rebuildBeforeAllocationMigration, /app\.expense_atomic_bank_link/);
  assert.ok(
    rebuildBeforeAllocationMigration.indexOf('v_update_replacement')
      < rebuildBeforeAllocationMigration.indexOf("'public.edit_approved_finance_expense_atomic"),
  );
  assert.match(rebuildBeforeAllocationMigration, /DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting/);
});

test('EXP/26/056 accrual-to-bank edit rebuilds before allocation', () => {
  assert.match(
    rebuildBeforeAllocationMigration,
    /NEW\.payment_method = 'bank_transfer'[\s\S]*app\.expense_atomic_bank_link[\s\S]*NEW\.payment_method := NULL/,
  );
  assert.match(
    rebuildBeforeAllocationMigration,
    /app\.expense_atomic_bank_link[\s\S]*v_update_marker/,
  );
  const updatePosition = approvedEditMigration.indexOf('UPDATE public.finance_expenses SET');
  const identityPosition = approvedEditMigration.indexOf('-- The trigger must retain the header identity');
  const allocationPosition = approvedEditMigration.indexOf('PERFORM public.link_bank_statement_line');
  assert.ok(updatePosition >= 0 && updatePosition < identityPosition);
  assert.ok(identityPosition < allocationPosition);
  assert.match(approvedEditMigration, /upsert_expense_journal_header_in_place/);
});

test('both Expenses and Bank Reconciliation use the same atomic link command', () => {
  assert.match(expenseUi, /saveAndLinkFinanceExpense/);
  assert.match(bankUi, /saveAndLinkFinanceExpense\(null/);
  const recordExpense = bankUi.slice(
    bankUi.indexOf('const handleRecordExpense'),
    bankUi.indexOf('const handleLinkToExpense'),
  );
  assert.doesNotMatch(recordExpense, /approveFinanceExpense/);
  assert.doesNotMatch(recordExpense, /linkBankStatementLine/);
});

test('linked edit keeps the existing canonical in-place edit path', () => {
  assert.match(expenseUi, /editingApprovedExpense[\s\S]*editApprovedFinanceExpense/);
  assert.doesNotMatch(migration, /DELETE FROM public\.journal_entries/);
  assert.doesNotMatch(migration, /INSERT INTO public\.journal_entry_lines/);
  assert.match(migration, /source_module IN \('expense', 'expenses'\)/);
  assert.match(migration, /reference_number = 'EXP-' \|\| v_expense_id::text/);
  assert.match(migration, /validate_expense_bank_allocation_against_journal/);
  assert.match(migration, /v_journal_bank_amount \+ 0\.01 < v_document_bank_allocated/);
  assert.match(migration, /Select a matching bank transaction or unlink first/);
  assert.match(allocationValidationMigration, /BEFORE INSERT OR UPDATE OF bank_statement_line_id/);
  assert.doesNotMatch(allocationValidationMigration, /CREATE TRIGGER[^;]+ON public\.finance_expenses/s);
});

test('unlink releases only expense allocations and returns it to pending through audited reversal', () => {
  assert.match(commands, /unlinkFinanceExpenseBankLink[\s\S]*unlink_finance_expense_bank_atomic/);
  assert.match(expenseUi, /await unlinkFinanceExpenseBankLink\(expenseId\)/);
  assert.match(migration, /document_type = 'expense'[\s\S]*document_id = p_expense_id/);
  assert.match(migration, /PERFORM public\.unmatch_bank_statement_allocation/);
  assert.match(migration, /PERFORM public\.cancel_expense_posting/);
  assert.match(migration, /approval_status = 'pending_approval'/);
  assert.doesNotMatch(migration, /DELETE FROM public\.finance_expenses/);
  assert.doesNotMatch(migration, /UPDATE public\.bank_statement_lines/);
});

test('payment types remain delegated to the existing canonical posting logic', () => {
  assert.doesNotMatch(migration, /chart_of_accounts|payment_method='|payment_method = '/);
  assert.match(migration, /existing[\s\S]*auto_post_expense_accounting/i);
  assert.match(migration, /Cash\/petty|bank account, currency, amount/i);
});

test('migration is schema-only and contains no historical or unrelated data repair', () => {
  assert.doesNotMatch(migration, /historical_repair|inventory|crm/i);
  assert.doesNotMatch(migration, /DO\s+\$\$/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.(?:finance_expenses|journal_entries|bank_statement)/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+public\.(?:finance_expenses|journal_entries|bank_statement)/i);
});
