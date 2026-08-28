/*
  # Fix DC approval trigger and reservation release triggers (permanent fix)

  ## Problem
  Two bugs cause stale reservations after partial deliveries:

  ### Bug 1 — trg_dc_approval_deduct_stock (critical)
  The live function only does:
    UPDATE batches SET current_stock = current_stock - qty,
                       reserved_stock = GREATEST(0, reserved_stock - qty)
  It NEVER updates stock_reservations. Because trg_sync_batch_reserved_stock
  only fires when stock_reservations rows change, batches.reserved_stock gets
  re-synced back to the stale value the next time any reservation is touched.
  Result: reservation records stay status='active' forever after DC approval,
  and batches.reserved_stock keeps drifting back to the stale value.

  ### Bug 2 — trg_auto_release_reservation_on_dc_item (partial)
  The first loop has: AND batch_id = NEW.batch_id
  This means it only releases reservations on the exact same batch as the DC
  item. If the SO reservation was placed on a different batch (common in
  partial/split deliveries), it is never released.

  ## Fix
  1. Replace trg_dc_approval_deduct_stock with a version that:
     - Deducts batches.current_stock (same as before)
     - Properly releases stock_reservations by FIFO (same batch first, then any)
     - Logs inventory transactions (same as before)
     - trg_sync_batch_reserved_stock then auto-syncs batches.reserved_stock
       correctly because stock_reservations rows were actually updated

  2. Replace trg_auto_release_reservation_on_dc_item with a version that
     releases reservations cross-batch (no batch_id filter in first loop),
     matching the intent of the fallback second loop that already existed.

  ## Safety
  - No data is deleted — reservations are set to status='released'
  - batches.current_stock logic is unchanged
  - Inventory transaction logging is unchanged
  - trg_sync_batch_reserved_stock handles batches.reserved_stock automatically
*/

-- ============================================================
-- FIX 1: trg_dc_approval_deduct_stock
-- Deducts current_stock AND properly releases stock_reservations
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_dc_approval_deduct_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item          RECORD;
  v_current_stock numeric;
  v_reservation   RECORD;
  v_remaining_qty numeric;
  v_release_qty   numeric;
BEGIN
  IF NEW.approval_status = 'approved' AND OLD.approval_status != 'approved' THEN

    FOR v_item IN
      SELECT dci.*, p.product_id
      FROM delivery_challan_items dci
      -- product_id is on dci directly
      WHERE dci.challan_id = NEW.id
    LOOP
      -- 1. Snapshot current stock before deduction (for transaction log)
      SELECT current_stock INTO v_current_stock
      FROM batches WHERE id = v_item.batch_id;

      -- 2. Deduct physical stock from the batch
      UPDATE batches
      SET current_stock = current_stock - v_item.quantity
      WHERE id = v_item.batch_id;

      -- 3. Log inventory transaction
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

      -- 4. Release stock_reservations for this SO + product (same batch first)
      IF NEW.sales_order_id IS NOT NULL THEN
        v_remaining_qty := v_item.quantity;

        -- Pass 1: same batch as DC item (exact match, most accurate)
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

        -- Pass 2: any batch for this product on this SO (covers cross-batch reservations)
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

    -- 5. Update SO status (partially_delivered or delivered)
    IF NEW.sales_order_id IS NOT NULL THEN
      UPDATE sales_orders
      SET status = CASE
        WHEN (SELECT COALESCE(SUM(quantity), 0)        FROM sales_order_items WHERE sales_order_id = NEW.sales_order_id) =
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
$$;


-- ============================================================
-- FIX 2: trg_auto_release_reservation_on_dc_item
-- Remove the incorrect same-batch filter from Pass 1.
-- Both passes now search any batch, FIFO. This is safe because
-- the function is scoped to one SO + one product — it can't
-- accidentally release reservations for a different order.
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_auto_release_reservation_on_dc_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so_id         uuid;
  v_reservation   RECORD;
  v_remaining_qty numeric;
  v_release_qty   numeric;
BEGIN
  SELECT sales_order_id INTO v_so_id
  FROM delivery_challans
  WHERE id = NEW.challan_id;

  IF v_so_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_remaining_qty := NEW.quantity;

  -- Release active reservations for this SO + product, any batch, FIFO
  FOR v_reservation IN
    SELECT id, reserved_quantity
    FROM stock_reservations
    WHERE sales_order_id = v_so_id
      AND product_id     = NEW.product_id
      AND status         = 'active'
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

  -- If all reservations for this SO are gone, mark SO delivered
  IF NOT EXISTS (
    SELECT 1 FROM stock_reservations
    WHERE sales_order_id = v_so_id
      AND status = 'active'
  ) THEN
    UPDATE sales_orders
    SET status = 'delivered', updated_at = now()
    WHERE id = v_so_id
      AND status NOT IN ('delivered', 'closed', 'cancelled', 'rejected');
  END IF;

  RETURN NEW;
END;
$$;
