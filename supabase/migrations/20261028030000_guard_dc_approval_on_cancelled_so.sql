-- Migration: 20261028030000_guard_dc_approval_on_cancelled_so.sql
-- Description:
-- 1. Prevents Delivery Challan item modifications when linked Sales Order is cancelled or rejected.
-- 2. Prevents Delivery Challan approval and inventory deduction when linked Sales Order is cancelled or rejected.
-- 3. Auto-cancels/rejects any draft or pending Delivery Challans when a Sales Order is cancelled or rejected.
-- 4. Ensures strict transactional data integrity between Sales Orders, Delivery Challans, and Physical Stock.

BEGIN;

-- 1. Update validate_dc_item_product_reservation_v2 trigger function
CREATE OR REPLACE FUNCTION public.validate_dc_item_product_reservation_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dc record;
  v_so_item public.sales_order_items%ROWTYPE;
  v_pending numeric;
  v_remaining numeric;
  v_so_make uuid;
  v_batch_make uuid;
  v_so_status text;
BEGIN
  SELECT dc.sales_order_id, dc.approval_status INTO v_dc
  FROM public.delivery_challans dc
  WHERE dc.id = NEW.challan_id;

  IF NOT FOUND OR NEW.sales_order_item_id IS NULL THEN
    RAISE EXCEPTION 'DC item requires a canonical SO item';
  END IF;

  -- Verify parent Sales Order status
  IF v_dc.sales_order_id IS NOT NULL THEN
    SELECT status::text INTO v_so_status
    FROM public.sales_orders
    WHERE id = v_dc.sales_order_id;

    IF v_so_status IN ('cancelled', 'rejected') THEN
      RAISE EXCEPTION 'Cannot add or modify Delivery Challan items: linked Sales Order is %', v_so_status;
    END IF;
  END IF;

  SELECT * INTO v_so_item
  FROM public.sales_order_items soi
  WHERE soi.id = NEW.sales_order_item_id
    AND soi.sales_order_id = v_dc.sales_order_id
    AND soi.product_id = NEW.product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DC product does not match its SO item';
  END IF;

  v_so_make := v_so_item.make_id;

  SELECT b.make_id INTO v_batch_make
  FROM public.batches b
  WHERE b.id = NEW.batch_id
    AND b.product_id = NEW.product_id
    AND b.is_active = true
    AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected DC batch is not eligible for this product';
  END IF;

  -- NULL Make preserves historical records; known Make must match exactly.
  IF v_so_make IS NOT NULL AND v_batch_make IS DISTINCT FROM v_so_make THEN
    RAISE EXCEPTION 'Selected DC batch Make does not match the Sales Order Make';
  END IF;

  -- Validate against remaining deliverable Sales Order quantity (including other pending draft DCs)
  SELECT COALESCE(sum(dci.quantity), 0) INTO v_pending
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.sales_order_item_id = NEW.sales_order_item_id
    AND dc.approval_status = 'pending_approval'
    AND dci.id IS DISTINCT FROM NEW.id;

  v_remaining := v_so_item.quantity - COALESCE(v_so_item.delivered_quantity, 0);
  IF (v_pending + NEW.quantity) > (v_remaining + 0.0001) THEN
    RAISE EXCEPTION 'Delivery quantity (%) exceeds remaining Sales Order quantity (%)', (v_pending + NEW.quantity), v_remaining;
  END IF;

  RETURN NEW;
END;
$$;

-- 2. Update consume_so_product_reservation_v2 function
CREATE OR REPLACE FUNCTION public.consume_so_product_reservation_v2(
  p_dc_item_id uuid,
  p_operation_id uuid,
  p_actor uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v record;
  v_res public.so_product_reservations%ROWTYPE;
  v_soi record;
  v_tx uuid;
  v_after numeric;
  v_consume_qty numeric;
  v_res_id uuid;
  v_so_status text;
BEGIN
  SELECT dci.*, dc.id AS dc_id, dc.sales_order_id, dc.challan_number, dc.challan_date INTO v
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.id = p_dc_item_id
  FOR UPDATE OF dci, dc;

  IF NOT FOUND OR v.sales_order_item_id IS NULL THEN
    RAISE EXCEPTION 'DC item has no canonical SO item';
  END IF;

  -- Guard: linked Sales Order must be eligible for delivery
  IF v.sales_order_id IS NOT NULL THEN
    SELECT status::text INTO v_so_status
    FROM public.sales_orders
    WHERE id = v.sales_order_id;

    IF v_so_status IN ('cancelled', 'rejected') THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan %: linked Sales Order is %', v.challan_number, v_so_status;
    END IF;
  END IF;

  SELECT * INTO v_soi
  FROM public.sales_order_items
  WHERE id = v.sales_order_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order item not found';
  END IF;

  -- Validate remaining SO quantity
  IF v.quantity > (v_soi.quantity - COALESCE(v_soi.delivered_quantity, 0) + 0.0001) THEN
    RAISE EXCEPTION 'DC quantity exceeds remaining Sales Order quantity';
  END IF;

  -- Validate physical batch stock
  IF NOT EXISTS (
    SELECT 1 FROM public.batches b
    WHERE b.id = v.batch_id
      AND b.product_id = v.product_id
      AND b.is_active = true
      AND b.current_stock >= v.quantity
      AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'Selected batch is invalid, expired, or has insufficient physical stock';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.dc_batch_allocations
    WHERE delivery_challan_item_id = v.id
      AND status = 'consumed'
  ) THEN
    RAISE EXCEPTION 'Delivery Challan item reservation is already consumed';
  END IF;

  -- Post inventory movement
  v_tx := public.post_inventory_movement(
    public.uuid_from_text('inventory-v2:dc:' || p_operation_id || ':' || v.id),
    v.product_id,
    v.batch_id,
    'delivery_challan',
    -v.quantity,
    v.challan_date,
    v.challan_number,
    'delivery_challan',
    v.dc_id,
    'Product delivery against DC batch',
    COALESCE(p_actor, auth.uid()),
    NULL,
    NULL
  );

  -- Check if there is an active reservation to consume
  SELECT * INTO v_res
  FROM public.so_product_reservations
  WHERE sales_order_item_id = v.sales_order_item_id
    AND product_id = v.product_id
    AND status = 'active'
  FOR UPDATE;

  IF FOUND THEN
    v_res_id := v_res.id;
    v_consume_qty := LEAST(v_res.reserved_quantity, v.quantity);
    v_after := v_res.reserved_quantity - v_consume_qty;

    UPDATE public.so_product_reservations SET
      reserved_quantity = v_after,
      status = CASE WHEN v_after = 0 THEN 'consumed' ELSE 'active' END,
      closed_at = CASE WHEN v_after = 0 THEN now() END,
      close_reason = CASE WHEN v_after = 0 THEN 'Fully delivered' END,
      updated_at = now()
    WHERE id = v_res.id;

    INSERT INTO public.so_product_reservation_events(
      reservation_id, sales_order_id, sales_order_item_id, event_type,
      quantity_delta, quantity_after, delivery_challan_item_id, reason, actor_id
    ) VALUES (
      v_res.id, v.sales_order_id, v.sales_order_item_id, 'consumed',
      -v_consume_qty, v_after, v.id, 'DC approval', COALESCE(p_actor, auth.uid())
    );
  ELSE
    -- If no active reservation existed prior to delivery (e.g. shortage SO fulfilled on stock arrival),
    -- create a fulfilled/consumed reservation record for complete audit trail & FK integrity in dc_batch_allocations
    INSERT INTO public.so_product_reservations(
      sales_order_id, sales_order_item_id, product_id, reserved_quantity,
      status, created_at, closed_at, close_reason, created_by
    ) VALUES (
      v.sales_order_id, v.sales_order_item_id, v.product_id, 0,
      'consumed', now(), now(), 'Direct DC delivery without prior reservation', COALESCE(p_actor, auth.uid())
    ) RETURNING id INTO v_res_id;

    INSERT INTO public.so_product_reservation_events(
      reservation_id, sales_order_id, sales_order_item_id, event_type,
      quantity_delta, quantity_after, delivery_challan_item_id, reason, actor_id
    ) VALUES (
      v_res_id, v.sales_order_id, v.sales_order_item_id, 'consumed',
      -v.quantity, 0, v.id, 'Direct DC delivery without prior reservation', COALESCE(p_actor, auth.uid())
    );
  END IF;

  INSERT INTO public.dc_batch_allocations(
    delivery_challan_id, delivery_challan_item_id, sales_order_item_id,
    reservation_id, product_id, batch_id, allocated_quantity,
    operation_id, inventory_transaction_id, created_by
  ) VALUES (
    v.dc_id, v.id, v.sales_order_item_id,
    v_res_id, v.product_id, v.batch_id, v.quantity,
    p_operation_id, v_tx, COALESCE(p_actor, auth.uid())
  );

  RETURN v_tx;
END;
$$;

-- 3. Update trg_dc_approval_product_reservation_v2 trigger function
CREATE OR REPLACE FUNCTION public.trg_dc_approval_product_reservation_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_so_status text;
BEGIN
  IF NEW.approval_status = 'approved'
     AND OLD.approval_status IS DISTINCT FROM 'approved' THEN
    IF NEW.approval_operation_id IS NULL THEN
      RAISE EXCEPTION 'approval_operation_id is required';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.delivery_challan_items WHERE challan_id = NEW.id) THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan % without items', NEW.challan_number;
    END IF;

    -- Validate that linked Sales Order is not cancelled or rejected
    IF NEW.sales_order_id IS NOT NULL THEN
      SELECT status::text INTO v_so_status
      FROM public.sales_orders
      WHERE id = NEW.sales_order_id;

      IF v_so_status IN ('cancelled', 'rejected') THEN
        RAISE EXCEPTION 'Cannot approve Delivery Challan %: linked Sales Order is %', NEW.challan_number, v_so_status;
      END IF;
    END IF;

    FOR r IN
      SELECT id FROM public.delivery_challan_items WHERE challan_id = NEW.id ORDER BY id
    LOOP
      PERFORM public.consume_so_product_reservation_v2(
        r.id,
        NEW.approval_operation_id,
        COALESCE(NEW.approved_by, auth.uid())
      );
    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
      PERFORM public.fn_recompute_so_status(NEW.sales_order_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 4. Update fn_cancel_sales_order
CREATE OR REPLACE FUNCTION public.fn_cancel_sales_order(p_so_id uuid, p_canceller_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_status text;
BEGIN
  SELECT role INTO v_role
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF v_role NOT IN ('admin', 'accounts', 'sales') THEN
    RAISE EXCEPTION
      'Permission denied: role % cannot cancel sales orders', v_role;
  END IF;

  SELECT status::text INTO v_status
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.delivery_challans dc
    WHERE dc.sales_order_id = p_so_id
      AND dc.approval_status = 'approved'
  ) THEN
    RAISE EXCEPTION
      'Sales Order has an approved Delivery Challan; reverse/cancel the Delivery Challan before cancelling the order';
  END IF;

  -- Automatically cancel/reject any draft or pending Delivery Challans linked to this order
  UPDATE public.delivery_challans
  SET approval_status = 'rejected',
      rejection_reason = 'Cancelled because linked Sales Order was cancelled: ' || p_reason,
      rejected_by = COALESCE(p_canceller_id, auth.uid()),
      rejected_at = now(),
      updated_at = now()
  WHERE sales_order_id = p_so_id
    AND approval_status IN ('draft', 'pending_approval');

  DELETE FROM public.import_requirements
  WHERE sales_order_id = p_so_id;

  PERFORM public.fn_release_stock_reservations(
    p_so_id,
    'SO cancelled: ' || p_reason,
    p_canceller_id
  );

  UPDATE public.sales_orders
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = p_so_id;

  RETURN true;
END;
$$;

-- 5. Update fn_reject_sales_order
CREATE OR REPLACE FUNCTION public.fn_reject_sales_order(p_so_id uuid, p_rejector_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot reject sales orders', v_role;
  END IF;

  -- Automatically cancel/reject any draft or pending Delivery Challans linked to this order
  UPDATE public.delivery_challans
  SET approval_status = 'rejected',
      rejection_reason = 'Rejected because linked Sales Order was rejected: ' || p_reason,
      rejected_by = COALESCE(p_rejector_id, auth.uid()),
      rejected_at = now(),
      updated_at = now()
  WHERE sales_order_id = p_so_id
    AND approval_status IN ('draft', 'pending_approval');

  PERFORM public.fn_release_stock_reservations(p_so_id, 'SO rejected: ' || p_reason);

  UPDATE public.sales_orders
  SET status = 'rejected',
      rejected_by = p_rejector_id,
      rejected_at = now(),
      rejection_reason = p_reason,
      updated_at = now()
  WHERE id = p_so_id;

  RETURN true;
END;
$$;

COMMIT;
