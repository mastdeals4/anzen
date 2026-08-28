/*
# Fix: DC approval auto-rebuild with priority for SOs with pending DCs

## Problem
When the DC approval trigger tries to rebuild a reservation and finds no stock
available (because other SOs have active reservations), the DC approval fails.
But the other SOs may have no pending DCs — they're just reserved, not being
delivered. The SO with a pending DC should have priority.

## Fix
When trg_dc_approval_deduct_stock detects no active reservation for the SO,
it calls fn_reserve_stock_for_so_v2 to rebuild. If that fails (shortage),
it then checks if other SOs have active reservations but no pending DCs. If so,
it releases those reservations and retries the rebuild. This gives priority
to the SO with a pending DC.

## Safety
- Only releases reservations from SOs with NO pending DCs
- Does NOT bypass validation — the reservation must still be created
- Only fires when the SO has no active reservation AND stock is unavailable
*/

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
  v_rebuild_ok boolean := false;
  v_other_so_id uuid;
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

    -- Safety net: if the SO has no active reservations, try to rebuild.
    IF NEW.sales_order_id IS NOT NULL THEN
      SELECT status::text INTO v_so_status
      FROM public.sales_orders
      WHERE id = NEW.sales_order_id;

      IF v_so_status IS NOT NULL AND v_so_status NOT IN ('delivered', 'closed', 'cancelled', 'rejected') THEN
        SELECT COALESCE(sum(reserved_quantity), 0) INTO v_reserved_qty
        FROM public.stock_reservations
        WHERE sales_order_id = NEW.sales_order_id
          AND status = 'active';

        IF v_reserved_qty = 0 THEN
          -- Try to rebuild the reservation
          BEGIN
            PERFORM public.fn_reserve_stock_for_so_v2(NEW.sales_order_id);
            v_rebuild_ok := true;
          EXCEPTION WHEN OTHERS THEN
            v_rebuild_ok := false;
          END;

          -- If rebuild failed (shortage), release reservations from other SOs
          -- that have no pending DCs, then retry
          IF NOT v_rebuild_ok THEN
            FOR v_other_so_id IN
              SELECT DISTINCT sr.sales_order_id
              FROM public.stock_reservations sr
              JOIN public.delivery_challan_items dci ON dci.product_id = sr.product_id
              JOIN public.delivery_challans dc ON dc.id = dci.challan_id
              WHERE dc.id = NEW.id
                AND sr.sales_order_id <> NEW.sales_order_id
                AND sr.status = 'active'
                AND NOT EXISTS (
                  SELECT 1 FROM public.delivery_challans dc2
                  WHERE dc2.sales_order_id = sr.sales_order_id
                    AND dc2.approval_status = 'pending_approval'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM public.delivery_challans dc2
                  WHERE dc2.sales_order_id = sr.sales_order_id
                    AND dc2.approval_status = 'approved'
                )
            LOOP
              -- Release this SO's reservations to free up stock
              UPDATE public.stock_reservations
              SET status = 'released',
                  is_released = true,
                  released_at = now(),
                  release_reason = 'Released for DC priority: SO with pending DC needs stock'
              WHERE sales_order_id = v_other_so_id
                AND status = 'active';
            END LOOP;

            -- Now retry the rebuild
            BEGIN
              PERFORM public.fn_reserve_stock_for_so_v2(NEW.sales_order_id);
              v_rebuild_ok := true;
            EXCEPTION WHEN OTHERS THEN
              v_rebuild_ok := false;
            END;
          END IF;
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

DROP TRIGGER IF EXISTS trigger_dc_approval_deduct_stock ON public.delivery_challans;
CREATE TRIGGER trigger_dc_approval_deduct_stock
AFTER UPDATE OF approval_status ON public.delivery_challans
FOR EACH ROW
EXECUTE FUNCTION public.trg_dc_approval_deduct_stock();
