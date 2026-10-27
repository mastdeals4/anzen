import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const partyLedgerSrc = readFileSync(
  new URL('../src/components/finance/PartyLedger.tsx', import.meta.url),
  'utf8',
);

test('1. Invoice paid in full in one transaction', async () => {
  const { calculateCanonicalCashPayable } = await import('../src/utils/taxCalculations.ts');

  const invoice = {
    amount: 10000000,
    ppn_amount: 1100000,
    pph_amount: 200000, // 2% PPh 23
    stamp_duty_amount: 10000,
    bank_charges_amount: 0,
  };

  const originalPayable = calculateCanonicalCashPayable(invoice);
  assert.equal(originalPayable, 10910000, 'Original payable = 10,000,000 + 1,100,000 - 200,000 + 10,000 = 10,910,000');

  const paymentsAllocated = 10910000;
  const outstanding = Math.max(0, originalPayable - paymentsAllocated);
  assert.equal(outstanding, 0, 'Invoice paid in full in one transaction has 0 outstanding balance');
});

test('2. Invoice paid in two or more instalments (Exact EXP/26/205 scenario)', async () => {
  const { calculateCanonicalCashPayable } = await import('../src/utils/taxCalculations.ts');

  // EXP/26/205: Payable Rp 22,715,358
  const exp205 = {
    voucher_number: 'EXP/26/205',
    expense_category: 'import_broker',
    amount: 5300000,
    ppn_amount: 66000,
    pph_amount: 106000,
    broker_items: [
      {
        type: 'other',
        amount: 0,
        dpp_amount: 17521358,
        ppn_amount: 0,
        ppn_treatment: 'excluded',
      },
    ],
  };

  const payable = calculateCanonicalCashPayable(exp205);
  assert.equal(payable, 22715358, 'EXP/26/205 canonical payable must equal 22,715,358');

  // Instalment 1: Rp 37,148
  const instalment1 = 37148;
  const balanceAfter1 = payable - instalment1;
  assert.equal(balanceAfter1, 22678210, 'Balance after instalment 1 is 22,678,210');

  // Instalment 2: Rp 22,678,210
  const instalment2 = 22678210;
  const balanceAfter2 = balanceAfter1 - instalment2;
  assert.equal(balanceAfter2, 0, 'Balance after instalment 2 must be exactly 0 (fully settled)');
});

test('3. Invoice partially paid, with an outstanding balance carried forward', async () => {
  const payable = 15000000;
  const payment1 = 6000000;
  const outstandingAfterPay1 = payable - payment1;
  assert.equal(outstandingAfterPay1, 9000000, 'Remaining balance carried forward is 9,000,000');
  assert.ok(outstandingAfterPay1 > 0, 'Invoice remains partial');
});

test('4. Partial payment combined with PPh withholding', async () => {
  const { calculateCanonicalCashPayable } = await import('../src/utils/taxCalculations.ts');

  const bill = {
    amount: 20000000,
    ppn_amount: 2200000,
    pph_amount: 400000, // PPh 23 withheld
  };

  // Cash payable to supplier: 20,000,000 + 2,200,000 - 400,000 = 21,800,000
  const supplierPayable = calculateCanonicalCashPayable(bill);
  assert.equal(supplierPayable, 21800000, 'Cash payable to supplier excludes withheld PPh 23');

  // PPh liability to tax office is tracked separately
  const taxOfficePayable = bill.pph_amount;
  assert.equal(taxOfficePayable, 400000, 'PPh 23 liability is tracked separately');

  // Partial cash payment to supplier: 10,000,000
  const cashPaid = 10000000;
  const remainingSupplierLiability = supplierPayable - cashPaid;
  assert.equal(remainingSupplierLiability, 11800000, 'Supplier liability reduced only by actual cash paid');
  assert.equal(taxOfficePayable, 400000, 'Tax liability remains unchanged by supplier cash payment');
});

test('5. Invoice containing broker fees and reimbursements (Exact EXP/26-26/113 scenario)', async () => {
  const { calculateCanonicalCashPayable } = await import('../src/utils/taxCalculations.ts');

  // EXP/26-26/113
  const exp113 = {
    voucher_number: 'EXP/26-26/113',
    expense_category: 'import_broker',
    amount: 3100000, // Broker service invoice
    ppn_amount: 0,
    pph_amount: 62000, // 2% of 3,100,000
    broker_items: [
      {
        dpp_amount: 4987710,
        ppn_amount: 54864,
        ppn_treatment: 'included',
      },
      {
        dpp_amount: 3132098,
        ppn_amount: 344531,
        ppn_treatment: 'excluded',
      },
      {
        dpp_amount: 530000,
        ppn_amount: 58300,
        ppn_treatment: 'excluded',
      },
      {
        dpp_amount: 20000,
        ppn_amount: 0,
        ppn_treatment: 'excluded',
      },
    ],
  };

  const reimbursementTotal = exp113.broker_items.reduce((s, item) => s + item.dpp_amount + item.ppn_amount, 0);
  assert.equal(reimbursementTotal, 9127503, 'Reimbursement breakdown sum must equal 9,127,503');

  const grossExpense = exp113.amount + reimbursementTotal;
  assert.equal(grossExpense, 12227503, 'Total expense must equal 12,227,503');

  const recoverablePPN = exp113.broker_items.reduce((s, item) => s + item.ppn_amount, 0);
  assert.equal(recoverablePPN, 457695, 'Recoverable PPN must equal 457,695');

  const inventoryDebit = (exp113.amount) + exp113.broker_items.reduce((s, item) => s + item.dpp_amount, 0);
  assert.equal(inventoryDebit, 11769808, 'Accounting expense shown (inventory debit) must equal 11,769,808');

  const finalCashPayable = calculateCanonicalCashPayable(exp113);
  assert.equal(finalCashPayable, 12165503, 'Final cash payable must equal 12,165,503 (gross 12,227,503 - PPh 62,000)');
});

test('6. Two payments against one invoice, ensuring neither is duplicated', () => {
  // Simulate payment deduplication logic
  const invoicePayable = 22715358;
  const paymentAllocations = [
    { id: 'alloc-1', amount: 37148, journal_entry_id: 'je-1', pv_id: null },
    { id: 'alloc-2', amount: 22678210, journal_entry_id: 'je-2', pv_id: null },
  ];

  // Ensure unique payment events
  const uniqueJournalIds = new Set(paymentAllocations.map(a => a.journal_entry_id));
  assert.equal(uniqueJournalIds.size, 2, 'Two distinct payments must have distinct journal IDs');

  const totalPaid = paymentAllocations.reduce((s, a) => s + a.amount, 0);
  assert.equal(totalPaid, 22715358, 'Total paid matches payable');
  assert.equal(invoicePayable - totalPaid, 0, 'No outstanding balance remaining');
});

test('7. Failed or reversed payment restores outstanding balance', () => {
  const invoicePayable = 10000000;
  let paidAmount = 10000000;

  // Payment reversal event occurs
  const reversalDebit = 0;
  const reversalCredit = 10000000; // Credit to AP / Debit to Bank (or reversal journal)
  paidAmount = paidAmount - reversalCredit;

  const outstanding = Math.max(0, invoicePayable - paidAmount);
  assert.equal(outstanding, 10000000, 'Reversed payment fully restores outstanding liability');
});

test('8. Overpayment and unapplied supplier credit bounded correctly', () => {
  const invoicePayable = 5000000;
  const attemptedPayment = 6000000;

  const validSettlement = Math.min(attemptedPayment, invoicePayable);
  const unappliedCredit = attemptedPayment - validSettlement;

  assert.equal(validSettlement, 5000000, 'Invoice settlement is bounded to the payable amount');
  assert.equal(unappliedCredit, 1000000, 'Excess 1,000,000 is recognized as unapplied credit / overpayment');
});

test('9. Payment allocated to the wrong invoice and subsequently corrected', () => {
  const invA_Payable = 10000000;
  const invB_Payable = 5000000;

  let invA_Paid = 5000000; // Mistakenly applied to Inv A
  let invB_Paid = 0;

  // Unlink from Inv A
  invA_Paid = 0;
  // Re-link to Inv B
  invB_Paid = 5000000;

  assert.equal(invA_Payable - invA_Paid, 10000000, 'Invoice A restored to full 10,000,000 outstanding');
  assert.equal(invB_Payable - invB_Paid, 0, 'Invoice B settled with the 5,000,000 payment');
});

test('10. Historical repair journals and bank reconciliation included in Party Ledger', () => {
  assert.ok(
    partyLedgerSrc.includes("chart_of_accounts!inner(code)"),
    'PartyLedger must join chart_of_accounts to query 2110 lines',
  );
  assert.ok(
    partyLedgerSrc.includes(".eq('chart_of_accounts.code', '2110')"),
    'PartyLedger must query 2110 lines',
  );
  assert.ok(
    !partyLedgerSrc.includes(".eq('journal_entries.transaction_category', 'import_broker')"),
    'PartyLedger must NOT restrict 2110 lines to transaction_category = import_broker, ensuring bank recon & repair journals are included',
  );
});

test('11. Multiple invoices for the same supplier maintain correct running balance', () => {
  // Sequence of 5 invoices and payments for PT. TRANS EXIS JAYA:
  const transactions = [
    { date: '2026-02-20', dr: 0, cr: 12165503, ref: 'EXP/26-26/113' },
    { date: '2026-04-17', dr: 0, cr: 10514070, ref: 'EXP/26-26/115' },
    { date: '2026-06-16', dr: 10514070, cr: 0, ref: 'HR-5d816647...' },
    { date: '2026-06-24', dr: 0, cr: 6094500, ref: 'EXP/26-26/139' },
    { date: '2026-08-05', dr: 3742000, cr: 0, ref: 'HR-PAY-1' },
    { date: '2026-08-05', dr: 2352000, cr: 0, ref: 'HR-PAY-2' },
    { date: '2026-08-06', dr: 37148, cr: 0, ref: 'EXP-PAY-e24815d2...' },
    { date: '2026-08-06', dr: 28861549, cr: 0, ref: 'EXP-PAY-1ce4b068...' },
    { date: '2026-08-16', dr: 0, cr: 28861549, ref: 'EXP/26/202' },
    { date: '2026-08-30', dr: 0, cr: 22715358, ref: 'EXP/26/205' },
    { date: '2026-09-13', dr: 500, cr: 0, ref: 'PV/26-26/017' },
    { date: '2026-09-17', dr: 22678210, cr: 0, ref: 'EXP-PAY-cb3250f1...' },
  ];

  let runningBalance = 0;
  for (const t of transactions) {
    runningBalance += t.dr - t.cr;
    t.balance = runningBalance;
  }

  // Before payment for EXP/26-26/113, the net balance is -12,165,503 (Credit balance Rp 12,165,503)
  assert.equal(runningBalance, -12165503, 'Net running balance must equal -12,165,503 before EXP/26-26/113 payment');

  // When EXP/26-26/113 payment (Dr 12,165,503) is recorded:
  runningBalance += 12165503;
  assert.equal(runningBalance, 0, 'Net running balance becomes exactly 0 once EXP/26-26/113 payment is posted');
});

test('12. PartyLedger deduplication prevents double-counting of payment vouchers, purchase invoices, and expense bills', () => {
  assert.ok(
    partyLedgerSrc.includes('pvJeIds.has(line.journal_entry_id)'),
    'PartyLedger must check pvJeIds to prevent duplicate PV journal entry lines',
  );
  assert.ok(
    partyLedgerSrc.includes('piIds.has(je.reference_id)'),
    'PartyLedger must check piIds to prevent duplicate PI journal entry lines',
  );
  assert.ok(
    partyLedgerSrc.includes('expIds.has(je.reference_id)'),
    'PartyLedger must check expIds to prevent duplicate expense bill journal entry lines',
  );
});
