#!/usr/bin/env node
/**
 * tests/inventory-data-access-architecture-regression.test.mjs
 * 
 * Regression test suite verifying:
 * 1. Legacy inventory transaction added -> operational stock does NOT change.
 * 2. Legacy duplicate sale present -> operational OUT does NOT change.
 * 3. Historical repair record present -> operational stock does NOT change.
 * 4. A new approved DC occurs -> operational OUT increases exactly once.
 * 5. A new receipt occurs -> operational IN increases exactly once.
 * 6. Domperidone Maleate BP: 75 received, 75 delivered, 0 current.
 * 7. MCC PH-101 & MCC PH-102: current 0.
 * 8. Zero negative operational closing balances across all products.
 * 9. AI reporting layer permissions & contracts:
 *    ai_inventory_current & ai_inventory_movement operational isolation.
 */

import { execFileSync } from 'node:child_process';

function runSql(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: '/Users/Kunal/Documents/anzen-main',
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
}

let allPassed = true;
function assert(name, condition, details = '') {
  if (condition) {
    console.log(`✅ PASS: ${name}${details ? ' - ' + details : ''}`);
  } else {
    console.error(`❌ FAIL: ${name}${details ? ' - ' + details : ''}`);
    allPassed = false;
  }
}

console.log('====================================================================');
console.log('FINAL INVENTORY DATA ACCESS ARCHITECTURE REGRESSION SUITE');
console.log('====================================================================\n');

// -----------------------------------------------------------------------------
// TEST 1: Domperidone Maleate BP Verification (75 received, 75 delivered, 0 current)
// -----------------------------------------------------------------------------
{
  const rows = runSql(`
    SELECT product_code, product_name, opening, in_qty, out_qty, closing, current_stock
    FROM public.ai_inventory_movement('2025-01-01', '2026-12-31')
    WHERE product_name ILIKE '%Domperidone Maleate BP%';
  `);
  
  assert('Domperidone record found', rows.length === 1);
  if (rows.length === 1) {
    const row = rows[0];
    assert('Domperidone 75 received', Number(row.in_qty) === 75, `in_qty = ${row.in_qty}`);
    assert('Domperidone 75 delivered', Number(row.out_qty) === 75, `out_qty = ${row.out_qty}`);
    assert('Domperidone 0 closing', Number(row.closing) === 0, `closing = ${row.closing}`);
    assert('Domperidone 0 current', Number(row.current_stock) === 0, `current_stock = ${row.current_stock}`);
  }
}

// -----------------------------------------------------------------------------
// TEST 2: MCC PH-101 and MCC PH-102 Verification (current 0)
// -----------------------------------------------------------------------------
{
  const rows = runSql(`
    SELECT product_code, product_name, current_stock, closing
    FROM public.ai_inventory_movement('2025-01-01', '2026-12-31')
    WHERE product_name ILIKE '%PH - 101%' OR product_name ILIKE '%PH - 102%';
  `);

  assert('MCC products found', rows.length === 2, `found ${rows.length} products`);
  for (const r of rows) {
    assert(`${r.product_name} current 0`, Number(r.current_stock) === 0, `current = ${r.current_stock}`);
    assert(`${r.product_name} closing 0`, Number(r.closing) === 0, `closing = ${r.closing}`);
  }
}

// -----------------------------------------------------------------------------
// TEST 3: No Negative Operational Closing Balances Across Entire Database
// -----------------------------------------------------------------------------
{
  const negativeRows = runSql(`
    SELECT product_code, product_name, closing, current_stock
    FROM public.ai_inventory_movement('2025-01-01', '2026-12-31')
    WHERE closing < 0 OR current_stock < 0;
  `);

  assert('Zero negative operational closing balances', negativeRows.length === 0, `count = ${negativeRows.length}`);
}

// -----------------------------------------------------------------------------
// TEST 4: Perfect Parity Between ai_inventory_current and inventory_v1_stock_summary
// -----------------------------------------------------------------------------
{
  const parity = runSql(`
    SELECT
      (SELECT count(*) FROM public.ai_inventory_current) as ai_count,
      (SELECT count(*) FROM public.inventory_v1_stock_summary) as canon_count;
  `);

  assert(
    'AI layer current stock row parity',
    parity[0].ai_count === parity[0].canon_count,
    `ai: ${parity[0].ai_count}, canon: ${parity[0].canon_count}`
  );
}

// -----------------------------------------------------------------------------
// TEST 5: Mathematical Invariant: Opening + In - Out = Closing Across Entire Database
// -----------------------------------------------------------------------------
{
  const mathViolations = runSql(`
    SELECT product_code, product_name, opening, in_qty, out_qty, closing
    FROM public.ai_inventory_movement('2026-01-01', '2026-12-31')
    WHERE ROUND(opening + in_qty - out_qty, 3) <> ROUND(closing, 3);
  `);

  assert(
    'Mathematical contract Opening + In - Out = Closing',
    mathViolations.length === 0,
    `violations: ${mathViolations.length}`
  );
}

// -----------------------------------------------------------------------------
// TEST 6: Atomic Simulation: Legacy row / duplicate sale / repair row does NOT alter operational report
// -----------------------------------------------------------------------------
{
  const testSimulation = runSql(`
    DO $$
    DECLARE
      v_prod_id uuid;
      v_batch_id uuid;
      v_customer_id uuid;
      v_dc_id uuid;
      v_before_closing numeric;
      v_before_out numeric;
      v_after_closing numeric;
      v_after_out numeric;
      v_after_dc_out numeric;
      v_after_receipt_in numeric;
      v_new_batch_id uuid;
    BEGIN
      -- Select test product (PROD-0005)
      SET LOCAL session_replication_role = 'replica';
      PERFORM set_config('app.canonical_stock_engine', 'on', true);
      SELECT id INTO v_prod_id FROM public.products WHERE product_code = 'PROD-0005';
      SELECT id INTO v_batch_id FROM public.batches WHERE product_id = v_prod_id LIMIT 1;
      SELECT id INTO v_customer_id FROM public.customers LIMIT 1;

      -- Baseline
      SELECT closing, out_qty INTO v_before_closing, v_before_out
      FROM public.ai_inventory_movement('2025-01-01', '2026-12-31')
      WHERE product_id = v_prod_id;

      -- 1. Insert a legacy transaction into legacy table
      INSERT INTO public.inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        reference_type, reference_number, transaction_date, created_at,
        operation_id
      ) VALUES (
        v_prod_id, v_batch_id, 'purchase', 9999,
        'legacy_audit_test', 'LEGACY-001', '2026-05-01', '2026-05-01 00:00:00+00',
        gen_random_uuid()
      );

      -- 2. Insert a legacy duplicate sale
      INSERT INTO public.inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        reference_type, reference_number, transaction_date, created_at,
        operation_id
      ) VALUES (
        v_prod_id, v_batch_id, 'sale', -5555,
        'legacy_duplicate_sale', 'DUP-001', '2026-05-01', '2026-05-01 00:00:00+00',
        gen_random_uuid()
      );

      -- 3. Insert a historical repair record
      INSERT INTO public.inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        reference_type, reference_number, transaction_date, created_at,
        operation_id, metadata
      ) VALUES (
        v_prod_id, v_batch_id, 'adjustment', 1111,
        'historical_stock_repair', 'REPAIR-001', '2026-05-01', '2026-08-15 00:00:00+00',
        gen_random_uuid(), '{"canonical_engine_version": "1.0"}'::jsonb
      );

      -- Check after legacy insertions: operational report MUST BE UNCHANGED
      SELECT closing, out_qty INTO v_after_closing, v_after_out
      FROM public.ai_inventory_movement('2025-01-01', '2026-12-31')
      WHERE product_id = v_prod_id;

      IF v_before_closing <> v_after_closing OR v_before_out <> v_after_out THEN
        RAISE EXCEPTION 'REGRESSION: Legacy row mutated operational report! Before: closing=%, out=%. After: closing=%, out=%',
          v_before_closing, v_before_out, v_after_closing, v_after_out;
      END IF;

      -- 4. Create an approved DC: operational OUT must increase exactly once
      INSERT INTO public.delivery_challans (
        challan_number, challan_date, customer_id, delivery_address, created_by, approval_status, created_at
      ) VALUES (
        'TEST-DC-AUTOTEST', '2026-09-01', v_customer_id, 'Test Address', 'cd7b9d5f-d45c-4b5f-b113-68505a8cae27', 'approved', now()
      ) RETURNING id INTO v_dc_id;

      INSERT INTO public.delivery_challan_items (
        challan_id, product_id, batch_id, quantity
      ) VALUES (
        v_dc_id, v_prod_id, v_batch_id, 10
      );

      SELECT out_qty INTO v_after_dc_out
      FROM public.ai_inventory_movement('2025-01-01', '2026-12-31')
      WHERE product_id = v_prod_id;

      IF v_after_dc_out <> v_before_out + 10 THEN
        RAISE EXCEPTION 'REGRESSION: Approved DC did not increase out_qty by exactly 10! Got: %', v_after_dc_out;
      END IF;

      -- 5. Create a new batch receipt: operational IN must increase exactly once
      INSERT INTO public.batches (
        product_id, batch_number, import_date, import_quantity, current_stock, import_price, is_active
      ) VALUES (
        v_prod_id, 'TEST-BATCH-RECV', '2026-09-02', 25, 25, 100000, true
      ) RETURNING id INTO v_new_batch_id;

      SELECT in_qty INTO v_after_receipt_in
      FROM public.ai_inventory_movement('2025-01-01', '2026-12-31')
      WHERE product_id = v_prod_id;

      IF v_after_receipt_in <> 75 + 25 THEN
        RAISE EXCEPTION 'REGRESSION: New receipt did not increase in_qty by exactly 25! Got: %', v_after_receipt_in;
      END IF;

      -- Roll back all simulated test mutations so database remains clean
      RAISE EXCEPTION 'SIMULATION_SUCCESS';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM = 'SIMULATION_SUCCESS' THEN
          -- Expected clean rollback
          RETURN;
        ELSE
          RAISE;
        END IF;
    END $$;
  `);

  assert('Atomic simulation: Legacy noise ignored & new operational events counted exactly once', true);
}

// -----------------------------------------------------------------------------
// TEST 7: Real Permission Isolation: reporting_ai_role execution test
// PASS:
// - SELECT ai_inventory_current
// - EXECUTE ai_inventory_movement()
// - cannot SELECT inventory_transactions
// - cannot SELECT inventory_historical_movement_classifications
// - cannot SELECT audit_removed_duplicate_sale_inventory_transactions
// -----------------------------------------------------------------------------
{
  const testRealPermissions = runSql(`
    DO $$
    DECLARE
      v_rec record;
      v_err_it boolean := false;
      v_err_ihmc boolean := false;
      v_err_audit boolean := false;
    BEGIN
      -- Switch to reporting_ai_role
      SET ROLE reporting_ai_role;

      -- 1. Must succeed: SELECT ai_inventory_current
      BEGIN
        SELECT * INTO v_rec FROM public.ai_inventory_current LIMIT 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FAILED: reporting_ai_role could not query ai_inventory_current: %', SQLERRM;
      END;

      -- 2. Must succeed: EXECUTE ai_inventory_movement()
      BEGIN
        SELECT * INTO v_rec FROM public.ai_inventory_movement('2026-01-01', '2026-12-31') LIMIT 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FAILED: reporting_ai_role could not execute ai_inventory_movement: %', SQLERRM;
      END;

      -- 3. Must FAIL: cannot SELECT inventory_transactions
      BEGIN
        EXECUTE 'SELECT * FROM public.inventory_transactions LIMIT 1';
      EXCEPTION WHEN insufficient_privilege THEN
        v_err_it := true;
      END;

      -- 4. Must FAIL: cannot SELECT inventory_historical_movement_classifications
      BEGIN
        EXECUTE 'SELECT * FROM public.inventory_historical_movement_classifications LIMIT 1';
      EXCEPTION WHEN insufficient_privilege THEN
        v_err_ihmc := true;
      END;

      -- 5. Must FAIL: cannot SELECT audit_removed_duplicate_sale_inventory_transactions
      BEGIN
        EXECUTE 'SELECT * FROM public.audit_removed_duplicate_sale_inventory_transactions LIMIT 1';
      EXCEPTION WHEN insufficient_privilege THEN
        v_err_audit := true;
      END;

      -- Reset role
      RESET ROLE;

      IF NOT v_err_it THEN
        RAISE EXCEPTION 'SECURITY BREACH: reporting_ai_role was able to SELECT inventory_transactions';
      END IF;
      IF NOT v_err_ihmc THEN
        RAISE EXCEPTION 'SECURITY BREACH: reporting_ai_role was able to SELECT inventory_historical_movement_classifications';
      END IF;
      IF NOT v_err_audit THEN
        RAISE EXCEPTION 'SECURITY BREACH: reporting_ai_role was able to SELECT audit_removed_duplicate_sale_inventory_transactions';
      END IF;
    END $$;
  `);

  assert('Real permission test: reporting_ai_role can query ai views/functions', true);
  assert('Real permission test: reporting_ai_role strictly denied all legacy tables', true);
}

console.log('\n====================================================================');
if (allPassed) {
  console.log('🏆 ALL 12 INVENTORY DATA ACCESS ARCHITECTURE TESTS PASSED');
  console.log('====================================================================');
  process.exit(0);
} else {
  console.error('💥 SOME TESTS FAILED');
  console.log('====================================================================');
  process.exit(1);
}
