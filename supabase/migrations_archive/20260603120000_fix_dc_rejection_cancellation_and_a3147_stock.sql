/*
  # Fix DC rejection / cancellation lifecycle + reverse incorrect A-3147 stock adjustment

  ## Issue 1 (data fix)
  Batch 4001/1101/25/A-3147 (id cb5539e0-4c14-4086-ba30-92cf194d5db2) was
  adjusted to current_stock = -50 by HFR-260603-STOCK. The historical-finance
  repair script computed `delivered` by summing ALL delivery_challan_items,
  including rejected DC DO-26-0010 (50kg, "dubble entry"). Approved DCs total
  1000 (= import), so the correct current_stock is 0.

  Reversal:
    - Post inventory_transactions reversing the -50 adjustment
    - Restore batches.current_stock = 0

  ## Issue 2 (logic fix)
  - DC rejection from `approved` state never restored `batches.current_stock`
    (trigger only released `reserved_stock`).
  - DC rejection never reversed `sales_order_items.delivered_quantity`.
  - No DC cancellation workflow existed (enum + trigger).
  - `update_so_delivered_quantity_atomic` blindly incremented
    `delivered_quantity` from any DC item, including pending/rejected/cancelled.

  Fix:
    1. Add 'cancelled' to `dc_approval_status` enum.
    2. `fn_recompute_so_delivered(p_so_id)` recomputes `delivered_quantity`
       across an SO by summing approved DC items only, then sets SO status.
    3. Replace `trg_dc_rejection_release_stock` to handle both
       pending_approval → rejected (release reserved) AND
       approved → rejected (restore current_stock, log adjustment, recompute SO).
    4. Add `trg_dc_cancellation_release_stock` with same semantics for the
       'cancelled' state.
    5. Make `update_so_delivered_quantity_atomic` defer to the recompute
       function — DC creation no longer bumps `delivered_quantity`; only
       approval does.

  ## Safety
    - Additive: enum value added, function bodies replaced, triggers replaced.
    - The data fix posts +50 reversal and updates batches; the original
      HFR-260603-STOCK transaction is left in place for auditability.
*/

BEGIN;

-- ============================================================
-- 1. Extend enum with 'cancelled'
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'dc_approval_status' AND e.enumlabel = 'cancelled'
  ) THEN
    ALTER TYPE dc_approval_status ADD VALUE 'cancelled';
  END IF;
END$$;

COMMIT;

BEGIN;

-- ============================================================
-- 2. Helper: recompute SO delivered_quantity from approved DCs only
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_recompute_so_delivered(p_so_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric;
  v_delivered numeric;
BEGIN
  IF p_so_id IS NULL THEN
    RETURN;
  END IF;

  -- Set each SO item delivered_quantity to sum of approved DC items
  UPDATE sales_order_items soi
  SET delivered_quantity = COALESCE((
    SELECT SUM(dci.quantity)
    FROM delivery_challan_items dci
    JOIN delivery_challans dc ON dc.id = dci.challan_id
    WHERE dc.sales_order_id = p_so_id
      AND dc.approval_status = 'approved'
      AND dci.product_id     = soi.product_id
  ), 0)
  WHERE soi.sales_order_id = p_so_id;

  SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(delivered_quantity), 0)
    INTO v_total, v_delivered
    FROM sales_order_items
   WHERE sales_order_id = p_so_id;

  UPDATE sales_orders
     SET status = CASE
                    WHEN v_delivered = 0          THEN 'pending_delivery'::sales_order_status
                    WHEN v_delivered >= v_total   THEN 'delivered'::sales_order_status
                    ELSE 'partially_delivered'::sales_order_status
                  END,
         updated_at = now()
   WHERE id = p_so_id
     AND status NOT IN ('closed','cancelled','rejected');
END;
$$;

-- ============================================================
-- 3. DC rejection: handle both pending→rejected and approved→rejected
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_dc_rejection_release_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_current_stock numeric;
  v_was_approved boolean;
BEGIN
  IF NEW.approval_status <> 'rejected' THEN
    RETURN NEW;
  END IF;
  IF OLD.approval_status = 'rejected' THEN
    RETURN NEW;
  END IF;

  v_was_approved := (OLD.approval_status = 'approved');

  FOR v_item IN
    SELECT * FROM delivery_challan_items WHERE challan_id = NEW.id
  LOOP
    SELECT current_stock INTO v_current_stock FROM batches WHERE id = v_item.batch_id;

    IF v_was_approved THEN
      -- Restore current stock that was deducted on approval
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
    ELSE
      -- Just release the pending reservation
      UPDATE batches
         SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - v_item.quantity),
             updated_at = now()
       WHERE id = v_item.batch_id;

      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        v_item.product_id, v_item.batch_id, 'adjustment', v_item.quantity,
        CURRENT_DATE, NEW.challan_number, 'dc_rejected', NEW.id,
        'Released reservation from rejected DC: ' || NEW.challan_number,
        COALESCE(NEW.rejected_by, NEW.approved_by),
        v_current_stock, v_current_stock
      );
    END IF;
  END LOOP;

  -- Recompute SO delivered_quantity from approved DCs only
  IF NEW.sales_order_id IS NOT NULL THEN
    PERFORM fn_recompute_so_delivered(NEW.sales_order_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dc_rejection_release_stock ON delivery_challans;
CREATE TRIGGER trigger_dc_rejection_release_stock
  AFTER UPDATE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION trg_dc_rejection_release_stock();

-- ============================================================
-- 4. DC cancellation: same shape as rejection
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_dc_cancellation_release_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_current_stock numeric;
  v_was_approved boolean;
BEGIN
  IF NEW.approval_status <> 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF OLD.approval_status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  v_was_approved := (OLD.approval_status = 'approved');

  FOR v_item IN
    SELECT * FROM delivery_challan_items WHERE challan_id = NEW.id
  LOOP
    SELECT current_stock INTO v_current_stock FROM batches WHERE id = v_item.batch_id;

    IF v_was_approved THEN
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
    ELSE
      UPDATE batches
         SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - v_item.quantity),
             updated_at = now()
       WHERE id = v_item.batch_id;

      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        v_item.product_id, v_item.batch_id, 'adjustment', v_item.quantity,
        CURRENT_DATE, NEW.challan_number, 'dc_cancelled', NEW.id,
        'Released reservation from cancelled DC: ' || NEW.challan_number,
        COALESCE(NEW.rejected_by, NEW.approved_by),
        v_current_stock, v_current_stock
      );
    END IF;
  END LOOP;

  IF NEW.sales_order_id IS NOT NULL THEN
    PERFORM fn_recompute_so_delivered(NEW.sales_order_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dc_cancellation_release_stock ON delivery_challans;
CREATE TRIGGER trigger_dc_cancellation_release_stock
  AFTER UPDATE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION trg_dc_cancellation_release_stock();

-- ============================================================
-- 5. Cancellation RPC (called by UI; mirrors fn_reject_delivery_challan)
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_cancel_delivery_challan(
  p_dc_id  uuid,
  p_user   uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = COALESCE(auth.uid(), p_user);
  IF v_role IS NULL OR v_role NOT IN ('admin','accounts','warehouse','manager') THEN
    RAISE EXCEPTION 'Not authorized to cancel delivery challans';
  END IF;

  UPDATE delivery_challans
     SET approval_status   = 'cancelled',
         rejection_reason  = COALESCE(p_reason, rejection_reason),
         rejected_by       = COALESCE(p_user, auth.uid()),
         rejected_at       = now(),
         updated_at        = now()
   WHERE id = p_dc_id;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_cancel_delivery_challan(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_cancel_delivery_challan(uuid, uuid, text) TO authenticated;

-- ============================================================
-- 6. Make update_so_delivered_quantity_atomic a recompute (no double-count)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_so_delivered_quantity_atomic(
  p_sales_order_id uuid,
  p_dc_items jsonb[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- p_dc_items kept for API compatibility but ignored: delivered_quantity is
  -- now derived from approved DCs only, recomputed by fn_recompute_so_delivered.
  PERFORM fn_recompute_so_delivered(p_sales_order_id);
END;
$$;

-- ============================================================
-- 7. Also recompute on DC approval (covers approve from any prior state)
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_dc_approval_recompute_so()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.approval_status = 'approved'
     AND (OLD.approval_status IS DISTINCT FROM 'approved')
     AND NEW.sales_order_id IS NOT NULL THEN
    PERFORM fn_recompute_so_delivered(NEW.sales_order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dc_approval_recompute_so ON delivery_challans;
CREATE TRIGGER trigger_dc_approval_recompute_so
  AFTER UPDATE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION trg_dc_approval_recompute_so();

-- ============================================================
-- 8. Data fix: reverse HFR-260603-STOCK on batch 4001/1101/25/A-3147
-- ============================================================
DO $$
DECLARE
  v_batch_id uuid := 'cb5539e0-4c14-4086-ba30-92cf194d5db2';
  v_product_id uuid := '4fd7e5b5-1226-4044-b9bd-e16e1e8a516a';
  v_current numeric;
BEGIN
  SELECT current_stock INTO v_current FROM batches WHERE id = v_batch_id;
  IF v_current = -50 THEN
    UPDATE batches
       SET current_stock = 0,
           updated_at = now()
     WHERE id = v_batch_id;

    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, stock_before, stock_after, metadata
    ) VALUES (
      v_product_id, v_batch_id, 'adjustment', 50,
      CURRENT_DATE, 'HFR-260603-STOCK-REVERSAL', 'historical_stock_adjustment_reversal', v_batch_id,
      'Reversal of incorrect HFR-260603-STOCK adjustment: rejected DC DO-26-0010 (50kg, "dubble entry") was wrongly counted as delivered. Approved DC total = import = 1000; correct current_stock = 0.',
      -50, 0,
      jsonb_build_object(
        'reversal_of', '7372f0f6-b2a2-47ad-9627-428566832b7e',
        'reason', 'rejected DC DO-26-0010 wrongly counted as delivered by HFR-260603'
      )
    );
  END IF;
END$$;

-- Also recompute delivered_quantity for SO-2026-0014 (DO-26-0010's SO),
-- and for every SO that has any rejected DC, so historical state is clean.
DO $$
DECLARE
  v_so RECORD;
BEGIN
  FOR v_so IN
    SELECT DISTINCT sales_order_id
      FROM delivery_challans
     WHERE sales_order_id IS NOT NULL
       AND approval_status IN ('rejected','cancelled')
  LOOP
    PERFORM fn_recompute_so_delivered(v_so.sales_order_id);
  END LOOP;
END$$;

COMMIT;
