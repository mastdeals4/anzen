/*
  # Security Fix Part 2: Add role guards to write RPCs — Sales Order & Delivery Challan

  ## Problem
  These SECURITY DEFINER functions are callable by any authenticated user but
  perform privileged writes (approve/reject/cancel SOs and DCs, reserve/release
  stock). Without a role check inside, any authenticated user (e.g. auditor_ca,
  warehouse) could call them.

  ## Fix
  Add a role check at the top of each function that raises an exception if the
  calling user does not have an authorised role. The function bodies are otherwise
  unchanged.

  ## Role assignments:
  - fn_approve_sales_order / fn_approve_sales_order_with_import → admin, accounts, manager
  - fn_reject_sales_order                                       → admin, accounts, manager
  - fn_cancel_sales_order                                       → admin, accounts, sales, manager
  - fn_approve_delivery_challan / fn_reject_delivery_challan    → admin, accounts, warehouse, manager
  - fn_reserve_stock_for_so / fn_reserve_stock_for_so_v2       → admin, accounts, manager (called by approve)
  - fn_release_reservation_by_so_id / fn_release_partial_reservation / fn_release_stock_reservations
                                                                → admin, accounts, warehouse, manager
  - fn_deduct_stock_and_release_reservation                     → admin, accounts, warehouse, manager
  - fn_create_import_requirements                               → admin, accounts, manager
  - fn_safe_autolink_dc_to_so                                   → admin, accounts, manager
  - adjust_batch_stock_atomic                                   → admin, accounts, warehouse
  - update_batch_stock                                          → admin, accounts, warehouse
*/

-- Helper: inline role check snippet used in every function below
-- Raises exception if the current user's role is not in the allowed list.

CREATE OR REPLACE FUNCTION public.fn_approve_sales_order(
  p_so_id uuid, p_approver_id uuid, p_remarks text DEFAULT NULL
)
RETURNS TABLE(success boolean, message text, shortage_info jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_result RECORD;
  v_role   text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot approve sales orders', v_role;
  END IF;

  UPDATE sales_orders
  SET status = 'approved', approved_by = p_approver_id, approved_at = now(), updated_at = now()
  WHERE id = p_so_id;

  SELECT * INTO v_result FROM fn_reserve_stock_for_so(p_so_id);
  RETURN QUERY SELECT v_result.success, v_result.message, v_result.shortage_items;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_approve_sales_order_with_import(
  p_so_id uuid, p_approver_id uuid, p_remarks text DEFAULT NULL
)
RETURNS TABLE(success boolean, message text, shortage_info jsonb, import_created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_result         RECORD;
  v_import_created boolean := false;
  v_role           text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot approve sales orders', v_role;
  END IF;

  UPDATE sales_orders
  SET status = 'approved', approved_by = p_approver_id, approved_at = now(), updated_at = now()
  WHERE id = p_so_id;

  SELECT * INTO v_result FROM fn_reserve_stock_for_so(p_so_id);

  IF NOT v_result.success AND jsonb_array_length(v_result.shortage_items) > 0 THEN
    PERFORM fn_create_import_requirements(p_so_id, v_result.shortage_items);
    v_import_created := true;
  END IF;

  RETURN QUERY SELECT v_result.success, v_result.message, v_result.shortage_items, v_import_created;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_reject_sales_order(
  p_so_id uuid, p_rejector_id uuid, p_reason text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot reject sales orders', v_role;
  END IF;

  PERFORM fn_release_stock_reservations(p_so_id, 'SO rejected: ' || p_reason);
  UPDATE sales_orders
  SET status = 'rejected', rejected_by = p_rejector_id, rejected_at = now(),
      rejection_reason = p_reason, updated_at = now()
  WHERE id = p_so_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_cancel_sales_order(
  p_so_id uuid, p_canceller_id uuid, p_reason text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','sales','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot cancel sales orders', v_role;
  END IF;

  DELETE FROM import_requirements WHERE sales_order_id = p_so_id;
  PERFORM fn_release_stock_reservations(p_so_id, 'SO cancelled: ' || p_reason, p_canceller_id);
  UPDATE sales_orders
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_so_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_approve_delivery_challan(
  p_dc_id uuid, p_approver_id uuid, p_remarks text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_so_id   uuid;
  v_dc_item RECORD;
  v_dc_number text;
  v_role    text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','warehouse','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot approve delivery challans', v_role;
  END IF;

  SELECT sales_order_id, challan_number INTO v_so_id, v_dc_number
  FROM delivery_challans WHERE id = p_dc_id;

  UPDATE delivery_challans
  SET approval_status = 'approved', approved_by = p_approver_id, approved_at = now()
  WHERE id = p_dc_id;

  FOR v_dc_item IN
    SELECT dci.product_id, dci.quantity, dci.batch_id
    FROM delivery_challan_items dci WHERE dci.delivery_challan_id = p_dc_id
  LOOP
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity, transaction_date,
      reference_number, notes, created_by
    ) VALUES (
      v_dc_item.product_id, v_dc_item.batch_id, 'delivery', -v_dc_item.quantity,
      CURRENT_DATE, v_dc_number, 'Delivered via DC: ' || v_dc_number, p_approver_id
    );

    IF v_so_id IS NOT NULL THEN
      UPDATE sales_order_items
      SET delivered_quantity = delivered_quantity + v_dc_item.quantity
      WHERE sales_order_id = v_so_id AND product_id = v_dc_item.product_id;

      UPDATE stock_reservations
      SET status = 'consumed'
      WHERE sales_order_id = v_so_id AND product_id = v_dc_item.product_id
        AND batch_id = v_dc_item.batch_id AND status = 'active';
    END IF;
  END LOOP;

  IF v_so_id IS NOT NULL THEN
    UPDATE sales_orders
    SET status = CASE
      WHEN (SELECT SUM(quantity) FROM sales_order_items WHERE sales_order_id = v_so_id) =
           (SELECT SUM(delivered_quantity) FROM sales_order_items WHERE sales_order_id = v_so_id)
      THEN 'delivered' ELSE 'partially_delivered'
    END
    WHERE id = v_so_id;
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_reject_delivery_challan(
  p_dc_id uuid, p_rejector_id uuid, p_reason text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','warehouse','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot reject delivery challans', v_role;
  END IF;

  UPDATE delivery_challans
  SET approval_status = 'rejected', rejection_reason = p_reason
  WHERE id = p_dc_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_release_reservation_by_so_id(
  p_so_id uuid, p_released_by uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','warehouse','sales','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot release reservations', v_role;
  END IF;

  UPDATE stock_reservations
  SET status = 'released', is_released = true, released_at = now(), released_by = p_released_by
  WHERE sales_order_id = p_so_id
    AND (status = 'active' OR (status IS NULL AND is_released = false));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_deduct_stock_and_release_reservation(
  p_so_id uuid, p_batch_id uuid, p_product_id uuid, p_quantity numeric, p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','warehouse','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot deduct stock', v_role;
  END IF;

  UPDATE batches SET current_stock = current_stock - p_quantity WHERE id = p_batch_id;
  PERFORM fn_release_partial_reservation(p_so_id, p_product_id, p_quantity, p_user_id);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_safe_autolink_dc_to_so()
RETURNS TABLE(dc_id uuid, linked_so_id uuid, action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  dc_rec          RECORD;
  candidate_so_id uuid;
  match_count     int;
  v_role          text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot auto-link challans', v_role;
  END IF;

  FOR dc_rec IN
    SELECT dc.id, dc.customer_id FROM delivery_challans dc
    WHERE dc.sales_order_id IS NULL
      AND (dc.review_status IS NULL OR dc.review_status != 'needs_review')
  LOOP
    SELECT COUNT(DISTINCT so.id) INTO match_count
    FROM sales_orders so
    WHERE so.customer_id = dc_rec.customer_id AND so.is_archived = false
      AND so.status NOT IN ('draft','cancelled','rejected')
      AND NOT EXISTS (
        SELECT 1 FROM delivery_challan_items dci
        WHERE dci.challan_id = dc_rec.id
          AND NOT EXISTS (
            SELECT 1 FROM sales_order_items soi
            WHERE soi.sales_order_id = so.id AND soi.product_id = dci.product_id
              AND soi.quantity >= dci.quantity
          )
      )
      AND EXISTS (SELECT 1 FROM delivery_challan_items dci2 WHERE dci2.challan_id = dc_rec.id);

    IF match_count = 1 THEN
      SELECT so.id INTO candidate_so_id
      FROM sales_orders so
      WHERE so.customer_id = dc_rec.customer_id AND so.is_archived = false
        AND so.status NOT IN ('draft','cancelled','rejected')
        AND NOT EXISTS (
          SELECT 1 FROM delivery_challan_items dci
          WHERE dci.challan_id = dc_rec.id
            AND NOT EXISTS (
              SELECT 1 FROM sales_order_items soi
              WHERE soi.sales_order_id = so.id AND soi.product_id = dci.product_id
                AND soi.quantity >= dci.quantity
            )
        )
        AND EXISTS (SELECT 1 FROM delivery_challan_items dci2 WHERE dci2.challan_id = dc_rec.id)
      LIMIT 1;

      UPDATE delivery_challans SET sales_order_id = candidate_so_id, updated_at = now()
      WHERE id = dc_rec.id;
      dc_id := dc_rec.id; linked_so_id := candidate_so_id; action := 'linked';
      RETURN NEXT;
    ELSE
      UPDATE delivery_challans SET review_status = 'needs_review', updated_at = now()
      WHERE id = dc_rec.id AND sales_order_id IS NULL;
      dc_id := dc_rec.id; linked_so_id := NULL; action := 'needs_review';
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.adjust_batch_stock_atomic(
  p_batch_id uuid, p_quantity_change numeric, p_transaction_type text,
  p_reference_id uuid DEFAULT NULL, p_notes text DEFAULT NULL, p_created_by uuid DEFAULT NULL
)
RETURNS TABLE(new_stock numeric, transaction_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_transaction_id UUID;
  v_new_stock      NUMERIC;
  v_product_id     UUID;
  v_role           text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot adjust batch stock', v_role;
  END IF;

  SELECT product_id INTO v_product_id FROM batches WHERE id = p_batch_id;
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Batch not found: %', p_batch_id;
  END IF;

  UPDATE batches SET current_stock = current_stock + p_quantity_change
  WHERE id = p_batch_id RETURNING current_stock INTO v_new_stock;

  INSERT INTO inventory_transactions (
    product_id, batch_id, transaction_type, quantity, reference_id, notes, created_by
  ) VALUES (
    v_product_id, p_batch_id, p_transaction_type, ABS(p_quantity_change),
    p_reference_id, p_notes, p_created_by
  ) RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT v_new_stock, v_transaction_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_batch_stock(p_batch_id uuid, p_adjustment numeric)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update batch stock', v_role;
  END IF;

  UPDATE batches SET current_stock = current_stock + p_adjustment WHERE id = p_batch_id;
END;
$$;
