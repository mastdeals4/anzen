import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260830110000_atomic_approved_expense_edit.sql', import.meta.url),
  'utf8',
);
const expenseUi = readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');
const commands = readFileSync(new URL('../src/services/financeCommands.ts', import.meta.url), 'utf8');
const cancellation = readFileSync(
  new URL('../supabase/migrations/20260827160000_fix_expense_cancellation_uuid_and_audit.sql', import.meta.url),
  'utf8',
);
const journalIdentityFix = readFileSync(
  new URL('../supabase/migrations/20260830120000_fix_approved_expense_edit_journal_identity.sql', import.meta.url),
  'utf8',
);

test('approved expense edit preserves one effective journal header and reference', () => {
  assert.match(migration, /edit_approved_finance_expense_atomic/);
  assert.match(migration, /v_journal_count<>1/);
  assert.match(migration, /upsert_expense_journal_header_in_place/);
  assert.match(migration, /reference_number='EXP-'\|\|p_expense_id::text/);
  assert.match(migration, /DELETE FROM public\.journal_entry_lines WHERE journal_entry_id=v_journal_id/);
  assert.doesNotMatch(migration, /DELETE FROM public\.journal_entries/);
  assert.match(migration, /Expense edit did not preserve exactly one active journal/);
  const postUpdateValidation = migration.slice(migration.indexOf('-- The trigger must retain the header identity'));
  assert.match(postUpdateValidation, /source_module IN\('expense','expenses'\)[\s\S]*\(reference_id=p_expense_id OR reference_number='EXP-'\|\|p_expense_id::text\)/);
  assert.doesNotMatch(postUpdateValidation, /source_module IN\('expense','expenses'\) AND reference_id=p_expense_id/);
  assert.match(journalIdentityFix, /v_old_count_check[\s\S]*v_new_count_check/);
  assert.match(journalIdentityFix, /EXECUTE v_definition/);
});

test('bank-linked description edit preserves and revalidates its allocation', () => {
  assert.match(migration, /SET journal_entry_id=v_journal_id/);
  assert.match(migration, /no-op FK update deliberately re-runs all canonical allocation guards/);
  assert.match(migration, /document_type='expense' AND document_id=p_expense_id/);
  assert.doesNotMatch(expenseUi, /editingApprovedExpense[\s\S]{0,300}unlinkBankTransaction/);
});

test('bank account change atomically replaces the canonical allocation', () => {
  assert.match(migration, /PERFORM public\.unmatch_bank_statement_allocation\(v_allocation\.id\)/);
  assert.match(migration, /PERFORM public\.link_bank_statement_line\([\s\S]*p_bank_statement_line_id,'expense',p_expense_id,'supplier',p_allocation_amount/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /BEGIN;[\s\S]*COMMIT;/);
});

test('accrued expense edit never fabricates a bank allocation', () => {
  assert.match(migration, /Accrued expense cannot create a bank allocation/);
  assert.match(migration, /NEW\.payment_method IS NULL[\s\S]*code='2110'/);
  assert.match(expenseUi, /payment_method === null[\s\S]*Outstanding \(A\/P\)/);
  assert.match(migration, /payment_method='cash'[\s\S]*code='1101'/);
  assert.match(migration, /payment_method='petty_cash'[\s\S]*code='1102'/);
  assert.match(migration, /Cash\/petty-cash expense cannot create a bank allocation/);
  assert.match(expenseUi, /const effectivePaymentMethod = reconciledBankInfo\?\.bank_account_id[\s\S]*: expense\.payment_method;/);
  assert.doesNotMatch(expenseUi, /expense\.payment_method \|\| 'bank_transfer'/);
});

test('UI edits ACTIVE expense without routing through cancellation', () => {
  assert.match(commands, /editApprovedFinanceExpense/);
  assert.match(commands, /edit_approved_finance_expense_atomic/);
  assert.match(expenseUi, /editingApprovedExpense[\s\S]*editApprovedFinanceExpense/);
  assert.match(expenseUi, /postingState === 'ACTIVE' \|\| postingState === 'PENDING'/);
  const handleEdit = expenseUi.slice(expenseUi.indexOf('const handleEdit = async'), expenseUi.indexOf('const handleDelete = async'));
  assert.doesNotMatch(handleEdit, /Cancel Posting first/);
});

test('repeated edit remains idempotent and cancellation remains separate/idempotent', () => {
  assert.match(migration, /active_count|v_active_count/);
  assert.match(migration, /v_active_count>1/);
  assert.match(cancellation, /No active journal entry found for expense/);
  assert.match(cancellation, /source_module, reference_id,[\s\S]*'expense_cancellation'/);
  assert.match(expenseUi, /rpc\('cancel_expense_posting'/);
  assert.doesNotMatch(migration, /expense_cancellation/);
});

test('migration contains no historical repair or production data patch', () => {
  assert.doesNotMatch(migration, /historical_salary|historical_repair_items|DO\s+\$\$/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.bank_statement_lines\s+SET/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.finance_expenses\s+SET[\s\S]*WHERE\s+(?:id\s*=\s*'|voucher_number)/i);
});
