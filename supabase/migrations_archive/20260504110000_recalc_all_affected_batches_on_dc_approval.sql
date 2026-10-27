/*
  Ensure reserved_stock is recalculated for all batches touched by reservation release
  in trg_dc_approval_deduct_stock(), including fallback releases from non-DC batches.
*/

CREATE OR REPLACE FUNCTION public.trg_dc_approval_deduct_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_so_id uuid;
  v_reservation RECORD;
  v_remaining_qty numeric;
  v_release_qty numeric;
  v_affected_batch_ids uuid[] := ARRAY[]::uuid[];
  v_batch_id uuid;
BEGIN
  IF NEW.approval_status = 'approved' AND (OLD.approval_status != 'approved') THEN
    v_so_id := NEW.sales_order_id;

    FOR v_item IN
      SELECT * FROM public.delivery_challan_items WHERE challan_id = NEW.id
    LOOP
      UPDATE public.batches
      SET current_stock = current_stock - v_item.quantity
      WHERE id = v_item.batch_id;

      v_affected_batch_ids := array_append(v_affected_batch_ids, v_item.batch_id);

      IF v_so_id IS NOT NULL THEN
        v_remaining_qty := v_item.quantity;

        FOR v_reservation IN
          SELECT id, batch_id, reserved_quantity
          FROM public.stock_reservations
          WHERE sales_order_id = v_so_id
            AND product_id = v_item.product_id
            AND batch_id = v_item.batch_id
            AND (status = 'active' OR (status IS NULL AND is_released = false))
          ORDER BY reserved_at ASC
        LOOP
          EXIT WHEN v_remaining_qty <= 0;
          v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);

          IF v_release_qty >= v_reservation.reserved_quantity THEN
            UPDATE public.stock_reservations
            SET
              status = 'released',
              is_released = true,
              released_at = now(),
              released_by = NEW.approved_by,
              release_reason = 'delivered'
            WHERE id = v_reservation.id;
          ELSE
            UPDATE public.stock_reservations
            SET reserved_quantity = reserved_quantity - v_release_qty
            WHERE id = v_reservation.id;
          END IF;

          v_affected_batch_ids := array_append(v_affected_batch_ids, v_reservation.batch_id);
          v_remaining_qty := v_remaining_qty - v_release_qty;
        END LOOP;

        IF v_remaining_qty > 0 THEN
          FOR v_reservation IN
            SELECT id, batch_id, reserved_quantity
            FROM public.stock_reservations
            WHERE sales_order_id = v_so_id
              AND product_id = v_item.product_id
              AND (status = 'active' OR (status IS NULL AND is_released = false))
            ORDER BY reserved_at ASC
          LOOP
            EXIT WHEN v_remaining_qty <= 0;
            v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);

            IF v_release_qty >= v_reservation.reserved_quantity THEN
              UPDATE public.stock_reservations
              SET
                status = 'released',
                is_released = true,
                released_at = now(),
                released_by = NEW.approved_by,
                release_reason = 'delivered'
              WHERE id = v_reservation.id;
            ELSE
              UPDATE public.stock_reservations
              SET reserved_quantity = reserved_quantity - v_release_qty
              WHERE id = v_reservation.id;
            END IF;

            v_affected_batch_ids := array_append(v_affected_batch_ids, v_reservation.batch_id);
            v_remaining_qty := v_remaining_qty - v_release_qty;
          END LOOP;
        END IF;
      END IF;
    END LOOP;

    -- Recalculate reserved_stock for all touched batches (distinct)
    FOR v_batch_id IN
      SELECT DISTINCT unnest(v_affected_batch_ids)
    LOOP
      UPDATE public.batches b
      SET reserved_stock = COALESCE(sr.total_reserved, 0)
      FROM (
        SELECT COALESCE(SUM(reserved_quantity), 0) AS total_reserved
        FROM public.stock_reservations
        WHERE batch_id = v_batch_id
          AND (status = 'active' OR (status IS NULL AND is_released = false))
      ) sr
      WHERE b.id = v_batch_id;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;
