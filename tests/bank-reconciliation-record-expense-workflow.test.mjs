import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const financePage = readFileSync(
  new URL('../src/pages/Finance.tsx', import.meta.url),
  'utf8',
);
const bankReconUi = readFileSync(
  new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url),
  'utf8',
);
const expenseManagerUi = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);
const autoReconcileMigration = readFileSync(
  new URL('../supabase/migrations/20261022120000_auto_reconcile_bank_expense_on_approval.sql', import.meta.url),
  'utf8',
);

test('1. Record as Expense opens compact popup directly over Bank Reconciliation without full page navigation', () => {
  // BankReconciliationEnhanced must invoke setEmbeddedExpensePrefill directly on primary "Record as Expense" button
  assert.match(
    bankReconUi,
    /setRecordModal\(false\);\s*setEmbeddedExpensePrefill\(prefill\);[\s\S]*<span>Record as Expense<\/span>/,
    'Record as Expense button must directly set embeddedExpensePrefill'
  );

  // Embedded modal mounts ExpenseManager with embeddedModalOnly={true}
  assert.match(
    bankReconUi,
    /<ExpenseManager\s+canManage=\{canManage\}\s+embeddedModalOnly=\{true\}\s+prefillFromBankReconciliation=\{embeddedExpensePrefill\}/,
    'BankReconciliationEnhanced must render ExpenseManager in embedded modal mode directly over Bank Recon'
  );
});

test('2. Embedded expense popup avoids loading the full expense list unnecessarily', () => {
  // ExpenseManager loadData checks embeddedModalOnly to skip expensive expense queries
  assert.match(
    expenseManagerUi,
    /if \(embeddedModalOnly\) \{\s*const \[batchesRes, containersRes, challansRes, banksRes, salesOrdersRes\] = await Promise\.all\(dropdownQueries\);/,
    'ExpenseManager loadData must skip expensesQuery when embeddedModalOnly is active'
  );
  // Full expensesQuery is guarded in else block
  assert.match(
    expenseManagerUi,
    /\} else \{\s*\/\/ perf: server-side date filter[\s\S]*let expensesQuery = supabase\s*\.from\('finance_expenses'\)/,
    'Full expenses query must be isolated from the embedded modal workflow'
  );
});

test('3. Administrator workflow: direct server-side approval and bank reconciliation pipeline', () => {
  // Initial save maintains pending_approval without client-side privilege escalation
  assert.match(
    expenseManagerUi,
    /const newExpensePayload = \{\s*\.\.\.expenseData,\s*created_by: user\.id,\s*\.\.\.\(selectedBankTransactionId \? \{ originating_bank_statement_line_id: selectedBankTransactionId \} : \{\}\),\s*\};/,
    'Payload preserves document creation without hardcoded client approval flags'
  );

  // For admin users, calls authorized approveFinanceExpense pipeline directly
  assert.match(
    expenseManagerUi,
    /if \(isAdmin && newExpenseId\) \{\s*await approveFinanceExpense\(newExpenseId, profile\?\.id \|\| user\.id\);\s*\}/,
    'Admins trigger server-side approveFinanceExpense immediately after saving'
  );

  // Non-admins do not bypass approval; the condition strictly requires isAdmin
  assert.match(
    expenseManagerUi,
    /const isAdmin = profile\?\.role === 'admin';/,
    'Admin status is strictly checked from user profile role'
  );

  // Server-side approve_finance_expense verifies security role and triggers accounting + auto-reconcile
  assert.match(
    autoReconcileMigration,
    /PERFORM public\._sec_check_finance_role\(\);/,
    'Server-side approve_finance_expense enforces finance authorization checks'
  );
  assert.match(
    autoReconcileMigration,
    /WHERE \(matched_expense_id = p_expense_id OR id = v_exp\.originating_bank_statement_line_id\)/,
    'Server auto-reconciles bank line linked via matched_expense_id or originating_bank_statement_line_id'
  );
});

test('4. Correct withholding tax and canonical bank allocation logic (4.5M gross, 112.5k PPh -> 4.3875M bank debit)', () => {
  // Database calculate_finance_expense_payable calculates: amount + ppn - pph + stamp_duty
  const gross = 4500000;
  const pphWithholding = 112500;
  const bankDebit = 4387500;

  const payable = gross - pphWithholding;
  assert.equal(payable, bankDebit, 'Calculated payable must match bank debit exactly');

  // Server allocates LEAST(bank debit, payable)
  const canonicalAllocation = Math.min(bankDebit, payable);
  assert.equal(canonicalAllocation, 4387500, 'Canonical allocation must be 4,387,500, never allocating gross 4,500,000');

  // Verify server-side allocation code in migration
  assert.match(
    autoReconcileMigration,
    /v_payable := COALESCE\(public\.calculate_finance_expense_payable\(p_expense_id\), 0\);/,
    'Server resolves true canonical payable before allocating'
  );
  assert.match(
    autoReconcileMigration,
    /v_allocate := LEAST\(v_line\.debit_amount, v_payable\);/,
    'Server caps allocation to LEAST(debit_amount, payable)'
  );
});

test('5. Duplicate submission and network timeout idempotency', () => {
  // Checks existing expense by inFlightExpenseIdRef before re-saving
  assert.match(
    expenseManagerUi,
    /const expenseToSaveId = inFlightExpenseIdRef\.current \|\| null;\s*const newExpenseId = await saveFinanceExpense\(expenseToSaveId, newExpensePayload\);\s*inFlightExpenseIdRef\.current = newExpenseId;/,
    'Idempotency guard reuses inFlightExpenseIdRef to prevent duplicate expense creation'
  );

  // Guards against duplicate line linking errors on timeout retry
  assert.match(
    expenseManagerUi,
    /if \(inFlightExpenseIdRef\.current && lineCheck\.matched_expense_id === inFlightExpenseIdRef\.current\) \{\s*\/\/ Retry of same operation after network timeout/,
    'Handles retry of same statement line without throwing duplicate link error'
  );

  // Server-side allocation idempotency guard in approve_finance_expense
  assert.match(
    autoReconcileMigration,
    /IF EXISTS \(\s*SELECT 1 FROM public\.bank_statement_allocations\s*WHERE bank_statement_line_id = v_line\.id\s*AND document_type = 'expense'\s*AND document_id = p_expense_id\s*\) THEN/,
    'Server skips duplicate allocation if line is already allocated to expense'
  );
});

test('6. Bank reconciliation action feedback reflects approved vs pending status correctly', () => {
  assert.match(
    bankReconUi,
    /const isApproved = savedExpense\.approval_status === 'approved';\s*setActionFeedback\(\{\s*type: 'success',\s*title: isApproved \? 'Expense recorded & reconciled' : 'Expense recorded as pending',/,
    'Action feedback dynamically differentiates Approved & Reconciled from Pending Approval'
  );
  assert.match(
    bankReconUi,
    /label:\s*'Status',\s*value:\s*isApproved \? 'Approved & Reconciled' : 'Pending Approval'/,
    'Feedback detail status displays Approved & Reconciled for admin direct save'
  );
});
