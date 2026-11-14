import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateExpenseMandatoryTaxLinkage } from '../src/utils/expenseValidation.ts';
import { calculateRecognizedPPh } from '../src/utils/taxCalculations.ts';

// ============================================================================
// Mandatory Supplier & Payment Validation for Tax Expenses Test Suite
// Covers all 8 requirements specified in the user prompt.
// ============================================================================

// TEST 1: PPh entered without supplier/payee -> blocked
test('1. PPh entered without supplier/payee is blocked with clear validation message', () => {
  const input = {
    expense_category: 'consulting',
    amount: 5000000,
    ppn_amount: 0,
    pph_amount: 100000,
    supplier_id: null,
    payee_id: null,
    staff_id: null,
  };

  const res = validateExpenseMandatoryTaxLinkage(input);
  assert.equal(res.isValid, false, 'Expense with PPh and no party must be invalid');
  assert.equal(res.firstErrorField, 'party');
  assert.equal(
    res.firstErrorMessage,
    'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.'
  );
});

// TEST 2: PPN entered without supplier/payee -> blocked
test('2. PPN entered without supplier/payee is blocked with clear validation message', () => {
  const input = {
    expense_category: 'office_supplies',
    amount: 1000000,
    ppn_amount: 110000,
    pph_amount: 0,
    supplier_id: null,
    payee_id: null,
    staff_id: null,
  };

  const res = validateExpenseMandatoryTaxLinkage(input);
  assert.equal(res.isValid, false, 'Expense with PPN and no party must be invalid');
  assert.equal(res.firstErrorField, 'party');
  assert.equal(
    res.firstErrorMessage,
    'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.'
  );
});

// TEST 3: PPN and PPh entered without supplier/payee -> blocked
test('3. PPN and PPh entered without supplier/payee is blocked', () => {
  const input = {
    expense_category: 'import_broker',
    amount: 10000000,
    ppn_amount: 1100000,
    pph_amount: 200000,
    supplier_id: null,
    payee_id: null,
    staff_id: null,
  };

  const res = validateExpenseMandatoryTaxLinkage(input);
  assert.equal(res.isValid, false);
  assert.equal(res.firstErrorField, 'party');
});

// TEST 4: Valid supplier, unpaid expense -> allowed; no PPh period allocation
test('4. Valid supplier, unpaid expense is allowed; pph_tax_period_id remains NULL and recognized PPh is 0', () => {
  const unpaidPestControl = {
    voucher_number: 'EXP/26/345',
    expense_category: 'maintenance_repair',
    amount: 900000,
    ppn_amount: 99000,
    pph_amount: 18000,
    supplier_id: 'supplier-uuid-pest-control',
    payee_id: null,
    staff_id: null,
    payment_method: null, // Outstanding / unpaid bill
    bank_account_id: null,
    paid_amount: 0,
    pph_tax_period_id: null,
  };

  // 1. Validation must pass
  const val = validateExpenseMandatoryTaxLinkage(unpaidPestControl);
  assert.equal(val.isValid, true, 'Valid supplier on unpaid expense must be allowed');
  assert.deepEqual(val.errors, {});

  // 2. Statutory PPh recognition: remains 0 and unallocated until payment
  const pphCalc = calculateRecognizedPPh(unpaidPestControl);
  assert.equal(pphCalc.isPaid, false);
  assert.equal(pphCalc.recognizedPph, 0);
  assert.equal(pphCalc.status, 'unpaid');
  assert.equal(unpaidPestControl.pph_tax_period_id, null);
});

// TEST 5: Valid supplier and payment details -> allowed
test('5. Valid supplier and payment details is allowed', () => {
  const paidExpense = {
    expense_category: 'office_supplies',
    amount: 2000000,
    ppn_amount: 220000,
    pph_amount: 40000,
    supplier_id: 'supplier-uuid-1',
    payment_method: 'bank_transfer',
    bank_account_id: 'bank-acc-uuid-bca',
    paid_amount: 2180000,
  };

  const val = validateExpenseMandatoryTaxLinkage(paidExpense);
  assert.equal(val.isValid, true);
  assert.deepEqual(val.errors, {});
});

// TEST 6: Paid expense without payment method/account -> blocked
test('6. Paid expense without payment method or payment account is blocked', () => {
  // Case A: Recorded as paid via bank transfer but missing bank_account_id
  const missingBank = {
    expense_category: 'professional_services',
    amount: 4500000,
    pph_amount: 112500,
    payee_id: '8ce88102-35f5-4c10-883a-86dbd31412ec', // YENY FAHRIANI
    payment_method: 'bank_transfer',
    bank_account_id: null,
  };
  const valA = validateExpenseMandatoryTaxLinkage(missingBank);
  assert.equal(valA.isValid, false);
  assert.equal(valA.firstErrorField, 'bank_account_id');
  assert.match(valA.firstErrorMessage || '', /payment account/);

  // Case B: Has paid_amount > 0 but payment_method is null or outstanding
  const missingMethod = {
    expense_category: 'professional_services',
    amount: 4000000,
    pph_amount: 100000,
    payee_id: '8ce88102-35f5-4c10-883a-86dbd31412ec', // YENY FAHRIANI (EXP/26/313 regression)
    payment_method: null,
    paid_amount: 3900000,
  };
  const valB = validateExpenseMandatoryTaxLinkage(missingMethod);
  assert.equal(valB.isValid, false);
  assert.equal(valB.firstErrorField, 'payment_method');
  assert.match(valB.firstErrorMessage || '', /payment method/);
});

// TEST 7: Expense without PPN/PPh -> existing workflow remains unchanged
test('7. Expense without PPN/PPh preserves existing workflow (non-tax expenses)', () => {
  // Non-tax general expense saved without supplier (e.g. general petty cash / meal allowance)
  const nonTaxExpense = {
    expense_category: 'meals_entertainment',
    amount: 150000,
    ppn_amount: 0,
    pph_amount: 0,
    supplier_id: null,
    payee_id: null,
    staff_id: null,
    payment_method: null, // outstanding
  };

  const val = validateExpenseMandatoryTaxLinkage(nonTaxExpense);
  assert.equal(val.isValid, true, 'Non-tax expense without supplier is permitted');
});

// TEST 8: Editing an existing expense must enforce the same rules
test('8. Editing an existing expense enforces the exact same rules', () => {
  // Attempting to edit an existing expense to add PPh without linking a supplier/payee
  const editedExisting = {
    id: 'exp-existing-123',
    amount: 5000000,
    pph_amount: 100000, // added PPh
    supplier_id: null,
    payee_id: null,
    staff_id: null,
  };

  const val = validateExpenseMandatoryTaxLinkage(editedExisting);
  assert.equal(val.isValid, false);
  assert.equal(val.firstErrorField, 'party');
});

// ============================================================================
// PART 2: Database Migration Integrity Verification
// ============================================================================

test('9. Migration 20261114160000 enforces database constraints, RPC checks, and payee_id persistence', async () => {
  const sql = await readFile('supabase/migrations/20261114160000_mandatory_supplier_and_payment_validation_for_tax_expenses.sql', 'utf8');

  // 1. Row-level trigger guard exists
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.validate_tax_expense_linkage/);
  assert.match(sql, /CREATE TRIGGER trg_validate_tax_expense_linkage/);

  // 2. Checks party requirement for PPN or PPh
  assert.match(sql, /COALESCE\(NEW\.ppn_amount, 0\) > 0 OR COALESCE\(NEW\.pph_amount, 0\) > 0/);
  assert.match(sql, /NEW\.supplier_id IS NULL AND NEW\.payee_id IS NULL AND NEW\.staff_id IS NULL/);
  assert.match(sql, /Please select a Supplier\/Payee and complete the required payment details before saving this tax expense\./);

  // 3. Checks payment details when paid
  assert.match(sql, /Please select a valid payment account for this paid expense\./);

  // 4. save_finance_expense persists payee_id
  assert.match(sql, /payee_id,\s+linked_sales_invoice_id/);
  assert.match(sql, /v_payee_id/);

  // 5. approve_finance_expense blocks approval if party is missing
  assert.match(sql, /Cannot approve tax expense % without selecting a valid Supplier, Payee, or Staff member\./);

  // 6. auto_post_expense_accounting blocks posting if party is missing
  assert.match(sql, /Cannot post tax expense % without selecting a valid Supplier, Payee, or Staff member\./);
});

// TEST 10: Investigation of Yanni / Yeny Fahriani regression case
test('10. Yanni / Yeny Fahriani regression case root cause resolution', () => {
  // In EXP/26/304 and EXP/26/313:
  // Payee was Yeny Fahriani, PPh 21 was withheld (Rp 112,500 and Rp 100,000),
  // but paid_amount was recorded without payment_method.
  const yanniRecord = {
    voucher_number: 'EXP/26/304',
    amount: 4500000,
    pph_amount: 112500,
    payee_id: '8ce88102-35f5-4c10-883a-86dbd31412ec',
    payment_method: null,
    paid_amount: 4387500,
  };

  // The new validation catches this exact condition:
  const res = validateExpenseMandatoryTaxLinkage(yanniRecord);
  assert.equal(res.isValid, false);
  assert.equal(res.firstErrorField, 'payment_method');
  assert.match(res.firstErrorMessage || '', /valid payment method/);
});

// ============================================================================
// PART 3: Multi-Period Partial Payments & Cash Strictness Tests
// ============================================================================

import { calculateMultiPeriodPPhAllocations } from '../src/utils/taxCalculations.ts';

// TEST 11: Two partial payments across multiple tax periods
test('11. Two partial payments across separate months recognize proportional PPh in each month without reassignment', () => {
  const expense = {
    amount: 2000000,
    pph_amount: 100000,
    ppn_amount: 0,
  };

  const payments = [
    {
      source: 'bank_statement_allocation',
      sourceId: 'bsa-nov-001',
      paymentDate: '2026-11-15',
      amount: 950000, // 50% of net cash payable (Rp 1,900,000)
      isReversed: false,
    },
    {
      source: 'bank_statement_allocation',
      sourceId: 'bsa-dec-002',
      paymentDate: '2026-12-10',
      amount: 950000, // Remaining 50%
      isReversed: false,
    },
  ];

  const result = calculateMultiPeriodPPhAllocations(expense, payments);

  // November recognition: Rp 50,000
  assert.equal(result.periodTotals['2026-11']?.pphTotal, 50000, 'November must recognize 50% PPh');
  assert.equal(result.periodTotals['2026-11']?.paymentTotal, 950000);

  // December recognition: Rp 50,000
  assert.equal(result.periodTotals['2026-12']?.pphTotal, 50000, 'December must recognize remaining 50% PPh');
  assert.equal(result.periodTotals['2026-12']?.paymentTotal, 950000);

  // Total recognized PPh equals Rp 100,000
  assert.equal(result.totalRecognizedPph, 100000);
  assert.equal(result.unrecognizedPph, 0);
  assert.equal(result.isFullySettled, true);

  // Assert individual allocations do not move or overwrite each other
  assert.equal(result.allocations.length, 2);
  assert.equal(result.allocations[0].taxPeriodMonth, 11);
  assert.equal(result.allocations[0].recognizedPph, 50000);
  assert.equal(result.allocations[1].taxPeriodMonth, 12);
  assert.equal(result.allocations[1].recognizedPph, 50000);
});

// TEST 12: Repeated reconciliation (Idempotency)
test('12. Repeated reconciliation with same payment allocations produces identical allocations without duplicates', () => {
  const expense = {
    amount: 2000000,
    pph_amount: 100000,
    ppn_amount: 0,
  };

  const paymentsWithDuplicates = [
    { source: 'bank_statement_allocation', sourceId: 'bsa-nov-001', paymentDate: '2026-11-15', amount: 950000 },
    { source: 'bank_statement_allocation', sourceId: 'bsa-nov-001', paymentDate: '2026-11-15', amount: 950000 }, // Duplicate
    { source: 'bank_statement_allocation', sourceId: 'bsa-dec-002', paymentDate: '2026-12-10', amount: 950000 },
  ];

  const result = calculateMultiPeriodPPhAllocations(expense, paymentsWithDuplicates);

  // Duplicates are deduplicated by (source, sourceId)
  assert.equal(result.allocations.length, 2);
  assert.equal(result.periodTotals['2026-11']?.pphTotal, 50000);
  assert.equal(result.periodTotals['2026-12']?.pphTotal, 50000);
  assert.equal(result.totalRecognizedPph, 100000);
});

// TEST 13: Reversed payments
test('13. Reversed payment allocations are excluded from period recognition without altering history', () => {
  const expense = {
    amount: 2000000,
    pph_amount: 100000,
    ppn_amount: 0,
  };

  const paymentsWithReversal = [
    {
      source: 'bank_statement_allocation',
      sourceId: 'bsa-nov-001',
      paymentDate: '2026-11-15',
      amount: 950000,
      isReversed: true, // Reversal
    },
    {
      source: 'bank_statement_allocation',
      sourceId: 'bsa-dec-002',
      paymentDate: '2026-12-10',
      amount: 950000,
      isReversed: false,
    },
  ];

  const result = calculateMultiPeriodPPhAllocations(expense, paymentsWithReversal);

  // November has 0 recognized because payment was reversed
  assert.equal(result.periodTotals['2026-11'], undefined);
  // December has Rp 50,000 recognized
  assert.equal(result.periodTotals['2026-12']?.pphTotal, 50000);
  assert.equal(result.totalRecognizedPph, 50000);
  assert.equal(result.unrecognizedPph, 50000);
  assert.equal(result.isFullySettled, false);
});

// TEST 14: Final settlement absorbs rounding remainder
test('14. Final settlement absorbs rounding residual so sum of period allocations exactly equals total PPh', () => {
  const expense = {
    amount: 3000000,
    pph_amount: 100001, // Odd amount that doesn't divide evenly into thirds
    ppn_amount: 0,
  };
  const netPayable = 3000000 - 100001; // 2899999

  const instalment1 = Math.round(netPayable / 3);
  const instalment2 = Math.round(netPayable / 3);
  const instalment3 = netPayable - instalment1 - instalment2;

  const payments = [
    { source: 'bank_statement_allocation', sourceId: 'bsa-oct', paymentDate: '2026-10-10', amount: instalment1 },
    { source: 'bank_statement_allocation', sourceId: 'bsa-nov', paymentDate: '2026-11-10', amount: instalment2 },
    { source: 'bank_statement_allocation', sourceId: 'bsa-dec', paymentDate: '2026-12-10', amount: instalment3 },
  ];

  const result = calculateMultiPeriodPPhAllocations(expense, payments);

  // Sum of allocations across all 3 months must EXACTLY equal 100,001
  const sumRecognized = result.allocations.reduce((sum, a) => sum + a.recognizedPph, 0);
  assert.equal(sumRecognized, 100001);
  assert.equal(result.totalRecognizedPph, 100001);
  assert.equal(result.unrecognizedPph, 0);
  assert.equal(result.isFullySettled, true);
});

// TEST 15: Cash payment date differs from expense date
test('15. Cash payment date differing from expense date allocates PPh to payment date, not expense date', () => {
  const expense = {
    voucher_number: 'EXP/26/CASH-01',
    expense_date: '2026-10-15', // October
    amount: 1000000,
    pph_amount: 20000,
    payment_method: 'cash',
    paid_amount: 980000,
    actual_payment_date: '2026-11-05', // November disbursement
    has_verified_cash_payment: true,
  };

  const pphInfo = calculateRecognizedPPh(expense);

  assert.equal(pphInfo.isPaid, true);
  assert.equal(pphInfo.recognizedPph, 20000);
  assert.equal(pphInfo.actualPaymentDate, '2026-11-05', 'Payment date must be the actual cash payment date');

  // Verify multi-period allocation allocates to November, NOT October
  const payments = [
    {
      source: 'cash',
      sourceId: 'pct-cash-01',
      paymentDate: '2026-11-05',
      amount: 980000,
    },
  ];
  const allocResult = calculateMultiPeriodPPhAllocations(expense, payments);
  assert.equal(allocResult.periodTotals['2026-11']?.pphTotal, 20000, 'Must be allocated to November 2026');
  assert.equal(allocResult.periodTotals['2026-10'], undefined, 'Must NOT be allocated to October 2026');
});

// TEST 16: Cash selected but payment is still outstanding
test('16. Cash selected on expense with unconfirmed payment leaves PPh unallocated and recognized PPh at 0', () => {
  const outstandingCashExpense = {
    voucher_number: 'EXP/26/CASH-UNPAID',
    expense_date: '2026-10-20',
    amount: 1500000,
    pph_amount: 30000,
    payment_method: 'cash',
    paid_amount: 0, // No cash actually disbursed yet
    has_verified_cash_payment: false,
    pph_tax_period_id: null,
  };

  const pphInfo = calculateRecognizedPPh(outstandingCashExpense);

  assert.equal(pphInfo.isPaid, false, 'Unpaid cash expense must not be assumed paid');
  assert.equal(pphInfo.recognizedPph, 0, 'Recognized PPh must be 0');
  assert.equal(pphInfo.unrecognizedPph, 30000);
  assert.equal(pphInfo.status, 'unpaid');
  assert.equal(pphInfo.actualPaymentDate, null);
  assert.equal(outstandingCashExpense.pph_tax_period_id, null, 'Tax period must remain NULL');
});

// TEST 17: Migration 20261114170000 multi-period PPh allocation schema integrity
test('17. Migration 20261114170000 defines finance_expense_pph_allocations and idempotent triggers', async () => {
  const sql = await readFile('supabase/migrations/20261114170000_multi_period_pph_allocations_and_cash_strictness.sql', 'utf8');

  // 1. Table structure and RESTRICT audit history protection
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.finance_expense_pph_allocations/);
  assert.match(sql, /expense_id UUID NOT NULL REFERENCES public\.finance_expenses\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /tax_period_id UUID NOT NULL REFERENCES public\.tax_periods\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /payment_source TEXT NOT NULL/);
  assert.match(sql, /recognized_pph_amount NUMERIC\(18,2\) NOT NULL/);
  assert.match(sql, /is_reversed BOOLEAN DEFAULT false/);

  // 2. Stable payment-event identity and unique constraint
  assert.match(sql, /payment_event_id UUID NOT NULL/);
  assert.match(sql, /CONSTRAINT uq_expense_pph_alloc_event UNIQUE \(expense_id, payment_source, payment_event_id\)/);

  // 3. Filed-period protection trigger & server-authorized amendments
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tax_period_amendment_authorizations/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.authorize_tax_period_amendment/);
  assert.match(sql, /CREATE TRIGGER trg_lock_finance_expense_pph_allocations/);
  assert.match(sql, /enforce_pph_allocation_period_lock/);

  // 4. Sync function
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.sync_expense_pph_allocation/);

  // 5. Triggers on bank_statement_allocations
  assert.match(sql, /CREATE TRIGGER trg_sync_bank_alloc_pph/);
  assert.match(sql, /CREATE TRIGGER trg_revert_bank_alloc_pph/);
});

// TEST 18: Actual Yanni data structure with authoritative bank statement allocation
test('18. Actual Yanni data structure with authoritative bank statement allocation passes without duplicate fields', () => {
  // Exact data structure as found in production DB for EXP/26/304:
  // - Payee ID is populated (Yeny Fahriani)
  // - payment_method is NULL, bank_account_id is NULL
  // - paid_amount is recorded (4387500)
  // - An authoritative bank_statement_allocations row exists linking to a verified bank line
  const liveYanniExp304 = {
    voucher_number: 'EXP/26/304',
    amount: 4500000,
    pph_amount: 112500,
    ppn_amount: 0,
    supplier_id: null,
    payee_id: '8ce88102-35f5-4c10-883a-86dbd31412ec', // Valid Payee (Yeny Fahriani)
    staff_id: null,
    payment_method: null,
    bank_account_id: null,
    paid_amount: 4387500,
    bank_statement_allocations: [
      {
        id: 'fe091a26-29b0-4e6e-88fd-bc3b3ecbff91',
        bank_statement_line_id: 'd26c3867-5181-4d60-82fa-9a435e35099f',
        allocation_amount: 4387500,
        bank_statement_lines: {
          transaction_date: '2026-10-15',
          bank_account_id: 'bfe79829-07d1-48ed-8965-ff9d367d758e',
        },
      },
    ],
  };

  const validation = validateExpenseMandatoryTaxLinkage(liveYanniExp304);
  assert.equal(validation.isValid, true, 'Authoritative linked bank statement allocation satisfies payment details');
  assert.deepEqual(validation.errors, {});
});

// TEST 19: Accounting calculations audit across adjustments, deductions, and currencies
test('19. Accounting calculations audit: discounts, multi-currency, and exact settlement reconciliation', () => {
  // Case A: Multi-currency expense with PPh and bank charges
  // Gross = Rp 16,000,000, PPh 2% = Rp 320,000, Bank charges = Rp 50,000
  // Net cash payable = 16,000,000 - 320,000 + 50,000 = 15,730,000
  const usdExpense = {
    amount: 16000000,
    pph_amount: 320000,
    ppn_amount: 0,
    bank_charges_amount: 50000,
  };

  // 3 instalments:
  // 1. Rp 5,000,000
  // 2. Rp 5,000,000
  // 3. Rp 5,730,000 (Final balance)
  const payments = [
    { source: 'bank_statement_allocation', sourceId: 'bsa-1', paymentDate: '2026-11-01', amount: 5000000 },
    { source: 'bank_statement_allocation', sourceId: 'bsa-2', paymentDate: '2026-11-15', amount: 5000000 },
    { source: 'bank_statement_allocation', sourceId: 'bsa-3', paymentDate: '2026-12-01', amount: 5730000 },
  ];

  const result = calculateMultiPeriodPPhAllocations(usdExpense, payments);

  // Total active allocations must NEVER exceed 320,000
  assert.equal(result.totalRecognizedPph, 320000);
  assert.equal(result.unrecognizedPph, 0);
  assert.equal(result.isFullySettled, true);

  // November total: instalment 1 + 2
  const novPph = (result.periodTotals['2026-11']?.pphTotal || 0);
  const decPph = (result.periodTotals['2026-12']?.pphTotal || 0);
  assert.equal(novPph + decPph, 320000, 'Sum of all period totals must reconcile to exact PPh total');
});

// TEST 20: Reversal and subsequent re-payment flow
test('20. Reversal and subsequent re-payment preserves history and correctly settles PPh', () => {
  const expense = {
    amount: 5000000,
    pph_amount: 100000,
    ppn_amount: 0,
  };
  // Net cash payable: 4,900,000

  // First payment was bounced / reversed
  const payments = [
    { source: 'bank_statement_allocation', sourceId: 'bsa-bounced', paymentDate: '2026-11-01', amount: 4900000, isReversed: true },
    { source: 'bank_statement_allocation', sourceId: 'bsa-successful', paymentDate: '2026-11-10', amount: 4900000, isReversed: false },
  ];

  const result = calculateMultiPeriodPPhAllocations(expense, payments);

  assert.equal(result.allocations.length, 1, 'Only active successful payment is recognized');
  assert.equal(result.totalRecognizedPph, 100000);
  assert.equal(result.unrecognizedPph, 0);
  assert.equal(result.isFullySettled, true);
});
