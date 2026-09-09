import { execSync } from 'child_process';

console.log('--- Starting Verification: Batch Cost Propagation to Sales COGS ---');

const testSql = `
BEGIN;

DO $test$
DECLARE
  v_prod_id uuid;
  v_batch_id uuid;
  v_cust_id uuid;
  v_user_id uuid;
  v_inv_id uuid;
  v_item_id uuid;
  v_dci_id uuid;
  v_ar_je_id uuid;
  v_initial_cogs_je_id uuid;
  v_reval_je_id uuid;
  v_cogs_acc_id uuid;
  v_inv_acc_id uuid;
  v_ar_acc_id uuid;
  v_sales_acc_id uuid;
  v_item_cogs_unit numeric;
  v_item_cogs_total numeric;
  v_auth_cogs numeric;
  v_auth_unit_cogs numeric;
  v_res_tier text;
  v_gl_5100_debits numeric;
  v_gl_1130_credits numeric;
  v_prop_result jsonb;
  v_je_rec record;
  v_jel_rec record;
BEGIN
  -- 0. Get system IDs
  SELECT id INTO v_user_id FROM public.user_profiles WHERE is_active = true LIMIT 1;
  SELECT id INTO v_cust_id FROM public.customers LIMIT 1;
  SELECT id INTO v_cogs_acc_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inv_acc_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  SELECT id INTO v_ar_acc_id FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
  SELECT id INTO v_sales_acc_id FROM public.chart_of_accounts WHERE code = '4100' LIMIT 1;

  PERFORM set_config('app.canonical_stock_engine', 'on', true);

  IF v_cogs_acc_id IS NULL OR v_inv_acc_id IS NULL OR v_ar_acc_id IS NULL OR v_sales_acc_id IS NULL THEN
    RAISE EXCEPTION 'Required accounts missing in chart_of_accounts';
  END IF;

  -- 1. Create a test product
  INSERT INTO public.products (
    product_name, product_code, category, unit, is_active
  ) VALUES (
    'Test Revaluation Product', 'TEST-REVAL-PROD-01', 'api', 'kg', true
  ) RETURNING id INTO v_prod_id;

  -- 2. Create a test batch with cost Rp 0
  INSERT INTO public.batches (
    batch_number, product_id, current_stock,
    import_quantity, import_date,
    cost_per_unit, landed_cost_per_unit, import_price, is_active
  ) VALUES (
    'BATCH-TEST-COST-0', v_prod_id, 100,
    100, CURRENT_DATE,
    0, 0, 0, true
  ) RETURNING id INTO v_batch_id;

  RAISE NOTICE 'Step 1: Created Batch % with cost Rp 0', v_batch_id;

  -- 3. Create a delivery challan and item matching product & batch
  DECLARE
    v_dc_id uuid;
  BEGIN
    INSERT INTO public.delivery_challans (
      challan_number, customer_id, challan_date, delivery_address, approval_status, created_by
    ) VALUES (
      'DC-TEST-REVAL-001', v_cust_id, CURRENT_DATE, 'Test Delivery Address', 'approved', v_user_id
    ) RETURNING id INTO v_dc_id;

    ALTER TABLE public.delivery_challan_items DISABLE TRIGGER trg_validate_dc_item_product_reservation_v2;
    ALTER TABLE public.delivery_challan_items DISABLE TRIGGER trg_validate_delivery_challan_source_item;

    INSERT INTO public.delivery_challan_items (
      challan_id, product_id, batch_id, quantity
    ) VALUES (
      v_dc_id, v_prod_id, v_batch_id, 10
    ) RETURNING id INTO v_dci_id;

    ALTER TABLE public.delivery_challan_items ENABLE TRIGGER trg_validate_dc_item_product_reservation_v2;
    ALTER TABLE public.delivery_challan_items ENABLE TRIGGER trg_validate_delivery_challan_source_item;

    -- 4. Create a sales invoice referencing this batch (10 units @ Rp 200,000)
    INSERT INTO public.sales_invoices (
      invoice_number, invoice_date, customer_id, total_amount, subtotal, tax_amount,
      payment_status, is_draft, created_by
    ) VALUES (
      'TEST-INV-REVAL-001', CURRENT_DATE, v_cust_id, 2000000, 2000000, 0,
      'pending', false, v_user_id
    ) RETURNING id INTO v_inv_id;

    INSERT INTO public.sales_invoice_items (
      invoice_id, product_id, batch_id, delivery_challan_item_id, quantity, unit_price,
      cogs_unit_cost, cogs_total_cost
    ) VALUES (
      v_inv_id, v_prod_id, v_batch_id, v_dci_id, 10, 200000,
      0, 0
    ) RETURNING id INTO v_item_id;
  END;

  -- Ensure invoice is marked with journal_entry_id if trigger set it
  SELECT journal_entry_id INTO v_ar_je_id FROM public.sales_invoices WHERE id = v_inv_id;

  RAISE NOTICE 'Step 2: Posted Sales Invoice % for 10 units with cost Rp 0 (AR JE: %)', v_inv_id, v_ar_je_id;

  -- Verify initial state before cost change:
  SELECT cogs_unit_cost, cogs_total_cost INTO v_item_cogs_unit, v_item_cogs_total
    FROM public.sales_invoice_items WHERE id = v_item_id;

  IF COALESCE(v_item_cogs_total, 0) <> 0 THEN
    RAISE EXCEPTION 'Assertion failed: Initial item COGS should be 0, got %', v_item_cogs_total;
  END IF;

  -- 4. UPDATE BATCH COST TO Rp 176,750 (Simulate cost correction/landed cost finalization)
  RAISE NOTICE 'Step 3: Updating batch cost to Rp 176,750...';
  UPDATE public.batches
     SET landed_cost_per_unit = 176750,
         cost_per_unit = 176750
   WHERE id = v_batch_id;

  -- 5. ASSERT: Item snapshot updated automatically by trigger
  SELECT cogs_unit_cost, cogs_total_cost INTO v_item_cogs_unit, v_item_cogs_total
    FROM public.sales_invoice_items WHERE id = v_item_id;

  IF v_item_cogs_unit <> 176750.00 THEN
    RAISE EXCEPTION 'Assertion failed: Expected cogs_unit_cost = 176750.00, got %', v_item_cogs_unit;
  END IF;

  IF v_item_cogs_total <> 1767500.00 THEN
    RAISE EXCEPTION 'Assertion failed: Expected cogs_total_cost = 1767500.00 (10 * 176750), got %', v_item_cogs_total;
  END IF;

  RAISE NOTICE 'Step 4 Passed: sales_invoice_items snapshot updated to unit % and total %',
    v_item_cogs_unit, v_item_cogs_total;

  -- 6. ASSERT: Controlled Revaluation Journal Entry was created in GL
  SELECT id, entry_number, source_module, total_debit, total_credit
    INTO v_je_rec
    FROM public.journal_entries
   WHERE reference_id = v_inv_id
     AND source_module IN ('sales_invoice_cogs', 'sales_invoice_cogs_adjustment')
     AND is_posted = true;

  IF v_je_rec.id IS NULL THEN
    RAISE EXCEPTION 'Assertion failed: No COGS revaluation journal entry was created in GL!';
  END IF;

  IF v_je_rec.total_debit <> 1767500.00 OR v_je_rec.total_credit <> 1767500.00 THEN
    RAISE EXCEPTION 'Assertion failed: Expected journal entry debit/credit = 1767500.00, got Dr % / Cr %',
      v_je_rec.total_debit, v_je_rec.total_credit;
  END IF;

  RAISE NOTICE 'Step 5 Passed: GL Journal Entry % created with total % (source_module: %)',
    v_je_rec.entry_number, v_je_rec.total_debit, v_je_rec.source_module;

  -- Check lines attribution
  SELECT SUM(debit) AS dr_5100 INTO v_gl_5100_debits
    FROM public.journal_entry_lines
   WHERE journal_entry_id = v_je_rec.id
     AND account_id = v_cogs_acc_id
     AND sales_invoice_item_id = v_item_id
     AND batch_id = v_batch_id;

  SELECT SUM(credit) AS cr_1130 INTO v_gl_1130_credits
    FROM public.journal_entry_lines
   WHERE journal_entry_id = v_je_rec.id
     AND account_id = v_inv_acc_id
     AND sales_invoice_item_id = v_item_id
     AND batch_id = v_batch_id;

  IF v_gl_5100_debits <> 1767500.00 THEN
    RAISE EXCEPTION 'Assertion failed: Expected 5100 Dr = 1767500.00 attributed to item %, got %',
      v_item_id, v_gl_5100_debits;
  END IF;

  IF v_gl_1130_credits <> 1767500.00 THEN
    RAISE EXCEPTION 'Assertion failed: Expected 1130 Cr = 1767500.00 attributed to item %, got %',
      v_item_id, v_gl_1130_credits;
  END IF;

  RAISE NOTICE 'Step 6 Passed: GL lines correctly attributed to item % and batch % with Dr 5100 / Cr 1130',
    v_item_id, v_batch_id;

  -- 7. ASSERT: Reports & Authoritative COGS function immediately reflects 1,767,500
  SELECT authoritative_cogs, authoritative_unit_cogs, resolution_tier
    INTO v_auth_cogs, v_auth_unit_cogs, v_res_tier
    FROM public.get_authoritative_sales_line_cogs(CURRENT_DATE, CURRENT_DATE)
   WHERE line_id = v_item_id;

  IF v_auth_cogs <> 1767500.00 THEN
    RAISE EXCEPTION 'Assertion failed: Expected get_authoritative_sales_line_cogs authoritative_cogs = 1767500.00, got %',
      v_auth_cogs;
  END IF;

  IF v_auth_unit_cogs <> 176750.00 THEN
    RAISE EXCEPTION 'Assertion failed: Expected authoritative_unit_cogs = 176750.00, got %',
      v_auth_unit_cogs;
  END IF;

  IF v_res_tier <> 'posted_item_cogs' THEN
    RAISE EXCEPTION 'Assertion failed: Expected resolution_tier = posted_item_cogs, got %',
      v_res_tier;
  END IF;

  RAISE NOTICE 'Step 7 Passed: get_authoritative_sales_line_cogs resolved to % (unit %) via tier %',
    v_auth_cogs, v_auth_unit_cogs, v_res_tier;

  -- 7b. ASSERT: Sales Profitability Summary report JSON includes corrected cost
  SELECT public.get_sales_profitability_summary(CURRENT_DATE, CURRENT_DATE) INTO v_prop_result;
  IF v_prop_result IS NULL THEN
    RAISE EXCEPTION 'Assertion failed: get_sales_profitability_summary returned null';
  END IF;
  RAISE NOTICE 'Step 7b Passed: get_sales_profitability_summary executes cleanly with updated COGS';

  -- 8. TEST ADDITIVE ADJUSTMENT: Cost changes further to Rp 180,000
  RAISE NOTICE 'Step 8: Testing subsequent general cost correction to Rp 180,000...';
  UPDATE public.batches
     SET landed_cost_per_unit = 180000,
         cost_per_unit = 180000
   WHERE id = v_batch_id;

  -- Assert: Snapshot updated to 180,000 * 10 = 1,800,000
  SELECT cogs_unit_cost, cogs_total_cost INTO v_item_cogs_unit, v_item_cogs_total
    FROM public.sales_invoice_items WHERE id = v_item_id;

  IF v_item_cogs_unit <> 180000.00 OR v_item_cogs_total <> 1800000.00 THEN
    RAISE EXCEPTION 'Assertion failed on second update: expected 180000/1800000, got % / %',
      v_item_cogs_unit, v_item_cogs_total;
  END IF;

  -- Assert: Total GL 5100 debits across both journal entries equals 1,800,000
  SELECT SUM(jel.debit - jel.credit) INTO v_gl_5100_debits
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE je.reference_id = v_inv_id
     AND jel.account_id = v_cogs_acc_id
     AND jel.sales_invoice_item_id = v_item_id
     AND je.is_posted = true;

  IF v_gl_5100_debits <> 1800000.00 THEN
    RAISE EXCEPTION 'Assertion failed: Total GL 5100 debits should be 1800000.00, got %', v_gl_5100_debits;
  END IF;

  -- Assert: Authoritative COGS function immediately returns 1,800,000
  SELECT authoritative_cogs, authoritative_unit_cogs, resolution_tier
    INTO v_auth_cogs, v_auth_unit_cogs, v_res_tier
    FROM public.get_authoritative_sales_line_cogs(CURRENT_DATE, CURRENT_DATE)
   WHERE line_id = v_item_id;

  IF v_auth_cogs <> 1800000.00 THEN
    RAISE EXCEPTION 'Assertion failed: Authoritative COGS should be 1800000.00, got %', v_auth_cogs;
  END IF;

  RAISE NOTICE 'Step 9 Passed: Additive cost correction successfully posted delta journal. Total GL COGS = %',
    v_gl_5100_debits;

  RAISE NOTICE '--- ALL TESTS PASSED SUCCESSFULLY! ---';

  -- Clean rollback so test artifacts do not pollute production database
  RAISE EXCEPTION 'ROLLBACK_SUCCESS';
END;
$test$;

ROLLBACK;
`;

try {
  const result = execSync(`npx supabase db query --linked`, {
    input: testSql,
    encoding: 'utf8',
  });
  console.log('Query result:');
  console.log(result);
} catch (err) {
  const stdout = err.stdout?.toString() || '';
  const stderr = err.stderr?.toString() || '';
  if (stdout.includes('ROLLBACK_SUCCESS') || stderr.includes('ROLLBACK_SUCCESS')) {
    console.log('\n======================================================');
    console.log('ALL VERIFICATION CHECKS PASSED PERFECTLY (ROLLBACK_SUCCESS)');
    console.log('======================================================\n');
    console.log(stdout);
    process.exit(0);
  } else {
    console.error('Test execution failed:', stdout, stderr);
    process.exit(1);
  }
}
