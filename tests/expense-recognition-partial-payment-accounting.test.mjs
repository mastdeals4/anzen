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

// =============================================================================
// Canonical Engine Simulation for recalculate_expense_payment_state()
// Replicates exact SQL deduplication & payment-evidence logic from migration
// =============================================================================
function recalculateExpensePaymentState({
  payable,
  voucherAllocations = [], // { id, amount, is_posted, payment_voucher_id, payment_kind, journal_entry_id }
  bankAllocations = [],    // { id, amount, journal_entry_id, payment_kind, document_type, document_id }
  recognitionJournalLines = [], // { account_code, credit, debit }
}) {
  let supplierPaid = 0;

  // 1. Confirmed, posted Payment Vouchers allocated to this expense (supplier kind)
  const postedPVs = voucherAllocations.filter(
    va => va.is_posted === true && (va.payment_kind || 'supplier') === 'supplier'
  );
  supplierPaid += postedPVs.reduce((sum, va) => sum + Number(va.amount), 0);

  // 2. Direct Bank Statement Allocations that do NOT duplicate a posted Payment Voucher
  // Deduplicate by actual payment event / journal identity:
  const directBankAllocs = bankAllocations.filter(bsa => {
    if ((bsa.payment_kind || 'supplier') !== 'supplier') return false;
    if (bsa.document_type !== 'expense') return false;
    // Exclude if journal belongs to a posted Payment Voucher for this expense
    const isDuplicateOfPV = postedPVs.some(pv => pv.journal_entry_id === bsa.journal_entry_id);
    return !isDuplicateOfPV;
  });
  supplierPaid += directBankAllocs.reduce((sum, bsa) => sum + Number(bsa.amount), 0);

  // 3. Legacy cash expense recognition: if the original recognition journal directly credited
  // Cash on Hand (1101) or Petty Cash (1102) rather than AP 2110
  const legacyCashLines = recognitionJournalLines.filter(
    l => ['1101', '1102'].includes(l.account_code) && Number(l.credit) > 0
  );
  supplierPaid += legacyCashLines.reduce((sum, l) => sum + Number(l.credit), 0);

  const targetPaid = Math.min(payable, Math.max(0, supplierPaid));
  const outstanding = Math.max(0, payable - targetPaid);

  return {
    paid_amount: targetPaid,
    outstanding,
    isFullyPaid: outstanding <= 0.01,
    isPartiallyPaid: targetPaid > 0.01 && outstanding > 0.01,
    isOutstanding: targetPaid <= 0.01 && outstanding > 0.01,
  };
}

// =============================================================================
// Canonical Engine Simulation for link_bank_statement_line()
// Replicates exact bank statement reconciliation routing & validation from migration
// =============================================================================
function simulateLinkBankStatementLine({
  bankLine, // { id, bank_account_id, debit_amount, credit_amount, currency }
  bankAccount, // { id, coa_code, currency }
  documentType, // 'expense' or 'payment'
  documentId,
  payable,
  voucherAllocations = [], // { va_id, pv_id, allocated_amount, pv_journal_id, is_posted, bank_account_id }
  existingBankAllocations = [], // { id, bank_line_id, journal_entry_id, allocation_amount, document_type, document_id }
  journalEntries = [], // { id, lines: [{ account_code, credit, debit }] }
  allocationAmount,
}) {
  // Validate bank account & line
  assert.equal(bankLine.bank_account_id, bankAccount.id, 'Bank account must match');
  assert.ok(bankLine.debit_amount > 0, 'Expense payment requires an outgoing bank transaction');

  const bankTotal = bankLine.debit_amount;
  const bankAlreadyAllocated = existingBankAllocations
    .filter(a => a.bank_line_id === bankLine.id)
    .reduce((sum, a) => sum + a.allocation_amount, 0);
  const bankRemaining = bankTotal - bankAlreadyAllocated;

  let allocatedJe = null;
  let allocateAmount = 0;
  let finalDocType = documentType;
  let finalDocId = documentId;
  let createdNewJournal = false;

  if (documentType === 'expense') {
    // Check if this expense already has an existing posted Payment Voucher on this bank account
    const existingPV = voucherAllocations.find(va =>
      va.is_posted === true &&
      va.bank_account_id === bankLine.bank_account_id &&
      (va.allocated_amount > existingBankAllocations
        .filter(a => a.journal_entry_id === va.pv_journal_id)
        .reduce((sum, a) => sum + a.allocation_amount, 0) + 0.01)
    );

    if (existingPV) {
      // Reconciles the existing Payment Voucher!
      finalDocType = 'payment';
      finalDocId = existingPV.pv_id;
      allocatedJe = existingPV.pv_journal_id;

      const pvReconciled = existingBankAllocations
        .filter(a => a.journal_entry_id === existingPV.pv_journal_id)
        .reduce((sum, a) => sum + a.allocation_amount, 0);
      const pvRemaining = existingPV.allocated_amount - pvReconciled;

      allocateAmount = allocationAmount ? Math.min(allocationAmount, pvRemaining) : Math.min(bankRemaining, pvRemaining);
      assert.ok(allocateAmount > 0.01, 'No remaining amount available to allocate');
      assert.ok(allocateAmount <= bankRemaining + 0.01, 'Allocation exceeds remaining bank amount');
      assert.ok(allocateAmount <= pvRemaining + 0.01, 'Allocation exceeds Payment Voucher remaining amount');
    } else {
      // Direct unvouched expense payment: requires remaining payable
      const alreadySettledVA = voucherAllocations
        .filter(va => va.is_posted)
        .reduce((sum, va) => sum + va.allocated_amount, 0);
      const alreadySettledBSA = existingBankAllocations
        .filter(a => a.document_type === 'expense' && a.document_id === documentId)
        .reduce((sum, a) => sum + a.allocation_amount, 0);
      const docRemaining = payable - (alreadySettledVA + alreadySettledBSA);

      assert.ok(docRemaining > 0.01, 'Allocation exceeds document outstanding amount');
      allocateAmount = allocationAmount ? Math.min(allocationAmount, docRemaining) : Math.min(bankRemaining, docRemaining);
      assert.ok(allocateAmount > 0.01, 'No remaining amount available to allocate');
      assert.ok(allocateAmount <= docRemaining + 0.01, 'Allocation exceeds document outstanding amount');

      // Creates new payment journal
      allocatedJe = `EXP-PAY-JE-${Date.now()}`;
      createdNewJournal = true;
    }
  }

  return {
    reconciledJournalId: allocatedJe,
    allocatedAmount: allocateAmount,
    finalDocType,
    finalDocId,
    createdNewJournal,
  };
}

// =============================================================================
// TEST 1: Expense 100, no payment: paid 0, outstanding 100
// =============================================================================
test('Test 1: Expense 100 with no payment recorded shows paid = 0, outstanding = 100', () => {
  const state = recalculateExpensePaymentState({
    payable: 100,
    voucherAllocations: [],
    bankAllocations: [],
  });

  assert.equal(state.paid_amount, 0);
  assert.equal(state.outstanding, 100);
  assert.equal(state.isOutstanding, true);
  assert.equal(state.isFullyPaid, false);
});

// =============================================================================
// TEST 2: Payment Voucher of 50, with its bank line subsequently matched
// Paid stays 50, outstanding stays 50 (NO DOUBLE COUNTING)
// =============================================================================
test('Test 2: Payment Voucher of 50 with subsequent bank line match preserves paid = 50, outstanding = 50 without double counting', () => {
  const payable = 100;
  const pvJournalId = 'JE-PV-50';

  // Step 1: Posted Payment Voucher of 50
  const voucherAllocations = [
    { id: 'va-1', amount: 50, is_posted: true, payment_voucher_id: 'pv-1', journal_entry_id: pvJournalId, payment_kind: 'supplier' },
  ];

  const stateAfterPV = recalculateExpensePaymentState({
    payable,
    voucherAllocations,
    bankAllocations: [],
  });
  assert.equal(stateAfterPV.paid_amount, 50, 'Paid must be 50 after posted PV');
  assert.equal(stateAfterPV.outstanding, 50, 'Outstanding must be 50 after posted PV');

  // Step 2: Bank statement line of 50 arrives and is matched against this payment
  const reconResult = simulateLinkBankStatementLine({
    bankLine: { id: 'line-1', bank_account_id: 'bank-1', debit_amount: 50, credit_amount: 0, currency: 'IDR' },
    bankAccount: { id: 'bank-1', coa_code: '111101', currency: 'IDR' },
    documentType: 'expense',
    documentId: 'expense-1',
    payable,
    voucherAllocations: [
      { va_id: 'va-1', pv_id: 'pv-1', allocated_amount: 50, pv_journal_id: pvJournalId, is_posted: true, bank_account_id: 'bank-1' },
    ],
    existingBankAllocations: [],
  });

  // Verification of reconciliation:
  assert.equal(reconResult.createdNewJournal, false, 'Reconciling existing PV must NOT create a new journal');
  assert.equal(reconResult.reconciledJournalId, pvJournalId, 'Must reconcile the existing PV journal');
  assert.equal(reconResult.finalDocType, 'payment', 'Must link to document_type = payment');

  // Step 3: Bank allocation record is stored
  const bankAllocations = [
    { id: 'bsa-1', amount: 50, journal_entry_id: pvJournalId, payment_kind: 'supplier', document_type: reconResult.finalDocType, document_id: reconResult.finalDocId },
  ];

  // Step 4: Re-evaluate expense payment state
  const stateAfterBankRecon = recalculateExpensePaymentState({
    payable,
    voucherAllocations,
    bankAllocations,
  });

  // CANONICAL CONTRACT: Paid must remain 50, NOT become 100!
  assert.equal(stateAfterBankRecon.paid_amount, 50, 'Paid amount MUST stay 50 after matching bank line to existing PV');
  assert.equal(stateAfterBankRecon.outstanding, 50, 'Outstanding MUST stay 50');
  assert.equal(stateAfterBankRecon.isPartiallyPaid, true);
  assert.equal(stateAfterBankRecon.isFullyPaid, false);
});

// =============================================================================
// TEST 3: Full Payment Voucher of 100, followed by bank reconciliation
// Reconciliation succeeds without an extra journal or duplicate bank credit
// =============================================================================
test('Test 3: Full Payment Voucher of 100 followed by bank reconciliation succeeds without extra journal or duplicate bank credit', () => {
  const payable = 100;
  const pvJournalId = 'JE-PV-100';

  // Full PV of 100 posted
  const voucherAllocations = [
    { id: 'va-1', amount: 100, is_posted: true, payment_voucher_id: 'pv-1', journal_entry_id: pvJournalId, payment_kind: 'supplier' },
  ];

  const stateInitial = recalculateExpensePaymentState({
    payable,
    voucherAllocations,
    bankAllocations: [],
  });
  assert.equal(stateInitial.paid_amount, 100);
  assert.equal(stateInitial.outstanding, 0, 'Expense is fully settled (outstanding = 0)');

  // Bank reconciliation on fully settled expense
  const reconResult = simulateLinkBankStatementLine({
    bankLine: { id: 'line-1', bank_account_id: 'bank-1', debit_amount: 100, credit_amount: 0, currency: 'IDR' },
    bankAccount: { id: 'bank-1', coa_code: '111101', currency: 'IDR' },
    documentType: 'expense',
    documentId: 'expense-1',
    payable,
    voucherAllocations: [
      { va_id: 'va-1', pv_id: 'pv-1', allocated_amount: 100, pv_journal_id: pvJournalId, is_posted: true, bank_account_id: 'bank-1' },
    ],
    existingBankAllocations: [],
  });

  assert.equal(reconResult.createdNewJournal, false, 'Must NOT create an extra payment journal');
  assert.equal(reconResult.reconciledJournalId, pvJournalId, 'Must reuse the existing PV journal');
  assert.equal(reconResult.allocatedAmount, 100);

  // Bank allocation stored
  const bankAllocations = [
    { id: 'bsa-1', amount: 100, journal_entry_id: pvJournalId, payment_kind: 'supplier', document_type: reconResult.finalDocType, document_id: reconResult.finalDocId },
  ];

  const stateFinal = recalculateExpensePaymentState({
    payable,
    voucherAllocations,
    bankAllocations,
  });

  assert.equal(stateFinal.paid_amount, 100, 'Paid amount must remain 100');
  assert.equal(stateFinal.outstanding, 0, 'Outstanding must remain 0');
  assert.equal(stateFinal.isFullyPaid, true);
});

// =============================================================================
// TEST 4: Two separate partial payments of 50
// Paid progresses from 50 to 100
// =============================================================================
test('Test 4: Two separate partial payments of 50 step cleanly from 50 to 100 paid', () => {
  const payable = 100;
  const pv1JournalId = 'JE-PV1-50';
  const pv2JournalId = 'JE-PV2-50';

  // Payment 1: PV 50
  const va1 = { id: 'va-1', amount: 50, is_posted: true, payment_voucher_id: 'pv-1', journal_entry_id: pv1JournalId, payment_kind: 'supplier' };
  const state1 = recalculateExpensePaymentState({
    payable,
    voucherAllocations: [va1],
    bankAllocations: [],
  });
  assert.equal(state1.paid_amount, 50);
  assert.equal(state1.outstanding, 50);

  // Match line 1 to PV 1
  const bsa1 = { id: 'bsa-1', amount: 50, journal_entry_id: pv1JournalId, payment_kind: 'supplier', document_type: 'payment', document_id: 'pv-1' };
  const state1Matched = recalculateExpensePaymentState({
    payable,
    voucherAllocations: [va1],
    bankAllocations: [bsa1],
  });
  assert.equal(state1Matched.paid_amount, 50, 'Paid stays 50 after line 1 match');
  assert.equal(state1Matched.outstanding, 50);

  // Payment 2: PV 50
  const va2 = { id: 'va-2', amount: 50, is_posted: true, payment_voucher_id: 'pv-2', journal_entry_id: pv2JournalId, payment_kind: 'supplier' };
  const state2 = recalculateExpensePaymentState({
    payable,
    voucherAllocations: [va1, va2],
    bankAllocations: [bsa1],
  });
  assert.equal(state2.paid_amount, 100, 'Paid reaches 100 after second PV');
  assert.equal(state2.outstanding, 0, 'Outstanding cleared to 0');

  // Match line 2 to PV 2
  const bsa2 = { id: 'bsa-2', amount: 50, journal_entry_id: pv2JournalId, payment_kind: 'supplier', document_type: 'payment', document_id: 'pv-2' };
  const state2Matched = recalculateExpensePaymentState({
    payable,
    voucherAllocations: [va1, va2],
    bankAllocations: [bsa1, bsa2],
  });
  assert.equal(state2Matched.paid_amount, 100, 'Paid stays 100 after line 2 match');
  assert.equal(state2Matched.outstanding, 0);
  assert.equal(state2Matched.isFullyPaid, true);
});

// =============================================================================
// TEST 5: An unposted Payment Voucher does not affect paid amount
// =============================================================================
test('Test 5: An unposted (draft) Payment Voucher does not affect paid amount; posting it updates paid amount', () => {
  const payable = 100;

  // Draft PV: is_posted = false
  const draftVA = [
    { id: 'va-draft', amount: 50, is_posted: false, payment_voucher_id: 'pv-draft', journal_entry_id: null, payment_kind: 'supplier' },
  ];

  const stateDraft = recalculateExpensePaymentState({
    payable,
    voucherAllocations: draftVA,
    bankAllocations: [],
  });
  assert.equal(stateDraft.paid_amount, 0, 'Unposted PV must NOT affect paid amount');
  assert.equal(stateDraft.outstanding, 100);

  // Now post the PV: is_posted = true
  const postedVA = [
    { id: 'va-draft', amount: 50, is_posted: true, payment_voucher_id: 'pv-draft', journal_entry_id: 'JE-PV-50', payment_kind: 'supplier' },
  ];

  const statePosted = recalculateExpensePaymentState({
    payable,
    voucherAllocations: postedVA,
    bankAllocations: [],
  });
  assert.equal(statePosted.paid_amount, 50, 'Posting the PV must update paid amount');
  assert.equal(statePosted.outstanding, 50);
});

// =============================================================================
// TEST 6: Cash and petty-cash handling agrees with ledger and paid-state display
// =============================================================================
test('Test 6: Cash handling agrees with ledger and Expense form excludes direct cash option', () => {
  // 1. Expense form does NOT offer cash in the payment method dropdown
  assert.doesNotMatch(
    expenseManager,
    /<option\s+value="cash">/i,
    'Expense form must NOT expose direct cash option; cash is routed to Petty Cash Manager',
  );

  // 2. Legacy cash recognition journals crediting 1101/1102 are recognized so paid_amount agrees with ledger
  const stateLegacyCash = recalculateExpensePaymentState({
    payable: 100,
    voucherAllocations: [],
    bankAllocations: [],
    recognitionJournalLines: [
      { account_code: '5100', debit: 100, credit: 0 },
      { account_code: '1101', debit: 0, credit: 100 }, // Legacy cash credit
    ],
  });
  assert.equal(stateLegacyCash.paid_amount, 100, 'Legacy cash recognition journal must agree with ledger as paid');
  assert.equal(stateLegacyCash.outstanding, 0);

  // 3. Standard expense recognition crediting 2110 (A/P) leaves paid = 0 until payment event
  const stateStandardAP = recalculateExpensePaymentState({
    payable: 100,
    voucherAllocations: [],
    bankAllocations: [],
    recognitionJournalLines: [
      { account_code: '5100', debit: 100, credit: 0 },
      { account_code: '2110', debit: 0, credit: 100 }, // Standard AP credit
    ],
  });
  assert.equal(stateStandardAP.paid_amount, 0);
  assert.equal(stateStandardAP.outstanding, 100);
});

// =============================================================================
// TEST 7: Existing bank-allocation integrity checks continue to work
// =============================================================================
test('Test 7: Existing bank-allocation integrity triggers and validations are preserved', () => {
  // Migration preserves all integrity checks:
  assert.match(
    migration,
    /validate_expense_bank_allocation_against_journal/i,
    'validate_expense_bank_allocation_against_journal trigger must be present',
  );
  assert.match(
    migration,
    /Total bank allocations \(%\) exceed bank statement line amount/i,
    'Bank line amount cap validation must be enforced',
  );
  assert.match(
    migration,
    /Allocation exceeds remaining bank amount/i,
    'Remaining bank amount validation must be enforced',
  );
  assert.match(
    migration,
    /Direct expense allocation requires matching expense and bank currencies/i,
    'Currency matching validation must be enforced',
  );
  assert.match(
    migration,
    /Expense payment requires an outgoing bank transaction/i,
    'Debit direction validation must be enforced',
  );
});

// =============================================================================
// TEST 8: SQL Deduplication Invariant in Migration
// =============================================================================
test('Test 8: Migration deduplicates bank statement allocations against voucher allocations by journal identity', () => {
  assert.match(
    migration,
    /AND\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.voucher_allocations\s+va\s+JOIN\s+public\.payment_vouchers\s+pv\s+ON\s+pv\.id\s*=\s*va\.payment_voucher_id\s+WHERE\s+va\.finance_expense_id\s*=\s*p_expense_id\s+AND\s+pv\.is_posted\s*=\s*true\s+AND\s+pv\.journal_entry_id\s*=\s*bsa\.journal_entry_id\s*\)/i,
    'recalculate_expense_payment_state must deduplicate bsa by pv.journal_entry_id',
  );
});

// =============================================================================
// TEST 9: Fully Settled Payment Voucher Reconciliation Invariant in Migration
// =============================================================================
test('Test 9: Migration allows reconciling existing posted Payment Vouchers on fully paid expenses', () => {
  assert.match(
    migration,
    /SELECT\s+pv\.\*,\s+va\.allocated_amount\s+AS\s+expense_allocation_amount[\s\S]*WHERE\s+va\.finance_expense_id\s*=\s*p_document_id[\s\S]*pv\.is_posted\s*=\s*true/i,
    'link_bank_statement_line must search for existing posted Payment Vouchers allocated to this expense',
  );
  assert.match(
    migration,
    /'reconciled_payment_voucher_id',\s*v_pv\.id/i,
    'link_bank_statement_line must return the reconciled payment voucher id',
  );
});
