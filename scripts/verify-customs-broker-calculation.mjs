import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  brokerLineExpenseBase,
  brokerLineTotal,
  calculateBrokerExpenseTotals,
} from '../src/utils/taxCalculations.ts';

const supplierInvoiceLine = {
  type: 'other',
  description: 'Supplier invoice reference',
  amount: 569_430,
  invoice_amount_authoritative: true,
  dpp_amount: 470_250,
  ppn_amount: 56_430,
};

assert.equal(
  brokerLineTotal(supplierInvoiceLine),
  569_430,
  'Invoice Amount must be the line payable; DPP and PPN must not be added',
);
assert.equal(
  brokerLineExpenseBase(supplierInvoiceLine),
  513_000,
  'Recoverable PPN must be separated from expense without changing cash payable',
);

const totals = calculateBrokerExpenseTotals({
  amount: 4_750_000,
  dpp_amount: 4_750_000,
  ppn_amount: 0,
  pph_amount: 95_000,
  stamp_duty_amount: 0,
  broker_items: [
    supplierInvoiceLine,
    {
      type: 'other',
      description: 'Remaining reimbursement invoices',
      amount: 5_289_640,
      invoice_amount_authoritative: true,
      dpp_amount: 5_000_000,
      ppn_amount: 101_919,
    },
  ],
});

assert.equal(totals.reimbursementTotal, 5_859_070);
assert.equal(totals.recoverableInputPpn, 158_349);
assert.equal(totals.accountingExpenseTotal, 10_450_721);
assert.equal(totals.expenseTotal, 10_609_070);
assert.equal(totals.finalCashPayable, 10_514_070);

const withHeaderPpn = calculateBrokerExpenseTotals({
  amount: 4_750_000,
  ppn_amount: 100_000,
  pph_amount: 95_000,
  broker_items: totals.reimbursementTotal > 0 ? [{
    type: 'other',
    description: 'Gross reimbursement',
    amount: 5_859_070,
    invoice_amount_authoritative: true,
    dpp_amount: 5_700_721,
    ppn_amount: 158_349,
  }] : [],
});
assert.equal(
  withHeaderPpn.finalCashPayable,
  10_514_070,
  'Header PPN is recoverable tax metadata and must not increase cash payable',
);

assert.equal(
  brokerLineTotal({
    type: 'other',
    description: 'Historical row without Invoice Amount',
    amount: 0,
    dpp_amount: 470_250,
    ppn_amount: 56_430,
  }),
  526_680,
  'Historical empty-amount rows must retain their compatibility fallback',
);

assert.equal(
  brokerLineTotal({
    type: 'other',
    description: 'New or edited zero-amount line',
    amount: 0,
    dpp_amount: 470_250,
    ppn_amount: 56_430,
    invoice_amount_authoritative: true,
  }),
  0,
  'New or edited lines must use stored Invoice Amount even when it is zero',
);

const expenseManagerSource = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);
for (const previewColumn of [
  'Invoice Amount',
  'DPP',
  'PPN %',
  'PPN Amount',
  'Payable Amount',
]) {
  assert.ok(
    expenseManagerSource.includes(`>${previewColumn}</th>`),
    `Preview must retain the ${previewColumn} column`,
  );
}

console.log(JSON.stringify({
  status: 'passed',
  reimbursementTotal: totals.reimbursementTotal,
  recoverablePpn: totals.recoverableInputPpn,
  finalCashPayable: totals.finalCashPayable,
}, null, 2));
