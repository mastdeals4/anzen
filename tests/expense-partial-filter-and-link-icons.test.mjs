import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getExpenseSettlementStatus } from '../src/utils/taxCalculations.ts';

test('Expenses module — Partial filter and link icons verification', async (t) => {
  await t.test('1. Static source verification of ExpenseManager.tsx', () => {
    const src = readFileSync(
      new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
      'utf8'
    );

    // Filter renamed from Pending to Partial
    assert.match(src, /\{\s*value:\s*'partial',\s*label:\s*'Partial'\s*\}/, "Recon filter button must be 'Partial'");
    assert.doesNotMatch(src, /\{\s*value:\s*'pending_recon',\s*label:\s*'Pending'\s*\}/, "Old 'pending_recon' filter must be removed");

    // Recon column: status only, non-clickable
    assert.match(src, /cursor-default\s+select-none/, "Recon column must use non-clickable cursor-default styling");
    assert.match(src, /title="Paid \/ Reconciled"[^>]*>\s*<CheckCircle/, "Reconciled status must render CheckCircle icon");
    assert.match(src, /title="Partially Paid \/ Reconciled"[^>]*>\s*<Clock/, "Partially reconciled status must render Clock icon");
    assert.match(src, /title="Outstanding · Unreconciled"[^>]*>\s*<Minus/, "Outstanding/unreconciled status must render neutral Minus icon");

    // Actions column: distinct bank linking icon and exact tooltips
    assert.match(src, /<Landmark className="w-3\.5 h-3\.5 shrink-0" \/>/, "Actions column must use distinct Landmark action icon");
    assert.match(src, /'Manage Bank Links' : 'Link Bank Transaction'/, "Actions column tooltip must be 'Manage Bank Links' or 'Link Bank Transaction'");
    assert.match(src, /void handleEdit\(expense,\s*true\)/, "Actions column must open bank linking workflow via handleEdit(expense, true)");

    // KPI Counters: Partial counter included and impossible ratios eliminated
    assert.match(src, /partialCount/, "expenseSummaryKpis must provide partialCount");
    assert.match(src, /reconciledRatio:\s*`\$\{reconciledCount\}\s*\/\s*\$\{applicableTotal\}`/, "reconciledRatio must be based on applicableTotal");
    assert.match(src, /<span className="text-amber-600 font-normal">Partial:<\/span>/, "Top summary must include Partial badge");
  });

  await t.test('2. Case 1: Fully unpaid expense appears in Outstanding', () => {
    const unpaidExpense = {
      id: 'test-unpaid-1',
      voucher_number: 'EXP/26/901',
      amount: 5000000,
      paid_amount: 0,
      expense_category: 'operations',
      approval_status: 'approved',
      effective_posting_state: 'ACTIVE',
      bank_statement_lines: [],
      voucher_allocations: [],
      salary_advance_applications: [],
    };
    const status = getExpenseSettlementStatus(unpaidExpense);
    assert.equal(status, 'outstanding', 'Fully unpaid expense must be classified as outstanding');
  });

  await t.test('3. Case 2: Partially paid expense appears in Partial', () => {
    const partialExpense = {
      id: 'test-partial-1',
      voucher_number: 'EXP/26/902',
      amount: 10000000,
      paid_amount: 4000000,
      expense_category: 'operations',
      approval_status: 'approved',
      effective_posting_state: 'ACTIVE',
      bank_statement_lines: [],
      voucher_allocations: [],
      salary_advance_applications: [],
    };
    const status = getExpenseSettlementStatus(partialExpense);
    assert.equal(status, 'partial', 'Partially paid expense (paid Rp 4m of Rp 10m) must be classified as partial');
  });

  await t.test('4. Case 3: Expense with multiple partial payments appears once in Partial with correct accumulated total', () => {
    const multiPaymentExpense = {
      id: 'test-multi-pay-1',
      voucher_number: 'EXP/26/903',
      amount: 10000000,
      paid_amount: 6000000, // Cumulative in DB
      expense_category: 'operations',
      approval_status: 'approved',
      effective_posting_state: 'ACTIVE',
      bank_statement_lines: [
        { id: 'b1', allocation_amount: 3000000, debit_amount: 3000000, credit_amount: 0, payment_kind: 'supplier' },
        { id: 'b2', allocation_amount: 3000000, debit_amount: 3000000, credit_amount: 0, payment_kind: 'supplier' },
      ],
      voucher_allocations: [],
      salary_advance_applications: [],
    };
    const status = getExpenseSettlementStatus(multiPaymentExpense);
    assert.equal(status, 'partial', 'Expense with multiple partial payments must be classified as partial');
  });

  await t.test('5. Case 4: Fully paid/reconciled expense appears in Reconciled', () => {
    const fullyPaidExpense = {
      id: 'test-reconciled-1',
      voucher_number: 'EXP/26/904',
      amount: 5000000,
      paid_amount: 5000000,
      expense_category: 'operations',
      approval_status: 'approved',
      effective_posting_state: 'ACTIVE',
      bank_statement_lines: [
        { id: 'b3', allocation_amount: 5000000, debit_amount: 5000000, credit_amount: 0, payment_kind: 'supplier' },
      ],
      voucher_allocations: [],
      salary_advance_applications: [],
    };
    const status = getExpenseSettlementStatus(fullyPaidExpense);
    assert.equal(status, 'reconciled', 'Fully paid/reconciled expense must be classified as reconciled');
  });

  await t.test('6. Case 5: Summary counters partition dataset and never show impossible ratio (e.g. 59 / 58)', () => {
    const dataset = [
      // 3 fully reconciled
      { id: 'e1', amount: 1000000, paid_amount: 1000000, approval_status: 'approved', effective_posting_state: 'ACTIVE' },
      { id: 'e2', amount: 2000000, paid_amount: 2000000, approval_status: 'approved', effective_posting_state: 'ACTIVE' },
      { id: 'e3', amount: 3000000, paid_amount: 3000000, approval_status: 'approved', effective_posting_state: 'ACTIVE' },
      // 2 partial
      { id: 'e4', amount: 5000000, paid_amount: 2000000, approval_status: 'approved', effective_posting_state: 'ACTIVE' },
      { id: 'e5', amount: 4000000, paid_amount: 1000000, approval_status: 'approved', effective_posting_state: 'ACTIVE' },
      // 1 outstanding
      { id: 'e6', amount: 1500000, paid_amount: 0, approval_status: 'approved', effective_posting_state: 'ACTIVE' },
    ];

    let reconciledCount = 0;
    let partialCount = 0;
    let outstandingCount = 0;

    for (const exp of dataset) {
      const s = getExpenseSettlementStatus(exp);
      if (s === 'reconciled') reconciledCount++;
      else if (s === 'partial') partialCount++;
      else if (s === 'outstanding') outstandingCount++;
    }

    const applicableTotal = dataset.length;
    assert.equal(applicableTotal, 6, 'Total count must be 6');
    assert.equal(reconciledCount, 3, 'Reconciled count must be 3');
    assert.equal(partialCount, 2, 'Partial count must be 2');
    assert.equal(outstandingCount, 1, 'Outstanding count must be 1');
    assert.equal(reconciledCount + partialCount + outstandingCount, applicableTotal, 'Sum of partitions must equal total');
    assert.ok(reconciledCount <= applicableTotal, 'Reconciled count must never exceed applicable total');
    const ratio = `${reconciledCount} / ${applicableTotal}`;
    assert.equal(ratio, '3 / 6');
  });

  await t.test('7. Edge Cases: Import Broker derived payable and Salary Advances', () => {
    // Import broker with broker items
    const brokerExpense = {
      id: 'test-broker-1',
      voucher_number: 'EXP/26/177',
      expense_category: 'import_broker',
      amount: 499500,
      paid_amount: 15273502,
      broker_items: [
        { type: 'other', amount: 5357460 },
        { type: 'other', amount: 8316042 },
        { type: 'other', amount: 1500000 },
        { type: 'other', amount: 100000 },
      ],
      approval_status: 'approved',
      effective_posting_state: 'ACTIVE',
    };
    const brokerStatus = getExpenseSettlementStatus(brokerExpense);
    assert.equal(brokerStatus, 'partial', 'Broker expense with partial payment against total payable must be partial');
  });
});
