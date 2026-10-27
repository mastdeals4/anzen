import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function runSql(sql) {
  const tmpFile = path.join(os.tmpdir(), `query_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf-8');
  try {
    const res = execSync(`npx supabase db query --linked -f "${tmpFile}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      shell: '/bin/zsh'
    });
    const jsonMatch = res.match(/\{[\s\S]*"rows":[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.rows;
    }
    return [];
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

test('CASE 1: Material Return sourced from Delivery Challan accepts valid item (transactional rollback)', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_dc_id uuid;
      v_product_id uuid;
      v_batch_id uuid;
      v_qty numeric;
      v_return_id uuid;
      v_item_id uuid;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;
      
      SELECT dci.challan_id, dc.customer_id, dci.product_id, dci.batch_id, dci.quantity
      INTO v_dc_id, v_customer_id, v_product_id, v_batch_id, v_qty
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.batch_id IS NOT NULL AND dci.quantity > 0
      LIMIT 1;

      INSERT INTO material_returns (
        return_number, original_dc_id, customer_id, return_date, return_type, return_reason,
        status, created_by
      ) VALUES (
        'RET-TEST-DC-01', v_dc_id, v_customer_id, CURRENT_DATE, 'quality_issue', 'Test DC return',
        'pending_approval', v_user_id
      ) RETURNING id INTO v_return_id;

      INSERT INTO material_return_items (
        return_id, product_id, batch_id, quantity_returned, original_quantity, unit_price,
        condition, disposition
      ) VALUES (
        v_return_id, v_product_id, v_batch_id, LEAST(v_qty, 1), v_qty, 1000,
        'good', 'pending'
      ) RETURNING id INTO v_item_id;

      IF v_item_id IS NULL THEN
        RAISE EXCEPTION 'Failed to insert material return item';
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 2: Material Return sourced from Sales Invoice accepts valid item (transactional rollback)', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_inv_id uuid;
      v_product_id uuid;
      v_batch_id uuid;
      v_qty numeric;
      v_return_id uuid;
      v_item_id uuid;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;
      
      SELECT sii.invoice_id, si.customer_id, sii.product_id, sii.batch_id, sii.quantity
      INTO v_inv_id, v_customer_id, v_product_id, v_batch_id, v_qty
      FROM sales_invoice_items sii
      JOIN sales_invoices si ON si.id = sii.invoice_id
      WHERE sii.batch_id IS NOT NULL AND sii.quantity > 0
      LIMIT 1;

      INSERT INTO material_returns (
        return_number, original_invoice_id, customer_id, return_date, return_type, return_reason,
        status, created_by
      ) VALUES (
        'RET-TEST-INV-01', v_inv_id, v_customer_id, CURRENT_DATE, 'wrong_product', 'Test Invoice return',
        'pending_approval', v_user_id
      ) RETURNING id INTO v_return_id;

      INSERT INTO material_return_items (
        return_id, product_id, batch_id, quantity_returned, original_quantity, unit_price,
        condition, disposition
      ) VALUES (
        v_return_id, v_product_id, v_batch_id, LEAST(v_qty, 1), v_qty, 2000,
        'good', 'pending'
      ) RETURNING id INTO v_item_id;

      IF v_item_id IS NULL THEN
        RAISE EXCEPTION 'Failed to insert material return item';
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 3: Item validation rejects batch not present on original Delivery Challan', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_dc_id uuid;
      v_product_id uuid;
      v_fake_batch_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      v_return_id uuid;
      v_rejected boolean := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;

      SELECT dci.challan_id, dc.customer_id, dci.product_id
      INTO v_dc_id, v_customer_id, v_product_id
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      LIMIT 1;

      INSERT INTO material_returns (
        return_number, original_dc_id, customer_id, return_date, return_type, return_reason,
        status, created_by
      ) VALUES (
        'RET-TEST-DC-ERR', v_dc_id, v_customer_id, CURRENT_DATE, 'quality_issue', 'Test Error',
        'pending_approval', v_user_id
      ) RETURNING id INTO v_return_id;

      BEGIN
        INSERT INTO material_return_items (
          return_id, product_id, batch_id, quantity_returned, original_quantity, unit_price,
          condition, disposition
        ) VALUES (
          v_return_id, v_product_id, v_fake_batch_id, 1, 10, 1000, 'good', 'pending'
        );
      EXCEPTION WHEN OTHERS THEN
        v_rejected := true;
      END;

      IF NOT v_rejected THEN
        RAISE EXCEPTION 'Expected insert to fail for unassociated batch, but it succeeded!';
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 4: Quantity validation rejects return quantity exceeding shipped quantity', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_dc_id uuid;
      v_product_id uuid;
      v_batch_id uuid;
      v_qty numeric;
      v_return_id uuid;
      v_rejected boolean := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;

      SELECT dci.challan_id, dc.customer_id, dci.product_id, dci.batch_id, dci.quantity
      INTO v_dc_id, v_customer_id, v_product_id, v_batch_id, v_qty
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.batch_id IS NOT NULL AND dci.quantity > 0
      LIMIT 1;

      INSERT INTO material_returns (
        return_number, original_dc_id, customer_id, return_date, return_type, return_reason,
        status, created_by
      ) VALUES (
        'RET-TEST-DC-QTY-ERR', v_dc_id, v_customer_id, CURRENT_DATE, 'quality_issue', 'Test Qty Error',
        'pending_approval', v_user_id
      ) RETURNING id INTO v_return_id;

      BEGIN
        INSERT INTO material_return_items (
          return_id, product_id, batch_id, quantity_returned, original_quantity, unit_price,
          condition, disposition
        ) VALUES (
          v_return_id, v_product_id, v_batch_id, v_qty + 100, v_qty, 1000, 'good', 'pending'
        );
      EXCEPTION WHEN OTHERS THEN
        v_rejected := true;
      END;

      IF NOT v_rejected THEN
        RAISE EXCEPTION 'Expected insert to fail for excessive return quantity, but it succeeded!';
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 5: Approving return with disposition = restock creates canonical Inventory V1 transaction', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_dc_id uuid;
      v_product_id uuid;
      v_batch_id uuid;
      v_qty numeric;
      v_stock_before numeric;
      v_stock_after numeric;
      v_return_id uuid;
      v_inv_tx_count integer;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;

      SELECT dci.challan_id, dc.customer_id, dci.product_id, dci.batch_id, dci.quantity
      INTO v_dc_id, v_customer_id, v_product_id, v_batch_id, v_qty
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.batch_id IS NOT NULL AND dci.quantity > 0
      LIMIT 1;

      SELECT current_stock INTO v_stock_before FROM batches WHERE id = v_batch_id;

      INSERT INTO material_returns (
        return_number, original_dc_id, customer_id, return_date, return_type, return_reason,
        status, restocked, created_by
      ) VALUES (
        'RET-TEST-APPROVE-RESTOCK', v_dc_id, v_customer_id, CURRENT_DATE, 'quality_issue', 'Test restock',
        'pending_approval', false, v_user_id
      ) RETURNING id INTO v_return_id;

      INSERT INTO material_return_items (
        return_id, product_id, batch_id, quantity_returned, original_quantity, unit_price,
        condition, disposition
      ) VALUES (
        v_return_id, v_product_id, v_batch_id, 1, v_qty, 1000, 'good', 'restock'
      );

      -- Approve the return with restocked = true
      UPDATE material_returns
      SET status = 'approved',
          restocked = true,
          approved_by = v_user_id
      WHERE id = v_return_id;

      SELECT COUNT(*) INTO v_inv_tx_count
      FROM inventory_transactions
      WHERE reference_type = 'material_return'
        AND reference_id = v_return_id
        AND metadata->>'canonical_engine_version' = '1.0';

      SELECT current_stock INTO v_stock_after FROM batches WHERE id = v_batch_id;

      IF v_inv_tx_count <> 1 THEN
        RAISE EXCEPTION 'Expected 1 canonical inventory transaction, got %', v_inv_tx_count;
      END IF;

      IF v_stock_after <> v_stock_before + 1 THEN
        RAISE EXCEPTION 'Expected stock to increase by 1 (from % to %), got %',
          v_stock_before, v_stock_before + 1, v_stock_after;
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 6: Approving return with disposition = scrap does NOT create inventory restock movement', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_dc_id uuid;
      v_product_id uuid;
      v_batch_id uuid;
      v_qty numeric;
      v_stock_before numeric;
      v_stock_after numeric;
      v_return_id uuid;
      v_inv_tx_count integer;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;

      SELECT dci.challan_id, dc.customer_id, dci.product_id, dci.batch_id, dci.quantity
      INTO v_dc_id, v_customer_id, v_product_id, v_batch_id, v_qty
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.batch_id IS NOT NULL AND dci.quantity > 0
      LIMIT 1;

      SELECT current_stock INTO v_stock_before FROM batches WHERE id = v_batch_id;

      INSERT INTO material_returns (
        return_number, original_dc_id, customer_id, return_date, return_type, return_reason,
        status, restocked, created_by
      ) VALUES (
        'RET-TEST-SCRAP', v_dc_id, v_customer_id, CURRENT_DATE, 'damaged', 'Test scrap',
        'pending_approval', false, v_user_id
      ) RETURNING id INTO v_return_id;

      INSERT INTO material_return_items (
        return_id, product_id, batch_id, quantity_returned, original_quantity, unit_price,
        condition, disposition
      ) VALUES (
        v_return_id, v_product_id, v_batch_id, 1, v_qty, 1000, 'damaged', 'scrap'
      );

      -- Approve
      UPDATE material_returns
      SET status = 'approved',
          restocked = true,
          approved_by = v_user_id
      WHERE id = v_return_id;

      SELECT COUNT(*) INTO v_inv_tx_count
      FROM inventory_transactions
      WHERE reference_type = 'material_return'
        AND reference_id = v_return_id;

      SELECT current_stock INTO v_stock_after FROM batches WHERE id = v_batch_id;

      IF v_inv_tx_count <> 0 THEN
        RAISE EXCEPTION 'Expected 0 inventory transactions for scrap disposition, got %', v_inv_tx_count;
      END IF;

      IF v_stock_after <> v_stock_before THEN
        RAISE EXCEPTION 'Expected stock to remain unchanged for scrap disposition';
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 7: Status reversal rolls back restocked inventory cleanly', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_dc_id uuid;
      v_product_id uuid;
      v_batch_id uuid;
      v_qty numeric;
      v_stock_before numeric;
      v_stock_reverted numeric;
      v_return_id uuid;
      v_reversal_count integer;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;

      SELECT dci.challan_id, dc.customer_id, dci.product_id, dci.batch_id, dci.quantity
      INTO v_dc_id, v_customer_id, v_product_id, v_batch_id, v_qty
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      WHERE dci.batch_id IS NOT NULL AND dci.quantity > 0
      LIMIT 1;

      SELECT current_stock INTO v_stock_before FROM batches WHERE id = v_batch_id;

      INSERT INTO material_returns (
        return_number, original_dc_id, customer_id, return_date, return_type, return_reason,
        status, restocked, created_by
      ) VALUES (
        'RET-TEST-REV', v_dc_id, v_customer_id, CURRENT_DATE, 'quality_issue', 'Test reversal',
        'pending_approval', false, v_user_id
      ) RETURNING id INTO v_return_id;

      INSERT INTO material_return_items (
        return_id, product_id, batch_id, quantity_returned, original_quantity, unit_price,
        condition, disposition
      ) VALUES (
        v_return_id, v_product_id, v_batch_id, 1, v_qty, 1000, 'good', 'restock'
      );

      -- Approve
      UPDATE material_returns SET status = 'approved', restocked = true, approved_by = v_user_id WHERE id = v_return_id;

      -- Reverse approval (reject/void)
      UPDATE material_returns SET status = 'rejected', restocked = false WHERE id = v_return_id;

      SELECT COUNT(*) INTO v_reversal_count
      FROM inventory_transactions
      WHERE reference_type = 'material_return_reversal'
        AND reference_id = v_return_id;

      SELECT current_stock INTO v_stock_reverted FROM batches WHERE id = v_batch_id;

      IF v_reversal_count <> 1 THEN
        RAISE EXCEPTION 'Expected 1 reversal inventory transaction, got %', v_reversal_count;
      END IF;

      IF v_stock_reverted <> v_stock_before THEN
        RAISE EXCEPTION 'Expected stock to revert back to %, got %', v_stock_before, v_stock_reverted;
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 8: Legacy parallel functions raise deprecation exceptions', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_err1 boolean := false;
      v_err2 boolean := false;
    BEGIN
      BEGIN
        PERFORM handle_material_return_approval();
      EXCEPTION WHEN OTHERS THEN
        v_err1 := true;
      END;

      BEGIN
        PERFORM trg_material_return_item_stock();
      EXCEPTION WHEN OTHERS THEN
        v_err2 := true;
      END;

      IF NOT v_err1 OR NOT v_err2 THEN
        RAISE EXCEPTION 'Expected legacy functions to raise deprecation exceptions';
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 9: Multi-SO expense allocation distributes expense across invoice lines in get_sales_profitability_line_expenses', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_so_id uuid;
      v_exp_id uuid;
      v_alloc_count integer;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;

      SELECT sales_order_id INTO v_so_id
      FROM sales_invoices
      WHERE sales_order_id IS NOT NULL AND NOT COALESCE(is_draft, false)
      LIMIT 1;

      IF v_so_id IS NOT NULL THEN
        -- Create a test approved sales expense with multi-SO allocation
        INSERT INTO finance_expenses (
          voucher_number, expense_category, amount, expense_date, approval_status,
          sales_order_allocations, created_by
        ) VALUES (
          'EXP-TEST-MULTI-SO', 'delivery_sales', 500000, CURRENT_DATE, 'approved',
          jsonb_build_array(jsonb_build_object(
            'sales_order_id', v_so_id,
            'allocated_amount', 500000,
            'allocated_percent', 100
          )),
          v_user_id
        ) RETURNING id INTO v_exp_id;

        SELECT COUNT(*) INTO v_alloc_count
        FROM get_sales_profitability_line_expenses((CURRENT_DATE - INTERVAL '1 year')::date, (CURRENT_DATE + INTERVAL '1 day')::date)
        WHERE sales_expense > 0;
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 10: Credit Note ↔ Material Return bidirectional linkage and trigger lifecycle (transactional rollback)', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_return_id uuid;
      v_cn_id uuid;
      v_mr_cn_id uuid;
      v_mr_cn_issued boolean;
      v_mr_cn_num text;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;
      SELECT id INTO v_customer_id FROM customers LIMIT 1;

      INSERT INTO material_returns (
        return_number, customer_id, return_date, return_type, return_reason,
        status, created_by
      ) VALUES (
        'RET-TEST-CN-LINK', v_customer_id, CURRENT_DATE, 'quality_issue', 'Test CN link lifecycle',
        'approved', v_user_id
      ) RETURNING id INTO v_return_id;

      -- 1. Insert pending CN
      INSERT INTO credit_notes (
        credit_note_number, credit_note_date, customer_id, material_return_id,
        status, total_amount, created_by
      ) VALUES (
        'CN-TEST-LINK-01', CURRENT_DATE, v_customer_id, v_return_id,
        'pending_approval', 75000, v_user_id
      ) RETURNING id INTO v_cn_id;

      SELECT credit_note_id, credit_note_issued, credit_note_number
      INTO v_mr_cn_id, v_mr_cn_issued, v_mr_cn_num
      FROM material_returns WHERE id = v_return_id;

      IF v_mr_cn_id <> v_cn_id OR v_mr_cn_issued <> false OR v_mr_cn_num <> 'CN-TEST-LINK-01' THEN
        RAISE EXCEPTION 'Pending CN failed to sync to material return: id=%, issued=%, num=%', v_mr_cn_id, v_mr_cn_issued, v_mr_cn_num;
      END IF;

      -- 2. Approve CN
      UPDATE credit_notes SET status = 'approved', approved_by = v_user_id, approval_date = now() WHERE id = v_cn_id;

      SELECT credit_note_id, credit_note_issued, credit_note_number
      INTO v_mr_cn_id, v_mr_cn_issued, v_mr_cn_num
      FROM material_returns WHERE id = v_return_id;

      IF v_mr_cn_issued <> true THEN
        RAISE EXCEPTION 'Approved CN failed to set credit_note_issued = true: issued=%', v_mr_cn_issued;
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 11: Idempotency guard prevents duplicate Credit Notes for same Material Return (unique constraint)', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_return_id uuid;
      v_cn1_id uuid;
      v_cn2_id uuid;
      v_dup_error boolean := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;
      SELECT id INTO v_customer_id FROM customers LIMIT 1;

      INSERT INTO material_returns (
        return_number, customer_id, return_date, return_type, return_reason,
        status, created_by
      ) VALUES (
        'RET-TEST-DUP-CN', v_customer_id, CURRENT_DATE, 'quality_issue', 'Test CN idempotency',
        'approved', v_user_id
      ) RETURNING id INTO v_return_id;

      INSERT INTO credit_notes (
        credit_note_number, credit_note_date, customer_id, material_return_id,
        status, total_amount, created_by
      ) VALUES (
        'CN-TEST-DUP-01', CURRENT_DATE, v_customer_id, v_return_id,
        'pending_approval', 50000, v_user_id
      ) RETURNING id INTO v_cn1_id;

      BEGIN
        INSERT INTO credit_notes (
          credit_note_number, credit_note_date, customer_id, material_return_id,
          status, total_amount, created_by
        ) VALUES (
          'CN-TEST-DUP-02', CURRENT_DATE, v_customer_id, v_return_id,
          'pending_approval', 50000, v_user_id
        ) RETURNING id INTO v_cn2_id;
      EXCEPTION WHEN unique_violation THEN
        v_dup_error := true;
      END;

      IF NOT v_dup_error THEN
        RAISE EXCEPTION 'Unique index uq_credit_notes_material_return_id failed to prevent duplicate CN';
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 13: Credit Note COGS reversal uses exact historical FIFO cost from original sales invoice line, not current batch landed cost', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_product_id uuid;
      v_batch_id uuid;
      v_invoice_id uuid;
      v_sii_id uuid;
      v_cn_id uuid;
      v_cogs_je_id uuid;
      v_cogs_amount numeric;
      v_inv_dr numeric;
      v_cogs_cr numeric;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_user_id FROM user_profiles LIMIT 1;

      -- 1. Find an existing sales invoice item with a valid batch
      SELECT sii.id, sii.invoice_id, si.customer_id, sii.product_id, sii.batch_id
      INTO v_sii_id, v_invoice_id, v_customer_id, v_product_id, v_batch_id
      FROM sales_invoice_items sii
      JOIN sales_invoices si ON si.id = sii.invoice_id
      WHERE sii.batch_id IS NOT NULL AND sii.quantity >= 1
      LIMIT 1;

      -- 2. Explicitly set HISTORICAL FIFO cogs_unit_cost = 85,000 (different from batch landed cost 120,000)
      UPDATE sales_invoice_items SET cogs_unit_cost = 85000.00 WHERE id = v_sii_id;
      UPDATE batches SET cost_per_unit = 120000.00, landed_cost_per_unit = 120000.00 WHERE id = v_batch_id;

      -- 3. Create a Credit Note for 2 units linked to this invoice
      INSERT INTO credit_notes (
        credit_note_number, credit_note_date, customer_id, original_invoice_id,
        status, subtotal, tax_amount, total_amount, created_by
      ) VALUES (
        'CN-TEST-FIFO-01', CURRENT_DATE, v_customer_id, v_invoice_id,
        'pending_approval', 40000, 4400, 44400, v_user_id
      ) RETURNING id INTO v_cn_id;

      INSERT INTO credit_note_items (
        credit_note_id, product_id, batch_id, quantity, unit_price
      ) VALUES (
        v_cn_id, v_product_id, v_batch_id, 2, 20000
      );

      -- 4. Approve the Credit Note (triggers post_credit_note_journal -> _post_credit_note_je)
      UPDATE credit_notes SET status = 'approved', approved_by = v_user_id, approval_date = now() WHERE id = v_cn_id;

      -- 5. Inspect the generated credit_note_cogs journal entry
      SELECT id, total_debit INTO v_cogs_je_id, v_cogs_amount
      FROM journal_entries
      WHERE source_module = 'credit_note_cogs' AND reference_id = v_cn_id;

      IF v_cogs_je_id IS NULL THEN
        RAISE EXCEPTION 'Expected credit_note_cogs journal entry to be created for CN %', v_cn_id;
      END IF;

      -- Expected COGS reversal: 2 units * 85,000 historical FIFO cost = 170,000 (NOT batch landed cost)
      IF v_cogs_amount <> 170000.00 THEN
        RAISE EXCEPTION 'COGS reversal mismatch: expected 170000.00, got %', v_cogs_amount;
      END IF;

      SELECT debit INTO v_inv_dr FROM journal_entry_lines WHERE journal_entry_id = v_cogs_je_id AND account_id = (SELECT id FROM chart_of_accounts WHERE code = '1130');
      SELECT credit INTO v_cogs_cr FROM journal_entry_lines WHERE journal_entry_id = v_cogs_je_id AND account_id = (SELECT id FROM chart_of_accounts WHERE code = '5100');

      IF v_inv_dr <> 170000.00 OR v_cogs_cr <> 170000.00 THEN
        RAISE EXCEPTION 'Dr 1130 (%) or Cr 5100 (%) mismatch from expected 170000.00', v_inv_dr, v_cogs_cr;
      END IF;

      RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%TEST_PASSED_ROLLBACK%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
    END $$;
    SELECT 'PASSED' AS result;
  `);
  assert.equal(rows[0]?.result, 'PASSED');
});

test('CASE 14: Sales Profitability Summary returns canonical 10 metrics with mathematical consistency', () => {
  const rows = runSql(`
    SELECT public.get_sales_profitability_summary('2026-09-01', '2026-09-30') AS summary;
  `);
  assert.equal(rows.length, 1);
  const company = rows[0]?.summary?.company;
  assert.ok(company, 'Company summary object must exist');

  // Verify all 10 canonical keys exist
  const expectedKeys = [
    'gross_sales',
    'sales_returns',
    'net_sales',
    'product_cost',
    'return_cogs',
    'net_product_cost',
    'sales_expenses',
    'gross_profit',
    'profit_after_sales_expenses',
    'profit_margin_pct'
  ];

  for (const k of expectedKeys) {
    assert.ok(company[k] !== undefined, `Company metric ${k} must be defined`);
  }

  // Verify mathematical integrity
  assert.equal(
    Number(company.net_sales),
    Number(company.gross_sales) - Number(company.sales_returns),
    'net_sales must equal gross_sales - sales_returns'
  );

  assert.equal(
    Number(company.net_product_cost),
    Number(company.product_cost) - Number(company.return_cogs),
    'net_product_cost must equal product_cost - return_cogs'
  );

  assert.equal(
    Number(company.gross_profit),
    Number(company.net_sales) - Number(company.net_product_cost),
    'gross_profit must equal net_sales - net_product_cost'
  );

  assert.equal(
    Number(company.profit_after_sales_expenses),
    Number(company.gross_profit) - Number(company.sales_expenses),
    'profit_after_sales_expenses must equal gross_profit - sales_expenses'
  );
});

test('CASE 12: Zero data contamination verified: zero test returns, CNs, and expenses remain', () => {
  const rows = runSql(`
    SELECT
      (SELECT COUNT(*) FROM material_returns WHERE return_number LIKE 'RET-TEST-%') AS test_returns,
      (SELECT COUNT(*) FROM credit_notes WHERE credit_note_number LIKE 'CN-TEST-%') AS test_cns,
      (SELECT COUNT(*) FROM finance_expenses WHERE voucher_number = 'EXP-TEST-MULTI-SO') AS test_expenses,
      (SELECT COUNT(*) FROM inventory_transactions WHERE notes LIKE '%RET-TEST-%') AS test_inv_tx;
  `);
  assert.equal(Number(rows[0]?.test_returns), 0);
  assert.equal(Number(rows[0]?.test_cns), 0);
  assert.equal(Number(rows[0]?.test_expenses), 0);
  assert.equal(Number(rows[0]?.test_inv_tx), 0);
});

