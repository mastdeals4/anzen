/*
  # Fix: Reservation Released Too Early + Duplicate Release Logic

  ## Bugs Fixed

  ### Bug 1 — trg_auto_release_reservation_on_dc_item fires on DC CREATE
  The trigger fires AFTER INSERT on delivery_challan_items. DC items are inserted
  when the DC is created (approval_status = 'pending_approval'). This means
  reservations are released immediately when the DC is drafted, before approval.
  Fix: add a guard — only release if the DC is already 'approved'.
  In practice, items are only inserted into an already-approved DC via
  admin_edit_approved_delivery_challan (which sets skip_dc_item_trigger anyway),
  so the trigger is a no-op in the normal flow. The canonical release path is
  trg_dc_approval_deduct_stock (which fires on UPDATE delivery_challans).

  ### Bug 2 — Duplicate release logic
  Both trg_auto_release_reservation_on_dc_item (INSERT) and
  trg_dc_approval_deduct_stock (UPDATE) attempted to release reservations.
  After this fix, only trg_dc_approval_deduct_stock releases reservations on
  DC approval. The INSERT trigger is demoted to a safety net that only fires
  if (somehow) items are inserted into an already-approved DC without the skip flag.

  ### Bug 3 — Rejection/cancellation of pending DC incorrectly manipulates reserved_stock
  trg_dc_rejection_release_stock and trg_dc_cancellation_release_stock have an
  ELSE branch (non-approved DCs) that directly decremented batches.reserved_stock.
  In the old broken world, reservations were already released on DC CREATE so this
  was attempting to "undo" a manual reserved_stock side-effect. After Bug 1 fix,
  reservations are still active when a pending DC is rejected/cancelled — the SO
  should keep its reservation and the SO status should remain stock_reserved.
  Fix: remove the direct reserved_stock manipulation from the non-approved branch.

  ### Bug 4 — edit_delivery_challan directly manipulates batches.reserved_stock
  In the old world, reservations were released on DC CREATE, so edit_delivery_challan
  had to manually re-add to reserved_stock to reflect the DC's claim. After Bug 1
  fix, the SO reservation remains active — so adding again to reserved_stock
  double-counts. Fix: remove direct reserved_stock manipulation from edit_delivery_challan.
  Pending DC items are informational only; stock changes happen only on approval.

  ## Safety
  - No data deleted from stock_reservations (audit history preserved)
  - No schema changes
  - No changes to working approval path (trg_dc_approval_deduct_stock unchanged)
  - trg_sync_batch_reserved_stock continues to be the canonical sync mechanism
  - Ended with full recalculation of batches.reserved_stock from stock_reservations
*/

-- ============================================================
-- FIX 1 & 2: Add approval-status guard to trg_auto_release_reservation_on_dc_item
-- Only release reservations if the DC is already approved (safety net).
-- Normal flow: DC is pending_approval when items are inserted → no-op.
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_auto_release_reservation_on_dc_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so_id          uuid;
  v_dc_status      text;
  v_reservation    RECORD;
  v_remaining_qty  numeric;
  v_release_qty    numeric;
BEGIN
  -- Only release reservations when the DC is already approved.
  -- During DC CREATE (pending_approval) or EDIT (pending), items are inserted
  -- but reservations must NOT be released — stock has not been physically dispatched.
  -- The canonical release path is trg_dc_approval_deduct_stock (UPDATE trigger).
  SELECT approval_status::text, sales_order_id
    INTO v_dc_status, v_so_id
  FROM delivery_challans
  WHERE id = NEW.challan_id;

  IF v_dc_status IS DISTINCT FROM 'approved' THEN
    RETURN NEW;
  END IF;

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
    SET status = 'delivered'::sales_order_status, updated_at = now()
    WHERE id = v_so_id
      AND status NOT IN (
        'delivered'::sales_order_status,
        'closed'::sales_order_status,
        'cancelled'::sales_order_status,
        'rejected'::sales_order_status
      );
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- FIX 3a: trg_dc_rejection_release_stock — remove direct reserved_stock
-- manipulation for non-approved (pending) DCs.
-- When a pending DC is rejected, the SO reservation is still active — correct.
-- Just re-evaluate SO stock so the SO status reflects current reality.
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_dc_rejection_release_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item          RECORD;
  v_current_stock numeric;
  v_was_approved  boolean;
BEGIN
  IF NEW.approval_status <> 'rejected' THEN
    RETURN NEW;
  END IF;
  IF OLD.approval_status = 'rejected' THEN
    RETURN NEW;
  END IF;

  v_was_approved := (OLD.approval_status = 'approved');

  IF v_was_approved THEN
    -- DC was approved → stock was deducted → reverse the deduction
    FOR v_item IN
      SELECT * FROM delivery_challan_items WHERE challan_id = NEW.id
    LOOP
      SELECT current_stock INTO v_current_stock FROM batches WHERE id = v_item.batch_id;

      UPDATE batches
         SET current_stock = current_stock + v_item.quantity,
             updated_at = now()
       WHERE id = v_item.batch_id;

      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        v_item.product_id, v_item.batch_id, 'adjustment', v_item.quantity,
        CURRENT_DATE, NEW.challan_number, 'dc_rejected', NEW.id,
        'Reversed delivery from rejected (previously approved) DC: ' || NEW.challan_number,
        COALESCE(NEW.rejected_by, NEW.approved_by),
        v_current_stock, v_current_stock + v_item.quantity
      );
    END LOOP;
  END IF;
  -- Non-approved DC: reservation is still active (correct); no stock was deducted.
  -- No action needed on batches.reserved_stock — trg_sync_batch_reserved_stock
  -- keeps it accurate from stock_reservations.

  -- Re-evaluate SO delivered quantity and status either way
  IF NEW.sales_order_id IS NOT NULL THEN
    PERFORM fn_recompute_so_delivered(NEW.sales_order_id);
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- FIX 3b: trg_dc_cancellation_release_stock — same fix as rejection
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_dc_cancellation_release_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item          RECORD;
  v_current_stock numeric;
  v_was_approved  boolean;
BEGIN
  IF NEW.approval_status <> 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF OLD.approval_status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  v_was_approved := (OLD.approval_status = 'approved');

  IF v_was_approved THEN
    -- DC was approved → stock was deducted → reverse the deduction
    FOR v_item IN
      SELECT * FROM delivery_challan_items WHERE challan_id = NEW.id
    LOOP
      SELECT current_stock INTO v_current_stock FROM batches WHERE id = v_item.batch_id;

      UPDATE batches
         SET current_stock = current_stock + v_item.quantity,
             updated_at = now()
       WHERE id = v_item.batch_id;

      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        v_item.product_id, v_item.batch_id, 'adjustment', v_item.quantity,
        CURRENT_DATE, NEW.challan_number, 'dc_cancelled', NEW.id,
        'Reversed delivery from cancelled (previously approved) DC: ' || NEW.challan_number,
        COALESCE(NEW.rejected_by, NEW.approved_by),
        v_current_stock, v_current_stock + v_item.quantity
      );
    END LOOP;
  END IF;
  -- Non-approved DC: reservation is still active (correct); no stock was deducted.
  -- No action needed on batches.reserved_stock.

  IF NEW.sales_order_id IS NOT NULL THEN
    PERFORM fn_recompute_so_delivered(NEW.sales_order_id);
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- FIX 4: edit_delivery_challan — remove direct batches.reserved_stock manipulation
-- Pending DC items are informational only. Reservations live in stock_reservations
-- (linked to the SO, not the DC). trg_sync_batch_reserved_stock keeps
-- batches.reserved_stock accurate. Direct manipulation causes double-counting.
-- ============================================================
CREATE OR REPLACE FUNCTION public.edit_delivery_challan(
  p_challan_id uuid,
  p_new_items  jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role       text;
  v_challan    record;
  v_item       jsonb;
  v_count      integer;
  v_product_id uuid;
  v_batch_id   uuid;
  v_new_qty    numeric;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot edit delivery challans', v_role;
  END IF;

  SELECT * INTO v_challan FROM delivery_challans WHERE id = p_challan_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;

  IF v_challan.approved_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot edit approved delivery challan');
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
  END IF;

  -- Suppress the INSERT trigger on delivery_challan_items (safety: DC is pending anyway,
  -- trigger now also guards against non-approved DCs, but be explicit)
  PERFORM set_config('app.skip_dc_item_trigger', 'true', true);

  -- Remove all existing items for this DC
  DELETE FROM delivery_challan_items WHERE challan_id = p_challan_id;

  -- Insert the new item list
  -- No reserved_stock manipulation needed: reservations are in stock_reservations
  -- linked to the SO, not the DC. trg_sync_batch_reserved_stock handles accuracy.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id   := (v_item->>'batch_id')::uuid;
    v_new_qty    := (v_item->>'quantity')::numeric;

    INSERT INTO delivery_challan_items (
      challan_id, product_id, batch_id, quantity,
      pack_size, pack_type, number_of_packs
    ) VALUES (
      p_challan_id, v_product_id, v_batch_id, v_new_qty,
      NULLIF(v_item->>'pack_size', '')::numeric,
      NULLIF(v_item->>'pack_type', ''),
      NULLIF(v_item->>'number_of_packs', '')::integer
    );
  END LOOP;

  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);

  RETURN jsonb_build_object('success', true, 'message', 'Delivery challan updated successfully');

EXCEPTION
  WHEN foreign_key_violation THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', 'Invalid product or batch selection');
  WHEN OTHERS THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- ============================================================
-- DATA FIX: Recalculate all batches.reserved_stock from stock_reservations
-- Ensures reserved_stock is consistent with actual active reservation rows
-- after any historical drift from the old broken trigger behaviour.
-- ============================================================
UPDATE batches b
SET reserved_stock = COALESCE((
  SELECT SUM(sr.reserved_quantity)
  FROM stock_reservations sr
  WHERE sr.batch_id = b.id AND sr.status = 'active'
), 0);
