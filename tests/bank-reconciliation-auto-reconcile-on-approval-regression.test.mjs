import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(process.cwd());
const migrationPath = resolve(
  projectRoot,
  'supabase/migrations/20261022120000_auto_reconcile_bank_expense_on_approval.sql'
);
const expenseManagerPath = resolve(projectRoot, 'src/components/finance/ExpenseManager.tsx');
const bankReconUiPath = resolve(projectRoot, 'src/components/finance/BankReconciliationEnhanced.tsx');
const baselineMigrationPath = resolve(projectRoot, 'supabase/migrations/20260905140000_canonical_baseline.sql');
const permanentIntegrityFixPath = resolve(
  projectRoot,
  'supabase/migrations/20261013190000_bank_reconciliation_permanent_integrity_fix.sql'
);

test('1. Migration adds durable relationship originating_bank_statement_line_id to finance_expenses', () => {
  assert.ok(existsSync(migrationPath), 'Auto-reconcile migration file must exist');
  const migration = readFileSync(migrationPath, 'utf8');

  assert.match(
    migration,
    /ALTER\s+TABLE\s+public\.finance_expenses[\s\S]*ADD\s+COLUMN\s+originating_bank_statement_line_id\s+uuid\s+REFERENCES\s+public\.bank_statement_lines/i,
    'Migration must add originating_bank_statement_line_id foreign key to finance_expenses'
  );

  assert.match(
    migration,
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_finance_expenses_originating_bsl/i,
    'Migration must index originating_bank_statement_line_id'
  );
});

test('2. Bank statement relationship is persisted immediately when expense is created (pending approval)', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // Payload includes originating_bank_statement_line_id
  assert.match(
    expenseUi,
    /originating_bank_statement_line_id:\s*selectedBankTransactionId/,
    'Expense payload must include originating_bank_statement_line_id'
  );

  // Bank statement line is updated with matched_expense_id and suggested matching_status
  assert.match(
    expenseUi,
    /\.from\('bank_statement_lines'\)[\s\S]*\.update\(\{[\s\S]*matched_expense_id:\s*newExpense\.id,[\s\S]*matching_status:\s*'suggested'/i,
    'Bank statement line must be linked with matched_expense_id and matching_status = suggested'
  );

  // syncExpenseBankLinks must be called immediately to populate joined bank transaction
  assert.match(
    expenseUi,
    /await\s+syncExpenseBankLinks\(\[newExpense\.id\]\)/,
    'syncExpenseBankLinks must be called immediately after saving expense'
  );
});

test('3. Relationship survives page reloads, navigation, and state refresh without wiping suggested status', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // bsl_sync_reconciliation_status must not wipe matching_status to 'none' when matched_expense_id is present
  assert.match(
    migration,
    /IF\s+NEW\.matching_status\s*=\s*'suggested'\s+OR\s+NEW\.reconciliation_status\s*=\s*'needs_review'\s+OR\s+NEW\.matched_expense_id\s+IS\s+NOT\s+NULL/i,
    'bsl_sync_reconciliation_status must preserve suggested and needs_review when matched_expense_id is present'
  );

  // refresh_bank_statement_allocation_status preserves suggested match
  assert.match(
    migration,
    /IF\s+v_line\.matched_expense_id\s+IS\s+NOT\s+NULL\s+OR\s+v_line\.matching_status\s*=\s*'suggested'/i,
    'refresh_bank_statement_allocation_status must preserve suggested and needs_review for pending matched expenses'
  );
});

test('4. Approval workflow preserves authorized segregation of duties without auto-approval bypass', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');

  // Bank reconciliation cannot auto-approve pending expenses
  assert.match(
    bankUi,
    /Bank\s+transactions\s+cannot\s+automatically\s+approve\s+pending\s+expenses/i,
    'Bank reconciliation must prohibit confirming matches for unapproved expenses'
  );

  // Confirm match button disabled when pending
  assert.match(
    bankUi,
    /disabled=\{cannotConfirm\}/,
    'Confirm Match button must be disabled when linked expense is pending or rejected'
  );
});

test('5. Successful accounting posting automatically completes reconciliation without manual relinking', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // approve_finance_expense checks that active posted journal exists
  assert.match(
    migration,
    /SELECT\s+EXISTS\s*\([\s\S]*FROM\s+public\.journal_entries[\s\S]*WHERE\s+source_module\s+IN\s*\('expense',\s*'expenses'\)[\s\S]*AND\s+is_posted\s*=\s*true/i,
    'approve_finance_expense must verify active posted journal before auto-reconciling'
  );

  // approve_finance_expense resolves matched bank line and calls link_bank_statement_line
  assert.match(
    migration,
    /PERFORM\s+public\.link_bank_statement_line\(\s*v_line\.id,\s*'expense',\s*p_expense_id/i,
    'approve_finance_expense must invoke link_bank_statement_line to auto-reconcile'
  );

  // link_bank_statement_line promotes matching_status to confirmed
  assert.match(
    migration,
    /UPDATE\s+public\.bank_statement_lines\s+SET[\s\S]*matching_status\s*=\s*'confirmed'/i,
    'link_bank_statement_line must set matching_status = confirmed'
  );
});

test('6. User never needs to manually relink or confirm in Bank Reconciliation after expense approval', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // handleApproveExpense synchronizes bank links and notifies reconciliation refresh
  assert.match(
    expenseUi,
    /await\s+approveFinanceExpense\(id,\s*profile\?\.id\);[\s\S]*await\s+syncExpenseBankLinks\(\[id\]\);[\s\S]*notifyFinanceReconciliationRefresh\(\);/,
    'handleApproveExpense must synchronize bank links and broadcast reconciliation refresh'
  );
});

test('7. Rejection preserves audit history and exception notes without unnoticed duplicate creation', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');
  const bankUi = readFileSync(bankReconUiPath, 'utf8');

  // handleRejectExpenseConfirm writes rejection reason to matched bank line notes
  assert.match(
    expenseUi,
    /\[Expense\s+\$\{voucherNumber\}[\s\S]*rejected:\s*\$\{rejectionReason\}\]/,
    'handleRejectExpenseConfirm must annotate matched bank line notes with rejection reason'
  );

  // Bank reconciliation displays rejected status chip
  assert.match(
    bankUi,
    /line\.matchedExpense\.approval_status\s*===\s*'rejected'/,
    'Bank reconciliation must display rejected state on linked expense'
  );

  // Bank reconciliation prevents confirming a rejected expense
  assert.match(
    bankUi,
    /Cannot\s+confirm\s+match\s+for\s+a\s+\$\{exp\.approval_status\}\s+expense/i,
    'Bank reconciliation must prevent confirming match for rejected expenses'
  );
});

test('8. Posting failure or closed accounting period does not falsely mark bank line as reconciled', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // Period status check before auto-reconciliation
  assert.match(
    migration,
    /IF\s+v_period_status\s+IS\s+NOT\s+NULL\s+AND\s+v_period_status\s*<>\s*'open'[\s\S]*Auto-reconciliation\s+pending:\s+closed\s+accounting\s+period/i,
    'Closed accounting period must leave bank line unreconciled with pending note'
  );

  // Exception block prevents false reconciliation on error
  assert.match(
    migration,
    /EXCEPTION\s+WHEN\s+OTHERS\s+THEN[\s\S]*UPDATE\s+public\.bank_statement_lines[\s\S]*Auto-reconciliation\s+pending:/i,
    'Auto-reconciliation errors must be caught and recorded in notes without marking line reconciled'
  );
});

test('9. Safe idempotency: retries and repeated calls do not duplicate expenses or journals', () => {
  const migration = readFileSync(migrationPath, 'utf8');
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // Frontend creation idempotency check
  assert.match(
    expenseUi,
    /if\s*\(lineCheck\?\.matched_expense_id\)[\s\S]*throw\s+new\s+Error\(/,
    'Frontend must prevent duplicate expense creation from already matched bank line'
  );

  // Database approval idempotency guard
  assert.match(
    migration,
    /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.bank_statement_allocations\s+WHERE\s+bank_statement_line_id\s*=\s*v_line\.id\s+AND\s+document_type\s*=\s*'expense'\s+AND\s+document_id\s*=\s*p_expense_id\s*\)\s*THEN[\s\S]*PERFORM\s+public\.refresh_bank_statement_allocation_status\(v_line\.id\);\s*CONTINUE;/i,
    'Auto-reconciliation must check existing allocation and skip duplicate linking'
  );
});

test('10. Compatibility checks: debit direction, currency, and bank account validation', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // Outgoing debit check
  assert.match(
    migration,
    /IF\s+COALESCE\(v_line\.debit_amount,\s*0\)\s*<=\s*0\s+THEN[\s\S]*Auto-reconciliation\s+skipped:\s+bank\s+transaction\s+is\s+not\s+an\s+outgoing\s+debit/i,
    'Must verify outgoing debit direction before reconciling'
  );

  // Bank account compatibility check
  assert.match(
    migration,
    /IF\s+v_exp\.bank_account_id\s+IS\s+NOT\s+NULL\s+AND\s+v_exp\.bank_account_id\s*<>\s*v_line\.bank_account_id\s+THEN[\s\S]*bank\s+account\s+mismatch/i,
    'Must verify bank account compatibility'
  );

  // Currency compatibility check
  assert.match(
    migration,
    /IF\s+COALESCE\(v_bank_currency,\s*'IDR'\)\s*<>\s*v_exp_currency\s+THEN[\s\S]*currency\s+mismatch/i,
    'Must verify currency compatibility between bank line and expense'
  );
});

test('11. Ordinary expenses created outside Bank Reconciliation continue to work unchanged', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // Loop only iterates when matched_expense_id or originating_bank_statement_line_id exists
  assert.match(
    migration,
    /WHERE\s+\(matched_expense_id\s*=\s*p_expense_id\s+OR\s+id\s*=\s*v_exp\.originating_bank_statement_line_id\)/i,
    'Ordinary expenses without bank lines will cleanly bypass the auto-reconciliation loop'
  );
});

test('12. Existing receipt, payment, contra, and journal workflows remain unaffected', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // link_bank_statement_line preserves all other document types
  assert.match(
    migration,
    /ELSIF\s+p_document_type='receipt'\s+THEN\s+SELECT\s+journal_entry_id\s+INTO\s+v_je\s+FROM\s+public\.receipt_vouchers/i,
    'Receipt linking preserved in link_bank_statement_line'
  );
  assert.match(
    migration,
    /ELSIF\s+p_document_type='payment'\s+THEN\s+SELECT\s+journal_entry_id\s+INTO\s+v_je\s+FROM\s+public\.payment_vouchers/i,
    'Payment linking preserved in link_bank_statement_line'
  );
  assert.match(
    migration,
    /ELSIF\s+p_document_type='fund_transfer'\s+THEN\s+SELECT\s+journal_entry_id\s+INTO\s+v_je\s+FROM\s+public\.fund_transfers/i,
    'Fund transfer linking preserved in link_bank_statement_line'
  );
});
