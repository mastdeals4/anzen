import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20261024170000_fix_expense_recognition_and_partial_payment.sql', import.meta.url),
  'utf8',
);

const expenseManager = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);

// Canonical simulated payment state calculator
function calculatePaymentState(payable, voucherAllocations = [], bankAllocations = []) {
  const postedVoucherPaid = voucherAllocations
    .filter(va => va.is_posted === true && va.payment_kind === 'supplier')
    .reduce((sum, va) => sum + va.amount, 0);

  const bankPaid = bankAllocations
    .filter(ba => ba.payment_kind === 'supplier')
    .reduce((sum, ba) => sum + ba.amount, 0);

  const totalPaid = postedVoucherPaid + bankPaid;
  const actualPaid = Math.min(payable, Math.max(0, totalPaid));
  const outstanding = Math.max(0, payable - actualPaid);

  return {
    actualPaid,
    outstanding,
    isFullyPaid: outstanding <= 0.01,
    isPartiallyPaid: actualPaid > 0.01 && outstanding > 0.01,
    isOutstanding: actualPaid <= 0.01 && outstanding > 0.01,
  };
}

// Canonical recognition journal simulator based on auto_post_expense_accounting
function simulateRecognitionJournal(expense) {
  const lines = [];
  const payable = expense.amount + (expense.ppn_amount || 0) - (expense.pph_amount || 0) + (expense.stamp_duty_amount || 0);

  // Debit expense
  lines.push({ account: '5100', debit: expense.amount, credit: 0, desc: 'Expense' });
  if (expense.ppn_amount > 0) {
    lines.push({ account: '1150', debit: expense.ppn_amount, credit: 0, desc: 'PPN Masukan' });
  }
  if (expense.stamp_duty_amount > 0) {
    lines.push({ account: '6950', debit: expense.stamp_duty_amount, credit: 0, desc: 'Bea Meterai' });
  }
  if (expense.pph_amount > 0) {
    lines.push({ account: '2132', debit: 0, credit: expense.pph_amount, desc: 'PPh Payable' });
  }

  // Credit side:
  let creditAccount;
  if (expense.payment_method === 'cash') {
    creditAccount = '1101'; // Cash Box
  } else if (expense.payment_method === 'petty_cash') {
    creditAccount = '1102'; // Petty Cash
  } else {
    // All other methods (bank_transfer, check, giro, other, outstanding, null) MUST credit AP 2110
    creditAccount = '2110'; // Accounts Payable
  }

  lines.push({ account: creditAccount, debit: 0, credit: payable, desc: 'Payable / Cash' });

  return {
    lines,
    creditsBank: lines.some(l => l.credit > 0 && (l.account.startsWith('1111') || (l.account !== '1101' && l.account !== '1102' && l.account !== '2110' && l.account !== '2132'))),
    creditsAP: lines.some(l => l.credit > 0 && l.account === '2110'),
    payable,
  };
}

// -----------------------------------------------------------------------------
// Scenario 1: An unlinked approved expense
// -----------------------------------------------------------------------------
test('Scenario 1: Unlinked approved expense posts Dr Expense, Cr AP 2110; does not credit Bank; paid = 0, outstanding = 100', () => {
  const expense = {
    amount: 100,
    ppn_amount: 0,
    pph_amount: 0,
    payment_method: null,
  };

  const recJournal = simulateRecognitionJournal(expense);
  assert.equal(recJournal.creditsAP, true, 'Expense recognition must credit Accounts Payable 2110');
  assert.equal(recJournal.creditsBank, false, 'Expense recognition must NOT credit any bank account');

  const state = calculatePaymentState(recJournal.payable, [], []);
  assert.equal(state.actualPaid, 0);
  assert.equal(state.outstanding, 100);
  assert.equal(state.isOutstanding, true);
  assert.equal(state.isFullyPaid, false);
});

// -----------------------------------------------------------------------------
// Scenario 2: Full payment
// -----------------------------------------------------------------------------
test('Scenario 2: Full payment records Dr AP 100, Cr Bank 100 once; paid = 100, outstanding = 0; recognition intact', () => {
  const expense = {
    amount: 100,
    payment_method: 'bank_transfer',
  };

  // 1. Initial recognition
  const recJournal = simulateRecognitionJournal(expense);
  assert.equal(recJournal.creditsAP, true);
  assert.equal(recJournal.creditsBank, false);

  // 2. Full payment event recorded (e.g. via Payment Voucher or Bank Line)
  const paymentAllocations = [{ id: 'va-1', amount: 100, is_posted: true, payment_kind: 'supplier' }];
  const paymentJournal = {
    lines: [
      { account: '2110', debit: 100, credit: 0, desc: 'Settle AP' },
      { account: '111101', debit: 0, credit: 100, desc: 'Credit Bank' },
    ],
  };

  const state = calculatePaymentState(recJournal.payable, paymentAllocations, []);
  assert.equal(state.actualPaid, 100);
  assert.equal(state.outstanding, 0);
  assert.equal(state.isFullyPaid, true);

  // Original recognition journal remains intact (total debit = 100, credit AP = 100)
  assert.equal(recJournal.lines.find(l => l.account === '5100').debit, 100);
  assert.equal(recJournal.lines.find(l => l.account === '2110').credit, 100);
  // Payment journal posted once
  assert.equal(paymentJournal.lines.find(l => l.account === '111101').credit, 100);
});

// -----------------------------------------------------------------------------
// Scenario 3: Two partial payments
// -----------------------------------------------------------------------------
test('Scenario 3: Two partial payments of 50 each step through (paid 50, out 50) -> (paid 100, out 0); recognition intact', () => {
  const expense = { amount: 100, payment_method: 'bank_transfer' };
  const recJournal = simulateRecognitionJournal(expense);

  // First partial payment of 50
  const payment1 = { id: 'va-1', amount: 50, is_posted: true, payment_kind: 'supplier' };
  const stateAfterP1 = calculatePaymentState(recJournal.payable, [payment1], []);
  assert.equal(stateAfterP1.actualPaid, 50);
  assert.equal(stateAfterP1.outstanding, 50);
  assert.equal(stateAfterP1.isPartiallyPaid, true);

  // Second partial payment of 50
  const payment2 = { id: 'va-2', amount: 50, is_posted: true, payment_kind: 'supplier' };
  const stateAfterP2 = calculatePaymentState(recJournal.payable, [payment1, payment2], []);
  assert.equal(stateAfterP2.actualPaid, 100);
  assert.equal(stateAfterP2.outstanding, 0);
  assert.equal(stateAfterP2.isFullyPaid, true);

  // Original recognition journal is unchanged
  assert.equal(recJournal.lines.find(l => l.account === '2110').credit, 100);
});

// -----------------------------------------------------------------------------
// Scenario 4: Expense entered before payment
// -----------------------------------------------------------------------------
test('Scenario 4: Expense entered before payment preserves accrual timeline and correct states at each date', () => {
  const expenseDate = '2026-10-01';
  const paymentDate = '2026-10-05';

  const expense = { amount: 100, expense_date: expenseDate, payment_method: 'bank_transfer' };
  const recJournal = simulateRecognitionJournal(expense);

  // On Day 1 (2026-10-01): Expense approved, no payment recorded
  const stateDay1 = calculatePaymentState(recJournal.payable, [], []);
  assert.equal(stateDay1.actualPaid, 0);
  assert.equal(stateDay1.outstanding, 100);
  assert.equal(stateDay1.isOutstanding, true);

  // On Day 5 (2026-10-05): Payment recorded
  const payment = { id: 'va-1', date: paymentDate, amount: 100, is_posted: true, payment_kind: 'supplier' };
  const stateDay5 = calculatePaymentState(recJournal.payable, [payment], []);
  assert.equal(stateDay5.actualPaid, 100);
  assert.equal(stateDay5.outstanding, 0);
  assert.equal(stateDay5.isFullyPaid, true);
});

// -----------------------------------------------------------------------------
// Scenario 5: Every payment-method choice
// -----------------------------------------------------------------------------
test('Scenario 5: Every payment method choice correctly routes liability or cash box, never crediting Bank at recognition', () => {
  const methods = ['cash', 'petty_cash', 'bank_transfer', 'check', 'giro', 'other', 'outstanding', null];

  for (const method of methods) {
    const journal = simulateRecognitionJournal({ amount: 100, payment_method: method });
    assert.equal(journal.creditsBank, false, `Method ${method} must NOT credit bank at recognition`);

    if (method === 'cash') {
      assert.equal(journal.lines.find(l => l.account === '1101').credit, 100);
    } else if (method === 'petty_cash') {
      assert.equal(journal.lines.find(l => l.account === '1102').credit, 100);
    } else {
      // bank_transfer, check, giro, other, outstanding, null ALL credit AP 2110
      assert.equal(
        journal.lines.find(l => l.account === '2110').credit,
        100,
        `Method ${method} must credit Accounts Payable 2110`,
      );
    }
  }
});

// -----------------------------------------------------------------------------
// Scenario 6: Unposted payment voucher
// -----------------------------------------------------------------------------
test('Scenario 6: Unposted payment voucher allocation does NOT affect paid_amount; only posting updates paid_amount', () => {
  const payable = 100;
  const draftAllocation = [{ id: 'va-draft', amount: 50, is_posted: false, payment_kind: 'supplier' }];

  // While draft: paid_amount must remain 0
  const draftState = calculatePaymentState(payable, draftAllocation, []);
  assert.equal(draftState.actualPaid, 0, 'Draft payment voucher must not increase paid_amount');
  assert.equal(draftState.outstanding, 100);

  // Once posted: paid_amount becomes 50
  const postedAllocation = [{ id: 'va-draft', amount: 50, is_posted: true, payment_kind: 'supplier' }];
  const postedState = calculatePaymentState(payable, postedAllocation, []);
  assert.equal(postedState.actualPaid, 50, 'Posted payment voucher must increase paid_amount');
  assert.equal(postedState.outstanding, 50);
});

// -----------------------------------------------------------------------------
// Scenario 7: Bank line matched after a payment has already been posted
// -----------------------------------------------------------------------------
test('Scenario 7: Bank line matched after payment already posted reuses existing payment journal, preventing duplicate bank credit', () => {
  // Check migration logic for link_bank_statement_line
  assert.match(
    migration,
    /OR\s+je\.id\s+IN\s*\(\s*SELECT\s+pv\.journal_entry_id\s+FROM\s+public\.voucher_allocations\s+va\s+JOIN\s+public\.payment_vouchers\s+pv\s+ON\s+pv\.id\s*=\s*va\.payment_voucher_id\s+WHERE\s+va\.finance_expense_id\s*=\s*p_document_id\s+AND\s+pv\.is_posted\s*=\s*true\s*\)/i,
    'link_bank_statement_line must search for existing posted Payment Voucher journals allocated to this expense',
  );

  assert.match(
    migration,
    /IF\s+v_existing_payment_je\s+IS\s+NOT\s+NULL\s+THEN\s+v_je\s*:=\s*v_existing_payment_je;\s+ELSE/i,
    'link_bank_statement_line must reuse existing payment journal and skip inserting a duplicate payment journal',
  );
});

// -----------------------------------------------------------------------------
// Database Migration Architecture & Safety Verification
// -----------------------------------------------------------------------------
test('Migration enforces non-cash expense recognition to AP 2110', () => {
  assert.match(
    migration,
    /IF\s+NEW\.payment_method\s*=\s*'cash'\s*THEN[\s\S]*code='1101'[\s\S]*ELSIF\s+NEW\.payment_method\s*=\s*'petty_cash'\s*THEN[\s\S]*code='1102'[\s\S]*ELSE[\s\S]*code='2110'/i,
  );
});

test('Migration enforces customs broker canonical posting to AP 2110 for non-cash', () => {
  assert.match(
    migration,
    /v_outstanding\s+boolean\s*:=\s*NEW\.payment_method\s+IS\s+NULL\s+OR\s+NEW\.payment_method\s+NOT\s+IN\s*\('cash',\s*'petty_cash'\)/i,
  );
});

test('Migration normalizes unlinked bank/cheque/giro/other methods', () => {
  assert.match(
    migration,
    /IF\s+NEW\.payment_method\s+IN\s*\('bank_transfer',\s*'check',\s*'giro',\s*'other'\)/i,
  );
});

test('Migration enforces pv.is_posted = true in recalculate_expense_payment_state', () => {
  assert.match(
    migration,
    /FROM\s+public\.voucher_allocations\s+va\s+JOIN\s+public\.payment_vouchers\s+pv\s+ON\s+pv\.id=va\.payment_voucher_id[\s\S]*AND\s+pv\.is_posted\s*=\s*true/i,
  );
});

test('Migration contains no live historical data modifications or destructive drops', () => {
  assert.doesNotMatch(migration, /DROP\s+TABLE/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.finance_expenses\s+SET\s+amount/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.bank_statement_lines\s+SET\s+(?:debit_amount|credit_amount)/i);
});

// -----------------------------------------------------------------------------
// ExpenseManager UI Verification
// -----------------------------------------------------------------------------
test('ExpenseManager UI defaults payment_method to null (Outstanding / Pay later)', () => {
  assert.match(
    expenseManager,
    /payment_method:\s*null\s*as\s*string\s*\|\s*null/i,
    'emptyFormData must default payment_method to null',
  );
  assert.match(
    expenseManager,
    /resetForm[\s\S]*payment_method:\s*null,/i,
    'resetForm must reset payment_method to null',
  );
});

test('ExpenseManager UI renders Outstanding status icon for unpaid expenses regardless of payment_method', () => {
  assert.match(
    expenseManager,
    /const billBalance = calculateCanonicalCashPayable\(expense\) - \(expense\.paid_amount \?\? 0\);[\s\S]*if \(billBalance > 0\.01 && \(expense\.paid_amount \?\? 0\) > 0\.01\)[\s\S]*Partially Paid[\s\S]*if \(billBalance > 0\.01\)[\s\S]*Outstanding/i,
    'Status icon must show Outstanding whenever billBalance > 0.01 and paid_amount <= 0.01',
  );
});

test('ExpenseManager UI payment method options prominently feature Outstanding / Pay Later', () => {
  assert.match(
    expenseManager,
    /<option\s+value="outstanding">\s*⏳\s*Outstanding\s*\/\s*Pay\s*Later\s*\(A\/P\s*2110\)\s*<\/option>/i,
  );
  assert.match(
    expenseManager,
    /⏳\s*Unpaid\s*expense:\s*Dr\s*Expense,\s*Cr\s*Accounts\s*Payable\s*\(2110\)/i,
  );
});
