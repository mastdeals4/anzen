/*
  # Fix Stale Reservations and Release Function Bug

  ## Root Cause
  The fn_release_reservation_by_so_id and fn_release_partial_reservation functions
  (rewritten in migration 20260219043341) set is_released = true but do NOT set
  status = 'released'. However, the trigger trg_sync_batch_reserved_stock calculates
  batches.reserved_stock based on status = 'active', NOT is_released. 
  
  Result: reservations for cancelled/delivered/invoiced SOs still count as "active",
  causing massive phantom reserved quantities (e.g. Ibuprofen BP showing -2,550 kg available).

  ## Fix
  1. Fix fn_release_reservation_by_so_id to set BOTH status='released' AND is_released=true
  2. Fix fn_release_partial_reservation similarly
  3. Fix fn_auto_release_on_so_status_change to also release on delivered/invoiced/closed
  4. Data cleanup: sync is_released=true rows to status='released'
  5. Release active reservations for SOs already in terminal states
  6. Recalculate ALL batch reserved_stock
*/

-- ================================================================
-- 1. Fix fn_release_reservation_by_so_id
--    Previously only set is_released=true, not status='released'
-- ================================================================
CREATE OR REPLACE FUNCTION fn_release_reservation_by_so_id(p_so_id uuid, p_released_by uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE stock_reservations
  SET
    status = 'released',
    is_released = true,
    released_at = now(),
    released_by = p_released_by
  WHERE sales_order_id = p_so_id
    AND (status = 'active' OR (status IS NULL AND is_released = false));

  RETURN true;
END;
$$;

-- ================================================================
-- 2. Fix fn_release_partial_reservation
--    Previously only set is_released=true, not status='released'
-- ================================================================
CREATE OR REPLACE FUNCTION fn_release_partial_reservation(
  p_so_id uuid, p_product_id uuid, p_qty numeric, p_released_by uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_reservation RECORD;
  v_remaining_qty numeric := p_qty;
  v_release_qty numeric;
BEGIN
  FOR v_reservation IN
    SELECT id, reserved_quantity FROM stock_reservations
    WHERE sales_order_id = p_so_id
      AND product_id = p_product_id
      AND (status = 'active' OR (status IS NULL AND is_released = false))
    ORDER BY created_at ASC
  LOOP
    EXIT WHEN v_remaining_qty <= 0;
    v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);
    IF v_release_qty >= v_reservation.reserved_quantity THEN
      UPDATE stock_reservations
      SET
        status = 'released',
        is_released = true,
        released_at = now(),
        released_by = p_released_by
      WHERE id = v_reservation.id;
    ELSE
      UPDATE stock_reservations
      SET reserved_quantity = reserved_quantity - v_release_qty
      WHERE id = v_reservation.id;
    END IF;
    v_remaining_qty := v_remaining_qty - v_release_qty;
  END LOOP;
  RETURN true;
END;
$$;

-- ================================================================
-- 3. Fix fn_auto_release_on_so_status_change
--    Add delivered, invoiced, closed to trigger release
-- ================================================================
CREATE OR REPLACE FUNCTION fn_auto_release_on_so_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('cancelled', 'rejected', 'delivered', 'invoiced', 'closed')
     AND OLD.status NOT IN ('cancelled', 'rejected', 'delivered', 'invoiced', 'closed') THEN
    PERFORM fn_release_reservation_by_so_id(NEW.id, NULL);
  END IF;
  RETURN NEW;
END;
$$;

-- ================================================================
-- 4. Also fix fn_reserve_stock_for_so_v2 to use status properly
--    The existing version doesn't set status on insert - rely on default
--    Make sure it explicitly sets status='active'
-- ================================================================
DROP FUNCTION IF EXISTS fn_reserve_stock_for_so_v2(uuid);
CREATE FUNCTION fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_batch RECORD;
  v_remaining_qty numeric;
  v_reserved_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  -- Release any existing active reservations before re-reserving
  UPDATE stock_reservations
  SET status = 'released', is_released = true, released_at = now()
  WHERE sales_order_id = p_so_id
    AND (status = 'active' OR (status IS NULL AND is_released = false));

  FOR v_item IN
    SELECT soi.id, soi.product_id, soi.quantity
    FROM sales_order_items soi WHERE soi.sales_order_id = p_so_id
  LOOP
    v_remaining_qty := v_item.quantity;
    FOR v_batch IN
      SELECT b.id, b.current_stock, COALESCE(b.reserved_stock, 0) as reserved_stock
      FROM batches b
      WHERE b.product_id = v_item.product_id AND b.is_active = true
        AND b.current_stock > COALESCE(b.reserved_stock, 0)
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
      ORDER BY b.import_date ASC, b.created_at ASC
    LOOP
      v_reserved_qty := LEAST(v_remaining_qty, v_batch.current_stock - v_batch.reserved_stock);
      IF v_reserved_qty > 0 THEN
        INSERT INTO stock_reservations (
          sales_order_id, sales_order_item_id, batch_id, product_id,
          reserved_quantity, is_released, status
        ) VALUES (
          p_so_id, v_item.id, v_batch.id, v_item.product_id,
          v_reserved_qty, false, 'active'
        );
        v_remaining_qty := v_remaining_qty - v_reserved_qty;
      END IF;
      EXIT WHEN v_remaining_qty <= 0;
    END LOOP;
    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id, 'required_qty', v_item.quantity, 'shortage_qty', v_remaining_qty);
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE sales_orders SET status = 'shortage', updated_at = now() WHERE id = p_so_id;
    PERFORM fn_create_import_requirements(p_so_id, v_shortage_list);
    RETURN QUERY SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE sales_orders SET status = 'stock_reserved', updated_at = now() WHERE id = p_so_id;
    RETURN QUERY SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;

-- ================================================================
-- 5. DATA CLEANUP: Fix existing drift
-- ================================================================

-- 5a. Sync rows where is_released=true but status still 'active'
--     These were released by the old broken functions
UPDATE stock_reservations
SET status = 'released'
WHERE is_released = true
  AND (status = 'active' OR status IS NULL);

-- 5b. Release active reservations for SOs already in terminal states
--     (delivered, invoiced, closed, cancelled, rejected)
UPDATE stock_reservations sr
SET
  status = 'released',
  is_released = true,
  released_at = COALESCE(sr.released_at, now()),
  release_reason = 'Auto-released: SO already in terminal state'
WHERE sr.status = 'active'
  AND EXISTS (
    SELECT 1 FROM sales_orders so
    WHERE so.id = sr.sales_order_id
      AND so.status IN ('delivered', 'invoiced', 'closed', 'cancelled', 'rejected')
  );

-- 5c. Recalculate ALL batches' reserved_stock from scratch
UPDATE batches b
SET reserved_stock = COALESCE((
  SELECT SUM(sr.reserved_quantity)
  FROM stock_reservations sr
  WHERE sr.batch_id = b.id AND sr.status = 'active'
), 0);

-- 5d. Log summary of what was fixed
DO $$
DECLARE
  v_fixed_count integer;
BEGIN
  SELECT COUNT(*) INTO v_fixed_count
  FROM stock_reservations
  WHERE status = 'released' AND is_released = true
    AND (release_reason = 'Auto-released: SO already in terminal state' OR released_at IS NOT NULL);
  RAISE NOTICE 'Reservation cleanup complete. Active reservations now: %',
    (SELECT COUNT(*) FROM stock_reservations WHERE status = 'active');
END $$;
