/*
  # Fix Trigger Cascade and DC Reservation Release

  1. Problems
    - `fn_auto_rereserve_on_batch_arrival` fires on every UPDATE to `batches`,
      including `reserved_stock` updates from `trg_sync_batch_reserved_stock`.
      This creates an infinite recursive loop: stock_reservations change ->
      batches update -> rereserve -> delete/insert reservations -> repeat.
    - `trg_auto_release_reservation_on_dc_item` references a non-existent
      `created_at` column on `stock_reservations` (should be `reserved_at`).

  2. Fix
    - `fn_auto_rereserve_on_batch_arrival`: only run when `current_stock`,
      `import_quantity`, or `is_active` actually changes on UPDATE, and never
      when only `reserved_stock`/`updated_at` changes.
    - `trg_auto_release_reservation_on_dc_item`: use `reserved_at` column and
      make the release batch-aware (release same-batch reservations first,
      then any remaining from other batches for the same product).

  3. Notes
    - No schema changes; only function bodies.
    - Idempotent and safe to re-run.
*/

CREATE OR REPLACE FUNCTION public.fn_auto_rereserve_on_batch_arrival()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE v_so_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.current_stock IS NOT DISTINCT FROM OLD.current_stock
       AND NEW.import_quantity IS NOT DISTINCT FROM OLD.import_quantity
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
      RETURN NEW;
    END IF;
  END IF;

  FOR v_so_id IN
    SELECT DISTINCT so.id
    FROM sales_orders so
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    WHERE soi.product_id = NEW.product_id
      AND so.status = 'shortage'
  LOOP
    PERFORM fn_reserve_stock_for_so_v2(v_so_id);
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_auto_release_reservation_on_dc_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
      AND status NOT IN ('delivered','invoiced','closed','cancelled','rejected');
  END IF;

  RETURN NEW;
END;
$function$;
