/*
  # Fix: DC should release SO reservations regardless of which batch was reserved

  ## Root Cause
  trg_auto_release_reservation_on_dc_item had:
    AND batch_id = NEW.batch_id
  
  This means it only released the SO reservation if the DC used the EXACT SAME
  batch that was originally reserved. Scenario that fails:
    1. SO approved → reserves Batch A (old batch) for 200 kg
    2. New shipment arrives → Batch B with fresh stock
    3. DC created using Batch B (FIFO picks it as available)
    4. Trigger fires but finds NO reservation for SO + product + Batch B
    5. Batch A reservation stays "active" → phantom 250 kg reserved
    6. SO never marks as "delivered" → reservation never auto-released

  ## Fix
  1. Remove AND batch_id = NEW.batch_id from the trigger — release by SO+product,
     any batch (the physical goods are dispatched regardless of which batch was
     originally reserved)
  2. Fix fn_restore_reservation_on_dc_delete — on DC rejection re-run the full
     reservation logic (fn_reserve_stock_for_so_v2) instead of hardcoding old batch
  3. Data fix: release stale active reservations for SOs that have approved DCs
*/

-- ===========================================================================
-- 1. Fix trg_auto_release_reservation_on_dc_item
--    Remove batch_id filter — release SO reservations for this product, any batch
-- ===========================================================================
CREATE OR REPLACE FUNCTION trg_auto_release_reservation_on_dc_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so_id uuid;
  v_reservation RECORD;
  v_remaining_qty numeric;
  v_release_qty numeric;
BEGIN
  -- Get the sales_order_id from the delivery challan
  SELECT sales_order_id INTO v_so_id
  FROM delivery_challans
  WHERE id = NEW.challan_id;

  -- Only process if DC is linked to a Sales Order
  IF v_so_id IS NOT NULL THEN
    v_remaining_qty := NEW.quantity;

    -- Release active SO reservations for this product, ANY batch (FIFO)
    -- KEY FIX: removed "AND batch_id = NEW.batch_id" so that when the DC uses
    -- a different batch than what was originally reserved, the old reservation
    -- is still released (goods are being dispatched regardless of source batch)
    FOR v_reservation IN
      SELECT id, reserved_quantity
      FROM stock_reservations
      WHERE sales_order_id = v_so_id
        AND product_id = NEW.product_id
        AND (status = 'active' OR (status IS NULL AND is_released = false))
      ORDER BY created_at ASC
    LOOP
      EXIT WHEN v_remaining_qty <= 0;

      v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);

      IF v_release_qty >= v_reservation.reserved_quantity THEN
        -- Fully release this reservation
        UPDATE stock_reservations
        SET
          status = 'released',
          is_released = true,
          released_at = now()
        WHERE id = v_reservation.id;
      ELSE
        -- Partially release
        UPDATE stock_reservations
        SET reserved_quantity = reserved_quantity - v_release_qty
        WHERE id = v_reservation.id;
      END IF;

      v_remaining_qty := v_remaining_qty - v_release_qty;
    END LOOP;

    -- If all SO reservations are now released → mark SO as delivered
    IF NOT EXISTS (
      SELECT 1 FROM stock_reservations
      WHERE sales_order_id = v_so_id
        AND (status = 'active' OR (status IS NULL AND is_released = false))
    ) THEN
      UPDATE sales_orders
      SET status = 'delivered', updated_at = now()
      WHERE id = v_so_id
        AND status NOT IN ('delivered', 'invoiced', 'closed', 'cancelled', 'rejected');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Rebind the trigger (function already replaced, this ensures it is active)
DROP TRIGGER IF EXISTS trigger_auto_release_reservation_on_dc_item ON delivery_challan_items;
CREATE TRIGGER trigger_auto_release_reservation_on_dc_item
  AFTER INSERT ON delivery_challan_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_auto_release_reservation_on_dc_item();


-- ===========================================================================
-- 2. Fix fn_restore_reservation_on_dc_delete
--    On DC delete/rejection, re-run fn_reserve_stock_for_so_v2 instead of
--    trying to restore the exact old batch reservation (which may not match)
-- ===========================================================================
CREATE OR REPLACE FUNCTION fn_restore_reservation_on_dc_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so_status text;
BEGIN
  IF OLD.sales_order_id IS NOT NULL THEN
    -- Get current SO status
    SELECT status INTO v_so_status FROM sales_orders WHERE id = OLD.sales_order_id;

    -- Only restore if the SO is not in a terminal state
    IF v_so_status NOT IN ('delivered', 'invoiced', 'closed', 'cancelled', 'rejected') THEN
      -- Re-run full reservation logic rather than recreating exact old batch reservation
      -- This correctly handles cases where the DC used a different batch than originally reserved
      PERFORM fn_reserve_stock_for_so_v2(OLD.sales_order_id);
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_restore_reservation_on_dc_delete ON delivery_challans;
CREATE TRIGGER trigger_restore_reservation_on_dc_delete
  BEFORE DELETE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION fn_restore_reservation_on_dc_delete();


-- ===========================================================================
-- 3. DATA FIX: Release stale active reservations for SOs that already have
--    approved Delivery Challans (goods already dispatched)
-- ===========================================================================

-- Release reservations for SOs that have an approved DC
-- and the reservation is still showing as active
UPDATE stock_reservations sr
SET
  status = 'released',
  is_released = true,
  released_at = now()
WHERE (sr.status = 'active' OR (sr.status IS NULL AND sr.is_released = false))
  AND EXISTS (
    SELECT 1 FROM delivery_challans dc
    WHERE dc.sales_order_id = sr.sales_order_id
      AND dc.approval_status = 'approved'
  );

-- Update SO status to 'delivered' for SOs whose DCs are approved
-- and now have no remaining active reservations
UPDATE sales_orders so
SET status = 'delivered', updated_at = now()
WHERE so.status IN ('stock_reserved', 'shortage', 'pending_delivery', 'approved')
  AND EXISTS (
    SELECT 1 FROM delivery_challans dc
    WHERE dc.sales_order_id = so.id
      AND dc.approval_status = 'approved'
  )
  AND NOT EXISTS (
    SELECT 1 FROM stock_reservations sr
    WHERE sr.sales_order_id = so.id
      AND (sr.status = 'active' OR (sr.status IS NULL AND sr.is_released = false))
  );

-- Recalculate all batch reserved_stock to fix any drift from above data fix
UPDATE batches b
SET reserved_stock = COALESCE((
  SELECT SUM(reserved_quantity)
  FROM stock_reservations
  WHERE batch_id = b.id
    AND status = 'active'
    AND (is_released IS NULL OR is_released = false)
), 0);
