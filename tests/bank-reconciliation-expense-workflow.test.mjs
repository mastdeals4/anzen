import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bankFrontend = fs.readFileSync('src/components/finance/BankReconciliationEnhanced.tsx', 'utf8');
const expenseFrontend = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');
const cancellationMigration = fs.readFileSync('supabase/migrations/20260827160000_fix_expense_cancellation_uuid_and_audit.sql', 'utf8');

const loadStatementLines = bankFrontend.slice(
  bankFrontend.indexOf('const loadStatementLines = async'),
  bankFrontend.indexOf('const parseCSVLine', bankFrontend.indexOf('const loadStatementLines = async')),
);

test('bank reconciliation bounds every UUID IN read to 50-100 IDs', () => {
  const size = Number(bankFrontend.match(/BANK_RECONCILIATION_IN_BATCH_SIZE\s*=\s*(\d+)/)?.[1]);
  assert.ok(size >= 50 && size <= 100, `unexpected batch size ${size}`);
  assert.match(loadStatementLines, /loadBankReconciliationRowsInBatches<any>\(lineIds/);
  for (const ids of ['expenseIds', 'paymentIds', 'receiptIds', 'fundTransferIds', 'pettyCashIds', 'entryIds', 'taxPaymentIds']) {
    assert.match(loadStatementLines, new RegExp(`loadBankReconciliationRowsInBatches<any>\\(${ids}`));
  }
  assert.doesNotMatch(loadStatementLines, /\.in\('bank_statement_line_id',\s*lineIds\)/);
});

test('statement lines use deterministic server pagination for long date ranges', () => {
  assert.match(bankFrontend, /BANK_RECONCILIATION_PAGE_SIZE\s*=\s*1000/);
  assert.match(loadStatementLines, /\.order\('transaction_date', \{ ascending: false \}\)/);
  assert.match(loadStatementLines, /\.order\('id', \{ ascending: true \}\)/);
  assert.match(loadStatementLines, /\.range\(offset, offset \+ BANK_RECONCILIATION_PAGE_SIZE - 1\)/);
  assert.match(loadStatementLines, /page\.length < BANK_RECONCILIATION_PAGE_SIZE/);
});

test('batched statement reads preserve canonical allocations and split totals', () => {
  assert.match(loadStatementLines, /from\('bank_statement_allocations'\)/);
  assert.match(loadStatementLines, /const list = allocationMap\.get\(allocation\.bank_statement_line_id\) \|\| \[\]/);
  assert.match(loadStatementLines, /list\.push\(/);
  assert.match(loadStatementLines, /allocatedAmount = allocations\.reduce/);
  assert.match(loadStatementLines, /canonicalBankReconciliationStatus\(bankAmount, allocatedAmount\)/);
});

test('bank date, journal accounting date, currency and status filters remain distinct', () => {
  assert.match(loadStatementLines, /date: row\.transaction_date/);
  assert.match(loadStatementLines, /entry_date/);
  assert.match(loadStatementLines, /currency: row\.currency \|\| 'IDR'/);
  assert.match(bankFrontend, /'all' \| 'matched' \| 'suggested' \| 'unmatched'/);
});

test('statement read path cannot mutate accounting or reconciliation data', () => {
  assert.doesNotMatch(loadStatementLines, /\.(?:insert|update|delete|upsert)\s*\(/);
});

test('expense cancellation preflight covers every database settlement guard', () => {
  for (const table of [
    'finance_expenses',
    'voucher_allocations',
    'bank_statement_allocations',
    'bank_statement_lines',
    'bank_reconciliation_items',
    'journal_entries',
    'accounting_periods',
  ]) {
    assert.match(expenseFrontend, new RegExp(`from\\('${table}'\\)`));
  }
  assert.match(expenseFrontend, /Number\(expense\.paid_amount \|\| 0\) > 0\.01/);
  assert.match(expenseFrontend, /Number\(expense\.pph_paid_amount \|\| 0\) > 0\.01/);
  assert.match(expenseFrontend, /This expense is already paid\/reconciled\. Reverse or unlink the payment\/bank reconciliation first\./);
});

test('preflight runs before opening and immediately before cancellation RPC', () => {
  const requestHandler = expenseFrontend.slice(
    expenseFrontend.indexOf('const handleCancelPostingRequest'),
    expenseFrontend.indexOf('const handleCancelPostingConfirm'),
  );
  const confirmHandler = expenseFrontend.slice(
    expenseFrontend.indexOf('const handleCancelPostingConfirm'),
    expenseFrontend.indexOf('const handleCancelPostingBankUnlink'),
  );
  assert.match(requestHandler, /preflightExpenseCancellation\(expense\.id\)/);
  assert.ok(
    confirmHandler.indexOf('preflightExpenseCancellation(cancelPostingTarget.id)')
      < confirmHandler.indexOf("rpc('cancel_expense_posting'"),
    'preflight must happen before cancellation RPC',
  );
  assert.match(confirmHandler, /if \(block\) \{[\s\S]*return;/);
});

test('UI offers only controlled settlement workflows and retains database protection', () => {
  assert.match(expenseFrontend, /Open Payment Voucher/);
  assert.match(expenseFrontend, /unlinkBankTransaction\(cancelPostingBlock\.bankStatementLineId\)/);
  assert.doesNotMatch(expenseFrontend, /from\('bank_statement_allocations'\)[\s\S]{0,160}\.delete\(/);
  assert.match(cancellationMigration, /paid\/settled expense/);
  assert.match(cancellationMigration, /voucher_allocations/);
  assert.match(cancellationMigration, /bank_statement_allocations/);
  assert.match(cancellationMigration, /bank_reconciliation_items/);
});

test('closed, reversed, missing-journal and normal open paths have clear outcomes', () => {
  assert.match(expenseFrontend, /closed accounting period/);
  assert.match(expenseFrontend, /posting has already been reversed/);
  assert.match(expenseFrontend, /No active journal exists for this expense/);
  assert.match(expenseFrontend, /return \{ block: null \}/);
  assert.match(expenseFrontend, /preserves the original journal, creates its auditable reversal/);
});
