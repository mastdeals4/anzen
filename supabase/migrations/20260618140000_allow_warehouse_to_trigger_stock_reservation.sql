/*
  Allow warehouse role to execute fn_reserve_stock_for_so_v2.

  When a warehouse user adds a new batch, the trigger
  fn_auto_rereserve_on_batch_arrival fires and calls
  fn_reserve_stock_for_so_v2 to auto-fill any pending shortage SOs.
  The previous role guard ('admin', 'accounts', 'manager' only) blocked
  this trigger path and raised "Permission denied: role warehouse cannot
  reserve stock for sales orders".

  The Approve button in SalesOrders.tsx is already restricted to
  profile?.role === 'admin', so adding 'warehouse' here does not expose
  manual SO approval to warehouse staff through the UI.
*/

CREATE OR REPLACE FUNCTION public.fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_item RECORD;
  v_batch RECORD;
  v_remaining_qty numeric;
  v_reserved_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'manager', 'warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot reserve stock for sales orders', v_role;
  END IF;

  DELETE FROM stock_reservations WHERE sales_order_id = p_so_id;

  FOR v_item IN
    SELECT soi.id, soi.product_id, soi.quantity
    FROM sales_order_items soi WHERE soi.sales_order_id = p_so_id
  LOOP
    v_remaining_qty := v_item.quantity;
    FOR v_batch IN
      SELECT b.id, b.current_stock, COALESCE(b.reserved_stock, 0) as reserved_stock
      FROM batches b
      WHERE b.product_id = v_item.product_id
        AND b.is_active = true
        AND b.current_stock > COALESCE(b.reserved_stock, 0)
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
      ORDER BY b.import_date ASC, b.created_at ASC
    LOOP
      v_reserved_qty := LEAST(v_remaining_qty, v_batch.current_stock - v_batch.reserved_stock);
      IF v_reserved_qty > 0 THEN
        INSERT INTO stock_reservations (
          sales_order_id, sales_order_item_id, batch_id, product_id, reserved_quantity, is_released
        ) VALUES (p_so_id, v_item.id, v_batch.id, v_item.product_id, v_reserved_qty, false);
        v_remaining_qty := v_remaining_qty - v_reserved_qty;
      END IF;
      EXIT WHEN v_remaining_qty <= 0;
    END LOOP;
    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id, 'required_qty', v_item.quantity, 'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE sales_orders SET status = 'shortage', updated_at = now() WHERE id = p_so_id;
    PERFORM fn_create_import_requirements(p_so_id, v_shortage_list);
    RETURN QUERY SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE sales_orders SET status = 'stock_reserved', updated_at = now() WHERE id = p_so_id;
    RETURN QUERY SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;
