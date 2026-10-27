/*
  # Fix DC approval trigger referencing undefined alias

  1. Problem
    - `trg_dc_approval_deduct_stock` selects `p.product_id` without a JOIN to products
    - Causes "missing FROM-clause entry for table p" and blocks DC approval
  2. Fix
    - Remove the stale `p.product_id` reference; `product_id` is already a column on
      `delivery_challan_items`, so `SELECT dci.*` already exposes it as `product_id`
  3. Safety
    - Pure function replacement; no data modification
*/

CREATE OR REPLACE FUNCTION public.trg_dc_approval_deduct_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item          RECORD;
  v_current_stock numeric;
  v_reservation   RECORD;
  v_remaining_qty numeric;
  v_release_qty   numeric;
BEGIN
  IF NEW.approval_status = 'approved' AND OLD.approval_status != 'approved' THEN

    FOR v_item IN
      SELECT dci.*
      FROM delivery_challan_items dci
      WHERE dci.challan_id = NEW.id
    LOOP
      SELECT current_stock INTO v_current_stock
      FROM batches WHERE id = v_item.batch_id;

      UPDATE batches
      SET current_stock = current_stock - v_item.quantity
      WHERE id = v_item.batch_id;

      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        v_item.product_id, v_item.batch_id, 'delivery_challan', -v_item.quantity,
        NEW.challan_date, NEW.challan_number, 'delivery_challan', NEW.id,
        'Delivered via approved DC: ' || NEW.challan_number, NEW.approved_by,
        v_current_stock, v_current_stock - v_item.quantity
      );

      IF NEW.sales_order_id IS NOT NULL THEN
        v_remaining_qty := v_item.quantity;

        FOR v_reservation IN
          SELECT id, reserved_quantity
          FROM stock_reservations
          WHERE sales_order_id = NEW.sales_order_id
            AND product_id     = v_item.product_id
            AND batch_id       = v_item.batch_id
            AND status         = 'active'
          ORDER BY reserved_at ASC
        LOOP
          EXIT WHEN v_remaining_qty <= 0;
          v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);

          IF v_release_qty >= v_reservation.reserved_quantity THEN
            UPDATE stock_reservations
            SET status = 'released', is_released = true,
                released_at = now(), released_by = NEW.approved_by,
                release_reason = 'delivered'
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
            WHERE sales_order_id = NEW.sales_order_id
              AND product_id     = v_item.product_id
              AND status         = 'active'
            ORDER BY reserved_at ASC
          LOOP
            EXIT WHEN v_remaining_qty <= 0;
            v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);

            IF v_release_qty >= v_reservation.reserved_quantity THEN
              UPDATE stock_reservations
              SET status = 'released', is_released = true,
                  released_at = now(), released_by = NEW.approved_by,
                  release_reason = 'delivered'
              WHERE id = v_reservation.id;
            ELSE
              UPDATE stock_reservations
              SET reserved_quantity = reserved_quantity - v_release_qty
              WHERE id = v_reservation.id;
            END IF;

            v_remaining_qty := v_remaining_qty - v_release_qty;
          END LOOP;
        END IF;
      END IF;

    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      UPDATE sales_orders
      SET status = CASE
            WHEN (SELECT COALESCE(SUM(quantity), 0)           FROM sales_order_items WHERE sales_order_id = NEW.sales_order_id) =
                 (SELECT COALESCE(SUM(delivered_quantity), 0) FROM sales_order_items WHERE sales_order_id = NEW.sales_order_id)
              THEN 'delivered'
            ELSE 'partially_delivered'
          END,
          updated_at = now()
      WHERE id = NEW.sales_order_id
        AND status NOT IN ('closed', 'cancelled', 'rejected');
    END IF;

  END IF;

  RETURN NEW;
END;
$function$;
