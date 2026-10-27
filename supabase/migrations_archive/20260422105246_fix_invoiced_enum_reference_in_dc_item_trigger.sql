/*
  # Fix invalid 'invoiced' enum reference in DC item trigger

  ## Problem
  The trigger `trg_auto_release_reservation_on_dc_item` compared
  `sales_orders.status NOT IN ('delivered','invoiced','closed','cancelled','rejected')`.
  The `sales_order_status` enum does NOT contain `'invoiced'`, so PostgreSQL raises:
    invalid input value for enum sales_order_status: "invoiced"
  when an item is inserted into delivery_challan_items and the SO has no more
  active reservations. This blocks DC creation.

  ## Fix
  Remove `'invoiced'` from both NOT IN comparisons — it's not a valid enum value.
  The valid terminal states are: delivered, closed, cancelled, rejected.

  ## Security
  No RLS changes. Function remains SECURITY DEFINER as before.
*/

CREATE OR REPLACE FUNCTION public.trg_auto_release_reservation_on_dc_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_so_id uuid;
  v_reservation RECORD;
  v_remaining_qty numeric;
  v_release_qty numeric;
BEGIN
  SELECT sales_order_id INTO v_so_id
  FROM delivery_challans
  WHERE id = NEW.challan_id;

  IF v_so_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_remaining_qty := NEW.quantity;

  FOR v_reservation IN
    SELECT id, reserved_quantity
    FROM stock_reservations
    WHERE sales_order_id = v_so_id
      AND product_id = NEW.product_id
      AND batch_id = NEW.batch_id
      AND (status = 'active' OR (status IS NULL AND is_released = false))
    ORDER BY reserved_at ASC
  LOOP
    EXIT WHEN v_remaining_qty <= 0;
    v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);
    IF v_release_qty >= v_reservation.reserved_quantity THEN
      UPDATE stock_reservations
      SET status = 'released', is_released = true, released_at = now()
      WHERE id = v_reservation.id;
    ELSE
      UPDATE stock_reservations
      SET reserved_quantity = reserved_quantity - v_release_qty
      WHERE id = v_reservation.id;
    END IF;
    v_remaining_qty := v_remaining_qty - v_release_qty;
  END LOOP;

  IF v_remaining_qty > 0 THEN
    FOR v_reservation IN
      SELECT id, reserved_quantity
      FROM stock_reservations
      WHERE sales_order_id = v_so_id
        AND product_id = NEW.product_id
        AND (status = 'active' OR (status IS NULL AND is_released = false))
      ORDER BY reserved_at ASC
    LOOP
      EXIT WHEN v_remaining_qty <= 0;
      v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);
      IF v_release_qty >= v_reservation.reserved_quantity THEN
        UPDATE stock_reservations
        SET status = 'released', is_released = true, released_at = now()
        WHERE id = v_reservation.id;
      ELSE
        UPDATE stock_reservations
        SET reserved_quantity = reserved_quantity - v_release_qty
        WHERE id = v_reservation.id;
      END IF;
      v_remaining_qty := v_remaining_qty - v_release_qty;
    END LOOP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM stock_reservations
    WHERE sales_order_id = v_so_id
      AND (status = 'active' OR (status IS NULL AND is_released = false))
  ) THEN
    UPDATE sales_orders
    SET status = 'delivered', updated_at = now()
    WHERE id = v_so_id
      AND status NOT IN ('delivered','closed','cancelled','rejected');
  END IF;

  RETURN NEW;
END;
$function$;

-- Also fix fn_restore_reservation_on_dc_delete, which compares text but still references an invalid value
CREATE OR REPLACE FUNCTION public.fn_restore_reservation_on_dc_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_so_status text;
BEGIN
  IF OLD.sales_order_id IS NOT NULL THEN
    SELECT status::text INTO v_so_status FROM sales_orders WHERE id = OLD.sales_order_id;
    IF v_so_status NOT IN ('delivered','closed','cancelled','rejected') THEN
      PERFORM fn_reserve_stock_for_so_v2(OLD.sales_order_id);
    END IF;
  END IF;
  RETURN OLD;
END;
$function$;
