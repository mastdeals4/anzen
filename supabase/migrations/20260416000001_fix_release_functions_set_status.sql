/*
  # Fix reservation release functions - set status='released' correctly

  ## Root Cause
  fn_release_reservation_by_so_id and fn_release_partial_reservation were only
  setting is_released=true but NOT setting status='released'.
  
  The trigger trg_sync_batch_reserved_stock uses WHERE status='active' to calculate
  batches.reserved_stock, so rows with is_released=true but status='active' were
  still counted as reserved, causing phantom reservations and negative available stock.

  ## Fix
  1. Both release functions now set status='released' AND is_released=true
  2. Trigger now also fires release on delivered/invoiced/closed SO status changes
  3. Data cleanup already applied via scripts (20260416000000 migration data)
*/

-- Fix fn_release_reservation_by_so_id
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

-- Fix fn_release_partial_reservation
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

-- Fix trigger: also release on delivered, invoiced, closed
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

-- Ensure the trigger is still bound
DROP TRIGGER IF EXISTS trigger_auto_release_on_so_status ON sales_orders;
CREATE TRIGGER trigger_auto_release_on_so_status
  AFTER UPDATE ON sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION fn_auto_release_on_so_status_change();
