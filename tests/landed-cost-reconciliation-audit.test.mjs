import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCapitalizableLandedCostCategory,
  calculateExpenseLandedCostAmount,
  calculateContainerLandedCostPool,
  CAPITALIZABLE_LANDED_COST_CATEGORIES,
} from '../src/utils/landedCost.ts';

test('1. Capitalizable Categories Whitelist: Matches PostgreSQL authoritative rules', () => {
  // Capitalizable landed costs (exact 13 categories accepted by public.is_capitalizable_landed_cost_category)
  assert.equal(isCapitalizableLandedCostCategory('import_broker'), true);
  assert.equal(isCapitalizableLandedCostCategory('loading_import'), true);
  assert.equal(isCapitalizableLandedCostCategory('pib_import'), true);
  assert.equal(isCapitalizableLandedCostCategory('freight_import'), true);
  assert.equal(isCapitalizableLandedCostCategory('freight'), true);
  assert.equal(isCapitalizableLandedCostCategory('clearing_forwarding'), true);
  assert.equal(isCapitalizableLandedCostCategory('port_charges'), true);
  assert.equal(isCapitalizableLandedCostCategory('container_handling'), true);
  assert.equal(isCapitalizableLandedCostCategory('transport_import'), true);
  assert.equal(isCapitalizableLandedCostCategory('duty_customs'), true);
  assert.equal(isCapitalizableLandedCostCategory('duty'), true);
  assert.equal(isCapitalizableLandedCostCategory('duty_import'), true);
  assert.equal(isCapitalizableLandedCostCategory('other_import'), true);

  // Non-capitalizable / operational categories strictly excluded
  assert.equal(isCapitalizableLandedCostCategory('freight_charges'), false, 'freight_charges is rejected by PostgreSQL whitelist');
  assert.equal(isCapitalizableLandedCostCategory('transportation'), false, 'transportation is rejected by PostgreSQL whitelist');
  assert.equal(isCapitalizableLandedCostCategory('other_import_costs'), false, 'other_import_costs is rejected by PostgreSQL whitelist');
  assert.equal(isCapitalizableLandedCostCategory('bpom_ski_fees'), false, 'BPOM/SKI is operational P&L 5410');
  assert.equal(isCapitalizableLandedCostCategory('ppn_import'), false, 'PPN is recoverable asset 1150');
  assert.equal(isCapitalizableLandedCostCategory('pph_import'), false, 'PPh 22 is prepaid tax asset 1155');
  assert.equal(isCapitalizableLandedCostCategory('staff_welfare'), false, 'Staff welfare is operational expense');
  assert.equal(isCapitalizableLandedCostCategory('office'), false, 'Office is operational expense');
  assert.equal(isCapitalizableLandedCostCategory('utilities'), false, 'Utilities is operational expense');
});

test('2. Exact Container Reconciliation: Proves Rp 66,658,805 pool and explains Rp 250,000 difference', () => {
  // Realistic mock of container E0000085/2627 - Jul26 MIx
  const linkedExpenses = [
    {
      id: 'exp-broker',
      expense_category: 'import_broker',
      amount: 3300000,
      ppn_amount: 0,
      stamp_duty_amount: 0,
      broker_items: [
        { amount: 18254727, ppn_amount: 0, invoice_amount_authoritative: true },
        { amount: 554220, ppn_amount: 0, invoice_amount_authoritative: true },
        { amount: 6077102, ppn_amount: 601244, invoice_amount_authoritative: true },
        { amount: 721500, ppn_amount: 71500, invoice_amount_authoritative: true },
        { amount: 20000, ppn_amount: 0, invoice_amount_authoritative: true },
      ],
      include_in_landed_cost: true,
    },
    {
      id: 'exp-load-1',
      expense_category: 'loading_import',
      amount: 200000,
      include_in_landed_cost: true,
    },
    {
      id: 'exp-load-2',
      expense_category: 'loading_import',
      amount: 900000,
      include_in_landed_cost: true,
    },
    {
      id: 'exp-pib',
      expense_category: 'pib_import',
      amount: 142196038,
      pib_bm_amount: 37079000,
      pib_ppn_amount: 85650988,
      pib_pph_amount: 19466050,
      include_in_landed_cost: true,
    },
    // 5 BPOM/SKI regulatory fees (Account 5410, Rp 50,000 each = Rp 250,000)
    { id: 'exp-ski-1', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
    { id: 'exp-ski-2', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
    { id: 'exp-ski-3', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
    { id: 'exp-ski-4', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
    { id: 'exp-ski-5', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
  ];

  const linkedPettyCash = [
    { id: 'pc-1', expense_category: 'loading_import', amount: 100000, include_in_landed_cost: true },
    { id: 'pc-2', expense_category: 'loading_import', amount: 125000, include_in_landed_cost: true },
    { id: 'pc-welfare', expense_category: 'staff_welfare', amount: 482000, include_in_landed_cost: true },
  ];

  const breakdown = calculateContainerLandedCostPool({
    linkedExpenses,
    linkedPettyCash,
    otherImportCosts: 0,
  });

  // Verify broker net base
  // 3,300,000 + 18,254,727 + 554,220 + (6,077,102 - 601,244) + (721,500 - 71,500) + 20,000 = 28,254,805
  const brokerAmount = calculateExpenseLandedCostAmount(linkedExpenses[0]);
  assert.equal(brokerAmount.amount, 28254805);

  // Selected Capitalizable Linked Costs:
  // Expenses: 28,254,805 (broker) + 200,000 + 900,000 = 29,354,805
  assert.equal(breakdown.selectedLandedExpensesTotal, 29354805);

  // Petty Cash: 100,000 + 125,000 = 225,000 (staff_welfare 482,000 is excluded)
  assert.equal(breakdown.selectedLandedPettyCashTotal, 225000);

  // Selected Landed Linked Total = 29,354,805 + 225,000 = 29,579,805
  assert.equal(breakdown.selectedLandedLinkedTotal, 29579805);

  // Import Duty (BM) = 37,079,000
  assert.equal(breakdown.pibDutyTotal, 37079000);

  // Other Import Costs = 0
  assert.equal(breakdown.otherImportCosts, 0);

  // Total Landed-Cost Pool = 29,579,805 + 37,079,000 = 66,658,805
  assert.equal(breakdown.containerLandedCostPool, 66658805);

  // Excluded PPN & PPh22
  assert.equal(breakdown.pibPpnTotal, 85650988);
  assert.equal(breakdown.pibPphTotal, 19466050);

  // Excluded Operational Expenses (5 x 50,000 BPOM + 482,000 staff welfare) = 732,000
  assert.equal(breakdown.excludedOperationalExpensesTotal, 732000);

  // The 5 BPOM fees alone total exactly Rp 250,000:
  const bpomOnly = linkedExpenses
    .filter((e) => e.expense_category === 'bpom_ski_fees')
    .reduce((s, e) => s + e.amount, 0);
  assert.equal(bpomOnly, 250000);

  // Prove the exact arithmetic identity:
  // (Old unvalidated client sum: 29,829,805) - (BPOM excluded: 250,000) = (Authoritative capitalized: 29,579,805)
  assert.equal(29829805 - bpomOnly, breakdown.selectedLandedLinkedTotal);
  assert.equal(breakdown.selectedLandedLinkedTotal + breakdown.pibDutyTotal, 66658805);
});

test('3. Dynamic Checkbox Toggling: Immediately recalculates pool', () => {
  const linkedExpenses = [
    { id: 'exp-1', expense_category: 'loading_import', amount: 1000000, include_in_landed_cost: true },
    { id: 'exp-2', expense_category: 'loading_import', amount: 500000, include_in_landed_cost: true },
    { id: 'exp-pib', expense_category: 'pib_import', amount: 10000000, pib_bm_amount: 2000000, include_in_landed_cost: true },
  ];

  // All included: 1,000,000 + 500,000 + 2,000,000 = 3,500,000
  let res = calculateContainerLandedCostPool({
    linkedExpenses,
    linkedPettyCash: [],
    inclusionMap: { 'exp-1': true, 'exp-2': true, 'exp-pib': true },
    otherImportCosts: 150000,
  });
  assert.equal(res.containerLandedCostPool, 3650000);

  // Deselect exp-2 (500,000): pool becomes 3,150,000
  res = calculateContainerLandedCostPool({
    linkedExpenses,
    linkedPettyCash: [],
    inclusionMap: { 'exp-1': true, 'exp-2': false, 'exp-pib': true },
    otherImportCosts: 150000,
  });
  assert.equal(res.selectedLandedLinkedTotal, 1000000);
  assert.equal(res.containerLandedCostPool, 3150000);

  // Deselect exp-1 (1,000,000): pool becomes 2,150,000
  res = calculateContainerLandedCostPool({
    linkedExpenses,
    linkedPettyCash: [],
    inclusionMap: { 'exp-1': false, 'exp-2': false, 'exp-pib': true },
    otherImportCosts: 150000,
  });
  assert.equal(res.selectedLandedLinkedTotal, 0);
  assert.equal(res.containerLandedCostPool, 2150000);
});

test('4. Currency & Rounding Precision: Indonesian Rupiah rounding is consistent', () => {
  const linkedExpenses = [
    { id: 'exp-1', expense_category: 'freight_import', amount: 1234567.89, include_in_landed_cost: true },
  ];
  const res = calculateContainerLandedCostPool({
    linkedExpenses,
    linkedPettyCash: [],
    inclusionMap: { 'exp-1': true },
    otherImportCosts: 987654.32,
  });
  assert.equal(res.selectedLandedLinkedTotal, 1234567.89);
  assert.equal(res.otherImportCosts, 987654.32);
  assert.equal(res.containerLandedCostPool, 2222222.21);
});

test('5. Duplicate References & Repeated Transactions: Distinguishes distinct items with identical descriptions', () => {
  const linkedExpenses = [
    {
      id: 'exp-ski-1',
      voucher_number: 'EXP/26-26/061',
      description: 'Registration fee BPOM',
      expense_category: 'bpom_ski_fees',
      amount: 50000,
      include_in_landed_cost: true,
    },
    {
      id: 'exp-ski-2',
      voucher_number: 'EXP/26-26/062',
      description: 'Registration fee BPOM',
      expense_category: 'bpom_ski_fees',
      amount: 50000,
      include_in_landed_cost: true,
    },
    {
      id: 'exp-load-1',
      voucher_number: 'EXP/26/183',
      description: 'Coolie charges',
      expense_category: 'loading_import',
      amount: 200000,
      include_in_landed_cost: true,
    },
    {
      id: 'exp-load-2',
      voucher_number: 'EXP/26/185',
      description: 'Coolie charges',
      expense_category: 'loading_import',
      amount: 900000,
      include_in_landed_cost: true,
    },
  ];

  const linkedPettyCash = [
    {
      id: 'pc-1',
      transaction_number: 'PC-202607-043',
      description: 'Coolie charges',
      expense_category: 'loading_import',
      amount: 125000,
      include_in_landed_cost: true,
    },
    {
      id: 'pc-2',
      transaction_number: 'PC-202608-010',
      description: 'Coolie charges',
      expense_category: 'loading_import',
      amount: 100000,
      include_in_landed_cost: true,
    },
  ];

  // Each distinct ID is tracked independently
  const res = calculateContainerLandedCostPool({
    linkedExpenses,
    linkedPettyCash,
    inclusionMap: {
      'exp-load-1': true,
      'exp-load-2': false, // Deselect one coolie expense
      'pc-1': true,
      'pc-2': true,
    },
    otherImportCosts: 0,
  });

  // Only exp-load-1 (200k) + pc-1 (125k) + pc-2 (100k) = 425k
  assert.equal(res.selectedLandedLinkedTotal, 425000);
  assert.equal(res.containerLandedCostPool, 425000);
  // Both BPOM items excluded from pool
  assert.equal(res.excludedOperationalExpensesTotal, 100000);
});

test('6. Tax Treatment Verification: Bea Masuk included in inventory pool, PPN 1150 & PPh 1155 strictly excluded', () => {
  const linkedExpenses = [
    {
      id: 'exp-pib',
      expense_category: 'pib_import',
      amount: 142196038, // Total paid to customs billing
      pib_bm_amount: 37079000, // Bea Masuk -> Inventory 1130
      pib_ppn_amount: 85650988, // PPN Masukan -> Asset 1150
      pib_pph_amount: 19466050, // PPh 22 Impor -> Asset 1155
      include_in_landed_cost: true,
    },
  ];

  const res = calculateContainerLandedCostPool({
    linkedExpenses,
    linkedPettyCash: [],
    inclusionMap: { 'exp-pib': true },
    otherImportCosts: 0,
  });

  assert.equal(res.pibDutyTotal, 37079000);
  assert.equal(res.pibPpnTotal, 85650988);
  assert.equal(res.pibPphTotal, 19466050);
  assert.equal(res.pibPaymentTotal, 142196038);
  assert.equal(res.containerLandedCostPool, 37079000, 'Only Bea Masuk forms landed cost');
});
