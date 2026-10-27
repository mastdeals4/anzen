import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluateVoucherBankLink } from '../src/utils/voucherBankLinks.ts';

test('1. Receipt Voucher - Fully Linked state evaluation (Green Link2)', () => {
  const result = evaluateVoucherBankLink({
    expectedAmount: 10000000,
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'alloc-1',
        bank_statement_line_id: 'line-1',
        allocation_amount: 10000000,
        document_id: 'receipt-1',
        document_type: 'receipt',
        bank_statement_lines: {
          id: 'line-1',
          transaction_date: '2026-10-15',
          description: 'Payment from Customer PT Jaya',
          reference: 'TRF-12345',
          credit_amount: 10000000,
        },
      },
    ],
    legacyLinks: [
      {
        bank_statement_line_id: 'line-1',
        credit_amount: 10000000,
      },
    ],
  });

  assert.equal(result.status, 'linked');
  assert.equal(result.statusLabel, 'Linked / Reconciled');
  assert.equal(result.hasConflict, false);
  assert.equal(result.canonicalAmount, 10000000);
});

test('2. Receipt Voucher - Partially Linked state evaluation (Yellow Link2)', () => {
  const result = evaluateVoucherBankLink({
    expectedAmount: 10000000,
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'alloc-1',
        bank_statement_line_id: 'line-1',
        allocation_amount: 4000000,
        document_id: 'receipt-1',
        document_type: 'receipt',
        bank_statement_lines: {
          id: 'line-1',
          transaction_date: '2026-10-15',
          description: 'Partial deposit',
          credit_amount: 4000000,
        },
      },
    ],
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.statusLabel, 'Partially Linked');
  assert.equal(result.hasConflict, false);
  assert.equal(result.canonicalAmount, 4000000);
});

test('3. Receipt Voucher - Unlinked state evaluation (Muted/red Unlink)', () => {
  const result = evaluateVoucherBankLink({
    expectedAmount: 10000000,
    currency: 'IDR',
    canonicalAllocations: [],
    legacyLinks: [],
  });

  assert.equal(result.status, 'unlinked');
  assert.equal(result.statusLabel, 'Unlinked');
  assert.equal(result.hasConflict, false);
  assert.equal(result.canonicalAmount, 0);
});

test('4. Genuine Data-Integrity Problems (Amber AlertTriangle / needs_review)', () => {
  // A. Over-allocation against voucher expected amount
  const overAllocatedVoucher = evaluateVoucherBankLink({
    expectedAmount: 10000000,
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'alloc-over',
        bank_statement_line_id: 'line-1',
        allocation_amount: 12000000,
        document_id: 'receipt-1',
        document_type: 'receipt',
        bank_statement_lines: {
          id: 'line-1',
          debit_amount: 0,
          credit_amount: 12000000,
        },
      },
    ],
  });
  assert.equal(overAllocatedVoucher.status, 'needs_review');
  assert.equal(overAllocatedVoucher.hasConflict, true);
  assert.match(overAllocatedVoucher.conflictReason || '', /Over-allocated: Bank allocation/);

  // B. Missing statement line (allocation references a line that does not exist in DB)
  const missingStatementLine = evaluateVoucherBankLink({
    expectedAmount: 5000000,
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'alloc-missing',
        bank_statement_line_id: 'line-nonexistent',
        allocation_amount: 5000000,
        document_id: 'receipt-2',
        document_type: 'receipt',
        bank_statement_lines: null, // missing foreign row
      },
    ],
  });
  assert.equal(missingStatementLine.status, 'needs_review');
  assert.equal(missingStatementLine.hasConflict, true);
  assert.match(missingStatementLine.conflictReason || '', /Missing statement line/);

  // C. Over-allocated statement line (allocation exceeds statement line total)
  const overAllocatedLine = evaluateVoucherBankLink({
    expectedAmount: 10000000,
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'alloc-bad-line',
        bank_statement_line_id: 'line-small',
        allocation_amount: 8000000,
        document_id: 'receipt-3',
        document_type: 'receipt',
        bank_statement_lines: {
          id: 'line-small',
          debit_amount: 0,
          credit_amount: 5000000, // statement line only 5m, but alloc is 8m
        },
      },
    ],
  });
  assert.equal(overAllocatedLine.status, 'needs_review');
  assert.equal(overAllocatedLine.hasConflict, true);
  assert.match(overAllocatedLine.conflictReason || '', /Over-allocated statement line/);

  // D. Duplicate allocations on the same statement line
  const duplicateAllocations = evaluateVoucherBankLink({
    expectedAmount: 10000000,
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'alloc-dup-1',
        bank_statement_line_id: 'line-dup',
        allocation_amount: 5000000,
        document_id: 'receipt-4',
        document_type: 'receipt',
        bank_statement_lines: {
          id: 'line-dup',
          credit_amount: 10000000,
        },
      },
      {
        id: 'alloc-dup-2',
        bank_statement_line_id: 'line-dup',
        allocation_amount: 5000000,
        document_id: 'receipt-4',
        document_type: 'receipt',
        bank_statement_lines: {
          id: 'line-dup',
          credit_amount: 10000000,
        },
      },
    ],
  });
  assert.equal(duplicateAllocations.status, 'needs_review');
  assert.equal(duplicateAllocations.hasConflict, true);
  assert.match(duplicateAllocations.conflictReason || '', /Duplicate allocation/);
});

test('5. Known Example Payment Voucher PV/26-026/027 (DB PV/26-26/027) evaluates to Green Link2', () => {
  // Production case:
  // Voucher expected: IDR 51,019,762
  // Canonical allocation: IDR 51,019,762 on statement line 3b2abcac-33e3-4640-a23e-992fd9b78ed0
  // Statement line has stale legacy flag manually_unlinked: true
  // Evaluation MUST NOT degrade to yellow or amber because canonical allocation is valid and full.
  const result = evaluateVoucherBankLink({
    expectedAmount: 51019762,
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'a3e0a4a3-ecf9-4557-970f-1acd5f1a1ab7',
        bank_statement_line_id: '3b2abcac-33e3-4640-a23e-992fd9b78ed0',
        allocation_amount: 51019762,
        document_id: '451c3333-eb21-47bb-a79f-75ccb71e75bc',
        document_type: 'payment',
        bank_statement_lines: {
          id: '3b2abcac-33e3-4640-a23e-992fd9b78ed0',
          transaction_date: '2026-10-19',
          description: 'TRSF E-BANKING DB 1910/FTSCY/WS95051 51019762.00 FJ1-2610003 Invoic paid KAIROS TRITUNGGAL',
          reference: '1910/FTSCY/WS95051',
          debit_amount: 51019762,
          credit_amount: 0,
        },
      },
    ],
    legacyLinks: [
      {
        bank_statement_line_id: '3b2abcac-33e3-4640-a23e-992fd9b78ed0',
        debit_amount: 51019762,
        manually_unlinked: true, // Stale legacy flag
      },
    ],
  });

  assert.equal(result.status, 'linked', 'Must evaluate to green linked despite stale legacy manually_unlinked flag');
  assert.equal(result.statusLabel, 'Linked / Reconciled');
  assert.equal(result.hasConflict, false);
  assert.equal(result.canonicalAmount, 51019762);
  assert.equal(result.expectedAmount, 51019762);
});

test('6. Payment Voucher - Fully Linked state evaluation', () => {
  const result = evaluateVoucherBankLink({
    expectedAmount: 5002500, // Amount + Bank charge
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'alloc-pv-1',
        bank_statement_line_id: 'line-pv-1',
        allocation_amount: 5002500,
        document_id: 'pv-1',
        document_type: 'payment',
        bank_statement_lines: {
          id: 'line-pv-1',
          transaction_date: '2026-10-18',
          description: 'Payment to Supplier CV Sentosa',
          reference: 'OUT-9988',
          debit_amount: 5002500,
        },
      },
    ],
    legacyLinks: [
      {
        bank_statement_line_id: 'line-pv-1',
        debit_amount: 5002500,
      },
    ],
  });

  assert.equal(result.status, 'linked');
  assert.equal(result.statusLabel, 'Linked / Reconciled');
  assert.equal(result.hasConflict, false);
  assert.equal(result.canonicalAmount, 5002500);
});

test('7. Payment Voucher - Partially Linked state evaluation', () => {
  const result = evaluateVoucherBankLink({
    expectedAmount: 15000000,
    currency: 'IDR',
    canonicalAllocations: [
      {
        id: 'alloc-pv-part',
        bank_statement_line_id: 'line-pv-part',
        allocation_amount: 5000000,
        document_id: 'pv-2',
        document_type: 'payment',
        bank_statement_lines: {
          id: 'line-pv-part',
          transaction_date: '2026-10-20',
          description: 'Tranche 1 payment',
          debit_amount: 5000000,
        },
      },
    ],
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.statusLabel, 'Partially Linked');
  assert.equal(result.hasConflict, false);
  assert.equal(result.canonicalAmount, 5000000);
});

test('8. Payment Voucher - Unlinked state evaluation', () => {
  const result = evaluateVoucherBankLink({
    expectedAmount: 8500000,
    currency: 'IDR',
    canonicalAllocations: [],
    legacyLinks: [],
  });

  assert.equal(result.status, 'unlinked');
  assert.equal(result.statusLabel, 'Unlinked');
  assert.equal(result.hasConflict, false);
  assert.equal(result.canonicalAmount, 0);
});

test('9. Internal settlement and cash vouchers do not require bank reconciliation', () => {
  const internalSettlement = evaluateVoucherBankLink({
    expectedAmount: 3000000,
    isInternalSettlement: true,
  });
  assert.equal(internalSettlement.status, 'unlinked');
  assert.equal(internalSettlement.statusLabel, 'Internal Settlement');
  assert.equal(internalSettlement.hasConflict, false);

  const cashVoucher = evaluateVoucherBankLink({
    expectedAmount: 500000,
    isCash: true,
  });
  assert.equal(cashVoucher.status, 'unlinked');
  assert.equal(cashVoucher.statusLabel, 'Cash (No Bank Link)');
  assert.equal(cashVoucher.hasConflict, false);
});

test('10. Table and Component Architecture Verification', () => {
  const receiptSrc = readFileSync(
    new URL('../src/components/finance/ReceiptVoucherManager.tsx', import.meta.url),
    'utf8',
  );
  // Separate column must NOT exist
  assert.doesNotMatch(receiptSrc, /<th[^>]*>Bank Link<\/th>/, 'Receipt vouchers table must NOT have a separate Bank Link column');
  // Link indicator must be placed beside View in the Actions column
  assert.match(
    receiptSrc,
    /<VoucherBankLinkIndicator[\s\S]*?<FinanceActionButton action="view"/,
    'Receipt vouchers must place link indicator immediately before View button in Actions',
  );

  const paymentSrc = readFileSync(
    new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url),
    'utf8',
  );
  // Separate column must NOT exist
  assert.doesNotMatch(paymentSrc, /header:\s*'Bank Link'/, 'Payment vouchers table must NOT have a separate Bank Link column');
  // Link indicator must be placed beside View in the Actions column
  assert.match(
    paymentSrc,
    /<VoucherBankLinkIndicator[\s\S]*?<FinanceActionButton action="view"/,
    'Payment vouchers must place link indicator immediately before View button in Actions',
  );

  const indicatorSrc = readFileSync(
    new URL('../src/components/finance/VoucherBankLinkIndicator.tsx', import.meta.url),
    'utf8',
  );
  // Must use Link2, Unlink, and AlertTriangle
  assert.match(indicatorSrc, /import \{ Link2, Unlink, AlertTriangle/, 'Indicator must import Link2, Unlink, AlertTriangle');
  // Must use clean button classes matching Expenses (no border boxes)
  assert.match(indicatorSrc, /inline-flex h-6 w-6 items-center justify-center rounded transition-colors/, 'Indicator button must use compact h-6 w-6 without borders');
  assert.doesNotMatch(indicatorSrc, /buttonClasses = '[^']*border/, 'Button classes must not have border box');
  // Popover details
  assert.match(indicatorSrc, /Not linked to a bank transaction/, 'Indicator must display unlinked message');
  assert.match(indicatorSrc, /Go to Bank Reconciliation/, 'Indicator popover must offer navigation to Bank Reconciliation');
  assert.match(indicatorSrc, /Link Conflict Detected/, 'Indicator popover must display conflict alert for needs_review');
});
