import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const expenseManagerSrc = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);
const bankReconSrc = readFileSync(
  new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url),
  'utf8',
);

test('1. Record an expense from a bank statement line links canonically using linkBankStatementLine', () => {
  // ExpenseManager must call linkBankStatementLine directly after expense approval when selectedBankTransactionId is present
  assert.match(
    expenseManagerSrc,
    /await linkBankStatementLine\(selectedBankTransactionId,\s*'expense',\s*newExpense\.id,\s*'supplier',\s*allocAmt\);/,
    'ExpenseManager must call canonical linkBankStatementLine with newExpense.id upon approval',
  );
  // Must sync links and notify reconciliation refresh
  assert.match(
    expenseManagerSrc,
    /await syncExpenseBankLinks\(\[newExpense\.id\]\);[\s\S]*notifyFinanceReconciliationRefresh\(\);/,
    'Must trigger syncExpenseBankLinks and notifyFinanceReconciliationRefresh on completion',
  );
});

test('2. Reload and refresh: bank link persistence relies on canonical bank_statement_allocations', () => {
  // bankTransactionLinking and BankReconciliationEnhanced use canonical bank_statement_allocations
  assert.match(
    expenseManagerSrc,
    /\.from\('bank_statement_allocations'\)[\s\S]*\.eq\('document_type',\s*'expense'\)/,
    'ExpenseManager queries bank_statement_allocations for expense reconciliation state',
  );
  assert.match(
    bankReconSrc,
    /const allocations = allocationMap\.get\(row\.id\) \|\| \[\];/,
    'Bank reconciliation derives statement line status from canonical allocations map',
  );
});

test('3. Retry and idempotency: does not duplicate expense or allocation', () => {
  // Checks existing allocation or existing expense before re-creating
  assert.match(
    expenseManagerSrc,
    /const \{ data: existingAllocations \} = await supabase[\s\S]*\.from\('bank_statement_allocations'\)[\s\S]*\.eq\('bank_statement_line_id',\s*selectedBankTransactionId\)[\s\S]*\.eq\('document_id',\s*existingExpId\);/,
    'Checks bank_statement_allocations for existing allocation on retry',
  );
  assert.match(
    expenseManagerSrc,
    /if \(inFlightExpenseIdRef\.current && lineCheck\.matched_expense_id === inFlightExpenseIdRef\.current\) \{\s*\/\/ Retry of same operation after network timeout/,
    'Handles in-flight retry gracefully without duplicate expense creation',
  );
});

test('4. Downstream linking failure reports an explicit error with actionable message', () => {
  // Explicit try/catch around linkBankStatementLine with user warning
  assert.match(
    expenseManagerSrc,
    /catch \(linkErr: any\) \{\s*console\.error\('Error linking bank statement line to expense:', linkErr\);\s*alert\(`⚠️ Expense was created successfully[\s\S]*automatic bank reconciliation linking could not be completed/,
    'Catches downstream linking failure and presents clear warning to user instead of silent failure',
  );
});

test('5. Reuses already existing expense (e.g. EXP/26/306) when recording from statement line', () => {
  // When an existing expense is already associated with the bank line, links it directly without inserting duplicate
  assert.match(
    expenseManagerSrc,
    /if \(!hasCanonicalAllocation\) \{\s*\/\/ Existing expense exists[\s\S]*await linkBankStatementLine\(selectedBankTransactionId,\s*'expense',\s*existingExpId,\s*'supplier',\s*allocAmt\);/,
    'ExpenseManager links existing unallocated expense rather than creating a duplicate',
  );
  // BankReconciliationEnhanced shows existing expense banner in record modal
  assert.match(
    bankReconSrc,
    /Existing Expense Found For This Transaction[\s\S]*Link to Existing/i,
    'Bank reconciliation modal displays direct one-click button to link existing expense',
  );
});

test('6. Verifies EXP/26/306 (IDR 1,000,000) and EXP/26/305 (IDR 30,000) canonical calculations', async () => {
  const { calculateExpenseReconciliation } = await import('../src/utils/taxCalculations.ts');

  // Case EXP/26/306
  const exp306 = {
    id: 'e625b6d2-c5eb-4950-829a-da30c24dfced',
    voucher_number: 'EXP/26/306',
    amount: 1000000,
    paid_amount: 0,
    approval_status: 'approved',
    bank_statement_lines: [
      {
        id: '0faa5994-836b-481b-85c3-3710dbc7dd75',
        transaction_date: '2026-10-20T17:00:00.000Z',
        description: 'TRSF E-BANKING DB 2110/FTSCY/WS95051 1000000.00 Bizpark Advance for Labour MARTUA ALOYSIUS GI',
        debit_amount: 1000000,
        credit_amount: 0,
      },
    ],
  };
  const recon306 = calculateExpenseReconciliation(exp306);
  assert.equal(recon306.isFullyReconciled, true);
  assert.equal(recon306.reconciledAmount, 1000000);
  assert.equal(recon306.statusLabel, 'Paid / Reconciled');

  // Case EXP/26/305
  const exp305 = {
    id: 'd27412dc-8a41-42cc-9b7f-510eb000c032',
    voucher_number: 'EXP/26/305',
    amount: 30000,
    paid_amount: 0,
    approval_status: 'approved',
    bank_statement_lines: [
      {
        id: '95e289ec-0eaa-4733-84a9-7f2a87c3e19d',
        transaction_date: '2026-10-03T17:00:00.000Z',
        description: 'BIAYA ADM',
        debit_amount: 30000,
        credit_amount: 0,
      },
    ],
  };
  const recon305 = calculateExpenseReconciliation(exp305);
  assert.equal(recon305.isFullyReconciled, true);
  assert.equal(recon305.reconciledAmount, 30000);
});

test('7. Partial payments and split allocation status derivation', async () => {
  const { canonicalBankReconciliationStatus, calculateExpenseReconciliation } = await import('../src/utils/taxCalculations.ts');

  // Bank debit 1,000,000 with 400,000 allocated -> partially reconciled
  assert.equal(
    canonicalBankReconciliationStatus(1000000, 400000),
    'partially_reconciled',
    'Bank line with partial allocation must have status partially_reconciled',
  );

  // Bank debit 1,000,000 with 1,000,000 allocated -> matched
  assert.equal(
    canonicalBankReconciliationStatus(1000000, 1000000),
    'matched',
    'Bank line fully allocated must have status matched',
  );

  // Bank debit 1,000,000 with 0 allocated -> unmatched
  assert.equal(
    canonicalBankReconciliationStatus(1000000, 0),
    'unmatched',
    'Bank line with zero allocation must have status unmatched',
  );

  // Split allocation on expense level:
  // Expense for 1,000,000 with partial 400,000 allocation
  const partialExpense = {
    amount: 1000000,
    paid_amount: 400000,
    bank_statement_lines: [
      { id: 'line-1', raw_line_id: 'bsl-1', allocation_id: 'alloc-1', allocation_amount: 400000 },
    ],
  };
  const partialRecon = calculateExpenseReconciliation(partialExpense);
  assert.equal(partialRecon.isPartiallyReconciled, true);
  assert.equal(partialRecon.isFullyReconciled, false);
  assert.equal(partialRecon.reconciledAmount, 400000);

  // Expense for 1,000,000 split across two bank lines: 400,000 + 600,000
  const splitExpense = {
    amount: 1000000,
    paid_amount: 1000000,
    bank_statement_lines: [
      { id: 'line-1', raw_line_id: 'bsl-1', allocation_id: 'alloc-1', allocation_amount: 400000 },
      { id: 'line-2', raw_line_id: 'bsl-2', allocation_id: 'alloc-2', allocation_amount: 600000 },
    ],
  };
  const splitRecon = calculateExpenseReconciliation(splitExpense);
  assert.equal(splitRecon.isFullyReconciled, true);
  assert.equal(splitRecon.isPartiallyReconciled, false);
  assert.equal(splitRecon.reconciledAmount, 1000000);
});

test('8. Unmatched lines remain unmatched unless explicitly linked', async () => {
  const { canonicalBankReconciliationStatus, calculateExpenseReconciliation } = await import('../src/utils/taxCalculations.ts');

  // Bank lines do not auto-match simply on amount or description similarity
  assert.equal(
    canonicalBankReconciliationStatus(1000000, 0),
    'unmatched',
    'A bank statement line without explicit allocations remains strictly unmatched',
  );

  // An expense with identical amount but no bank allocations remains unreconciled
  const unlinkedExpense = {
    amount: 1000000,
    description: 'TRSF E-BANKING DB 2110/FTSCY/WS95051 1000000.00 Bizpark Advance for Labour',
    bank_statement_lines: [],
  };
  const unlinkedRecon = calculateExpenseReconciliation(unlinkedExpense);
  assert.equal(unlinkedRecon.isFullyReconciled, false);
  assert.equal(unlinkedRecon.reconciledAmount, 0);
});
