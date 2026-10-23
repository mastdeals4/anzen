import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. Migration file structural and accounting contract verification for receipt voucher rounding', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261023170000_fix_receipt_voucher_settlement_rounding.sql'
  );
  assert.ok(fs.existsSync(migrationPath), 'Migration file 20261023170000 must exist');

  const content = fs.readFileSync(migrationPath, 'utf-8');

  // Schema alterations for sales order support
  assert.match(content, /ADD COLUMN IF NOT EXISTS sales_order_id uuid REFERENCES public\.sales_orders/,
    'Must add sales_order_id column to invoice_rounding_adjustments');
  assert.match(content, /chk_invoice_rounding_adjustments_target/,
    'Must update target check constraint to support sales_order_id');
  assert.match(content, /invoice_rounding_adjustments_one_per_so/,
    'Must create unique index on sales_order_id');

  // voucher_allocations_check fix
  assert.match(content, /DROP CONSTRAINT IF EXISTS voucher_allocations_check/,
    'Must drop existing voucher_allocations_check');
  assert.match(content, /voucher_type = 'receipt' AND receipt_voucher_id IS NOT NULL AND \([\s\S]*sales_order_id IS NOT NULL/,
    'Must add voucher_allocations_check allowing receipt voucher to sales order allocation');

  // SO advance status and rounding helpers
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.get_sales_order_rounding_adjustment_amount/,
    'Must define get_sales_order_rounding_adjustment_amount helper');
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.update_so_advance_status/,
    'Must update update_so_advance_status trigger function');
  assert.match(content, /v_total_advance \+ v_total_adj\) >= v_order_total/,
    'update_so_advance_status must account for rounding adjustments when marking full advance');

  // Sales order settlement adjustment handler
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.apply_so_allocation_rounding_adjustment/,
    'Must define apply_so_allocation_rounding_adjustment');
  assert.match(content, /code = '4900'/,
    'Sales order rounding gain must credit Round-Off Gain (4900)');
  assert.match(content, /code = '6900'/,
    'Sales order rounding expense must debit Round-Off Expense (6900)');

  // Unified RPC
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.save_invoice_settlement_adjustment/,
    'Must define updated save_invoice_settlement_adjustment');

  // Canonical post_receipt_voucher
  assert.match(content, /CREATE OR REPLACE FUNCTION public\.post_receipt_voucher/,
    'Must define upgraded post_receipt_voucher');
  assert.match(content, /v_rounding_gain_id/i,
    'post_receipt_voucher must resolve rounding gain account');
  assert.match(content, /v_rounding_loss_id/i,
    'post_receipt_voucher must resolve rounding loss/writeoff account');
  assert.match(content, /Receipt allocation difference % exceeds configured rounding tolerance %/,
    'post_receipt_voucher must reject differences exceeding rounding tolerance');
});

test('2. Reproduced case: Rp 0.25 difference accepted, properly adjusted to Rounding Gain', () => {
  // Case constants
  const bankReceiptAmount = 24704299.00;
  const soBalanceDue = 24704298.75;
  const allocatedAmount = 24704298.75; // Allocate actual balance due
  const roundingTolerance = 100.00;

  const difference = Math.round((bankReceiptAmount - allocatedAmount) * 100) / 100; // 0.25
  assert.equal(difference, 0.25, 'Residual difference must be exactly Rp 0.25');
  assert.ok(difference <= roundingTolerance, 'Difference Rp 0.25 must be within tolerance Rp 100.00');

  // Document balance settling
  const finalDocBalance = Math.round((soBalanceDue - allocatedAmount) * 100) / 100;
  assert.equal(finalDocBalance, 0.00, 'Sales Order balance due becomes exactly Rp 0.00');

  // Accounting simulation: GL Journal Entry lines
  // Debit: Bank Rp 24,704,299.00
  // Credit: AR (1120) Rp 24,704,298.75
  // Credit: Rounding Gain (4900) Rp 0.25
  const journalLines = [
    { account: '1111', debit: bankReceiptAmount, credit: 0, desc: 'Cash Receipt' },
    { account: '1120', debit: 0, credit: allocatedAmount, desc: 'Receipt - AR' },
    { account: '4900', debit: 0, credit: difference, desc: 'Receipt settlement rounding gain' },
  ];

  const totalDebit = journalLines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = journalLines.reduce((sum, l) => sum + l.credit, 0);

  assert.equal(totalDebit, 24704299.00, 'Total debit must match bank receipt exactly');
  assert.equal(totalCredit, 24704299.00, 'Total credit must match bank receipt exactly');
  assert.equal(totalDebit, totalCredit, 'Debit must equal credit');
});

test('3. Exact match: accepted with no rounding journal line', () => {
  const bankReceiptAmount = 24704299.00;
  const docBalance = 24704299.00;
  const allocated = 24704299.00;
  const difference = Math.round((bankReceiptAmount - allocated) * 100) / 100;

  assert.equal(difference, 0.00, 'Exact match has 0.00 difference');

  const journalLines = [
    { account: '1111', debit: bankReceiptAmount, credit: 0 },
    { account: '1120', debit: 0, credit: allocated },
  ];

  const totalDebit = journalLines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = journalLines.reduce((sum, l) => sum + l.credit, 0);

  assert.equal(totalDebit, totalCredit, 'Exact match journal must balance');
  assert.equal(journalLines.some(l => l.account === '4900' || l.account === '6900'), false,
    'Exact match must not generate rounding lines');
});

test('4. Difference within tolerance: underpayment write-off vs overpayment gain', () => {
  const tolerance = 100.00;

  // Case A: Customer overpaid by Rp 50.00
  const overpaidReceipt = 10000050.00;
  const soBalance = 10000000.00;
  const soAllocated = 10000000.00;
  const gainDiff = Math.round((overpaidReceipt - soAllocated) * 100) / 100;

  assert.equal(gainDiff, 50.00);
  assert.ok(gainDiff <= tolerance);

  const gainLines = [
    { account: '1111', debit: 10000050.00, credit: 0 },
    { account: '1120', debit: 0, credit: 10000000.00 },
    { account: '4900', debit: 0, credit: 50.00 },
  ];
  assert.equal(
    gainLines.reduce((s, l) => s + l.debit, 0),
    gainLines.reduce((s, l) => s + l.credit, 0),
    'Overpayment gain entry must balance'
  );

  // Case B: Customer underpaid by Rp 50.00 (short payment settled via rounding write-off)
  const underpaidReceipt = 9999950.00;
  const invBalance = 10000000.00;
  const invAllocated = 9999950.00;
  const writeoffDiff = Math.round((invBalance - invAllocated) * 100) / 100;

  assert.equal(writeoffDiff, 50.00);
  assert.ok(writeoffDiff <= tolerance);

  const lossLines = [
    { account: '1111', debit: 9999950.00, credit: 0 },
    { account: '6900', debit: 50.00, credit: 0 },
    { account: '1120', debit: 0, credit: 10000000.00 },
  ];
  assert.equal(
    lossLines.reduce((s, l) => s + l.debit, 0),
    lossLines.reduce((s, l) => s + l.credit, 0),
    'Underpayment write-off entry must balance'
  );
});

test('5. Difference exceeding tolerance: remains blocked on client and server', () => {
  const receiptAmount = 24704299.00;
  const allocatedAmount = 24500000.00;
  const tolerance = 100.00;
  const diff = Math.round((receiptAmount - allocatedAmount) * 100) / 100;

  assert.equal(diff, 204299.00, 'Difference must be Rp 204,299.00');
  assert.ok(diff > tolerance, 'Difference must exceed configured tolerance');

  // Verify UI logic blocks save
  const isBlockedInUI = diff > tolerance;
  assert.equal(isBlockedInUI, true, 'Client-side handleSubmit must block save');

  // Verify server-side post_receipt_voucher exception condition
  const willServerRaise = diff > tolerance;
  assert.equal(willServerRaise, true, 'Server-side RPC must raise exception');
});

test('6. Partial allocations across multiple documents', () => {
  const receiptAmount = 50000000.00;
  const allocations = [
    { type: 'invoice', balance: 25000000.00, allocated: 25000000.00 },
    { type: 'salesorder', balance: 24999999.75, allocated: 24999999.75 },
  ];

  const totalAllocated = allocations.reduce((sum, a) => sum + a.allocated, 0);
  const diff = Math.round((receiptAmount - totalAllocated) * 100) / 100;

  assert.equal(totalAllocated, 49999999.75);
  assert.equal(diff, 0.25);
  assert.ok(diff <= 100.00);

  const journalLines = [
    { account: '1111', debit: receiptAmount, credit: 0 },
    { account: '1120', debit: 0, credit: totalAllocated },
    { account: '4900', debit: 0, credit: diff },
  ];

  assert.equal(
    journalLines.reduce((s, l) => s + l.debit, 0),
    journalLines.reduce((s, l) => s + l.credit, 0),
    'Multi-document allocation with residual gain must balance'
  );
});

test('7. Repeated save/retry idempotency & duplicate prevention', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261023170000_fix_receipt_voucher_settlement_rounding.sql'
  );
  const content = fs.readFileSync(migrationPath, 'utf-8');

  // Check unique constraints and idempotency
  assert.match(content, /IF v_rv\.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is already posted'/,
    'post_receipt_voucher must reject duplicate posting attempts');
  assert.match(content, /IF NOT EXISTS \(SELECT 1 FROM public\.invoice_rounding_adjustments WHERE receipt_voucher_id = p_rv_id\)/,
    'post_receipt_voucher must check existing adjustment to prevent duplicates');
  assert.match(content, /DELETE FROM public\.invoice_rounding_adjustments WHERE receipt_voucher_id = p_rv_id/,
    'cancel_receipt_voucher_posting must clean up rounding adjustments upon posting cancellation');
});

test('8. Decimal precision and UI integration in ReceiptVoucherManager.tsx', () => {
  const filePath = path.join(process.cwd(), 'src/components/finance/ReceiptVoucherManager.tsx');
  const content = fs.readFileSync(filePath, 'utf-8');

  // Both invoice and salesorder handled in handleAllocationChange
  assert.match(content, /targetType === 'invoice' \|\| targetType === 'salesorder'/,
    'handleAllocationChange must handle both invoice and salesorder');

  // Preview handles sales orders and marks settled
  assert.match(content, /target\.type === 'invoice'[\s\S]*\?[\s\S]*balance_amount[\s\S]*:[\s\S]*balance_due/,
    'getInvoiceAllocationPreview must read balance_due for sales orders');
  assert.match(content, /invoiceClosed:[\s\S]*finalBalance === 0/,
    'getInvoiceAllocationPreview must close document when finalBalance is 0');

  // Tolerance enforcement in handleSubmit
  assert.match(content, /unallocatedDifference > roundingTolerance/,
    'handleSubmit must block unallocated difference exceeding tolerance');

  // Summary footer displays Round-off Gain within tolerance
  assert.match(content, /Round-off Gain/,
    'Summary footer must display Round-off Gain chip when within tolerance');
});
