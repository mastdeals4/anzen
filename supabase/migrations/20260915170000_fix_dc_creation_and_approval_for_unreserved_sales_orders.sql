-- ============================================================================
-- Migration: Fix Delivery Challan Creation & Approval for Sales Orders
-- Description:
-- 1. Updates validate_dc_item_product_reservation_v2 to validate delivery
--    quantity against the canonical remaining Sales Order deliverable quantity
--    (quantity - delivered_quantity minus pending DCs) rather than requiring
--    an existing active stock reservation, enabling delivery of orders created
--    under shortage once physical batch stock is available.
-- 2. Updates consume_so_product_reservation_v2 to safely consume active
--    reservations when present, or create a consumed reservation audit record
--    when delivering unreserved/shortage orders, ensuring 100% FK integrity,
--    inventory deduction, and accurate SO delivered quantity tracking.
-- ============================================================================

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
BEGIN
  SELECT dc.sales_order_id, dc.approval_status INTO v_dc
  FROM public.delivery_challans dc
  WHERE dc.id = NEW.challan_id;

  IF NOT FOUND OR NEW.sales_order_item_id IS NULL THEN
    RAISE EXCEPTION 'DC item requires a canonical SO item';
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
BEGIN
  SELECT dci.*, dc.id AS dc_id, dc.sales_order_id, dc.challan_number, dc.challan_date INTO v
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.id = p_dc_item_id
  FOR UPDATE OF dci, dc;

  IF NOT FOUND OR v.sales_order_item_id IS NULL THEN
    RAISE EXCEPTION 'DC item has no canonical SO item';
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

REVOKE ALL ON FUNCTION public.consume_so_product_reservation_v2(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_so_product_reservation_v2(uuid, uuid, uuid) TO authenticated, service_role;

COMMIT;
