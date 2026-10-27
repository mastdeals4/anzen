import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getCategoryFieldRules } from '../src/components/finance/categoryFieldRules.ts';
import { calculateExpenseTotals, calculateCanonicalCashPayable } from '../src/utils/taxCalculations.ts';

const expenseManagerSrc = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);
const categoryRulesSrc = readFileSync(
  new URL('../src/components/finance/categoryFieldRules.ts', import.meta.url),
  'utf8',
);

test('1. categoryFieldRules enables bankCharges by default across all categories', () => {
  assert.match(categoryRulesSrc, /bankCharges:\s*'show'/, 'DEFAULT in categoryFieldRules must set bankCharges: show');
  
  const testCategories = [
    'internet_phone',
    'electricity',
    'water',
    'office_rent',
    'warehouse_rent',
    'salary',
    'import_broker',
    'professional_services',
    'marketing_advertising',
    'non_permanent_employee_fee',
    'office_admin',
    'other',
  ];

  for (const cat of testCategories) {
    const rules = getCategoryFieldRules(cat);
    assert.equal(rules.bankCharges, 'show', `Category ${cat} must have bankCharges: show`);
  }
});

test('2. New Expense form displays editable Bank Charges field and defaults to 0', () => {
  // Check initial state defaults to 0
  assert.match(
    expenseManagerSrc,
    /const \[formData, setFormData\] = useState\(\{[\s\S]*?bank_charges_amount:\s*0/,
    'Initial form state must default bank_charges_amount to 0',
  );

  // Check resetForm defaults to 0
  assert.match(
    expenseManagerSrc,
    /const resetForm = \(\) => \{[\s\S]*?bank_charges_amount:\s*0/,
    'resetForm must default bank_charges_amount to 0',
  );

  // Check UI renders the Bank Charges field (FloatingField or SapField wrapper)
  // with a MoneyInput bound to bank_charges_amount.
  assert.match(
    expenseManagerSrc,
    /<(?:FloatingField|SapField)[\s\S]*?label=\{`Bank Charges \(\$\{expenseFormCurrency\}\)`\}[\s\S]*?span=\{3\}[\s\S]*?>[\s\S]*?<MoneyInput[\s\S]*?name="bank_charges_amount"[\s\S]*?value=\{formData\.bank_charges_amount\}/,
    'Form must render editable Bank Charges field with MoneyInput',
  );
});

test('3. Edit Expense form loads saved bank_charges_amount and preserves value', () => {
  // Check handleEdit loads saved bank_charges_amount
  assert.match(
    expenseManagerSrc,
    /const handleEdit =[\s\S]*?bank_charges_amount:\s*expense\.bank_charges_amount \?\? 0/,
    'handleEdit must load expense.bank_charges_amount into formData',
  );

  // Check handleSubmit does not wipe out saved bank_charges_amount
  assert.match(
    expenseManagerSrc,
    /bank_charges_amount:\s*Number\(formData\.bank_charges_amount \?\? editingExpense\?\.bank_charges_amount \?\? 0\)/,
    'handleSubmit must persist bank_charges_amount without forcing to 0',
  );
  assert.doesNotMatch(
    expenseManagerSrc,
    /bank_charges_amount:\s*rules\.bankCharges === 'show'/,
    'handleSubmit must not gate bank_charges_amount on rules.bankCharges === show',
  );
});

test('4. Formula bar includes Bank Charges in net payable calculation', () => {
  assert.match(
    expenseManagerSrc,
    /\{ label: 'Bank Charges', value: bc, valueColor: 'text-gray-900', show: bc > 0 \}/,
    'Formula bar must include Bank Charges cell when bc > 0',
  );
  assert.match(
    expenseManagerSrc,
    /\(formData\.amount > 0 \|\| formData\.ppn_amount > 0 \|\| formData\.pph_amount > 0 \|\| formData\.stamp_duty_amount > 0 \|\| \(formData\.bank_charges_amount \|\| 0\) > 0\)/,
    'Formula bar must display when bank_charges_amount > 0',
  );
});

test('5. Verify calculation for known example EXP/26-26/103', () => {
  // Example EXP/26-26/103:
  // Invoice amount: Rp 365,000
  // PPN: Rp 40,150
  // Bank charges: Rp 3,000
  // Net payable: Rp 408,150
  // Actual bank settlement: Rp 408,150
  const exp103 = {
    amount: 365000,
    ppn_amount: 40150,
    pph_amount: 0,
    stamp_duty_amount: 0,
    bank_charges_amount: 3000,
    expense_category: 'internet_phone',
  };

  const totals = calculateExpenseTotals(exp103);
  assert.equal(totals.amount, 365000);
  assert.equal(totals.ppnAmount, 40150);
  assert.equal(totals.pphAmount, 0);
  assert.equal(totals.bankChargesAmount, 3000);
  assert.equal(totals.netPayable, 408150, 'Net Payable must be 365,000 + 40,150 + 3,000 = 408,150');
  assert.equal(totals.settlementAmount, 408150, 'Actual Bank Settlement must be 408,150');

  const cashPayable = calculateCanonicalCashPayable(exp103);
  assert.equal(cashPayable, 408150, 'Canonical cash payable must match 408,150');
});

test('6. Verify calculations with withholding tax, zero charges, and bank settlement', () => {
  // Case A: Invoice with PPN, PPh Withheld, and Bank Charges
  const withTax = calculateExpenseTotals({
    amount: 1000000,
    ppn_amount: 110000,
    pph_amount: 20000, // PPh 23 (2%)
    stamp_duty_amount: 10000,
    bank_charges_amount: 6500,
  });
  // Net Payable = 1,000,000 + 110,000 − 20,000 + 10,000 + 6,500 = 1,106,500
  assert.equal(withTax.netPayable, 1106500);
  assert.equal(withTax.settlementAmount, 1106500);

  // Case B: Zero bank charges
  const zeroCharges = calculateExpenseTotals({
    amount: 500000,
    ppn_amount: 55000,
    pph_amount: 0,
    stamp_duty_amount: 0,
    bank_charges_amount: 0,
  });
  assert.equal(zeroCharges.netPayable, 555000);
  assert.equal(zeroCharges.bankChargesAmount, 0);
  assert.equal(zeroCharges.settlementAmount, 555000);
});
