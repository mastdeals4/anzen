BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_numeric(
  p_actual numeric,
  p_expected numeric,
  p_label text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF abs(COALESCE(p_actual, 0) - COALESCE(p_expected, 0)) > 0.001 THEN
    RAISE EXCEPTION '%: expected %, got %', p_label, p_expected, p_actual;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(
  p_condition boolean,
  p_label text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_condition, false) THEN
    RAISE EXCEPTION 'Assertion failed: %', p_label;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_sql text,
  p_expected_message text,
  p_label text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'Expected failure did not occur: %', p_label;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'Expected failure did not occur: ' || p_label THEN
        RAISE;
      END IF;
      IF position(p_expected_message IN SQLERRM) = 0 THEN
        RAISE EXCEPTION '% raised unexpected error: %', p_label, SQLERRM;
      END IF;
  END;
END;
$$;

DO $inventory_v1_regression$
DECLARE
  v_actor_id uuid;
  v_suffix text := replace(gen_random_uuid()::text, '-', '');
  v_result jsonb;
  v_certification jsonb;
  v_operation_id uuid;

  v_product_id uuid;
  v_customer_id uuid;
  v_batch_id uuid;
  v_archive_batch_id uuid;

  v_fefo_product_id uuid;
  v_expired_batch_id uuid;
  v_early_batch_id uuid;
  v_late_batch_id uuid;

  v_so_id uuid;
  v_so_item_id uuid;
  v_dc_id uuid;
  v_dc_item_id uuid;
  v_wrong_dc_id uuid;
  v_invoice_id uuid;
  v_invoice_item_id uuid;
  v_material_return_id uuid;
  v_credit_note_id uuid;
  v_rejection_id uuid;
BEGIN
  SELECT id
  INTO v_actor_id
  FROM public.user_profiles
  WHERE role = 'admin'
  ORDER BY created_at
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Inventory V1 regression requires an admin user profile';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role', 'sub', v_actor_id)::text,
    true
  );

  INSERT INTO public.products (
    product_name,
    product_code,
    unit,
    category,
    is_active,
    created_by
  )
  VALUES (
    'Inventory V1 Regression ' || v_suffix,
    'INV-' || v_suffix,
    'kg',
    'api',
    true,
    v_actor_id
  )
  RETURNING id INTO v_product_id;

  INSERT INTO public.customers (
    company_name,
    is_active,
    created_by
  )
  VALUES (
    'Inventory V1 Regression ' || v_suffix,
    true,
    v_actor_id
  )
  RETURNING id INTO v_customer_id;

  -- Batch Creation is the only stock IN and is idempotent.
  v_operation_id := gen_random_uuid();
  SELECT public.save_batch_inventory_v1(
    NULL,
    jsonb_build_object(
      'batch_number', 'B-' || v_suffix,
      'product_id', v_product_id,
      'import_date', CURRENT_DATE,
      'import_quantity', 100,
      'packaging_details', 'Regression batch',
      'import_price', 1000,
      'import_price_usd', NULL,
      'exchange_rate_usd_to_idr', NULL,
      'duty_percent', 0,
      'duty_charges', 0,
      'duty_charge_type', 'fixed',
      'freight_charges', 0,
      'freight_charge_type', 'fixed',
      'other_charges', 0,
      'other_charge_type', 'fixed',
      'expiry_date', CURRENT_DATE + 365
    ),
    v_operation_id
  )
  INTO v_result;

  v_batch_id := (v_result->>'batch_id')::uuid;

  SELECT public.save_batch_inventory_v1(
    NULL,
    jsonb_build_object(
      'batch_number', 'B-' || v_suffix,
      'product_id', v_product_id,
      'import_date', CURRENT_DATE,
      'import_quantity', 100,
      'packaging_details', 'Regression batch',
      'import_price', 1000,
      'duty_percent', 0,
      'duty_charges', 0,
      'duty_charge_type', 'fixed',
      'freight_charges', 0,
      'freight_charge_type', 'fixed',
      'other_charges', 0,
      'other_charge_type', 'fixed',
      'expiry_date', CURRENT_DATE + 365
    ),
    v_operation_id
  )
  INTO v_result;

  PERFORM pg_temp.assert_true(
    (v_result->>'batch_id')::uuid = v_batch_id
      AND COALESCE((v_result->>'idempotent_retry')::boolean, false),
    'Batch Create idempotent retry'
  );
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_batch_id),
    100,
    'Batch Create current stock'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT count(*)
      FROM public.inventory_transactions
      WHERE batch_id = v_batch_id
        AND transaction_type = 'purchase'
        AND metadata->>'canonical_engine_version' = '1.0'
    ),
    1,
    'Batch Create single canonical movement'
  );

  -- Batch edits append a correction movement; they never rewrite history.
  SELECT public.save_batch_inventory_v1(
    v_batch_id,
    jsonb_build_object(
      'batch_number', 'B-' || v_suffix,
      'product_id', v_product_id,
      'import_date', CURRENT_DATE,
      'import_quantity', 110,
      'packaging_details', 'Regression batch edited',
      'import_price', 1000,
      'duty_percent', 0,
      'duty_charges', 0,
      'duty_charge_type', 'fixed',
      'freight_charges', 0,
      'freight_charge_type', 'fixed',
      'other_charges', 0,
      'other_charge_type', 'fixed',
      'expiry_date', CURRENT_DATE + 365
    ),
    gen_random_uuid()
  )
  INTO v_result;

  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_batch_id),
    110,
    'Batch Edit current stock'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT sum(quantity)
      FROM public.inventory_transactions
      WHERE batch_id = v_batch_id
        AND metadata->>'canonical_engine_version' = '1.0'
    ),
    110,
    'Batch Edit movement reconciliation'
  );

  v_operation_id := gen_random_uuid();
  PERFORM *
  FROM public.adjust_batch_stock_atomic(
    v_batch_id,
    -5,
    'adjustment',
    NULL,
    'Inventory V1 regression adjustment',
    v_actor_id,
    v_operation_id
  );
  PERFORM *
  FROM public.adjust_batch_stock_atomic(
    v_batch_id,
    -5,
    'adjustment',
    NULL,
    'Inventory V1 regression adjustment',
    v_actor_id,
    v_operation_id
  );

  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_batch_id),
    105,
    'Stock Adjustment idempotent retry'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT count(*)
      FROM public.inventory_transactions
      WHERE operation_id = v_operation_id
    ),
    1,
    'Stock Adjustment duplicate prevention'
  );

  PERFORM pg_temp.assert_raises(
    format(
      'SELECT * FROM public.adjust_batch_stock_atomic(%L::uuid, -106, ''adjustment'', NULL, NULL, %L::uuid, gen_random_uuid())',
      v_batch_id,
      v_actor_id
    ),
    'Insufficient stock',
    'Negative stock prevention'
  );
  PERFORM pg_temp.assert_raises(
    format(
      'UPDATE public.batches SET current_stock = current_stock + 1 WHERE id = %L::uuid',
      v_batch_id
    ),
    'Direct batch quantity write blocked',
    'Direct batch quantity guard'
  );
  PERFORM pg_temp.assert_raises(
    format(
      'INSERT INTO public.inventory_transactions
         (operation_id, product_id, batch_id, transaction_type, quantity)
       VALUES (gen_random_uuid(), %L::uuid, %L::uuid, ''adjustment'', 1)',
      v_product_id,
      v_batch_id
    ),
    'Direct inventory movement write blocked',
    'Direct inventory movement guard'
  );
  PERFORM pg_temp.assert_raises(
    format('DELETE FROM public.batches WHERE id = %L::uuid', v_batch_id),
    'Batch with inventory history cannot be deleted',
    'Batch history delete guard'
  );

  SELECT public.archive_batch_inventory_v1(v_batch_id) INTO v_result;
  PERFORM pg_temp.assert_true(
    NOT (v_result->>'archived')::boolean,
    'Batch with non-zero stock cannot be archived'
  );

  -- FEFO: expired batch is excluded, then earliest expiry is reserved first.
  INSERT INTO public.products (
    product_name,
    product_code,
    unit,
    category,
    is_active,
    created_by
  )
  VALUES (
    'Inventory V1 FEFO ' || v_suffix,
    'FEFO-' || v_suffix,
    'kg',
    'api',
    true,
    v_actor_id
  )
  RETURNING id INTO v_fefo_product_id;

  SELECT public.save_batch_inventory_v1(
    NULL,
    jsonb_build_object(
      'batch_number', 'EXP-' || v_suffix,
      'product_id', v_fefo_product_id,
      'import_date', CURRENT_DATE - 90,
      'import_quantity', 30,
      'packaging_details', 'Expired regression batch',
      'import_price', 1000,
      'duty_percent', 0,
      'duty_charges', 0,
      'duty_charge_type', 'fixed',
      'freight_charges', 0,
      'freight_charge_type', 'fixed',
      'other_charges', 0,
      'other_charge_type', 'fixed',
      'expiry_date', CURRENT_DATE - 1
    ),
    gen_random_uuid()
  )
  INTO v_result;
  v_expired_batch_id := (v_result->>'batch_id')::uuid;

  SELECT public.save_batch_inventory_v1(
    NULL,
    jsonb_build_object(
      'batch_number', 'EARLY-' || v_suffix,
      'product_id', v_fefo_product_id,
      'import_date', CURRENT_DATE - 30,
      'import_quantity', 40,
      'packaging_details', 'Early expiry regression batch',
      'import_price', 1000,
      'duty_percent', 0,
      'duty_charges', 0,
      'duty_charge_type', 'fixed',
      'freight_charges', 0,
      'freight_charge_type', 'fixed',
      'other_charges', 0,
      'other_charge_type', 'fixed',
      'expiry_date', CURRENT_DATE + 30
    ),
    gen_random_uuid()
  )
  INTO v_result;
  v_early_batch_id := (v_result->>'batch_id')::uuid;

  SELECT public.save_batch_inventory_v1(
    NULL,
    jsonb_build_object(
      'batch_number', 'LATE-' || v_suffix,
      'product_id', v_fefo_product_id,
      'import_date', CURRENT_DATE - 20,
      'import_quantity', 100,
      'packaging_details', 'Late expiry regression batch',
      'import_price', 1000,
      'duty_percent', 0,
      'duty_charges', 0,
      'duty_charge_type', 'fixed',
      'freight_charges', 0,
      'freight_charge_type', 'fixed',
      'other_charges', 0,
      'other_charge_type', 'fixed',
      'expiry_date', CURRENT_DATE + 180
    ),
    gen_random_uuid()
  )
  INTO v_result;
  v_late_batch_id := (v_result->>'batch_id')::uuid;

  INSERT INTO public.sales_orders (
    so_number,
    customer_id,
    customer_po_number,
    customer_po_date,
    so_date,
    status,
    subtotal_amount,
    tax_amount,
    total_amount,
    created_by
  )
  VALUES (
    'SO-' || v_suffix,
    v_customer_id,
    'PO-' || v_suffix,
    CURRENT_DATE,
    CURRENT_DATE,
    'pending_approval',
    5000,
    0,
    5000,
    v_actor_id
  )
  RETURNING id INTO v_so_id;

  INSERT INTO public.sales_order_items (
    sales_order_id,
    product_id,
    quantity,
    delivered_quantity,
    unit_price,
    line_total
  )
  VALUES (
    v_so_id,
    v_fefo_product_id,
    50,
    0,
    100,
    5000
  )
  RETURNING id INTO v_so_item_id;

  PERFORM *
  FROM public.approve_sales_order_inventory_v1(v_so_id, v_actor_id);

  PERFORM pg_temp.assert_numeric(
    (
      SELECT COALESCE(sum(reserved_quantity), 0)
      FROM public.so_product_reservations
      WHERE sales_order_id = v_so_id
        AND status = 'active'
    ),
    50,
    'Sales Order creates a product-level reservation'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT count(*)
      FROM public.stock_reservations
      WHERE sales_order_id = v_so_id
        AND status = 'active'
    ),
    0,
    'Sales Order does not create batch-level reservations'
  );
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    40,
    'Sales Order reservation does not change physical stock'
  );

  UPDATE public.sales_orders
  SET status='rejected',rejected_by=v_actor_id,rejected_at=now(),
      rejection_reason='rollback regression'
  WHERE id=v_so_id;
  PERFORM pg_temp.assert_numeric(
    (
      SELECT COALESCE(sum(reserved_quantity), 0)
      FROM public.so_product_reservations
      WHERE sales_order_id = v_so_id
        AND status = 'active'
    ),
    0,
    'SO rejection releases the product reservation'
  );
  PERFORM pg_temp.assert_numeric(
    (SELECT reserved_stock FROM public.batches WHERE id = v_early_batch_id),
    0,
    'Product reservation lifecycle does not change batch reserved stock'
  );

  PERFORM public.approve_sales_order_product_reservation_v2(v_so_id, v_actor_id);
  PERFORM pg_temp.assert_numeric(
    (SELECT COALESCE(sum(reserved_quantity),0) FROM public.so_product_reservations
      WHERE sales_order_id=v_so_id AND status='active'),
    50,
    'SO re-approval recreates the product reservation'
  );

  INSERT INTO public.delivery_challans (
    challan_number,
    customer_id,
    challan_date,
    delivery_address,
    sales_order_id,
    approval_status,
    created_by
  )
  VALUES (
    'DO-' || v_suffix,
    v_customer_id,
    CURRENT_DATE,
    'Regression address',
    v_so_id,
    'pending_approval',
    v_actor_id
  )
  RETURNING id INTO v_dc_id;

  INSERT INTO public.delivery_challan_items (
    challan_id,
    sales_order_item_id,
    product_id,
    batch_id,
    quantity
  )
  VALUES (
    v_dc_id,
    v_so_item_id,
    v_fefo_product_id,
    v_early_batch_id,
    20
  )
  RETURNING id INTO v_dc_item_id;

  UPDATE public.delivery_challans
  SET approval_status = 'approved',
      approval_operation_id = gen_random_uuid(),
      approved_by = v_actor_id,
      approved_at = now()
  WHERE id = v_dc_id;

  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    20,
    'Delivery Challan is the physical stock OUT event'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT sum(quantity)
      FROM public.inventory_transactions
      WHERE reference_type = 'delivery_challan'
        AND reference_id = v_dc_id
        AND metadata->>'canonical_engine_version' = '1.0'
    ),
    -20,
    'Delivery Challan canonical movement'
  );

  -- Sales Invoice validates the approved DC but never changes stock.
  INSERT INTO public.sales_invoices (
    invoice_number,
    customer_id,
    invoice_date,
    subtotal,
    tax_amount,
    total_amount,
    payment_status,
    linked_challan_ids,
    is_draft,
    created_by
  )
  VALUES (
    'SI-' || v_suffix,
    v_customer_id,
    CURRENT_DATE,
    1500,
    0,
    1500,
    'pending',
    ARRAY[v_dc_id::text],
    true,
    v_actor_id
  )
  RETURNING id INTO v_invoice_id;

  INSERT INTO public.sales_invoice_items (
    invoice_id,
    product_id,
    batch_id,
    delivery_challan_item_id,
    quantity,
    unit_price,
    tax_rate
  )
  VALUES (
    v_invoice_id,
    v_fefo_product_id,
    v_early_batch_id,
    v_dc_item_id,
    20,
    100,
    0
  )
  RETURNING id INTO v_invoice_item_id;

  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    20,
    'Sales Invoice Create does not move stock'
  );

  UPDATE public.sales_invoice_items
  SET quantity = 10
  WHERE id = v_invoice_item_id;
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    20,
    'Sales Invoice Edit does not move stock'
  );

  PERFORM pg_temp.assert_raises(
    format(
      'INSERT INTO public.sales_invoice_items
         (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 1, 100, 0)',
      v_invoice_id,
      v_fefo_product_id,
      v_early_batch_id
    ),
    'must reference an approved Delivery Challan item',
    'Unlinked Sales Invoice item guard'
  );
  PERFORM pg_temp.assert_raises(
    format(
      'UPDATE public.sales_invoice_items SET quantity = 21 WHERE id = %L::uuid',
      v_invoice_item_id
    ),
    'exceeds approved Delivery Challan quantity',
    'Sales Invoice over-allocation guard'
  );
  PERFORM pg_temp.assert_raises(
    format(
      'SELECT public.admin_edit_approved_delivery_challan(
         %L::uuid,
         ''[]''::jsonb,
         gen_random_uuid()
       )',
      v_dc_id
    ),
    'already invoiced',
    'Approved invoiced Delivery Challan edit guard'
  );
  PERFORM pg_temp.assert_raises(
    format(
      'UPDATE public.delivery_challans
       SET approval_status = ''rejected'', rejected_by = %L::uuid
       WHERE id = %L::uuid',
      v_actor_id,
      v_dc_id
    ),
    'already invoiced',
    'Approved invoiced Delivery Challan reversal guard'
  );

  -- Material Return posts stock IN and reversal posts the opposite movement.
  INSERT INTO public.material_returns (
    return_number,
    original_dc_id,
    original_invoice_id,
    customer_id,
    return_date,
    return_type,
    return_reason,
    status,
    restocked,
    created_by
  )
  VALUES (
    'MR-' || v_suffix,
    v_dc_id,
    v_invoice_id,
    v_customer_id,
    CURRENT_DATE,
    'quality_issue',
    'Regression return',
    'pending_approval',
    false,
    v_actor_id
  )
  RETURNING id INTO v_material_return_id;

  INSERT INTO public.material_return_items (
    return_id,
    product_id,
    batch_id,
    quantity_returned,
    original_quantity,
    unit_price,
    condition,
    disposition
  )
  VALUES (
    v_material_return_id,
    v_fefo_product_id,
    v_early_batch_id,
    3,
    20,
    100,
    'good',
    'restock'
  );

  UPDATE public.material_returns
  SET status = 'approved',
      restocked = true,
      approved_by = v_actor_id
  WHERE id = v_material_return_id;
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    23,
    'Material Return approval'
  );

  UPDATE public.material_returns
  SET status = 'rejected',
      restocked = false
  WHERE id = v_material_return_id;
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    20,
    'Material Return reversal'
  );

  -- Credit Note stock return and reversal.
  INSERT INTO public.credit_notes (
    credit_note_number,
    credit_note_date,
    customer_id,
    original_invoice_id,
    original_invoice_number,
    reason,
    currency,
    subtotal,
    tax_amount,
    total_amount,
    status,
    created_by
  )
  VALUES (
    'CN-' || v_suffix,
    CURRENT_DATE,
    v_customer_id,
    v_invoice_id,
    'SI-' || v_suffix,
    'Regression credit note',
    'IDR',
    200,
    0,
    200,
    'pending_approval',
    v_actor_id
  )
  RETURNING id INTO v_credit_note_id;

  INSERT INTO public.credit_note_items (
    credit_note_id,
    product_id,
    batch_id,
    quantity,
    unit_price
  )
  VALUES (
    v_credit_note_id,
    v_fefo_product_id,
    v_early_batch_id,
    2,
    100
  );

  UPDATE public.credit_notes
  SET status = 'approved',
      approved_by = v_actor_id
  WHERE id = v_credit_note_id;
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    22,
    'Credit Note approval'
  );

  UPDATE public.credit_notes
  SET status = 'rejected'
  WHERE id = v_credit_note_id;
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    20,
    'Credit Note reversal'
  );

  -- Stock Rejection stock OUT and reversal.
  INSERT INTO public.stock_rejections (
    rejection_number,
    batch_id,
    product_id,
    rejection_date,
    quantity_rejected,
    rejection_reason,
    rejection_details,
    status,
    unit_cost,
    created_by,
    inspected_by
  )
  VALUES (
    'REJ-' || v_suffix,
    v_early_batch_id,
    v_fefo_product_id,
    CURRENT_DATE,
    1,
    'quality_failed',
    'Regression rejection',
    'pending_approval',
    100,
    v_actor_id,
    v_actor_id
  )
  RETURNING id INTO v_rejection_id;

  UPDATE public.stock_rejections
  SET status = 'approved',
      approved_by = v_actor_id
  WHERE id = v_rejection_id;
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    19,
    'Stock Rejection approval'
  );

  UPDATE public.stock_rejections
  SET status = 'rejected'
  WHERE id = v_rejection_id;
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    20,
    'Stock Rejection reversal'
  );

  -- Invoice deletion remains accounting-only; then DC reversal restores stock
  -- and recreates the outstanding SO reservation through the same FEFO engine.
  DELETE FROM public.sales_invoice_items WHERE id = v_invoice_item_id;
  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    20,
    'Sales Invoice Delete does not move stock'
  );

  UPDATE public.delivery_challans
  SET approval_status = 'rejected',
      rejected_by = v_actor_id
  WHERE id = v_dc_id;

  PERFORM pg_temp.assert_numeric(
    (SELECT current_stock FROM public.batches WHERE id = v_early_batch_id),
    40,
    'Delivery Challan reversal restores stock'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT COALESCE(sum(reserved_quantity), 0)
      FROM public.so_product_reservations
      WHERE sales_order_id = v_so_id
        AND status = 'active'
    ),
    50,
    'Delivery Challan reversal restores the product reservation'
  );
  PERFORM pg_temp.assert_raises(
    format(
      'UPDATE public.delivery_challans
       SET approval_status = ''approved'',
           approval_operation_id = gen_random_uuid()
       WHERE id = %L::uuid',
      v_dc_id
    ),
    'cannot be re-approved',
    'Reversed Delivery Challan cannot be re-approved'
  );
  PERFORM pg_temp.assert_raises(
    format('DELETE FROM public.delivery_challans WHERE id = %L::uuid', v_dc_id),
    'cannot be deleted',
    'Delivery Challan history delete guard'
  );

  -- A zero-stock batch can be archived, but its creation and adjustment
  -- movements remain immutable.
  SELECT public.save_batch_inventory_v1(
    NULL,
    jsonb_build_object(
      'batch_number', 'ARCH-' || v_suffix,
      'product_id', v_product_id,
      'import_date', CURRENT_DATE,
      'import_quantity', 5,
      'packaging_details', 'Archive regression batch',
      'import_price', 1000,
      'duty_percent', 0,
      'duty_charges', 0,
      'duty_charge_type', 'fixed',
      'freight_charges', 0,
      'freight_charge_type', 'fixed',
      'other_charges', 0,
      'other_charge_type', 'fixed',
      'expiry_date', CURRENT_DATE + 365
    ),
    gen_random_uuid()
  )
  INTO v_result;
  v_archive_batch_id := (v_result->>'batch_id')::uuid;

  PERFORM *
  FROM public.adjust_batch_stock_atomic(
    v_archive_batch_id,
    -5,
    'adjustment',
    NULL,
    'Zero before archive',
    v_actor_id,
    gen_random_uuid()
  );

  SELECT public.archive_batch_inventory_v1(v_archive_batch_id) INTO v_result;
  PERFORM pg_temp.assert_true(
    (v_result->>'archived')::boolean
      AND NOT (
        SELECT is_active
        FROM public.batches
        WHERE id = v_archive_batch_id
      ),
    'Batch archive preserves row and history'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT count(*)
      FROM public.inventory_transactions
      WHERE batch_id = v_archive_batch_id
    ),
    2,
    'Batch archive preserves movement history'
  );

  PERFORM pg_temp.assert_numeric(
    (
      SELECT total_current_stock
      FROM public.inventory_v1_stock_summary
      WHERE product_id = v_fefo_product_id
    ),
    170,
    'Canonical Stock Summary physical balance'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT reserved_stock
      FROM public.inventory_v1_stock_summary
      WHERE product_id = v_fefo_product_id
    ),
    0,
    'Batch Stock Summary has no batch-level SO reservation balance'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT available_quantity
      FROM public.inventory_v1_stock_summary
      WHERE product_id = v_fefo_product_id
    ),
    140,
    'Batch Stock Summary excludes expired stock from physical availability'
  );
  PERFORM pg_temp.assert_numeric(
    public.product_available_to_promise(v_fefo_product_id,NULL),
    90,
    'Product ATP subtracts the active product-level SO commitment'
  );
  PERFORM pg_temp.assert_numeric(
    (
      SELECT closing
      FROM public.inventory_v1_movement_report(CURRENT_DATE, CURRENT_DATE)
      WHERE product_id = v_fefo_product_id
    ),
    170,
    'Canonical Inventory Movement report closing balance'
  );

  v_certification := public.inventory_v1_certification_status();
  PERFORM pg_temp.assert_true(
    (v_certification->>'certified')::boolean,
    'Inventory V1 database certification: ' || v_certification::text
  );

  RAISE NOTICE 'Inventory V1 rollback regression passed: %',
    v_certification::text;
END;
$inventory_v1_regression$;

ROLLBACK;
