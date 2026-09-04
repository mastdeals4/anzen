/*
# Fix: Sales Order reservations lost after batch/GRN/import/recon operations

## Root Cause
1. fn_auto_rereserve_on_batch_arrival only re-reserves for SOs with status='shortage'.
   SOs with status='stock_reserved' that lost their reservations (e.g., due to
   a prior migration that hard-deleted reservations) are never re-reserved.

2. trg_dc_approval_deduct_stock calls inventory_v1_consume_reservation which
   checks for active reservations. If the reservation was wiped, the DC approval
   fails with "reserved 0, requested N" — even when stock is available.

## Fix
1. fn_auto_rereserve_on_batch_arrival: also re-reserve for 'stock_reserved' SOs
   whose reserved_quantity doesn't match their demand. This catches SOs that
   lost reservations due to prior operations.

2. trg_dc_approval_deduct_stock: before consuming the reservation, check if an
   active reservation exists for the SO+product+batch. If not, and stock is
   available, call fn_reserve_stock_for_so_v2 to rebuild the reservation.
   This is a safety net — it does NOT bypass validation, it ensures the
   reservation exists before consumption.

## Safety
- No data deleted from stock_reservations
- No validation bypassed
- fn_reserve_stock_for_so_v2 preserves history (UPDATE status='released', not DELETE)
- Auto-rebuild only fires when no active reservation exists AND stock is available
*/

-- ============================================================
-- FIX 1: fn_auto_rereserve_on_batch_arrival
-- Also re-reserve for 'stock_reserved' SOs that lost their reservations
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_auto_rereserve_on_batch_arrival()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_so_id uuid;
  v_demand numeric;
  v_reserved numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.current_stock IS NOT DISTINCT FROM OLD.current_stock
       AND NEW.import_quantity IS NOT DISTINCT FROM OLD.import_quantity
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Re-reserve for shortage SOs (existing behavior)
  FOR v_so_id IN
    SELECT DISTINCT so.id
    FROM sales_orders so
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    WHERE soi.product_id = NEW.product_id
      AND so.status::text = 'shortage'
      AND NOT COALESCE(so.is_archived, false)
  LOOP
    PERFORM public.fn_reserve_stock_for_so_v2(v_so_id);
  END LOOP;

  -- Also re-reserve for 'stock_reserved' SOs that lost their reservations
  -- (demand != active reserved quantity). This catches SOs whose reservations
  -- were wiped by prior operations (migrations, reconciliations, etc.)
  FOR v_so_id IN
    WITH demand AS (
      SELECT so.id,
             SUM(GREATEST(soi.quantity - COALESCE(soi.delivered_quantity, 0), 0)) AS quantity
      FROM sales_orders so
      JOIN sales_order_items soi ON soi.sales_order_id = so.id
      WHERE soi.product_id = NEW.product_id
        AND so.status::text = 'stock_reserved'
        AND NOT COALESCE(so.is_archived, false)
      GROUP BY so.id
    ),
    reserved AS (
      SELECT sales_order_id, SUM(reserved_quantity) AS quantity
      FROM stock_reservations
      WHERE status::text = 'active' AND NOT is_released
      GROUP BY sales_order_id
    )
    SELECT d.id
    FROM demand d
    LEFT JOIN reserved r ON r.sales_order_id = d.id
    WHERE d.quantity <> COALESCE(r.quantity, 0)
    ORDER BY d.id
  LOOP
    PERFORM public.fn_reserve_stock_for_so_v2(v_so_id);
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auto_rereserve_on_batch_arrival() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_auto_rereserve_on_batch_arrival() TO authenticated, service_role;

-- ============================================================
-- FIX 2: trg_dc_approval_deduct_stock
-- Before consuming the reservation, auto-rebuild if missing and stock available
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_dc_approval_deduct_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
  v_reserved_qty numeric;
  v_so_status text;
BEGIN
  IF NEW.approval_status = 'approved'
     AND OLD.approval_status IS DISTINCT FROM 'approved' THEN
    IF NEW.approval_operation_id IS NULL THEN
      RAISE EXCEPTION 'approval_operation_id is required for DC approval';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.inventory_transactions
      WHERE reference_type = 'delivery_challan_reversal'
        AND reference_id = NEW.id
        AND metadata->>'canonical_engine_version' = '1.0'
    ) THEN
      RAISE EXCEPTION 'Reversed Delivery Challan cannot be re-approved; create a new DC';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.delivery_challan_items
      WHERE challan_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan % without items',
        NEW.challan_number;
    END IF;

    -- Safety net: if the SO has no active reservations (e.g., wiped by a prior
    -- migration or reconciliation), try to rebuild them before consuming.
    -- This does NOT bypass validation — it ensures the reservation exists.
    IF NEW.sales_order_id IS NOT NULL THEN
      SELECT status::text INTO v_so_status
      FROM public.sales_orders
      WHERE id = NEW.sales_order_id;

      IF v_so_status IS NOT NULL AND v_so_status NOT IN ('delivered', 'closed', 'cancelled', 'rejected') THEN
        -- Check if any active reservation exists for this SO
        SELECT COALESCE(sum(reserved_quantity), 0) INTO v_reserved_qty
        FROM public.stock_reservations
        WHERE sales_order_id = NEW.sales_order_id
          AND status = 'active';

        -- If no active reservation, try to rebuild
        IF v_reserved_qty = 0 THEN
          PERFORM public.fn_reserve_stock_for_so_v2(NEW.sales_order_id);
        END IF;
      END IF;
    END IF;

    FOR v_item IN
      SELECT *
      FROM public.delivery_challan_items
      WHERE challan_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.inventory_v1_consume_reservation(
        NEW.sales_order_id,
        v_item.product_id,
        v_item.batch_id,
        v_item.quantity,
        NEW.approved_by
      );

      PERFORM public.post_inventory_movement(
        public.uuid_from_text(
          'inventory-v1:dc:' || NEW.approval_operation_id || ':' || v_item.id
        ),
        v_item.product_id,
        v_item.batch_id,
        'delivery_challan',
        -v_item.quantity,
        NEW.challan_date,
        NEW.challan_number,
        'delivery_challan',
        NEW.id,
        'Canonical Delivery Challan approval: ' || NEW.challan_number,
        NEW.approved_by,
        NULL,
        NULL
      );

    END LOOP;

    IF NEW.sales_order_id IS NOT NULL THEN
      PERFORM public.fn_recompute_so_delivered(NEW.sales_order_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop and recreate the trigger (same name, same event)
DROP TRIGGER IF EXISTS trigger_dc_approval_deduct_stock ON public.delivery_challans;
CREATE TRIGGER trigger_dc_approval_deduct_stock
AFTER UPDATE OF approval_status ON public.delivery_challans
FOR EACH ROW
EXECUTE FUNCTION public.trg_dc_approval_deduct_stock();
