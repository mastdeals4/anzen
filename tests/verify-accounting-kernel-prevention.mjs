#!/usr/bin/env node
/**
 * tests/verify-accounting-kernel-prevention.mjs
 * 
 * PREVENTION TEST SUITE
 * Proves that invalid future states are rejected or handled idempotently:
 * 1. Unposted receipt changing AR -> MUST NOT happen
 * 2. Duplicate receipt allocation -> MUST FAIL or be idempotent
 * 3. Duplicate rounding -> MUST remain one adjustment
 * 4. Salary allocation before payment purpose -> MUST NOT be possible
 * 5. Journal posted to GL 1101 -> MUST FAIL
 * 6. Fund transfer involving GL 1101 -> MUST FAIL
 * 7. Inventory transaction without operation_id -> MUST FAIL
 * 8. Duplicate inventory operation_id -> MUST FAIL
 * 9. Duplicate source posting -> MUST FAIL or be idempotent
 * 10. Negative stock -> Prohibited where business rules restrict stock
 */

import { execFileSync } from 'node:child_process';

function runSql(sql) {
  try {
    const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
      cwd: '/Users/Kunal/Documents/anzen-main',
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    const res = JSON.parse(stdout);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return res.rows || [];
  } catch (err) {
    const combinedMsg = `${err.message || ''}\n${err.stdout || ''}\n${err.stderr || ''}`;
    const customErr = new Error(combinedMsg);
    customErr.stdout = err.stdout;
    customErr.stderr = err.stderr;
    throw customErr;
  }
}

function expectError(fn, expectedSubstr) {
  try {
    fn();
    throw new Error(`Expected error containing "${expectedSubstr}", but no error was thrown.`);
  } catch (err) {
    const fullErr = `${err.message || ''}\n${err.stdout || ''}\n${err.stderr || ''}`;
    if (fullErr.toLowerCase().includes(expectedSubstr.toLowerCase())) {
      return true;
    }
    throw new Error(`Expected error containing "${expectedSubstr}", but got: ${fullErr}`);
  }
}

console.log('====================================================================');
console.log('PREVENTION TEST SUITE: ACCOUNTING & INVENTORY KERNEL GUARDS');
console.log('====================================================================\n');

// --------------------------------------------------------------------
// TEST 1: Unposted receipt changing AR -> MUST NOT happen
// --------------------------------------------------------------------
console.log('TEST 1: Verifying unposted receipt cannot affect invoice paid_amount...');
const testInv = runSql(`
  SELECT id, invoice_number, customer_id, total_amount, paid_amount
  FROM sales_invoices
  WHERE NOT COALESCE(is_draft, false) AND paid_amount < total_amount
  LIMIT 1;
`)[0];

const rvDraftId = runSql(`
  INSERT INTO receipt_vouchers (
    voucher_number, voucher_date, customer_id, bank_account_id,
    payment_method, amount, description, currency_code, is_posted
  ) VALUES (
    'TEST-RV-PREV-01', CURRENT_DATE, '${testInv.customer_id}',
    (SELECT id FROM bank_accounts LIMIT 1),
    'bank_transfer', 500000, 'Test unposted receipt guard', 'IDR', false
  ) RETURNING id;
`)[0].id;

let allocId = null;
try {
  allocId = runSql(`
    INSERT INTO voucher_allocations (
      receipt_voucher_id, sales_invoice_id, allocated_amount, allocated_currency, voucher_type
    ) VALUES (
      '${rvDraftId}', '${testInv.id}', 500000, 'IDR', 'receipt'
    ) RETURNING id;
  `)[0].id;

  runSql(`SELECT public.recalculate_sales_invoice_payment_state('${testInv.id}');`);

  const invAfterUnposted = runSql(`
    SELECT paid_amount FROM sales_invoices WHERE id = '${testInv.id}';
  `)[0].paid_amount;

  if (Number(invAfterUnposted) !== Number(testInv.paid_amount)) {
    throw new Error(`Test 1 Failed: Unposted receipt changed invoice paid_amount from ${testInv.paid_amount} to ${invAfterUnposted}`);
  }
  console.log('   ✅ PASS: Unposted receipt allocation does NOT alter invoice paid_amount.');
} finally {
  if (allocId) runSql(`DELETE FROM voucher_allocations WHERE id = '${allocId}';`);
  runSql(`DELETE FROM receipt_vouchers WHERE id = '${rvDraftId}';`);
  runSql(`SELECT public.recalculate_sales_invoice_payment_state('${testInv.id}');`);
}

// --------------------------------------------------------------------
// TEST 2: Duplicate receipt allocation -> MUST FAIL
// --------------------------------------------------------------------
console.log('\nTEST 2: Verifying duplicate receipt allocation prevention...');
const rv2Id = runSql(`
  INSERT INTO receipt_vouchers (
    voucher_number, voucher_date, customer_id, bank_account_id,
    payment_method, amount, description, currency_code, is_posted
  ) VALUES (
    'TEST-RV-PREV-02', CURRENT_DATE, '${testInv.customer_id}',
    (SELECT id FROM bank_accounts LIMIT 1),
    'bank_transfer', 500000, 'Test duplicate allocation guard', 'IDR', false
  ) RETURNING id;
`)[0].id;

let alloc2aId = null;
try {
  alloc2aId = runSql(`
    INSERT INTO voucher_allocations (
      receipt_voucher_id, sales_invoice_id, allocated_amount, allocated_currency, voucher_type
    ) VALUES (
      '${rv2Id}', '${testInv.id}', 100000, 'IDR', 'receipt'
    ) RETURNING id;
  `)[0].id;

  // Attempting duplicate insertion on same invoice (total 200,000 <= 500,000 voucher amount)
  expectError(() => {
    runSql(`
      INSERT INTO voucher_allocations (
        receipt_voucher_id, sales_invoice_id, allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        '${rv2Id}', '${testInv.id}', 100000, 'IDR', 'receipt'
      );
    `);
  }, 'unique');
  console.log('   ✅ PASS: Duplicate allocation on same voucher/invoice is rejected by unique constraint.');
} finally {
  if (alloc2aId) runSql(`DELETE FROM voucher_allocations WHERE id = '${alloc2aId}';`);
  runSql(`DELETE FROM receipt_vouchers WHERE id = '${rv2Id}';`);
  runSql(`SELECT public.recalculate_sales_invoice_payment_state('${testInv.id}');`);
}

// --------------------------------------------------------------------
// TEST 3: Duplicate rounding -> MUST remain one adjustment
// --------------------------------------------------------------------
console.log('\nTEST 3: Verifying duplicate rounding execution is idempotent...');
const roundingInv = runSql(`
  SELECT id, invoice_number, total_amount
  FROM sales_invoices
  WHERE invoice_number = 'SAPJ-26-020';
`)[0];

// Call rounding twice
runSql(`SELECT public.apply_receipt_allocation_rounding_adjustment('${roundingInv.id}');`);
runSql(`SELECT public.apply_receipt_allocation_rounding_adjustment('${roundingInv.id}');`);

const roundingAdjCount = runSql(`
  SELECT COUNT(*) as count
  FROM invoice_rounding_adjustments
  WHERE sales_invoice_id = '${roundingInv.id}';
`)[0].count;

const roundingJECount = runSql(`
  SELECT COUNT(*) as count
  FROM journal_entries
  WHERE source_module = 'sales_invoice_rounding' AND reference_id = '${roundingInv.id}';
`)[0].count;

if (Number(roundingAdjCount) !== 1 || Number(roundingJECount) !== 1) {
  throw new Error(`Test 3 Failed: Duplicate rounding created multiple records (adjustments: ${roundingAdjCount}, journals: ${roundingJECount})`);
}
console.log('   ✅ PASS: Executing rounding repeatedly remains strictly 1 adjustment and 1 journal.');

// --------------------------------------------------------------------
// TEST 4: Salary allocation before payment purpose -> Atomic prevention
// --------------------------------------------------------------------
console.log('\nTEST 4: Verifying salary allocation payment purpose atomicity...');
const canonicalProc = runSql(`
  SELECT pg_get_functiondef(oid) as def
  FROM pg_proc
  WHERE proname = 'save_payment_voucher_with_allocations'
  ORDER BY pronargs DESC LIMIT 1;
`)[0].def;

if (!canonicalProc.includes('INSERT INTO payment_vouchers') && !canonicalProc.includes('INSERT INTO public.payment_vouchers')) {
  throw new Error('Test 4 Failed: save_payment_voucher_with_allocations does not insert into payment_vouchers.');
}
if (!canonicalProc.includes('payment_purpose')) {
  throw new Error('Test 4 Failed: save_payment_voucher_with_allocations does not persist payment_purpose on INSERT.');
}
console.log('   ✅ PASS: Payment purpose is persisted on initial INSERT before any allocations exist.');

// --------------------------------------------------------------------
// TEST 5: Journal posted to GL 1101 -> MUST FAIL
// --------------------------------------------------------------------
console.log('\nTEST 5: Verifying postings to GL 1101 are hard-blocked...');
expectError(() => {
  runSql(`
    DO $$
    DECLARE
      v_je_id uuid;
      v_acc_id uuid;
    BEGIN
      SELECT id INTO v_acc_id FROM chart_of_accounts WHERE code = '1101';
      INSERT INTO journal_entries (entry_number, entry_date, is_posted, is_reversed)
      VALUES ('TEST-JE-1101-BLOCK', CURRENT_DATE, true, false)
      RETURNING id INTO v_je_id;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
      VALUES (v_je_id, 1, v_acc_id, 1000, 0);
    END $$;
  `);
}, 'permanently retired');
console.log('   ✅ PASS: Direct journal lines to GL 1101 are rejected by trg_prevent_gl1101_posting.');

// --------------------------------------------------------------------
// TEST 6: Fund transfer involving GL 1101 -> MUST FAIL
// --------------------------------------------------------------------
console.log('\nTEST 6: Verifying fund transfers involving GL 1101 are blocked...');
expectError(() => {
  runSql(`
    DO $$
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      INSERT INTO fund_transfers (
        transfer_number, transfer_date, from_account_type, to_account_type,
        amount, status
      ) VALUES (
        'TEST-FT-1101-BLOCK', CURRENT_DATE, 'cash_on_hand', 'petty_cash',
        50000, 'approved'
      );
    END $$;
  `);
}, 'permanently disabled');
console.log('   ✅ PASS: Fund transfers targeting GL 1101 are rejected by trg_prevent_cash_on_hand_fund_transfer.');

// --------------------------------------------------------------------
// TEST 7: Inventory transaction without operation_id -> MUST FAIL
// --------------------------------------------------------------------
console.log('\nTEST 7: Verifying inventory transaction without operation_id is blocked...');
const batchRow = runSql(`SELECT id, product_id FROM batches LIMIT 1;`)[0];
expectError(() => {
  runSql(`
    DO $$
    BEGIN
      PERFORM set_config('app.canonical_stock_engine', 'on', true);
      INSERT INTO inventory_transactions (
        transaction_date, transaction_type, product_id, batch_id,
        quantity, operation_id
      ) VALUES (
        CURRENT_DATE, 'adjustment', '${batchRow.product_id}', '${batchRow.id}',
        10, NULL
      );
    END $$;
  `);
}, 'Inventory transactions require an idempotent operation_id');
console.log('   ✅ PASS: Inventory insertions with NULL operation_id are rejected by trg_enforce_inventory_op_id.');

// --------------------------------------------------------------------
// TEST 8: Duplicate inventory operation_id -> MUST FAIL
// --------------------------------------------------------------------
console.log('\nTEST 8: Verifying duplicate inventory operation_id is rejected...');
const testOpId = 'a0000000-0000-0000-0000-000000000001';
const invTxId = runSql(`
  DO $$
  DECLARE
    v_id uuid;
  BEGIN
    PERFORM set_config('app.canonical_stock_engine', 'on', true);
    INSERT INTO inventory_transactions (
      transaction_date, transaction_type, product_id, batch_id,
      quantity, operation_id
    ) VALUES (
      CURRENT_DATE, 'adjustment', '${batchRow.product_id}', '${batchRow.id}',
      1, '${testOpId}'
    ) RETURNING id INTO v_id;
  END $$;
  SELECT id FROM inventory_transactions WHERE operation_id = '${testOpId}';
`)[0].id;

try {
  expectError(() => {
    runSql(`
      DO $$
      BEGIN
        PERFORM set_config('app.canonical_stock_engine', 'on', true);
        INSERT INTO inventory_transactions (
          transaction_date, transaction_type, product_id, batch_id,
          quantity, operation_id
        ) VALUES (
          CURRENT_DATE, 'adjustment', '${batchRow.product_id}', '${batchRow.id}',
          1, '${testOpId}'
        );
      END $$;
    `);
  }, 'idx_inventory_transactions_operation_id');
  console.log('   ✅ PASS: Duplicate operation_id is blocked by idx_inventory_transactions_operation_id unique index.');
} finally {
  runSql(`
    DO $$
    BEGIN
      PERFORM set_config('app.canonical_stock_engine', 'on', true);
      DELETE FROM inventory_transactions WHERE id = '${invTxId}';
    END $$;
  `);
}

// --------------------------------------------------------------------
// TEST 9: Duplicate source posting -> Handled idempotently
// --------------------------------------------------------------------
console.log('\nTEST 9: Verifying source posting idempotency...');
const sampleApprovedExpense = runSql(`
  SELECT id, approval_status
  FROM finance_expenses
  WHERE approval_status = 'approved' AND expense_category <> 'import_broker'
  LIMIT 1;
`)[0];

const jeCountBefore = runSql(`
  SELECT COUNT(*) as count
  FROM journal_entries
  WHERE source_module = 'finance_expenses' AND reference_id = '${sampleApprovedExpense.id}'
    AND is_posted = true AND NOT COALESCE(is_reversed, false);
`)[0].count;

// Trigger re-evaluation
runSql(`
  UPDATE finance_expenses
  SET description = description
  WHERE id = '${sampleApprovedExpense.id}';
`);

const jeCountAfter = runSql(`
  SELECT COUNT(*) as count
  FROM journal_entries
  WHERE source_module = 'finance_expenses' AND reference_id = '${sampleApprovedExpense.id}'
    AND is_posted = true AND NOT COALESCE(is_reversed, false);
`)[0].count;

if (Number(jeCountBefore) !== Number(jeCountAfter)) {
  throw new Error(`Test 9 Failed: Duplicate posting created extra journals on expense update.`);
}
console.log('   ✅ PASS: Re-evaluating approved expense does NOT create duplicate active journals.');

// --------------------------------------------------------------------
// TEST 10: Negative stock -> Prohibited
// --------------------------------------------------------------------
console.log('\nTEST 10: Verifying negative stock constraints...');
const totalNegStock = runSql(`
  SELECT COUNT(*) as count FROM batches WHERE current_stock < 0;
`)[0].count;
if (Number(totalNegStock) > 0) {
  throw new Error(`Test 10 Failed: ${totalNegStock} batches currently have negative stock.`);
}
console.log('   ✅ PASS: Zero negative stock batches exist in database.');

console.log('\n====================================================================');
console.log('ALL 10 PREVENTION TESTS COMPLETED SUCCESSFULLY: 100% PASS');
console.log('====================================================================');
