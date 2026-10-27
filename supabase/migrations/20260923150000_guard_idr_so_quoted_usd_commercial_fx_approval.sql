-- Migration: 20260923150000_guard_idr_so_quoted_usd_commercial_fx_approval.sql
-- Description:
-- Enforce commercial FX rate requirement before final approval of IDR Sales Orders:
-- If an IDR Sales Order has any line with quoted_usd_unit_price > 0,
-- commercial_usd_to_idr_rate must be provided before final approval.
-- Draft state remains unblocked.

-- 1. Update approve_sales_order_product_reservation_v2
CREATE OR REPLACE FUNCTION public.approve_sales_order_product_reservation_v2(p_so_id uuid, p_approved_by uuid)
 RETURNS TABLE(success boolean, message text, shortage_items jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_so record;
  r record;
  v_delivered numeric;
  v_item_required numeric;
  v_reserved numeric;
  v_shortage_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse'])
     AND current_setting('app.canonical_reservation_engine', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Permission denied for SO product reservation approval';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  -- Guard: If IDR Sales Order has any line with quoted_usd_unit_price > 0, commercial_usd_to_idr_rate must be provided before approval
  IF v_so.currency = 'IDR' AND (v_so.commercial_usd_to_idr_rate IS NULL OR v_so.commercial_usd_to_idr_rate <= 0) THEN
    IF EXISTS (
      SELECT 1 FROM public.sales_order_items
      WHERE sales_order_id = p_so_id
        AND quoted_usd_unit_price IS NOT NULL
        AND quoted_usd_unit_price > 0
    ) THEN
      RAISE EXCEPTION 'Set the commercial USD→IDR exchange rate before approving this Sales Order.';
    END IF;
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

    -- Cancel any pending import requirements for this SO
    UPDATE public.import_requirements
    SET status = 'cancelled',
        notes = COALESCE(notes || ' | ', '') ||
          'Auto-cancelled: shortage resolved by stock reservation ' ||
          to_char(now(), 'YYYY-MM-DD'),
        updated_at = now()
    WHERE sales_order_id = p_so_id
      AND status = 'pending';

    RETURN QUERY
    SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_sales_order_product_reservation_v2(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_sales_order_product_reservation_v2(uuid, uuid) TO authenticated, service_role;

-- 2. Update inventory_v1_guard_sales_order_approval trigger function
CREATE OR REPLACE FUNCTION public.inventory_v1_guard_sales_order_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status::text IN ('approved', 'stock_reserved', 'shortage')
     AND OLD.status::text NOT IN ('approved', 'stock_reserved', 'shortage') THEN
    IF NEW.currency = 'IDR' AND (NEW.commercial_usd_to_idr_rate IS NULL OR NEW.commercial_usd_to_idr_rate <= 0) THEN
      IF EXISTS (
        SELECT 1 FROM public.sales_order_items
        WHERE sales_order_id = NEW.id
          AND quoted_usd_unit_price IS NOT NULL
          AND quoted_usd_unit_price > 0
      ) THEN
        RAISE EXCEPTION 'Set the commercial USD→IDR exchange rate before approving this Sales Order.';
      END IF;
    END IF;
  END IF;

  IF NEW.status::text = 'approved'
     AND OLD.status::text IS DISTINCT FROM 'approved'
     AND current_setting('app.canonical_reservation_engine', true)
       IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Direct Sales Order approval blocked; use canonical reservation engine';
  END IF;
  RETURN NEW;
END;
$function$;
