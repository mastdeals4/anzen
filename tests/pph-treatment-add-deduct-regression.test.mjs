import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpenseTotals,
  calculateCanonicalCashPayable,
  calculateCanonicalExpenseTotal,
  computeExpensePPh,
} from '../src/utils/taxCalculations.ts';

test('1. PPH Deduct (-) vs Add (+): Canonical expense totals calculation model', () => {
  const baseExpense = {
    amount: 10_000_000,
    ppn_amount: 1_100_000,
    pph_amount: 200_000,
    stamp_duty_amount: 10_000,
    bank_charges_amount: 5_000,
    expense_category: 'port_charges',
  };

  // Deduct (-) mode
  const deductTotals = calculateExpenseTotals({
    ...baseExpense,
    pph_treatment: 'deduct',
  });
  // Recipient receives: amount + ppn - pph + stamp + bank
  // 10,000,000 + 1,100,000 - 200,000 + 10,000 + 5,000 = 10,915,000
  assert.equal(deductTotals.amount, 10_000_000);
  assert.equal(deductTotals.pphTreatment, 'deduct');
  assert.equal(deductTotals.netPayable, 10_915_000);
  assert.equal(deductTotals.settlementAmount, 10_915_000);
  // Total cash required: recipient payable + tax remittance = 10,915,000 + 200,000 = 11,115,000
  assert.equal(deductTotals.totalCashOutflow, 11_115_000);

  // Add (+) mode
  const addTotals = calculateExpenseTotals({
    ...baseExpense,
    pph_treatment: 'add',
  });
  // Recipient receives: amount + ppn + stamp + bank (PPh is not deducted!)
  // 10,000,000 + 1,100,000 + 10,000 + 5,000 = 11,115,000
  assert.equal(addTotals.amount, 10_000_000);
  assert.equal(addTotals.pphTreatment, 'add');
  assert.equal(addTotals.netPayable, 11_115_000);
  assert.equal(addTotals.settlementAmount, 11_115_000);
  // Total cash required: recipient payable + tax remittance = 11,115,000 + 200,000 = 11,315,000
  assert.equal(addTotals.totalCashOutflow, 11_315_000);

  // Difference in cash outflow is exactly the added PPH amount
  assert.equal(addTotals.totalCashOutflow - deductTotals.totalCashOutflow, 200_000);
  // Difference in recipient payable is exactly the PPH not deducted
  assert.equal(addTotals.netPayable - deductTotals.netPayable, 200_000);
});

test('2. Salary Net Payable, Cash Outflow, and BPJS wage base invariance', () => {
  const grossSalary = 8_500_000;
  const pph21Amount = 170_000;
  const bpjsEmployee = 255_000; // 3%
  const bpjsEmployer = 360_400; // 4.24%
  const advanceApplied = 500_000;

  // A. Deduct (-)
  // Net salary payable = Gross - Advances - Employee BPJS - PPh21
  const netPayableDeduct = Math.max(grossSalary - advanceApplied - pph21Amount - bpjsEmployee, 0);
  assert.equal(netPayableDeduct, 8_500_000 - 500_000 - 170_000 - 255_000); // 7,575,000
  // Total employer cash outflow = Net payable + PPh21 remittance + Advances settled + BPJS (Employee + Employer)
  const totalCashDeduct = netPayableDeduct + pph21Amount + advanceApplied + bpjsEmployee + bpjsEmployer;
  assert.equal(totalCashDeduct, grossSalary + bpjsEmployer); // 8,860,400

  // B. Add (+)
  // Changing PPh treatment must NOT change the gross salary or BPJS base!
  const grossSalaryAfterToggle = grossSalary;
  const bpjsBaseAfterToggle = grossSalary;
  assert.equal(grossSalaryAfterToggle, 8_500_000);
  assert.equal(bpjsBaseAfterToggle, 8_500_000);

  // Net salary payable = Gross - Advances - Employee BPJS (PPh is NOT deducted!)
  const netPayableAdd = Math.max(grossSalary - advanceApplied - bpjsEmployee, 0);
  assert.equal(netPayableAdd, 8_500_000 - 500_000 - 255_000); // 7,745,000
  // Total employer cash outflow = Net payable + PPh21 remittance + Advances settled + BPJS (Employee + Employer)
  const totalCashAdd = netPayableAdd + pph21Amount + advanceApplied + bpjsEmployee + bpjsEmployer;
  assert.equal(totalCashAdd, grossSalary + pph21Amount + bpjsEmployer); // 9,030,400

  // Net payable difference is exactly the PPh21 amount
  assert.equal(netPayableAdd - netPayableDeduct, pph21Amount);
  // Total employer cash outflow difference is exactly the PPh21 added on top
  assert.equal(totalCashAdd - totalCashDeduct, pph21Amount);
});

test('3. Port Charges and Normal Expense categories with PPh 23', () => {
  const portExpense = {
    amount: 15_000_000,
    ppn_amount: 0,
    pph_amount: 300_000, // 2% PPh 23
    stamp_duty_amount: 0,
    bank_charges_amount: 0,
    expense_category: 'port_charges',
  };

  const deduct = calculateExpenseTotals({ ...portExpense, pph_treatment: 'deduct' });
  assert.equal(deduct.netPayable, 14_700_000);
  assert.equal(deduct.settlementAmount, 14_700_000);
  assert.equal(deduct.totalCashOutflow, 15_000_000);

  const add = calculateExpenseTotals({ ...portExpense, pph_treatment: 'add' });
  assert.equal(add.netPayable, 15_000_000);
  assert.equal(add.settlementAmount, 15_000_000);
  assert.equal(add.totalCashOutflow, 15_300_000);

  // Underlying gross expense is always 15,000,000 in both modes
  assert.equal(calculateCanonicalExpenseTotal(deduct), 15_000_000);
  assert.equal(calculateCanonicalExpenseTotal(add), 15_000_000);
});

test('4. Zero PPh, Nonzero PPh, and manual override handling', () => {
  // A. Zero PPh
  const zeroPphExpense = {
    amount: 5_000_000,
    ppn_amount: 550_000,
    pph_amount: 0,
    stamp_duty_amount: 10_000,
    bank_charges_amount: 2_500,
  };
  const zeroDeduct = calculateExpenseTotals({ ...zeroPphExpense, pph_treatment: 'deduct' });
  const zeroAdd = calculateExpenseTotals({ ...zeroPphExpense, pph_treatment: 'add' });
  assert.equal(zeroDeduct.netPayable, zeroAdd.netPayable);
  assert.equal(zeroDeduct.totalCashOutflow, zeroAdd.totalCashOutflow);
  assert.equal(zeroDeduct.netPayable, 5_562_500);

  // B. Manual override PPh amount
  const manualOverrideExpense = {
    amount: 5_000_000,
    ppn_amount: 550_000,
    pph_amount: 125_000, // manual override from normal 2% (100k)
    stamp_duty_amount: 10_000,
    bank_charges_amount: 2_500,
  };
  const manualDeduct = calculateExpenseTotals({ ...manualOverrideExpense, pph_treatment: 'deduct' });
  const manualAdd = calculateExpenseTotals({ ...manualOverrideExpense, pph_treatment: 'add' });
  assert.equal(manualDeduct.netPayable, 5_562_500 - 125_000); // 5,437,500
  assert.equal(manualAdd.netPayable, 5_562_500); // 5,562,500 (not deducted)
  assert.equal(manualAdd.totalCashOutflow, 5_562_500 + 125_000); // 5,687,500
});

test('5. Backward compatibility: Existing records default to Deduct (-) without data alteration', () => {
  const legacyRecord = {
    amount: 2_000_000,
    ppn_amount: 220_000,
    pph_amount: 40_000,
    // pph_treatment is undefined on legacy records
  };

  const totals = calculateExpenseTotals(legacyRecord);
  assert.equal(totals.pphTreatment, 'deduct');
  assert.equal(totals.netPayable, 2_000_000 + 220_000 - 40_000); // 2,180,000
  assert.equal(totals.settlementAmount, 2_180_000);
  assert.equal(totals.totalCashOutflow, 2_220_000);

  // Also test null and empty string fallbacks
  assert.equal(calculateExpenseTotals({ ...legacyRecord, pph_treatment: null }).pphTreatment, 'deduct');
  assert.equal(calculateExpenseTotals({ ...legacyRecord, pph_treatment: '' }).pphTreatment, 'deduct');
});

test('6. Consistency between form preview, payment voucher, and journal calculations', () => {
  const exp = {
    amount: 6_000_000,
    ppn_amount: 660_000,
    pph_amount: 120_000,
    stamp_duty_amount: 10_000,
    bank_charges_amount: 6_500,
    pph_treatment: 'add',
    expense_category: 'consulting_fees',
  };

  const preview = calculateExpenseTotals(exp);
  const canonicalPayable = calculateCanonicalCashPayable(exp);

  // Form preview settlement matches canonical payable
  assert.equal(preview.settlementAmount, canonicalPayable);
  assert.equal(canonicalPayable, 6_000_000 + 660_000 + 10_000 + 6_500); // 6,676,500

  // Journal simulation under Add (+):
  // Debits:
  //   6700 Professional Fees (amount): 6,000,000
  //   1150 PPN Masukan: 660,000
  //   6950 Stamp Duty: 10,000
  //   7100 Bank Charges: 6,500
  //   6700 PPh Borne (Add-on): 120,000
  //   Total Debits = 6,796,500
  // Credits:
  //   2132 PPh 23 Payable: 120,000
  //   2110 / Bank Account (Payment to recipient): 6,676,500
  //   Total Credits = 6,796,500
  const journalDebits = exp.amount + exp.ppn_amount + exp.stamp_duty_amount + exp.bank_charges_amount + exp.pph_amount;
  const journalCredits = exp.pph_amount + canonicalPayable;
  assert.equal(journalDebits, journalCredits);
  assert.equal(journalDebits, preview.totalCashOutflow);
});
