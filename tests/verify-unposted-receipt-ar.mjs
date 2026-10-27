import { execFileSync } from 'node:child_process';

function runSql(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
}

async function main() {
  console.log('====================================================================');
  console.log('REGRESSION TEST: UNPOSTED RECEIPT VOUCHER CANNOT CHANGE PAID_AMOUNT');
  console.log('====================================================================');

  // 1. Verify SAPJ-26-043 baseline
  const inv = runSql(`
    SELECT id, invoice_number, total_amount, paid_amount, payment_status, customer_id
    FROM public.sales_invoices
    WHERE invoice_number = 'SAPJ-26-043';
  `)[0];

  console.log(`\n1. Baseline Invoice State:`);
  console.log(`   Invoice Number: ${inv.invoice_number}`);
  console.log(`   Total Amount:   Rp ${Number(inv.total_amount).toLocaleString('id-ID')}`);
  console.log(`   Paid Amount:    Rp ${Number(inv.paid_amount).toLocaleString('id-ID')}`);
  console.log(`   Payment Status: ${inv.payment_status}`);
  console.log(`   Outstanding AR: Rp ${(Number(inv.total_amount) - Number(inv.paid_amount)).toLocaleString('id-ID')}`);

  if (Number(inv.paid_amount) !== 41203339) {
    throw new Error(`Expected baseline paid_amount to be 41,203,339, got ${inv.paid_amount}`);
  }

  // 2. Verify GL 1120 reconciliation for SAPJ-26-043
  const arLines = runSql(`
    WITH invoice_je AS (
      SELECT COALESCE(SUM(jl.debit), 0) as total_debit
      FROM public.chart_of_accounts c
      JOIN public.journal_entry_lines jl ON jl.account_id = c.id
      JOIN public.journal_entries je ON je.id = jl.journal_entry_id 
        AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
      WHERE c.code = '1120' AND je.reference_number = 'SAPJ-26-043'
    ),
    receipt_jes AS (
      SELECT COALESCE(SUM(jl.credit), 0) as total_credit
      FROM public.voucher_allocations va
      JOIN public.receipt_vouchers rv ON rv.id = va.receipt_voucher_id AND rv.is_posted = true
      JOIN public.journal_entry_lines jl ON jl.journal_entry_id = rv.journal_entry_id
      JOIN public.chart_of_accounts c ON c.id = jl.account_id AND c.code = '1120'
      JOIN public.journal_entries je ON je.id = jl.journal_entry_id 
        AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
      WHERE va.sales_invoice_id = '${inv.id}'
    )
    SELECT 
      i.total_debit,
      r.total_credit,
      (i.total_debit - r.total_credit) as gl_ar_balance
    FROM invoice_je i, receipt_jes r;
  `)[0];

  console.log(`\n2. GL 1120 vs Subledger Reconciliation:`);
  console.log(`   GL 1120 Debits (Invoice JE):  Rp ${Number(arLines.total_debit).toLocaleString('id-ID')}`);
  console.log(`   GL 1120 Credits (Part 1 RV): Rp ${Number(arLines.total_credit).toLocaleString('id-ID')}`);
  console.log(`   GL 1120 Active Net AR:       Rp ${Number(arLines.gl_ar_balance).toLocaleString('id-ID')}`);
  console.log(`   Subledger Outstanding AR:    Rp ${(Number(inv.total_amount) - Number(inv.paid_amount)).toLocaleString('id-ID')}`);

  const diff = Number(arLines.gl_ar_balance) - (Number(inv.total_amount) - Number(inv.paid_amount));
  if (Math.abs(diff) > 0.01) {
    throw new Error(`GL 1120 and Subledger AR mismatch by Rp ${diff}`);
  }
  console.log('   ✅ GL 1120 and AR Subledger reconcile EXACTLY to Rp 29,440,956.00!');

  // 3. Test: Allocate an unposted draft receipt voucher
  console.log(`\n3. Testing Mutation with UNPOSTED Receipt Voucher:`);
  
  // Create draft receipt voucher
  const draftRv = runSql(`
    INSERT INTO public.receipt_vouchers (
      voucher_number, voucher_date, customer_id, payment_method,
      amount, is_posted, description, currency_code
    ) VALUES (
      'RV_TEST_DRAFT_9999', CURRENT_DATE, '${inv.customer_id}', 'bank_transfer',
      1000000.00, false, 'Temporary regression test draft voucher', 'IDR'
    ) RETURNING id;
  `)[0];

  // Insert allocation to SAPJ-26-043
  runSql(`
    INSERT INTO public.voucher_allocations (
      receipt_voucher_id, sales_invoice_id, allocated_amount, allocated_currency, voucher_type
    ) VALUES (
      '${draftRv.id}', '${inv.id}', 1000000.00, 'IDR', 'receipt'
    );

    -- Run recalculate
    SELECT public.recalculate_sales_invoice_payment_state('${inv.id}');
  `);

  // Check paid_amount: MUST STILL BE 41,203,339.00
  const afterDraftInv = runSql(`
    SELECT paid_amount, payment_status
    FROM public.sales_invoices
    WHERE id = '${inv.id}';
  `)[0];

  console.log(`   After allocating UNPOSTED receipt of Rp 1,000,000:`);
  console.log(`   Invoice Paid Amount: Rp ${Number(afterDraftInv.paid_amount).toLocaleString('id-ID')}`);
  console.log(`   Invoice Status:      ${afterDraftInv.payment_status}`);

  if (Number(afterDraftInv.paid_amount) !== 41203339) {
    // Clean up first
    runSql(`
      DELETE FROM public.voucher_allocations WHERE receipt_voucher_id = '${draftRv.id}';
      DELETE FROM public.receipt_vouchers WHERE id = '${draftRv.id}';
      SELECT public.recalculate_sales_invoice_payment_state('${inv.id}');
    `);
    throw new Error(`REGRESSION FAILED: Unposted receipt increased paid_amount to ${afterDraftInv.paid_amount}!`);
  }
  console.log('   ✅ PROVEN: Unposted receipt CANNOT change paid_amount!');

  // 4. Test: Posting the receipt voucher updates paid_amount
  console.log(`\n4. Testing Posting the Receipt Voucher (is_posted = true):`);
  runSql(`
    UPDATE public.receipt_vouchers SET is_posted = true WHERE id = '${draftRv.id}';
  `);

  const afterPostInv = runSql(`
    SELECT paid_amount, payment_status
    FROM public.sales_invoices
    WHERE id = '${inv.id}';
  `)[0];
  console.log(`   After setting is_posted = true:`);
  console.log(`   Invoice Paid Amount: Rp ${Number(afterPostInv.paid_amount).toLocaleString('id-ID')}`);
  if (Number(afterPostInv.paid_amount) !== 42203339) {
    // Clean up
    runSql(`
      DELETE FROM public.voucher_allocations WHERE receipt_voucher_id = '${draftRv.id}';
      DELETE FROM public.receipt_vouchers WHERE id = '${draftRv.id}';
      SELECT public.recalculate_sales_invoice_payment_state('${inv.id}');
    `);
    throw new Error(`Expected paid_amount to become 42,203,339, got ${afterPostInv.paid_amount}`);
  }
  console.log('   ✅ PROVEN: Posting the receipt voucher updates paid_amount synchronously!');

  // 5. Clean up test data and verify restoration
  console.log(`\n5. Cleaning up test data and restoring original state:`);
  runSql(`
    DELETE FROM public.voucher_allocations WHERE receipt_voucher_id = '${draftRv.id}';
    DELETE FROM public.receipt_vouchers WHERE id = '${draftRv.id}';
    SELECT public.recalculate_sales_invoice_payment_state('${inv.id}');
  `);

  const restoredInv = runSql(`
    SELECT paid_amount, payment_status
    FROM public.sales_invoices
    WHERE id = '${inv.id}';
  `)[0];
  console.log(`   Restored Invoice Paid Amount: Rp ${Number(restoredInv.paid_amount).toLocaleString('id-ID')}`);
  if (Number(restoredInv.paid_amount) !== 41203339) {
    throw new Error(`Restoration failed: ${restoredInv.paid_amount}`);
  }
  console.log('   ✅ Restored cleanly to exact baseline.');

  console.log('\n====================================================================');
  console.log('ALL REGRESSION ASSERTIONS PASSED SUCCESSFULLY!');
  console.log('====================================================================');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
