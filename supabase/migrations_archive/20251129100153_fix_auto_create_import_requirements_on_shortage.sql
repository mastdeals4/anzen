/*
  # Fix: Auto-create Import Requirements on Stock Shortage

  ## Problem:
  When a sales order has stock shortage, the system marks it as "shortage" 
  but does NOT create import requirements automatically.

  ## Solution:
  Update fn_reserve_stock_for_so_v2 to call fn_create_import_requirements 
  when shortage is detected.

  ## Changes:
  - Modified fn_reserve_stock_for_so_v2 to automatically create import requirements
  - Import requirements are created with correct shortage data
*/

CREATE OR REPLACE FUNCTION fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_batch RECORD;
  v_remaining_qty numeric;
  v_reserved_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  -- Delete existing reservations for this SO
  DELETE FROM stock_reservations WHERE sales_order_id = p_so_id;

  -- Loop through each sales order item
  FOR v_item IN 
    SELECT soi.id, soi.product_id, soi.quantity
    FROM sales_order_items soi
    WHERE soi.sales_order_id = p_so_id
  LOOP
    v_remaining_qty := v_item.quantity;

    -- Get available batches for this product (FIFO order)
    FOR v_batch IN
      SELECT id, batch_number, current_stock, COALESCE(reserved_stock, 0) as reserved_stock
      FROM batches
      WHERE product_id = v_item.product_id
        AND is_active = true
        AND current_stock > COALESCE(reserved_stock, 0)
        AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
      ORDER BY import_date ASC, created_at ASC
    LOOP
      -- Calculate how much we can reserve from this batch
      v_reserved_qty := LEAST(v_remaining_qty, v_batch.current_stock - v_batch.reserved_stock);

      IF v_reserved_qty > 0 THEN
        -- Create reservation record
        INSERT INTO stock_reservations (
          sales_order_id,
          sales_order_item_id,
          batch_id,
          product_id,
          reserved_quantity,
          is_released
        ) VALUES (
          p_so_id,
          v_item.id,
          v_batch.id,
          v_item.product_id,
          v_reserved_qty,
          false
        );

        -- Update batch reserved_stock
        UPDATE batches
        SET reserved_stock = reserved_stock + v_reserved_qty
        WHERE id = v_batch.id;

        v_remaining_qty := v_remaining_qty - v_reserved_qty;
      END IF;

      EXIT WHEN v_remaining_qty <= 0;
    END LOOP;

    -- If there's still remaining quantity, we have shortage
    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id,
        'required_qty', v_item.quantity,
        'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;

  -- Update SO status based on reservation result
  IF v_has_shortage THEN
    UPDATE sales_orders
    SET status = 'shortage', updated_at = now()
    WHERE id = p_so_id;

    -- AUTO-CREATE IMPORT REQUIREMENTS
    PERFORM fn_create_import_requirements(p_so_id, v_shortage_list);

    RETURN QUERY SELECT false, 'Partial stock reserved - shortage exists. Import requirements created.'::text, v_shortage_list;
  ELSE
    UPDATE sales_orders
    SET status = 'stock_reserved', updated_at = now()
    WHERE id = p_so_id;

    RETURN QUERY SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;