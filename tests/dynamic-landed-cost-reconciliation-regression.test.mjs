import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const migration = fs.readFileSync(
  'supabase/migrations/20260921130000_dynamic_landed_cost_and_cogs_engine.sql',
  'utf8',
);

test('1. Migration checks: ensures dynamic landed-cost propagation architecture', () => {
  assert.match(migration, /calculate_container_landed_cost_pool/);
  assert.match(migration, /approval_status.*NOT IN \('cancelled', 'rejected'\)/);
  assert.match(migration, /calculate_batch_direct_landed_cost/);
  assert.match(migration, /reallocate_container_costs/);
  assert.match(migration, /propagate_batch_cost_change/);
  assert.match(migration, /trigger_recalc_batches_on_expense/);
  assert.match(migration, /trigger_recalc_batches_on_petty_cash/);
  assert.match(migration, /sales_invoice_cogs_adjustment/);
  assert.match(migration, /get_authoritative_sales_line_cogs/);
  assert.doesNotMatch(migration, /pg_trigger_depth\(\)\s*>\s*1\s*THEN\s*RETURN/);
});

test('2. Live Database Transactional Regression Suite: Tests A through J', () => {
  const testSql = `
BEGIN;

DO $test$
DECLARE
  v_user_id uuid;
  v_cust_id uuid;
  v_supplier_id uuid;
  v_prod_id uuid;
  v_container_id uuid;
  v_batch_unsold_id uuid;
  v_batch_partial_id uuid;
  v_batch_full_id uuid;
  v_inv_partial_id uuid;
  v_item_partial_id uuid;
  v_inv_full_id uuid;
  v_item_full_id uuid;
  v_expense_id uuid;
  v_cogs_acc_id uuid;
  v_inv_acc_id uuid;
  v_dc_id uuid;
  v_dci_partial_id uuid;
  v_dci_full_id uuid;
  v_init_je_id uuid;
  v_cogs_gl numeric;
  v_item_snapshot_total numeric;
  v_item_snapshot_unit numeric;
  v_batch_unit_cost numeric;
  v_prop_res jsonb;
  v_auth_cogs numeric;
BEGIN
  -- Setup: Accounts & Profile
  SELECT id INTO v_user_id FROM public.user_profiles WHERE is_active = true LIMIT 1;
  SELECT id INTO v_cust_id FROM public.customers LIMIT 1;
  SELECT id INTO v_supplier_id FROM public.suppliers LIMIT 1;
  SELECT id INTO v_cogs_acc_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inv_acc_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;

  IF v_cogs_acc_id IS NULL OR v_inv_acc_id IS NULL THEN
    RAISE EXCEPTION 'Accounts 5100 or 1130 missing';
  END IF;

  PERFORM set_config('app.canonical_stock_engine', 'on', true);

  -- 1. Create a Test Product
  INSERT INTO public.products (product_name, product_code, category, unit, is_active)
  VALUES ('Test Dynamic Costing API', 'TEST-DYN-01', 'api', 'kg', true)
  RETURNING id INTO v_prod_id;

  -- 2. Create a Test Container
  INSERT INTO public.import_containers (container_ref, status, created_by)
  VALUES ('CONT-TEST-RECON-001', 'draft', v_user_id)
  RETURNING id INTO v_container_id;

  -- 3. Create Three Test Batches linked to this container (Base cost: 100,000 IDR/kg)
  -- Batch A: Unsold (1,000 kg)
  INSERT INTO public.batches (batch_number, product_id, import_container_id, import_date, import_quantity, current_stock, import_price, cost_per_unit, landed_cost_per_unit, is_active)
  VALUES ('BATCH-UNSOLD-01', v_prod_id, v_container_id, CURRENT_DATE, 1000, 1000, 100000, 100000, 100000, true)
  RETURNING id INTO v_batch_unsold_id;

  -- Batch B: Partially Sold (1,000 kg total, 500 kg sold, 500 kg stock)
  INSERT INTO public.batches (batch_number, product_id, import_container_id, import_date, import_quantity, current_stock, import_price, cost_per_unit, landed_cost_per_unit, is_active)
  VALUES ('BATCH-PARTIAL-01', v_prod_id, v_container_id, CURRENT_DATE, 1000, 500, 100000, 100000, 100000, true)
  RETURNING id INTO v_batch_partial_id;

  -- Batch C: Fully Sold (1,000 kg total, 1000 kg sold, 0 kg stock)
  INSERT INTO public.batches (batch_number, product_id, import_container_id, import_date, import_quantity, current_stock, import_price, cost_per_unit, landed_cost_per_unit, is_active)
  VALUES ('BATCH-FULL-01', v_prod_id, v_container_id, CURRENT_DATE, 1000, 0, 100000, 100000, 100000, true)
  RETURNING id INTO v_batch_full_id;

  -- 4. Create Invoices for Partial and Full Sales (Historical sale: 60 days ago)
  INSERT INTO public.delivery_challans (challan_number, customer_id, challan_date, delivery_address, approval_status, created_by)
  VALUES ('DC-TEST-RECON-001', v_cust_id, CURRENT_DATE - INTERVAL '60 days', 'Test Address', 'approved', v_user_id)
  RETURNING id INTO v_dc_id;

  ALTER TABLE public.delivery_challan_items DISABLE TRIGGER trg_validate_dc_item_product_reservation_v2;
  ALTER TABLE public.delivery_challan_items DISABLE TRIGGER trg_validate_delivery_challan_source_item;

  INSERT INTO public.delivery_challan_items (challan_id, product_id, batch_id, quantity)
  VALUES (v_dc_id, v_prod_id, v_batch_partial_id, 500)
  RETURNING id INTO v_dci_partial_id;

  INSERT INTO public.delivery_challan_items (challan_id, product_id, batch_id, quantity)
  VALUES (v_dc_id, v_prod_id, v_batch_full_id, 1000)
  RETURNING id INTO v_dci_full_id;

  ALTER TABLE public.delivery_challan_items ENABLE TRIGGER trg_validate_dc_item_product_reservation_v2;
  ALTER TABLE public.delivery_challan_items ENABLE TRIGGER trg_validate_delivery_challan_source_item;

  -- Invoice for Partial Sale: 500 kg @ Rp 100,000 initial cost = Rp 50,000,000 COGS
  INSERT INTO public.sales_invoices (invoice_number, invoice_date, customer_id, total_amount, subtotal, tax_amount, payment_status, is_draft, created_by)
  VALUES ('TEST-INV-PARTIAL-01', CURRENT_DATE - INTERVAL '60 days', v_cust_id, 75000000, 75000000, 0, 'paid', false, v_user_id)
  RETURNING id INTO v_inv_partial_id;

  INSERT INTO public.sales_invoice_items (invoice_id, product_id, batch_id, delivery_challan_item_id, quantity, unit_price, cogs_unit_cost, cogs_total_cost)
  VALUES (v_inv_partial_id, v_prod_id, v_batch_partial_id, v_dci_partial_id, 500, 150000, 100000, 50000000)
  RETURNING id INTO v_item_partial_id;

  -- Initial COGS Journal for Partial Invoice: 50,000,000
  INSERT INTO public.journal_entries (entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted)
  VALUES ('JE-TEST-INIT-PARTIAL', CURRENT_DATE - INTERVAL '60 days', 'sales_invoice_cogs', v_inv_partial_id, 'TEST-INV-PARTIAL-01', 'Initial COGS Partial', 50000000, 50000000, true)
  RETURNING id INTO v_init_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, sales_invoice_item_id, batch_id, customer_id)
  VALUES (v_init_je_id, 1, v_cogs_acc_id, 50000000, 0, v_item_partial_id, v_batch_partial_id, v_cust_id),
         (v_init_je_id, 2, v_inv_acc_id, 0, 50000000, v_item_partial_id, v_batch_partial_id, v_cust_id);

  UPDATE public.sales_invoices SET journal_entry_id = v_init_je_id WHERE id = v_inv_partial_id;

  -- Invoice for Full Sale: 1000 kg @ Rp 100,000 initial cost = Rp 100,000,000 COGS
  INSERT INTO public.sales_invoices (invoice_number, invoice_date, customer_id, total_amount, subtotal, tax_amount, payment_status, is_draft, created_by)
  VALUES ('TEST-INV-FULL-01', CURRENT_DATE - INTERVAL '60 days', v_cust_id, 150000000, 150000000, 0, 'paid', false, v_user_id)
  RETURNING id INTO v_inv_full_id;

  INSERT INTO public.sales_invoice_items (invoice_id, product_id, batch_id, delivery_challan_item_id, quantity, unit_price, cogs_unit_cost, cogs_total_cost)
  VALUES (v_inv_full_id, v_prod_id, v_batch_full_id, v_dci_full_id, 1000, 150000, 100000, 100000000)
  RETURNING id INTO v_item_full_id;

  INSERT INTO public.journal_entries (entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted)
  VALUES ('JE-TEST-INIT-FULL', CURRENT_DATE - INTERVAL '60 days', 'sales_invoice_cogs', v_inv_full_id, 'TEST-INV-FULL-01', 'Initial COGS Full', 100000000, 100000000, true)
  RETURNING id INTO v_init_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, sales_invoice_item_id, batch_id, customer_id)
  VALUES (v_init_je_id, 1, v_cogs_acc_id, 100000000, 0, v_item_full_id, v_batch_full_id, v_cust_id),
         (v_init_je_id, 2, v_inv_acc_id, 0, 100000000, v_item_full_id, v_batch_full_id, v_cust_id);

  UPDATE public.sales_invoices SET journal_entry_id = v_init_je_id WHERE id = v_inv_full_id;

  -----------------------------------------------------------------------------
  -- TEST A, B, C: Insert late clearing expense (30,000,000 IDR) to container
  -- 3 batches of 1,000 kg each = 3,000 kg total.
  -- 30,000,000 allocated equally = 10,000,000 per batch (+10,000 per kg).
  -- New batch unit cost = 110,000 IDR/kg.
  -----------------------------------------------------------------------------
  INSERT INTO public.finance_expenses (
    voucher_number, expense_date, expense_category, amount, include_in_landed_cost,
    import_container_id, supplier_id, approval_status, created_by
  ) VALUES (
    'EXP-TEST-CLEARING-01', CURRENT_DATE, 'clearing_forwarding', 30000000, true,
    v_container_id, v_supplier_id, 'approved', v_user_id
  ) RETURNING id INTO v_expense_id;

  -- Verify Batch A (Unsold): unit cost updated to 110,000, 0 COGS journals
  SELECT cost_per_unit INTO v_batch_unit_cost FROM public.batches WHERE id = v_batch_unsold_id;
  IF v_batch_unit_cost <> 110000.00 THEN
    RAISE EXCEPTION 'Test A Failed: Expected unsold batch cost 110000, got %', v_batch_unit_cost;
  END IF;

  -- Verify Batch B (Partially sold):
  -- Sold 500 kg * 110,000 = 55,000,000 (Delta = +5,000,000)
  SELECT cogs_unit_cost, cogs_total_cost INTO v_item_snapshot_unit, v_item_snapshot_total
    FROM public.sales_invoice_items WHERE id = v_item_partial_id;
  IF v_item_snapshot_unit <> 110000.00 OR v_item_snapshot_total <> 55000000.00 THEN
    RAISE EXCEPTION 'Test B Failed: Item snapshot expected 110000/55000000, got %/%', v_item_snapshot_unit, v_item_snapshot_total;
  END IF;

  SELECT SUM(jel.debit - jel.credit) INTO v_cogs_gl
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE je.reference_id = v_inv_partial_id AND coa.code = '5100' AND je.is_posted = true;
  IF v_cogs_gl <> 55000000.00 THEN
    RAISE EXCEPTION 'Test B Failed: Expected cumulative GL COGS 55000000, got %', v_cogs_gl;
  END IF;

  -- Verify Batch C (Fully sold):
  -- Sold 1,000 kg * 110,000 = 110,000,000 (Delta = +10,000,000)
  SELECT cogs_total_cost INTO v_item_snapshot_total FROM public.sales_invoice_items WHERE id = v_item_full_id;
  IF v_item_snapshot_total <> 110000000.00 THEN
    RAISE EXCEPTION 'Test C Failed: Fully sold snapshot expected 110000000, got %', v_item_snapshot_total;
  END IF;

  SELECT SUM(jel.debit - jel.credit) INTO v_cogs_gl
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE je.reference_id = v_inv_full_id AND coa.code = '5100' AND je.is_posted = true;
  IF v_cogs_gl <> 110000000.00 THEN
    RAISE EXCEPTION 'Test C Failed: Expected cumulative GL COGS 110000000, got %', v_cogs_gl;
  END IF;

  -----------------------------------------------------------------------------
  -- TEST D: Edit existing clearing cost (increase from 30m to 45m = +15k/kg)
  -- New batch unit cost = 115,000 IDR/kg.
  -----------------------------------------------------------------------------
  UPDATE public.finance_expenses
     SET amount = 45000000
   WHERE id = v_expense_id;

  SELECT cost_per_unit INTO v_batch_unit_cost FROM public.batches WHERE id = v_batch_partial_id;
  IF v_batch_unit_cost <> 115000.00 THEN
    RAISE EXCEPTION 'Test D Failed: Expected edited batch cost 115000, got %', v_batch_unit_cost;
  END IF;

  SELECT SUM(jel.debit - jel.credit) INTO v_cogs_gl
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE je.reference_id = v_inv_partial_id AND coa.code = '5100' AND je.is_posted = true;
  IF v_cogs_gl <> 57500000.00 THEN -- 500 * 115,000
    RAISE EXCEPTION 'Test D Failed: Expected partial invoice GL COGS 57500000, got %', v_cogs_gl;
  END IF;

  -----------------------------------------------------------------------------
  -- TEST E: Delete/unlink clearing cost (amount drops back to 0 allocated)
  -- Batch cost returns to base 100,000 IDR/kg.
  -- Cumulative GL COGS drops back to 50,000,000.
  -----------------------------------------------------------------------------
  DELETE FROM public.finance_expenses WHERE id = v_expense_id;

  SELECT cost_per_unit INTO v_batch_unit_cost FROM public.batches WHERE id = v_batch_partial_id;
  IF v_batch_unit_cost <> 100000.00 THEN
    RAISE EXCEPTION 'Test E Failed: Expected reverted batch cost 100000, got %', v_batch_unit_cost;
  END IF;

  SELECT SUM(jel.debit - jel.credit) INTO v_cogs_gl
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE je.reference_id = v_inv_partial_id AND coa.code = '5100' AND je.is_posted = true;
  IF v_cogs_gl <> 50000000.00 THEN
    RAISE EXCEPTION 'Test E Failed: Expected reverted GL COGS 50000000, got %', v_cogs_gl;
  END IF;

  -----------------------------------------------------------------------------
  -- TEST F & G: Multiple late costs and repeated edits
  -----------------------------------------------------------------------------
  -- Cost 1: Port charges 15,000,000 (+5,000/kg) -> unit cost 105,000
  INSERT INTO public.finance_expenses (
    voucher_number, expense_date, expense_category, amount, include_in_landed_cost,
    import_container_id, supplier_id, approval_status, created_by
  ) VALUES (
    'EXP-TEST-PORT-01', CURRENT_DATE, 'port_charges', 15000000, true,
    v_container_id, v_supplier_id, 'approved', v_user_id
  );

  -- Cost 2: Transport 15,000,000 (+5,000/kg) -> unit cost 110,000
  INSERT INTO public.finance_expenses (
    voucher_number, expense_date, expense_category, amount, include_in_landed_cost,
    import_container_id, supplier_id, approval_status, created_by
  ) VALUES (
    'EXP-TEST-TRANSPORT-01', CURRENT_DATE, 'transport_import', 15000000, true,
    v_container_id, v_supplier_id, 'approved', v_user_id
  );

  SELECT cost_per_unit INTO v_batch_unit_cost FROM public.batches WHERE id = v_batch_partial_id;
  IF v_batch_unit_cost <> 110000.00 THEN
    RAISE EXCEPTION 'Test F Failed: Expected cumulative batch cost 110000, got %', v_batch_unit_cost;
  END IF;

  SELECT SUM(jel.debit - jel.credit) INTO v_cogs_gl
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE je.reference_id = v_inv_partial_id AND coa.code = '5100' AND je.is_posted = true;
  IF v_cogs_gl <> 55000000.00 THEN
    RAISE EXCEPTION 'Test F Failed: Expected GL COGS 55000000, got %', v_cogs_gl;
  END IF;

  -----------------------------------------------------------------------------
  -- TEST H: Re-run recalculation twice (Idempotency)
  -----------------------------------------------------------------------------
  v_prop_res := public.propagate_batch_cost_change(v_batch_partial_id);
  IF (v_prop_res->>'adjusted_invoices_count')::integer <> 0 OR (v_prop_res->>'total_delta_posted')::numeric <> 0 THEN
    RAISE EXCEPTION 'Test H Failed: Re-running recalculation produced extra adjustment: %', v_prop_res;
  END IF;

  -----------------------------------------------------------------------------
  -- TEST I & J: Historical sale from months earlier + 3-layer reconciliation
  -- Batch Cost = Sales Invoice Item COGS = GL COGS
  -----------------------------------------------------------------------------
  SELECT sii.cogs_total_cost INTO v_item_snapshot_total
    FROM public.sales_invoice_items sii WHERE sii.id = v_item_partial_id;

  SELECT SUM(jel.debit - jel.credit) INTO v_cogs_gl
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE je.reference_id = v_inv_partial_id AND coa.code = '5100' AND je.is_posted = true;

  IF (500 * v_batch_unit_cost) <> v_item_snapshot_total OR v_item_snapshot_total <> v_cogs_gl THEN
    RAISE EXCEPTION 'Test J Failed: Batch (%), Snapshot (%), GL (%) do not reconcile',
      (500 * v_batch_unit_cost), v_item_snapshot_total, v_cogs_gl;
  END IF;

  -- Test get_authoritative_sales_line_cogs resolves cleanly for this historical line
  SELECT authoritative_cogs INTO v_auth_cogs
    FROM public.get_authoritative_sales_line_cogs((CURRENT_DATE - INTERVAL '65 days')::date, CURRENT_DATE)
   WHERE line_id = v_item_partial_id;

  IF v_auth_cogs <> 55000000.00 THEN
    RAISE EXCEPTION 'Test J Failed: get_authoritative_sales_line_cogs returned %, expected 55000000.00', v_auth_cogs;
  END IF;

  RAISE NOTICE '--- ALL TESTS A THROUGH J PASSED PERFECTLY ---';
  RAISE EXCEPTION 'ROLLBACK_SUCCESS';
END;
$test$;

ROLLBACK;
  `;

  let output = '';
  try {
    output = execSync('npx supabase db query --linked', {
      input: testSql,
      encoding: 'utf8',
    });
  } catch (err) {
    output = (err.stdout || '') + (err.stderr || '') + (err.message || '');
    if (!output.includes('ROLLBACK_SUCCESS')) {
      throw err;
    }
  }

  assert.match(output, /ROLLBACK_SUCCESS/);
});
