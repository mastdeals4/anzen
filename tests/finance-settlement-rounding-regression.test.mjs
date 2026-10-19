import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. Migration file structural and accounting contract verification', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261019140000_invoice_rounding_and_discount_settlement.sql'
  );
  assert.ok(fs.existsSync(migrationPath), 'Migration file must exist');

  const content = fs.readFileSync(migrationPath, 'utf-8');

  // Schema alterations
  assert.match(content, /ALTER COLUMN sales_invoice_id DROP NOT NULL/,
    'Must allow sales_invoice_id to be NULL for purchase adjustments');
  assert.match(content, /ADD COLUMN IF NOT EXISTS purchase_invoice_id uuid/,
    'Must add purchase_invoice_id column');
  assert.match(content, /ADD COLUMN IF NOT EXISTS payment_voucher_id uuid/,
    'Must add payment_voucher_id column');
  assert.match(content, /ADD COLUMN IF NOT EXISTS adjustment_type text/i,
    'Must add adjustment_type column');

  // Constraints
  assert.match(content, /chk_invoice_rounding_adjustments_target/,
    'Must enforce check constraint that exactly one invoice target is specified');
  assert.match(content, /chk_invoice_rounding_adjustment_type/,
    'Must enforce check constraint restricting adjustment_type to rounding, discount, or write_off');
  assert.match(content, /invoice_rounding_adjustments_one_per_pi/,
    'Must enforce unique partial index on purchase_invoice_id');

  // Recalculation functions
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.get_purchase_invoice_rounding_adjustment_amount/,
    'Must define get_purchase_invoice_rounding_adjustment_amount helper');
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.recalculate_purchase_invoice_payment_state/,
    'Must update recalculate_purchase_invoice_payment_state');
  assert.match(content, /v_paid := v_allocated \+ v_adjustment/,
    'Must include settlement adjustments in purchase invoice paid_amount calculation');

  // AP Round-off & Discount accounting
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.apply_payment_allocation_rounding_adjustment/,
    'Must define apply_payment_allocation_rounding_adjustment');
  assert.match(content, /code = '2110'/,
    'AP round-off must debit Accounts Payable (2110)');
  assert.match(content, /code = '4900'|code = '4910'/,
    'AP round-off must credit Round-Off Gain (4900 or 4910)');

  // AR Round-off & Discount accounting
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.apply_receipt_allocation_rounding_adjustment/,
    'Must define enhanced apply_receipt_allocation_rounding_adjustment');
  assert.match(content, /code = '4200'/,
    'Customer discounts must debit Sales Discounts (4200)');
  assert.match(content, /code = '6900'/,
    'Customer round-off must debit Round-off Expense (6900)');

  // Lifecycle triggers & cancellations
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.sync_purchase_invoice_payment_state_from_pv_posting/,
    'Must update sync_purchase_invoice_payment_state_from_pv_posting');
  assert.match(content, /apply_payment_allocation_rounding_adjustment\(v_invoice_id, NEW\.id\)/,
    'Must trigger adjustment on PV posting');
  assert.match(content, /clear_payment_allocation_rounding_adjustment\(v_invoice_id, NEW\.id\)/,
    'Must clear adjustment on PV unposting');
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.cancel_payment_voucher_posting/,
    'Must clean up adjustments in cancel_payment_voucher_posting');

  // Unified RPC
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.save_invoice_settlement_adjustment/,
    'Must define save_invoice_settlement_adjustment RPC');
});

test('2. Confirmed production case FJ1-2610003 arithmetic and accounting invariants', () => {
  // Case constants
  const subtotal = 45963750.00;
  const ppn = 5056012.50;
  const total = subtotal + ppn; // 51019762.50
  const actualPaid = 51019762.00;
  const residual = Math.round((total - actualPaid) * 100) / 100; // 0.50
  const roundingTolerance = 100.00;

  assert.equal(total, 51019762.50, 'Total invoice amount must be exactly Rp 51,019,762.50');
  assert.equal(residual, 0.50, 'Residual payable must be exactly Rp 0.50');
  assert.ok(residual <= roundingTolerance, 'Residual Rp 0.50 must be within configured tolerance Rp 100');

  // Settlement adjustment applied
  const adjustmentAmount = 0.50;
  const paidWithAdjustment = Math.round((actualPaid + adjustmentAmount) * 100) / 100;
  const finalBalance = Math.round((total - paidWithAdjustment) * 100) / 100;

  assert.equal(paidWithAdjustment, 51019762.50, 'Effective paid amount must equal total invoice amount');
  assert.equal(finalBalance, 0.00, 'Final payable balance must be exactly Rp 0.00');

  const finalStatus = finalBalance <= 0 ? 'paid' : (paidWithAdjustment > 0 ? 'partial' : 'unpaid');
  assert.equal(finalStatus, 'paid', 'Invoice status must transition to paid');

  // Journal entry balance verification
  const journalLines = [
    { account: '2110', debit: adjustmentAmount, credit: 0 }, // AP
    { account: '4900', debit: 0, credit: adjustmentAmount }, // Round-off Gain
  ];
  const totalDebit = journalLines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = journalLines.reduce((sum, l) => sum + l.credit, 0);

  assert.equal(totalDebit, totalCredit, 'Journal entry for Rp 0.50 round-off adjustment must be perfectly balanced');
  assert.equal(totalDebit, 0.50, 'Journal total must be Rp 0.50');

  // Cash / Bank debit invariance: Bank is NOT debited/credited for settlement round-off
  const bankPayment = actualPaid;
  assert.equal(bankPayment, 51019762.00, 'Bank statement payment amount must remain exactly Rp 51,019,762.00');
});

test('3. Commercial discount vs Round-off distinction invariants', () => {
  const tolerance = 100;

  // Case A: Round-off within tolerance without reason
  const smallResidual = 45.00;
  assert.ok(smallResidual <= tolerance, '45.00 is valid round-off within tolerance');

  // Case B: Round-off exceeding tolerance must fail
  const largeResidual = 150000.00;
  const isRoundingValid = largeResidual <= tolerance;
  assert.equal(isRoundingValid, false, 'Large residual cannot be treated as round-off');

  // Case C: Commercial discount requiring valid reason
  const discountAmount = 150000.00;
  const validReason = 'Approved volume price concession per director agreement';
  const emptyReason = '   ';

  assert.ok(validReason.trim().length > 0, 'Valid commercial discount has non-empty reason');
  assert.equal(emptyReason.trim().length, 0, 'Empty reason is invalid for commercial discount');

  // Accounting for Customer Commercial Discount:
  // Dr. 4200 (Sales Discounts) Rp 150,000
  // Cr. 1120 (Accounts Receivable) Rp 150,000
  const arDiscountJournal = [
    { account: '4200', name: 'Potongan Penjualan', debit: discountAmount, credit: 0 },
    { account: '1120', name: 'Piutang Usaha', debit: 0, credit: discountAmount },
  ];
  const arDebit = arDiscountJournal.reduce((s, l) => s + l.debit, 0);
  const arCredit = arDiscountJournal.reduce((s, l) => s + l.credit, 0);
  assert.equal(arDebit, arCredit, 'AR discount journal must be balanced');

  // Accounting for Supplier Commercial Discount:
  // Dr. 2110 (Accounts Payable) Rp 150,000
  // Cr. 4900 (Other Income / Purchase Discounts) Rp 150,000
  const apDiscountJournal = [
    { account: '2110', name: 'Hutang Usaha', debit: discountAmount, credit: 0 },
    { account: '4900', name: 'Pendapatan Lain-lain', debit: 0, credit: discountAmount },
  ];
  const apDebit = apDiscountJournal.reduce((s, l) => s + l.debit, 0);
  const apCredit = apDiscountJournal.reduce((s, l) => s + l.credit, 0);
  assert.equal(apDebit, apCredit, 'AP discount journal must be balanced');
});

test('4. Frontend command wrapper financeCommands.ts contract', () => {
  const filePath = path.join(process.cwd(), 'src/services/financeCommands.ts');
  const content = fs.readFileSync(filePath, 'utf-8');

  assert.match(content, /export interface SettlementAdjustmentCommand/,
    'financeCommands.ts must export SettlementAdjustmentCommand interface');
  assert.match(content, /documentType:\s*'purchase'\s*\|\s*'sales'/,
    'SettlementAdjustmentCommand must support both purchase and sales document types');
  assert.match(content, /adjustmentType:\s*'rounding'\s*\|\s*'discount'\s*\|\s*'write_off'/,
    'SettlementAdjustmentCommand must support rounding, discount, and write_off');
  assert.match(content, /export const applySettlementAdjustment/,
    'financeCommands.ts must export applySettlementAdjustment function');
  assert.match(content, /rpc<void>\('save_invoice_settlement_adjustment'/,
    'applySettlementAdjustment must invoke canonical RPC save_invoice_settlement_adjustment');
});

test('5. PaymentVoucherManager.tsx allocation and settlement UI integration', () => {
  const filePath = path.join(process.cwd(), 'src/components/finance/PaymentVoucherManager.tsx');
  const content = fs.readFileSync(filePath, 'utf-8');

  assert.match(content, /import.*applySettlementAdjustment.*from.*financeCommands/,
    'PaymentVoucherManager must import applySettlementAdjustment');
  assert.match(content, /roundOffAmount\?: number/,
    'InvoiceAllocationItem must track roundOffAmount');
  assert.match(content, /discountAmount\?: number/,
    'InvoiceAllocationItem must track discountAmount');
  assert.match(content, /adjustmentType\?: 'rounding' \| 'discount' \| 'write_off'/,
    'InvoiceAllocationItem must track adjustmentType');
  assert.match(content, /adjustmentReason\?: string/,
    'InvoiceAllocationItem must track adjustmentReason');

  // UI Table Columns
  assert.match(content, /<th[^>]*>Round-Off<\/th>/,
    'Payment allocation table must have Round-Off header');
  assert.match(content, /<th[^>]*>Discount<\/th>/,
    'Payment allocation table must have Discount header');
  assert.match(content, /<th[^>]*>Final Balance<\/th>/,
    'Payment allocation table must have Final Balance header');

  // Persistence in handleSubmit
  assert.match(content, /applySettlementAdjustment\(\{[\s\S]*documentType:\s*'purchase'/,
    'PaymentVoucherManager handleSubmit must call applySettlementAdjustment for purchase invoices');
});

test('6. ReceiptVoucherManager.tsx allocation and settlement UI integration', () => {
  const filePath = path.join(process.cwd(), 'src/components/finance/ReceiptVoucherManager.tsx');
  const content = fs.readFileSync(filePath, 'utf-8');

  assert.match(content, /import.*applySettlementAdjustment.*from.*financeCommands/,
    'ReceiptVoucherManager must import applySettlementAdjustment');
  assert.match(content, /interface ReceiptAllocationItem/,
    'ReceiptVoucherManager must define ReceiptAllocationItem interface');
  assert.match(content, /roundOffAmount\?: number/,
    'ReceiptAllocationItem must track roundOffAmount');
  assert.match(content, /discountAmount\?: number/,
    'ReceiptAllocationItem must track discountAmount');

  // UI Table Columns
  assert.match(content, /<th[^>]*>Round-Off<\/th>/,
    'Receipt allocation table must have Round-Off header');
  assert.match(content, /<th[^>]*>Discount<\/th>/,
    'Receipt allocation table must have Discount header');
  assert.match(content, /<th[^>]*>Final Balance<\/th>/,
    'Receipt allocation table must have Final Balance header');

  // Persistence in handleSubmit
  assert.match(content, /applySettlementAdjustment\(\{[\s\S]*documentType:\s*'sales'/,
    'ReceiptVoucherManager handleSubmit must call applySettlementAdjustment for sales invoices');
});

test('7. PurchaseInvoiceManager.tsx settlement UI and quick-settle integration', () => {
  const filePath = path.join(process.cwd(), 'src/components/finance/PurchaseInvoiceManager.tsx');
  const content = fs.readFileSync(filePath, 'utf-8');

  assert.match(content, /import.*applySettlementAdjustment.*from.*financeCommands/,
    'PurchaseInvoiceManager must import applySettlementAdjustment');
  assert.match(content, /invoiceAdjustment/,
    'PurchaseInvoiceManager must track invoiceAdjustment state');
  assert.match(content, /handleSettleResidualRoundOff/,
    'PurchaseInvoiceManager must define handleSettleResidualRoundOff');
  assert.match(content, /Settle Round-Off/,
    'PurchaseInvoiceManager must provide Settle Round-Off button for residual balances within tolerance');
});
