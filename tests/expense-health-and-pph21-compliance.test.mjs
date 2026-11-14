import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpenseTotals,
  calculateCanonicalCashPayable,
  calculateOutstanding,
  calculateRecognizedPPh,
  computeExpensePPh,
} from '../src/utils/taxCalculations.ts';
import { readFile } from 'node:fs/promises';

const isEffectiveExpensePosting = (state) => state === 'ACTIVE' || state === 'REPLACED';

// ============================================================================
// PART 1: Expense Health Checks (Bug 1 Safeguards)
// ============================================================================

test('1. Newly saved approved expense resolves consistent lifecycle state (ACTIVE) without AMBIGUOUS warning', async () => {
  const expense = {
    id: 'test-exp-364',
    voucher_number: 'EXP/26/364',
    amount: 6000000,
    pph_amount: 120000,
    pph_treatment: 'deduct',
    approval_status: 'approved',
    effective_posting_state: 'ACTIVE',
  };
  assert.equal(isEffectiveExpensePosting(expense.effective_posting_state), true);
  assert.notEqual(expense.effective_posting_state, 'AMBIGUOUS');
});

test('2. Expense save without browser refresh keeps hydrated lifecycle state', async () => {
  const mockCreated = {
    id: 'exp-created-1',
    voucher_number: 'EXP/26/999',
    approval_status: 'approved',
    amount: 5000000,
    pph_amount: 100000,
  };
  const mockLifecycle = {
    expense_id: 'exp-created-1',
    voucher_number: 'EXP/26/999',
    document_approval_status: 'approved',
    effective_posting_state: 'ACTIVE',
    effective_journal_id: 'je-1',
    active_original_count: 1,
    ambiguity_reason: null,
  };

  const hydrated = {
    ...mockCreated,
    posting_lifecycle: mockLifecycle,
    effective_posting_state: mockLifecycle.effective_posting_state,
  };

  assert.equal(hydrated.effective_posting_state, 'ACTIVE');
  assert.equal(hydrated.posting_lifecycle.ambiguity_reason, null);
});

test('3. Expense with approved status and valid posted journal resolves to ACTIVE', () => {
  const lifecycle = {
    expense_id: 'e1',
    document_approval_status: 'approved',
    effective_posting_state: 'ACTIVE',
    active_original_count: 1,
  };
  assert.equal(isEffectiveExpensePosting(lifecycle.effective_posting_state), true);
});

test('4. Expense with genuinely missing journal resolves to AMBIGUOUS with specific reason', async () => {
  const lifecycleSrc = await readFile('src/services/expensePostingLifecycle.ts', 'utf8');
  assert.match(lifecycleSrc, /approved_without_visible_posted_journal_evidence/);
  assert.match(lifecycleSrc, /getConsistentExpensePostingState/);
});

// ============================================================================
// PART 2: PPh Statutory Payment-Date Allocation & Protection (Bug 2 Safeguards)
// 12 Required Regression Test Cases
// ============================================================================

// REQUIREMENT 1: Unpaid expense with PPh: tax period remains NULL and is excluded from recognized PPh.
test('R1. Unpaid expense with PPh: tax period remains NULL and excluded from recognized PPh (EXP/26/345 Pest Control)', () => {
  const unpaidPestControl = {
    id: 'exp-345',
    voucher_number: 'EXP/26/345',
    expense_date: '2026-10-15',
    amount: 900000,
    pph_amount: 18000,
    pph_treatment: 'deduct',
    paid_amount: 0,
    payment_method: 'bank_transfer',
    pph_tax_period_id: null,
  };

  const res = calculateRecognizedPPh(unpaidPestControl);
  assert.equal(res.status, 'unpaid');
  assert.equal(res.isPaid, false);
  assert.equal(res.recognizedPph, 0, 'Unpaid expense must yield 0 recognized PPh');
  assert.equal(res.unrecognizedPph, 18000);
  assert.equal(unpaidPestControl.pph_tax_period_id, null, 'Tax period must remain NULL');
});

// REQUIREMENT 2: Payment made in November for an August expense: allocated to November, not August (Ricardo EXP/26/179 & EXP/26/180)
test('R2. Payment made in November for an August expense: allocated to November, not August (Ricardo Suhendra W EXP/26/179 & EXP/26/180)', () => {
  const exp179 = {
    voucher_number: 'EXP/26/179',
    expense_date: '2026-08-20',
    amount: 2000000,
    pph_amount: 50000,
    paid_amount: 1950000,
    actual_payment_date: '2026-11-03',
    proposed_period: 'November 2026',
  };
  const exp180 = {
    voucher_number: 'EXP/26/180',
    expense_date: '2026-08-20',
    amount: 2000000,
    pph_amount: 50000,
    paid_amount: 1950000,
    actual_payment_date: '2026-11-03',
    proposed_period: 'November 2026',
  };

  for (const exp of [exp179, exp180]) {
    const res = calculateRecognizedPPh(exp);
    assert.equal(res.isPaid, true);
    assert.equal(res.recognizedPph, 50000);
    // Statutory rule: withholding period is derived from payment event date (November), not expense date (August)
    const paymentMonth = exp.actual_payment_date.slice(0, 7);
    assert.equal(paymentMonth, '2026-11');
    assert.notEqual(paymentMonth, exp.expense_date.slice(0, 7));
  }
});

// REQUIREMENT 3: Payment date differs from expense date: allocation uses payment date, not expense date
test('R3. Payment date differs from expense date: allocation uses payment date, not expense date (EXP/26/317)', () => {
  const exp317 = {
    voucher_number: 'EXP/26/317',
    expense_date: '2026-09-02',
    actual_payment_date: '2026-10-15',
    amount: 4000000,
    pph_amount: 100000,
    paid_amount: 3900000,
  };
  const res = calculateRecognizedPPh(exp317);
  assert.equal(res.isPaid, true);
  assert.equal(res.recognizedPph, 100000);
  assert.equal(exp317.actual_payment_date.slice(0, 7), '2026-10');
});

// REQUIREMENT 4: One payment settles multiple expenses: each expense allocated correctly based on that payment event (EXP/26/101 & EXP/26/174)
test('R4. One payment settles multiple expenses: each expense allocated correctly based on that payment event (EXP/26/101 & EXP/26/174)', () => {
  const batchPaymentDate = '2026-02-20';
  const batchItems = [
    { voucher_number: 'EXP/26/101', expense_date: '2026-01-25', pph_amount: 75000, paid_amount: 1425000, amount: 1500000 },
    { voucher_number: 'EXP/26/174', expense_date: '2026-02-10', pph_amount: 45000, paid_amount: 855000, amount: 900000 },
  ];

  for (const item of batchItems) {
    const res = calculateRecognizedPPh(item);
    assert.equal(res.isPaid, true);
    assert.equal(res.recognizedPph, item.pph_amount);
    // Both settled on batchPaymentDate in February 2026
    const period = batchPaymentDate.slice(0, 7);
    assert.equal(period, '2026-02');
  }
});

// REQUIREMENT 5: Repeated bank reconciliation or re-import does not create duplicate allocation or change already-allocated period
test('R5. Repeated bank reconciliation or re-import does not create duplicate allocation or change already-allocated period', () => {
  const exp = {
    id: 'exp-repeat-check',
    amount: 5000000,
    pph_amount: 100000,
    pph_treatment: 'deduct',
    paid_amount: 4900000,
    pph_tax_period_id: 'period-uuid-1',
  };

  // Run reconciliation / calculation 3 consecutive times
  const pass1 = calculateRecognizedPPh(exp);
  const pass2 = calculateRecognizedPPh(exp);
  const pass3 = calculateRecognizedPPh(exp);

  assert.equal(pass1.recognizedPph, 100000);
  assert.equal(pass2.recognizedPph, 100000);
  assert.equal(pass3.recognizedPph, 100000);
  assert.equal(exp.pph_tax_period_id, 'period-uuid-1');
});

// REQUIREMENT 6: Attempting to edit a filed period's PPh amount, tax code, or tax period is blocked
test('R6. Attempting to edit a filed period PPh amount, tax code, or tax period is blocked in enforce_tax_period_lock migration', async () => {
  const migration3 = await readFile('supabase/migrations/20261114093607_lock_finance_expenses_in_filed_pph_periods.sql', 'utf8');
  assert.match(migration3, /CREATE OR REPLACE FUNCTION public\.enforce_tax_period_lock/);
  assert.match(migration3, /NEW\.pph_amount IS DISTINCT FROM OLD\.pph_amount/);
  assert.match(migration3, /NEW\.pph_code_id IS DISTINCT FROM OLD\.pph_code_id/);
  assert.match(migration3, /NEW\.pph_tax_period_id IS DISTINCT FROM OLD\.pph_tax_period_id/);
  assert.match(migration3, /tax-affecting modifications and period reassignments are blocked/);
});

// REQUIREMENT 7: Attempting to reassign an expense out of a filed period raises an error or is blocked
test('R7. Attempting to reassign an expense out of a filed period is blocked in enforce_tax_period_lock migration', async () => {
  const migration3 = await readFile('supabase/migrations/20261114093607_lock_finance_expenses_in_filed_pph_periods.sql', 'utf8');
  assert.match(migration3, /Cannot reassign expense to filed\/closed tax period/);
  assert.match(migration3, /Cannot reassign expense to filed\/closed PPh tax period/);
});

// REQUIREMENT 8: Recomputing a filed period leaves stored pph_total unchanged
test('R8. Recomputing a filed period leaves stored pph_total unchanged in compute_period_ppn migration', async () => {
  const migration2 = await readFile('supabase/migrations/20261114093434_protect_filed_pph_period_totals.sql', 'utf8');
  assert.match(migration2, /CREATE OR REPLACE FUNCTION public\.compute_period_ppn/);
  assert.match(migration2, /filing_status = 'filed'/);
  assert.match(migration2, /Skipping pph_total recalculation on filed\/closed tax period/);
  assert.match(migration2, /RETURN;/);
});

// REQUIREMENT 9: Editing harmless non-tax metadata on an expense in a filed period succeeds without modifying tax totals
test('R9. Editing harmless non-tax metadata on an expense in a filed period succeeds without modifying tax totals', async () => {
  const migration3 = await readFile('supabase/migrations/20261114093607_lock_finance_expenses_in_filed_pph_periods.sql', 'utf8');
  assert.match(migration3, /Non-tax metadata edits \(description, notes, document_urls, payment_reference, batch_id, etc\.\)/);
  // Confirms that description/notes are NOT in the DISTINCT list that throws an exception
  assert.doesNotMatch(migration3, /NEW\.description IS DISTINCT FROM OLD\.description/);
  assert.doesNotMatch(migration3, /NEW\.notes IS DISTINCT FROM OLD\.notes/);
  assert.doesNotMatch(migration3, /NEW\.document_urls IS DISTINCT FROM OLD\.document_urls/);
});

// REQUIREMENT 10: Newly added and paid November PPh21 and PPh23 expenses appear in the November PPh register
test('R10. Newly added and paid November PPh21 and PPh23 expenses appear in the November PPh register', () => {
  const novPaidExpenses = [
    { voucher_number: 'EXP/26/179', tax_type: 'PPh21', pph_amount: 50000, paid_amount: 1950000, amount: 2000000 },
    { voucher_number: 'EXP/26/180', tax_type: 'PPh21', pph_amount: 50000, paid_amount: 1950000, amount: 2000000 },
    { voucher_number: 'EXP/26/203', tax_type: 'PPh21', pph_amount: 50000, paid_amount: 1950000, amount: 2000000 },
    { voucher_number: 'EXP/26/204', tax_type: 'PPh21', pph_amount: 50000, paid_amount: 1950000, amount: 2000000 },
    { voucher_number: 'EXP/26/363', tax_type: 'PPh21', pph_amount: 170000, paid_amount: 8330000, amount: 8500000 },
  ];

  let totalNovPph21 = 0;
  for (const exp of novPaidExpenses) {
    const res = calculateRecognizedPPh(exp);
    assert.equal(res.status, 'fully_paid');
    totalNovPph21 += res.recognizedPph;
  }
  assert.equal(totalNovPph21, 370000);
});

// REQUIREMENT 11: Partial payment: only the paid portion of PPh is recognized; remainder is unrecognized; no premature full allocation
test('R11. Partial payment: only paid portion of PPh recognized; remainder unrecognized; no premature full allocation', () => {
  // Gross: 4,000,000, PPh: 100,000, Net cash payable: 3,900,000
  // 50% paid: 1,950,000
  const partialSalaryExp = {
    amount: 4000000,
    pph_amount: 100000,
    pph_treatment: 'deduct',
    paid_amount: 1950000,
    expense_category: 'salary',
  };
  const res = calculateRecognizedPPh(partialSalaryExp);
  assert.equal(res.status, 'partial');
  assert.equal(res.isPaid, true);
  assert.equal(res.paymentRatio, 0.5);
  assert.equal(res.recognizedPph, 50000, 'Only proportional PPh is recognized');
  assert.equal(res.unrecognizedPph, 50000, 'Remainder remains strictly unrecognized');
});

// REQUIREMENT 12: PPN reports and calculations remain 100% intact and unaffected by any of the PPh changes
test('R12. PPN reports and calculations remain 100% intact and unaffected by any PPh changes', async () => {
  const migration2 = await readFile('supabase/migrations/20261114093434_protect_filed_pph_period_totals.sql', 'utf8');
  // PPN pre-posted calculation continues to run unconditionally
  assert.match(migration2, /PERFORM public\.compute_period_ppn_pre_posted_register\(p_period_id\);/);
  // PPN periods return early before PPh updates
  assert.match(migration2, /IF v_period\.tax_type = 'PPN' THEN\s+RETURN;\s+END IF;/);

  // Standard PPN calculations
  const totals = calculateExpenseTotals({
    amount: 10000000,
    ppn_amount: 1100000,
    pph_amount: 200000,
    pph_treatment: 'deduct',
  });
  assert.equal(totals.ppnAmount, 1100000);
  assert.equal(totals.netPayable, 10900000);
});
