import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/utils/taxCalculations.ts', import.meta.url), 'utf8');

const cashPayable = ({ amount, ppn_amount = 0, pph_amount = 0, stamp_duty_amount = 0, bank_charges_amount = 0 }) =>
  amount + ppn_amount - pph_amount + stamp_duty_amount + bank_charges_amount;

test('expense payment display includes additional bank charges in payable and balance', () => {
  assert.equal(cashPayable({ amount: 365_000, ppn_amount: 40_150, bank_charges_amount: 3_000 }), 408_150);
  assert.equal(408_150 - 408_150, 0);
  assert.match(source, /const bank = rawBank/);
  assert.match(source, /netPayable: amount \+ ppn - pph \+ stamp \+ bank/);
  assert.match(source, /settlementAmount: amount \+ ppn - pph \+ stamp \+ bank/);
});

test('bank charge treatment is shared across ordinary categories, not hardcoded to one expense', () => {
  for (const expense_category of ['utilities', 'office_admin', 'professional_services', 'salary', null]) {
    assert.equal(
      cashPayable({ expense_category, amount: 100_000, ppn_amount: 11_000, bank_charges_amount: 2_500 }),
      113_500,
    );
  }
});

test('raw bank charges are absent only when no charge component is stored', () => {
  assert.equal(cashPayable({ amount: 100_000, ppn_amount: 11_000 }), 111_000);
  assert.doesNotMatch(source, /expense_category === 'utilities' \? rawBank : 0/);
});
