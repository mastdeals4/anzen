-- ============================================================================
-- Restore Canonical Anzen Sales Order Shortage & Import Requirements Workflow
-- ============================================================================
-- Restores the pre-August-27 business workflow:
-- 1. Insufficient ATP on SO approval does NOT throw a fatal exception.
-- 2. SO reserves available stock (if any), sets status = 'shortage'.
-- 3. Auto-calls fn_create_import_requirements to represent outstanding demand.
-- 4. Batch arrival trigger re-evaluates shortage SOs and auto-fulfills them.
-- 5. Product-level reservation architecture is preserved (no fake batch rows).
-- ============================================================================

BEGIN;

-- 1. reconcile_so_product_reservation_v2
CREATE OR REPLACE FUNCTION public.reconcile_so_product_reservation_v2(
  p_sales_order_item_id uuid,
  p_reason text DEFAULT 'SO state reconciliation'::text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
  v_res public.so_product_reservations%ROWTYPE;
  v_delivered numeric;
  v_required numeric;
  v_delta numeric;
  v_atp numeric;
  v_grant numeric;
BEGIN
  SELECT soi.*, so.status::text AS so_status INTO v_item
  FROM public.sales_order_items soi
  JOIN public.sales_orders so ON so.id = soi.sales_order_id
  WHERE soi.id = p_sales_order_item_id
  FOR UPDATE OF soi, so;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order item not found';
  END IF;

  -- Serialize ATP decisions for the product
  PERFORM pg_advisory_xact_lock(hashtextextended(v_item.product_id::text, 0));

  SELECT COALESCE(sum(dci.quantity), 0) INTO v_delivered
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.sales_order_item_id = v_item.id
    AND dc.approval_status = 'approved';

  IF v_delivered > v_item.quantity THEN
    RAISE EXCEPTION 'Delivered quantity exceeds ordered quantity';
  END IF;

  v_required := CASE
    WHEN v_item.so_status IN ('approved', 'stock_reserved', 'shortage', 'pending_delivery', 'partially_delivered')
      THEN v_item.quantity - v_delivered
    ELSE 0
  END;

  SELECT * INTO v_res
  FROM public.so_product_reservations
  WHERE sales_order_item_id = v_item.id
    AND status = 'active'
  FOR UPDATE;

  IF v_required = 0 THEN
    IF FOUND THEN
      UPDATE public.so_product_reservations
      SET reserved_quantity = 0,
          status = 'released',
          closed_at = now(),
          updated_at = now(),
          close_reason = p_reason
      WHERE id = v_res.id;

      INSERT INTO public.so_product_reservation_events(
        reservation_id, sales_order_id, sales_order_item_id, event_type,
        quantity_delta, quantity_after, reason, actor_id
      ) VALUES (
        v_res.id, v_item.sales_order_id, v_item.id, 'released',
        -v_res.reserved_quantity, 0, p_reason, auth.uid()
      );
    END IF;
    RETURN 0;
  END IF;

  -- Calculate available product ATP (excluding this SO item's existing active reservation if any)
  v_atp := public.product_available_to_promise(
    v_item.product_id,
    CASE WHEN v_res.id IS NOT NULL THEN v_item.id ELSE NULL END
  );

  -- Reserve what is physically available; unfulfilled quantity is handled as shortage
  v_grant := LEAST(v_required, GREATEST(COALESCE(v_atp, 0), 0));

  IF NOT FOUND THEN
    IF v_grant > 0 THEN
      INSERT INTO public.so_product_reservations(
        sales_order_id, sales_order_item_id, product_id, reserved_quantity, created_by
      ) VALUES (
        v_item.sales_order_id, v_item.id, v_item.product_id, v_grant, auth.uid()
      ) RETURNING * INTO v_res;

      INSERT INTO public.so_product_reservation_events(
        reservation_id, sales_order_id, sales_order_item_id, event_type,
        quantity_delta, quantity_after, reason, actor_id
      ) VALUES (
        v_res.id, v_item.sales_order_id, v_item.id, 'created',
        v_grant, v_grant, p_reason, auth.uid()
      );
    END IF;
  ELSE
    IF v_res.product_id <> v_item.product_id THEN
      RAISE EXCEPTION 'Cannot change product on an actively reserved SO item';
    END IF;

    IF v_grant = 0 THEN
      UPDATE public.so_product_reservations
      SET reserved_quantity = 0,
          status = 'released',
          closed_at = now(),
          updated_at = now(),
          close_reason = p_reason
      WHERE id = v_res.id;

      INSERT INTO public.so_product_reservation_events(
        reservation_id, sales_order_id, sales_order_item_id, event_type,
        quantity_delta, quantity_after, reason, actor_id
      ) VALUES (
        v_res.id, v_item.sales_order_id, v_item.id, 'released',
        -v_res.reserved_quantity, 0, p_reason, auth.uid()
      );
    ELSE
      v_delta := v_grant - v_res.reserved_quantity;
      IF v_delta <> 0 THEN
        UPDATE public.so_product_reservations
        SET reserved_quantity = v_grant,
            updated_at = now()
        WHERE id = v_res.id;

        INSERT INTO public.so_product_reservation_events(
          reservation_id, sales_order_id, sales_order_item_id, event_type,
          quantity_delta, quantity_after, reason, actor_id
        ) VALUES (
          v_res.id, v_item.sales_order_id, v_item.id,
          CASE WHEN v_delta > 0 THEN 'increased' ELSE 'decreased' END,
          v_delta, v_grant, p_reason, auth.uid()
        );
      END IF;
    END IF;
  END IF;

  RETURN v_grant;
END;
$$;

-- 2. approve_sales_order_product_reservation_v2
DROP FUNCTION IF EXISTS public.approve_sales_order_product_reservation_v2(uuid, uuid);

CREATE OR REPLACE FUNCTION public.approve_sales_order_product_reservation_v2(
  p_so_id uuid,
  p_approved_by uuid
)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_delivered numeric;
  v_item_required numeric;
  v_reserved numeric;
  v_shortage_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'manager', 'warehouse'])
     AND current_setting('app.canonical_reservation_engine', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Permission denied for SO product reservation approval';
  END IF;

  PERFORM 1 FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  PERFORM set_config('app.canonical_reservation_engine', 'on', true);

  UPDATE public.sales_orders
  SET approved_by = COALESCE(p_approved_by, auth.uid()),
      approved_at = COALESCE(approved_at, now())
  WHERE id = p_so_id;

  FOR r IN
    SELECT id, product_id, quantity
    FROM public.sales_order_items
    WHERE sales_order_id = p_so_id
    ORDER BY product_id, id
  LOOP
    v_reserved := public.reconcile_so_product_reservation_v2(r.id, 'SO approval/re-approval');

    SELECT COALESCE(sum(dci.quantity), 0) INTO v_delivered
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.sales_order_item_id = r.id
      AND dc.approval_status = 'approved';

    v_item_required := GREATEST(r.quantity - v_delivered, 0);

    IF v_item_required > v_reserved THEN
      v_has_shortage := true;
      v_shortage_qty := v_item_required - v_reserved;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', r.product_id,
        'required_qty', r.quantity,
        'shortage_qty', v_shortage_qty
      );
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE public.sales_orders
    SET status = 'shortage',
        updated_at = now()
    WHERE id = p_so_id;

    PERFORM public.fn_create_import_requirements(p_so_id, v_shortage_list);

    RETURN QUERY
    SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE public.sales_orders
    SET status = 'stock_reserved',
        updated_at = now()
    WHERE id = p_so_id;

    RETURN QUERY
    SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;

-- 3. fn_reserve_stock_for_so_v2
CREATE OR REPLACE FUNCTION public.fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM public.approve_sales_order_product_reservation_v2(p_so_id, auth.uid());
END;
$$;

-- 4. fn_auto_rereserve_on_batch_arrival
CREATE OR REPLACE FUNCTION public.fn_auto_rereserve_on_batch_arrival()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_so_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.current_stock IS NOT DISTINCT FROM OLD.current_stock
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
      RETURN NEW;
    END IF;
  END IF;

  -- When positive stock is added or a new active batch arrives with stock
  IF (TG_OP = 'INSERT' AND NEW.is_active AND NEW.current_stock > 0)
     OR (TG_OP = 'UPDATE' AND NEW.is_active AND NEW.current_stock > COALESCE(OLD.current_stock, 0)) THEN

    PERFORM set_config('app.canonical_reservation_engine', 'on', true);

    FOR v_so_id IN
      SELECT DISTINCT so.id
      FROM public.sales_orders so
      JOIN public.sales_order_items soi ON soi.sales_order_id = so.id
      WHERE soi.product_id = NEW.product_id
        AND so.status::text = 'shortage'
        AND NOT COALESCE(so.is_archived, false)
      ORDER BY so.id
    LOOP
      PERFORM public.approve_sales_order_product_reservation_v2(v_so_id, NULL);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- 5. Permissions
REVOKE ALL ON FUNCTION public.approve_sales_order_product_reservation_v2(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_sales_order_product_reservation_v2(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reconcile_so_product_reservation_v2(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_so_product_reservation_v2(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_reserve_stock_for_so_v2(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_reserve_stock_for_so_v2(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_auto_rereserve_on_batch_arrival() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_auto_rereserve_on_batch_arrival() TO authenticated, service_role;

COMMIT;
