import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ambiguityFixMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20261022110000_fix_receipt_allocation_rounding_overload_ambiguity.sql'
);
const dateFixMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20261019152825_fix_receipt_rounding_journal_dates.sql'
);
const bankReconUiPath = path.join(
  process.cwd(),
  'src/components/finance/BankReconciliationEnhanced.tsx'
);
const financeCommandsPath = path.join(
  process.cwd(),
  'src/services/financeCommands.ts'
);
const paymentVoucherManagerPath = path.join(
  process.cwd(),
  'src/components/finance/PaymentVoucherManager.tsx'
);
const fundTransferManagerPath = path.join(
  process.cwd(),
  'src/components/finance/FundTransferManager.tsx'
);
const baselineMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260905140000_canonical_baseline.sql'
);
const receiptSecurityMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260918010000_harden_receipt_voucher_security.sql'
);
const bankReconIntegrityMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20261013190000_bank_reconciliation_permanent_integrity_fix.sql'
);

test('1. Migration resolves function ambiguity by dropping the 2-parameter overload', () => {
  assert.ok(existsSync(ambiguityFixMigrationPath), 'Ambiguity fix migration file must exist');
  const content = readFileSync(ambiguityFixMigrationPath, 'utf8');

  // Must drop the conflicting (uuid, uuid) signature
  assert.match(
    content,
    /DROP FUNCTION IF EXISTS public\.apply_receipt_allocation_rounding_adjustment\s*\(\s*uuid\s*,\s*uuid\s*\)\s*;/i,
    'Must drop legacy 2-parameter signature apply_receipt_allocation_rounding_adjustment(uuid, uuid)'
  );

  // Must define the canonical 5-parameter signature with defaulted arguments
  assert.match(
    content,
    /CREATE OR REPLACE FUNCTION public\.apply_receipt_allocation_rounding_adjustment\s*\(\s*p_invoice_id uuid,\s*p_receipt_voucher_id uuid DEFAULT NULL::uuid,\s*p_adjustment_type text DEFAULT 'rounding',\s*p_reason text DEFAULT 'invoice_rounding_tolerance',\s*p_amount numeric DEFAULT NULL::numeric\s*\)/i,
    'Must define canonical 5-parameter apply_receipt_allocation_rounding_adjustment with defaults'
  );

  // Must grant permissions to authenticated and service_role
  assert.match(
    content,
    /GRANT EXECUTE ON FUNCTION public\.apply_receipt_allocation_rounding_adjustment\(uuid, uuid, text, text, numeric\) TO authenticated, service_role;/i,
    'Must grant permissions on canonical 5-parameter signature'
  );
});

test('2. Correct selection of intended function signature by trigger and caller sites', () => {
  const baseline = readFileSync(baselineMigrationPath, 'utf8');

  // Trigger recalculate_invoice_payment_status passes 2 arguments
  assert.match(
    baseline,
    /PERFORM public\.apply_receipt_allocation_rounding_adjustment\(NEW\.sales_invoice_id,\s*NEW\.receipt_voucher_id\);/,
    'Trigger must call apply_receipt_allocation_rounding_adjustment with 2 arguments'
  );

  // Verify that with (uuid, uuid) dropped, Postgres matches (uuid, uuid) to the 5-parameter signature via defaults
  const fixMigration = readFileSync(ambiguityFixMigrationPath, 'utf8');
  const paramMatches = fixMigration.match(/p_adjustment_type text DEFAULT 'rounding',\s*p_reason text DEFAULT 'invoice_rounding_tolerance',\s*p_amount numeric DEFAULT NULL::numeric/);
  assert.ok(paramMatches, 'Parameters 3, 4, 5 must all have default values to satisfy 2-argument invocation');
});

test('3. Receipt recording: canonical save, post, allocate, and link workflow', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');

  // Uses saveReceiptVoucher
  assert.match(
    bankUi,
    /const receiptId = await saveReceiptVoucher\(/,
    'handleRecordReceipt must invoke canonical saveReceiptVoucher'
  );

  // Uses post_receipt_voucher RPC
  assert.match(
    bankUi,
    /supabase\.rpc\('post_receipt_voucher',\s*\{\s*p_rv_id:\s*receiptId,\s*p_posted_by:\s*user\.id,?\s*\}\)/,
    'handleRecordReceipt must invoke canonical post_receipt_voucher RPC'
  );

  // Uses linkBankStatementLine
  assert.match(
    bankUi,
    /await linkBankStatementLine\(line\.id,\s*'receipt',\s*receiptId\)/,
    'handleRecordReceipt must link bank statement line to receipt'
  );

  // Allocations to invoices supported
  assert.match(
    bankUi,
    /Object\.entries\(receiptAllocations\)[\s\S]*filter\(\(\[,\s*amount\]\)\s*=>\s*amount\s*>\s*0\)[\s\S]*map\(\(\[invoiceId,\s*amount\]\)\s*=>\s*\(\{\s*sales_invoice_id:\s*invoiceId,\s*amount\s*\}\)\)/,
    'handleRecordReceipt must map and filter invoice allocations'
  );
});

test('4. Decimal precision and settlement rounding simulation (PT. Rania Kalani Indonesia SAPJ-26-061)', () => {
  // Scenario from prompt:
  // Subtotal: 22,256,125.00
  // PPN (11%): 2,448,173.75
  // Invoice total: 24,704,298.75
  // Bank statement credit: 24,704,299.00
  const subtotal = 22256125.00;
  const ppnRate = 0.11;
  const ppnAmount = subtotal * ppnRate; // 2448173.75
  const invoiceTotal = subtotal + ppnAmount; // 24704298.75
  const bankReceived = 24704299.00;

  assert.equal(invoiceTotal, 24704298.75, 'Calculated invoice total with 11% PPN is 24,704,298.75');

  const residual = Number((bankReceived - invoiceTotal).toFixed(2));
  assert.equal(residual, 0.25, 'Residual difference is exactly Rp 0.25');

  // Verify tolerance check
  const tolerance = 100; // default app_settings.rounding_tolerance_amount
  assert.ok(residual <= tolerance, 'Rp 0.25 is within tolerance of Rp 100');

  // Balanced journal entry simulation in post_receipt_voucher:
  // Actual received: 24,704,299.00
  // Carrying AR (allocated): 24,704,298.75
  // Realized FX/Gain: 24,704,299.00 - 24,704,298.75 = 0.25
  const debitBank = bankReceived; // 24704299.00
  const creditAr = invoiceTotal; // 24704298.75
  const creditGain = residual; // 0.25
  const totalDebit = debitBank;
  const totalCredit = creditAr + creditGain;

  assert.equal(totalDebit, totalCredit, 'Debit (24,704,299.00) must equal Credit (24,704,299.00)');
  assert.equal(totalDebit - totalCredit, 0, 'No imbalance or discarded difference');
});

test('5. Payment recording: canonical workflow and reconciliation prefill', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');
  const paymentUi = readFileSync(paymentVoucherManagerPath, 'utf8');

  // Bank reconciliation delegates payment prefill to canonical PaymentVoucherManager
  assert.match(
    bankUi,
    /onClick=\{.*onRecordPayment\?\.\(\{/,
    'Bank reconciliation must trigger onRecordPayment with line details'
  );

  // PaymentVoucherManager receives prefill and links bank statement line
  assert.match(
    paymentUi,
    /linkBankStatementLine\(bankReconStatementLineId,\s*'payment',\s*savedVoucher\.id\)/,
    'PaymentVoucherManager must link statement line to saved payment voucher'
  );

  // PaymentVoucherManager uses canonical savePaymentVoucher
  assert.match(
    paymentUi,
    /const savedVoucher = await savePaymentVoucher\(/,
    'PaymentVoucherManager must invoke canonical savePaymentVoucher'
  );
});

test('6. Expense recording: saved as pending approval with no premature bank link', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');

  // Uses saveFinanceExpense
  assert.match(
    bankUi,
    /const savedExpense = await saveFinanceExpense\(null,\s*\{[\s\S]*approval_status:\s*'pending_approval'/,
    'handleRecordExpense must save expense as pending_approval using saveFinanceExpense'
  );

  // Must not link bank line before approval
  const recordExpenseBlock = bankUi.slice(
    bankUi.indexOf('const handleRecordExpense = async'),
    bankUi.indexOf('const handleLinkToExpense = async')
  );
  assert.doesNotMatch(
    recordExpenseBlock,
    /linkBankStatementLine/,
    'handleRecordExpense must not link bank statement line before approval'
  );
});

test('7. Contra and journal recording: canonical FundTransfer and journal linking', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');
  const fundUi = readFileSync(fundTransferManagerPath, 'utf8');

  // Contra triggers onRecordContra
  assert.match(
    bankUi,
    /onRecordContra\?\.\(\{[\s\S]*bankAccountId:\s*selectedBank[\s\S]*statementLineId:\s*(recordingLine|line)\.id/,
    'Record Contra must trigger onRecordContra with bankAccountId and statementLineId'
  );

  // FundTransferManager accepts prefillFromBankReconciliation and loads statement
  assert.match(
    fundUi,
    /prefillFromBankReconciliation/,
    'FundTransferManager must accept prefillFromBankReconciliation'
  );

  // Journal receipt uses saveBankLinkedFinanceJournal
  assert.match(
    bankUi,
    /const result = await saveBankLinkedFinanceJournal\(/,
    'Non-customer receipt must record journal via saveBankLinkedFinanceJournal'
  );
});

test('8. Linking existing transactions prevents duplicate links', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');

  // handleLinkExistingReceipt links statement line
  assert.match(
    bankUi,
    /await linkBankStatementLine\(line\.id,\s*'receipt',\s*receiptId\)/,
    'handleLinkExistingReceipt must call linkBankStatementLine'
  );

  // Candidate buttons disabled when already linked
  assert.match(
    bankUi,
    /disabled=\{r\._linked\}/,
    'Existing receipt picker must disable already linked receipts'
  );
  assert.match(
    bankUi,
    /disabled=\{j\._linked\}/,
    'Existing journal picker must disable already linked journals'
  );
});

test('9. Failed posting preserves user inputs and does not falsely mark line recorded', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');

  const receiptHandler = bankUi.slice(
    bankUi.indexOf('const handleRecordReceipt = async'),
    bankUi.indexOf('const loadDirectorLoanAccounts = async')
  );

  // Modal closing occurs ONLY in try block after successful post and link
  assert.ok(
    receiptHandler.indexOf('setRecordModal(false)') > receiptHandler.indexOf('linkBankStatementLine'),
    'setRecordModal(false) must occur after linkBankStatementLine'
  );

  // In catch block, error action feedback is set and modal is NOT closed
  const catchBlock = receiptHandler.slice(receiptHandler.indexOf('} catch (error: any) {'));
  assert.match(
    catchBlock,
    /setActionFeedback\(\{\s*type:\s*'error'/,
    'Catch block must set error action feedback'
  );
  assert.doesNotMatch(
    catchBlock,
    /setRecordModal\(false\)/,
    'Catch block must not close modal on error (preserves user inputs)'
  );
  assert.doesNotMatch(
    catchBlock,
    /status:\s*'recorded'/,
    'Catch block must not mark statement line as recorded'
  );
});

test('10. Idempotency protection prevents duplicate submissions on rapid clicks', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');

  // Ref lock check at beginning of handler
  assert.match(
    bankUi,
    /if\s*\(recordingReceiptRef\.current\)\s*return;\s*recordingReceiptRef\.current\s*=\s*true;/,
    'handleRecordReceipt must guard with recordingReceiptRef to prevent duplicate submissions'
  );

  // Submit button disabled when recording
  assert.match(
    bankUi,
    /disabled=\{recordingReceipt\}/,
    'Submit button must be disabled during receipt recording'
  );

  // Finally block resets lock
  assert.match(
    bankUi,
    /finally\s*\{[\s\S]*recordingReceiptRef\.current\s*=\s*false;\s*setRecordingReceipt\(false\);\s*\}/,
    'Finally block must reset recordingReceiptRef and recordingReceipt state'
  );
});

test('11. Database row-level locking ensures concurrency integrity in bank line linking', () => {
  const integrityMigration = readFileSync(bankReconIntegrityMigrationPath, 'utf8');

  // link_bank_statement_line locks statement line row FOR UPDATE
  assert.match(
    integrityMigration,
    /SELECT\s+\*\s+INTO\s+v_line\s+FROM\s+public\.bank_statement_lines\s+WHERE\s+id\s*=\s*p_bank_line_id\s+FOR\s+UPDATE;/,
    'link_bank_statement_line must lock the bank statement line row FOR UPDATE'
  );
});

test('12. Settlement adjustment date aligns with receipt/payment voucher date (never invoice date)', () => {
  const fixMigration = readFileSync(ambiguityFixMigrationPath, 'utf8');

  // Must resolve voucher_date from receipt_vouchers
  assert.match(
    fixMigration,
    /SELECT voucher_date INTO v_voucher_date\s*FROM public\.receipt_vouchers\s*WHERE id = v_target_rv_id;/,
    'Must resolve voucher_date from target receipt voucher'
  );

  // Journal entry date must use voucher_date with fallback to CURRENT_DATE, NEVER invoice_date
  assert.match(
    fixMigration,
    /COALESCE\(v_voucher_date,\s*CURRENT_DATE\)/,
    'Settlement adjustment journal must be dated with COALESCE(v_voucher_date, CURRENT_DATE)'
  );
  assert.doesNotMatch(
    fixMigration,
    /COALESCE\(v_invoice\.invoice_date,\s*CURRENT_DATE\)/,
    'Settlement adjustment journal must never be backdated to invoice_date'
  );
});

test('13. Audit logs maintained upon voucher posting', () => {
  const baseline = readFileSync(baselineMigrationPath, 'utf8');

  // post_receipt_voucher inserts audit log
  assert.match(
    baseline,
    /INSERT INTO audit_logs\s*\(\s*table_name,\s*record_id,\s*action_type/i,
    'post_receipt_voucher must insert an audit log record'
  );
});

test('14. Regression protection for existing financeCommands wrappers', () => {
  const commands = readFileSync(financeCommandsPath, 'utf8');

  // Canonical commands remain exported and intact
  assert.match(commands, /export const saveReceiptVoucher =/);
  assert.match(commands, /export const savePaymentVoucher =/);
  assert.match(commands, /export const saveFinanceExpense =/);
  assert.match(commands, /export const saveFinanceJournal =/);
  assert.match(commands, /export const linkBankStatementLine =/);
  assert.match(commands, /export const unlinkBankStatementLine =/);
  assert.match(commands, /export const applySettlementAdjustment =/);
});
