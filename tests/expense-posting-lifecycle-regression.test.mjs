import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260830100000_effective_expense_posting_lifecycle.sql', import.meta.url),
  'utf8',
);
const service = readFileSync(new URL('../src/services/expensePostingLifecycle.ts', import.meta.url), 'utf8');
const expenseUi = readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');
const partyLedger = readFileSync(new URL('../src/components/finance/PartyLedger.tsx', import.meta.url), 'utf8');
const accountLedger = readFileSync(new URL('../src/components/finance/AccountLedger.tsx', import.meta.url), 'utf8');
const exportSource = readFileSync(new URL('../src/components/finance/reconciliationExport.ts', import.meta.url), 'utf8');
const bankReconciliation = readFileSync(new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url), 'utf8');
const pphRegister = readFileSync(new URL('../src/components/finance/tax/PphRegisterPanel.tsx', import.meta.url), 'utf8');
const taxPeriods = readFileSync(new URL('../src/components/finance/tax/TaxPeriodsPanel.tsx', import.meta.url), 'utf8');
const importContainers = readFileSync(new URL('../src/pages/ImportContainers.tsx', import.meta.url), 'utf8');
const reportRpc = readFileSync(
  new URL('../supabase/migrations/20260805184941_create_ca_report_journal_lines_rpc.sql', import.meta.url),
  'utf8',
);

test('database exposes one canonical, read-only expense posting lifecycle', () => {
  assert.match(migration, /CREATE OR REPLACE VIEW public\.effective_expense_posting_state/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.expense_explicit_replacement_journals\(\)/);
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = public/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.resolve_effective_expense_posting_state\(p_expense_id uuid\)/);
  assert.match(migration, /CREATE OR REPLACE VIEW public\.expense_posting_lifecycle_audit/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_outstanding_expense_bills/);
  assert.match(migration, /eps\.effective_posting_state IN \('ACTIVE','REPLACED'\)/);
  assert.match(migration, /active_original_count > 1 THEN 'AMBIGUOUS'/);
  assert.match(migration, /active_replacement_count > 1 THEN 'AMBIGUOUS'/);
  assert.match(migration, /active_original_count = 1 THEN 'ACTIVE'/);
  assert.match(migration, /reversed_original_count > 0 AND active_replacement_count = 1 THEN 'REPLACED'/);
  assert.match(migration, /reversed_original_count > 0 AND active_replacement_count = 0 THEN 'REVERSED'/);
  assert.match(migration, /document_approval_status = 'rejected' THEN 'REJECTED'/);
});

test('only explicit full historical replacements are effective', () => {
  assert.match(migration, /new_metadata ->> 'replacement_journal_id'/);
  assert.match(migration, /historical_salary_advance_repair/);
  assert.match(migration, /historical_repair'[\s\S]*reference_number LIKE 'HR-AP-%'/);
  assert.doesNotMatch(migration, /source_module = 'historical_salary_ap_reclassification'/);
  assert.doesNotMatch(migration, /source_module = 'historical_salary_advance_reversal'/);
  assert.doesNotMatch(migration, /source_module = 'expense_cancellation'/);
});

test('lifecycle migration cannot alter accounting or document data', () => {
  for (const table of [
    'finance_expenses',
    'journal_entries',
    'journal_entry_lines',
    'bank_statement_lines',
    'bank_statement_allocations',
  ]) {
    assert.doesNotMatch(migration, new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:public\\.)?${table}\\b`, 'i'));
  }
});

test('expense UI hydrates state centrally and blocks repeated cancellation/deletion', () => {
  assert.match(service, /effective_expense_posting_state/);
  assert.match(service, /READ_BATCH_SIZE = 75/);
  assert.match(expenseUi, /hydrateExpensePostingLifecycle/);
  assert.match(expenseUi, /effective_posting_state === 'REVERSED' \|\| lifecycle\.effective_posting_state === 'REPLACED'/);
  assert.match(expenseUi, /effective_posting_state !== 'ACTIVE'/);
  assert.match(expenseUi, /postingState === 'ACTIVE'[\s\S]*label="Cancel Posting"/);
  assert.match(expenseUi, /\['PENDING', 'REJECTED'\]\.includes\(expense\.effective_posting_state/);
  assert.match(expenseUi, /already has a current effective posting/);
  assert.match(expenseUi, /Journal \/ reversal history/);
  assert.match(expenseUi, /Effective replacement:/);
});

test('Party and Staff Ledgers include ACTIVE/REPLACED once and exclude REVERSED', () => {
  assert.match(partyLedger, /onlyEffectiveExpenses/);
  assert.match(partyLedger, /isEffectiveExpensePosting/);
  assert.match(partyLedger, /effectiveExpenseBills/);
  assert.match(partyLedger, /effectiveBills/);
  assert.match(partyLedger, /effectiveAdvances/);
  assert.match(partyLedger, /journal_entries\.is_reversed', false/);
});

test('reports and exports use only the effective non-reversed journal', () => {
  assert.match(exportSource, /getEffectiveExpensePostingStates/);
  assert.match(exportSource, /effective_journal_id/);
  assert.match(exportSource, /journalDocumentIds/);
  assert.match(accountLedger, /\.eq\('journal_entries\.is_reversed', false\)/);
  assert.match(reportRpc, /je\.is_reversed = false OR je\.is_reversed IS NULL/);
  assert.match(expenseUi, /effective_posting_state === 'REPLACED'/);
  assert.match(expenseUi, /effective_posting_state === 'REVERSED'/);
  assert.match(pphRegister, /getEffectiveExpensePostingStates/);
  assert.match(taxPeriods, /effectiveExpenseRows/);
  assert.match(importContainers, /isEffectiveExpensePosting/);
});

test('bank reconciliation never offers a reversed expense as a live match target', () => {
  assert.match(bankReconciliation, /getEffectiveExpensePostingStates/);
  assert.match(bankReconciliation, /\.filter\(expense => isEffectiveExpensePosting/);
  assert.match(bankReconciliation, /const postingState = await getEffectiveExpensePostingState\(expenseId\)/);
  assert.match(bankReconciliation, /cannot receive a new bank allocation/);
});

test('known forensic paths are representable without voucher-specific UI rules', () => {
  for (const voucher of ['EXP/26-26/106', 'EXP/26-26/124', 'EXP/26-26/093', 'EXP/26-26/102']) {
    assert.doesNotMatch(expenseUi, new RegExp(voucher.replaceAll('/', '\\/')));
  }
  assert.match(migration, /historical_salary_advance_repair/);
  assert.match(migration, /HR-AP-%/);
});
