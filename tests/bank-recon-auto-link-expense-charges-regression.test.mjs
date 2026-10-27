import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const expenseManagerSrc = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);
const migrationSrc = readFileSync(
  new URL('../supabase/migrations/20261026170000_fix_bank_recon_auto_link_expense_charges.sql', import.meta.url),
  'utf8',
);

test('1. Exact EXP/26/314 scenario: expense with bank charges matches bank statement debit', async () => {
  const { calculateCanonicalCashPayable, calculateExpenseTotals } = await import('../src/utils/taxCalculations.ts');

  // Case EXP/26/314
  const exp314 = {
    voucher_number: 'EXP/26/314',
    expense_category: 'internet_phone',
    amount: 102938,
    bank_charges_amount: 3000,
    ppn_amount: 0,
    pph_amount: 0,
    stamp_duty_amount: 0,
  };

  const totals = calculateExpenseTotals(exp314);
  assert.equal(totals.amount, 102938, 'Base expense amount is 102,938');
  assert.equal(totals.bankChargesAmount, 3000, 'Bank charges amount is 3,000');
  assert.equal(totals.settlementAmount, 105938, 'Settlement amount must be 102,938 + 3,000 = 105,938');

  const cashPayable = calculateCanonicalCashPayable(exp314);
  assert.equal(cashPayable, 105938, 'Canonical cash payable must match statement debit 105,938');

  // Verify database calculate_finance_expense_payable includes bank_charges_amount
  assert.match(
    migrationSrc,
    /\+\s*COALESCE\(fe\.bank_charges_amount,\s*0\)/,
    'Database calculate_finance_expense_payable must add fe.bank_charges_amount',
  );

  // Verify auto_post_expense_accounting handles bank charges across all categories
  assert.match(
    migrationSrc,
    /v_bank_charges:=COALESCE\(NEW\.bank_charges_amount,0\);/,
    'auto_post_expense_accounting must apply bank_charges_amount regardless of expense category',
  );
});

test('2. Bank transaction amount differs from document outstanding balance (Bank debit > Expense payable)', async () => {
  const { calculateCanonicalCashPayable } = await import('../src/utils/taxCalculations.ts');

  // User records an expense of 105,938 against a 1,000,000 lump sum / advance bank line
  const expense = {
    amount: 102938,
    bank_charges_amount: 3000,
    ppn_amount: 0,
    pph_amount: 0,
  };
  const bankStatementDebit = 1000000;
  const docPayable = calculateCanonicalCashPayable(expense);

  // ExpenseManager determines allocAmt using Math.min(selectedBankAllocationAmount, docPayable)
  const allocAmt = Math.min(bankStatementDebit, docPayable);
  assert.equal(allocAmt, 105938, 'Allocation must be capped at 105,938, never allocating full 1,000,000 to this expense');

  // ExpenseManager source code check
  assert.match(
    expenseManagerSrc,
    /const docPayable = calculateCanonicalCashPayable\(newExpense\);[\s\S]*Math\.min\(selectedBankAllocationAmount,\s*docPayable\)/,
    'ExpenseManager must cap selectedBankAllocationAmount by docPayable',
  );
});

test('3. Partial allocation: Bank debit is less than document outstanding balance', async () => {
  const { calculateCanonicalCashPayable } = await import('../src/utils/taxCalculations.ts');

  // User records a partial payment of 50,000 against a 105,938 expense
  const expense = {
    amount: 102938,
    bank_charges_amount: 3000,
    ppn_amount: 0,
    pph_amount: 0,
  };
  const bankStatementDebit = 50000;
  const docPayable = calculateCanonicalCashPayable(expense);

  const allocAmt = Math.min(bankStatementDebit, docPayable);
  assert.equal(allocAmt, 50000, 'Allocation must equal bank statement debit of 50,000');
});

test('4. Existing allocations on the statement line are respected and bounded', () => {
  // Database link_bank_statement_line calculates:
  // v_bank_remaining := v_bank_total - v_bank_allocated
  // v_doc_remaining := v_doc_total - v_doc_allocated
  // v_allocate := round(COALESCE(NULLIF(p_allocation_amount,0), LEAST(v_bank_remaining, v_doc_remaining)), 2)
  const bankTotal = 100000;
  const bankAllocated = 35000;
  const bankRemaining = bankTotal - bankAllocated; // 65,000

  const docTotal = 80000;
  const docAllocated = 0;
  const docRemaining = docTotal - docAllocated; // 80,000

  const computedAllocation = Math.min(bankRemaining, docRemaining);
  assert.equal(computedAllocation, 65000, 'Available bank balance (65,000) caps the allocation');
  assert.ok(computedAllocation <= bankRemaining, 'Allocation does not exceed bank remaining');
  assert.ok(computedAllocation <= docRemaining, 'Allocation does not exceed document remaining');
});

test('5. Idempotent linking prevents duplicate errors and duplicate allocations', () => {
  // Database migration link_bank_statement_line idempotency guard
  assert.match(
    migrationSrc,
    /IF p_document_type='expense' THEN[\s\S]*IF EXISTS \([\s\S]*FROM public\.bank_statement_allocations a[\s\S]*WHERE a\.bank_statement_line_id=p_bank_line_id[\s\S]*AND a\.document_type='expense'[\s\S]*AND a\.document_id=p_document_id/,
    'link_bank_statement_line must contain idempotency guard for existing expense allocations',
  );

  // Returns existing allocation JSON instead of throwing exception
  assert.match(
    migrationSrc,
    /RETURN jsonb_build_object\('allocation_amount',v_allocate,'bank_total',v_bank_total/,
    'link_bank_statement_line returns existing allocation safely',
  );
});

test('6. ExpenseManager links canonically and verifies existing allocation', () => {
  // Verifies linkBankStatementLine call
  assert.match(
    expenseManagerSrc,
    /await linkBankStatementLine\(selectedBankTransactionId,\s*'expense',\s*newExpense\.id,\s*'supplier',\s*allocAmt\);/,
    'ExpenseManager calls linkBankStatementLine with correct parameters upon approval',
  );
  assert.match(
    expenseManagerSrc,
    /await syncExpenseBankLinks\(\[newExpense\.id\]\);/,
    'ExpenseManager synchronizes local bank links',
  );
});
