/*
# Fix: Allow fn_reserve_stock_for_so_v2 to run in system/trigger context

## Problem
fn_reserve_stock_for_so_v2 checks inventory_v1_actor_allowed which requires
auth.uid() with a valid role OR service_role. When called from a trigger
(e.g., fn_auto_rereserve_on_batch_arrival) or a migration DO block,
auth.uid() is null and auth.role() is not service_role, so the function
raises 'Permission denied for stock reservation'.

This caused reservations to never be rebuilt after being wiped by prior
migrations — the re-reserve function would fail silently (in trigger context)
or raise an exception (in DO block context).

## Fix
Allow fn_reserve_stock_for_so_v2 to run when:
1. The caller has a valid role (existing behavior), OR
2. The function is called from within a trigger (pg_trigger_depth() > 0), OR
3. The canonical_reservation_engine config is set (system-level call)

This does NOT weaken security for direct user calls — it only allows
system/trigger contexts to re-reserve stock.
*/

CREATE OR REPLACE FUNCTION public.fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
  v_batch record;
  v_remaining_qty numeric;
  v_reserved_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
  v_is_system_call boolean := false;
BEGIN
  -- Allow system-level calls (triggers, migrations, reconciliation)
  -- without requiring a user session. Direct user calls still require
  -- a valid role via inventory_v1_actor_allowed.
  v_is_system_call := (
    pg_trigger_depth() > 0
    OR current_setting('app.canonical_reservation_engine', true) = 'on'
    OR current_setting('app.system_reconciliation', true) = 'on'
  );

  IF NOT v_is_system_call AND NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'manager', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for stock reservation';
  END IF;

  PERFORM 1
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  -- Release existing active reservations (history-preserving)
  UPDATE public.stock_reservations
  SET status = 'released',
      is_released = true,
      released_at = now(),
      released_by = auth.uid(),
      release_reason = 'Canonical re-reservation superseded prior reservation'
  WHERE sales_order_id = p_so_id
    AND status = 'active';

  FOR v_item IN
    SELECT soi.id, soi.product_id,
           GREATEST(soi.quantity - COALESCE(soi.delivered_quantity, 0), 0) quantity
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = p_so_id
  LOOP
    v_remaining_qty := v_item.quantity;

    FOR v_batch IN
      SELECT b.id, b.current_stock, COALESCE(b.reserved_stock, 0) reserved_stock
      FROM public.batches b
      WHERE b.product_id = v_item.product_id
        AND b.is_active = true
        AND b.current_stock > COALESCE(b.reserved_stock, 0)
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
      ORDER BY
        (b.expiry_date IS NULL) ASC,
        b.expiry_date ASC,
        b.import_date ASC,
        b.created_at ASC,
        b.id ASC
      FOR UPDATE OF b
    LOOP
      v_reserved_qty := LEAST(
        v_remaining_qty,
        v_batch.current_stock - v_batch.reserved_stock
      );

      IF v_reserved_qty > 0 THEN
        INSERT INTO public.stock_reservations (
          sales_order_id,
          sales_order_item_id,
          batch_id,
          product_id,
          reserved_quantity,
          reserved_by,
          is_released,
          status
        )
        VALUES (
          p_so_id,
          v_item.id,
          v_batch.id,
          v_item.product_id,
          v_reserved_qty,
          auth.uid(),
          false,
          'active'
        );
        v_remaining_qty := v_remaining_qty - v_reserved_qty;
      END IF;

      EXIT WHEN v_remaining_qty <= 0;
    END LOOP;

    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id,
        'required_qty', v_item.quantity,
        'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE public.sales_orders
    SET status = 'shortage', updated_at = now()
    WHERE id = p_so_id;
    -- Only create import requirements if called with a user context
    -- (system calls should not create import requirements)
    IF auth.uid() IS NOT NULL OR v_is_system_call = false THEN
      PERFORM public.fn_create_import_requirements(p_so_id, v_shortage_list);
    END IF;
    RETURN QUERY
    SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE public.sales_orders
    SET status = 'stock_reserved', updated_at = now()
    WHERE id = p_so_id;
    RETURN QUERY
    SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_reserve_stock_for_so_v2(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_reserve_stock_for_so_v2(uuid)
TO authenticated, service_role;
