/*
  # Stock Reservation Management Functions
  
  1. Functions Created
    - `fn_reserve_stock_for_so_v2` - Reserve stock without deducting (updated logic)
    - `fn_release_reservation_by_so_id` - Release all reservations for a SO
    - `fn_release_partial_reservation` - Release specific product/quantity
    - `fn_deduct_stock_and_release_reservation` - For DC creation
    - `fn_restore_reservation_on_dc_delete` - Restore when DC deleted
  
  2. Triggers
    - Auto-release reservations on SO cancellation/rejection
    - Auto-restore reservations on DC deletion
*/

-- Function: Reserve stock for Sales Order (ONLY reserve, no deduction)
CREATE OR REPLACE FUNCTION fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(
  success boolean,
  message text,
  shortage_items jsonb
) 
LANGUAGE plpgsql
SECURITY DEFINER
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
        'ordered_qty', v_item.quantity,
        'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;
  
  -- Update SO status based on reservation result
  IF v_has_shortage THEN
    UPDATE sales_orders
    SET status = 'shortage', updated_at = now()
    WHERE id = p_so_id;
    
    RETURN QUERY SELECT false, 'Partial stock reserved - shortage exists'::text, v_shortage_list;
  ELSE
    UPDATE sales_orders
    SET status = 'stock_reserved', updated_at = now()
    WHERE id = p_so_id;
    
    RETURN QUERY SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;

-- Function: Release all reservations for a Sales Order
CREATE OR REPLACE FUNCTION fn_release_reservation_by_so_id(
  p_so_id uuid,
  p_released_by uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reservation RECORD;
BEGIN
  -- Loop through all unreleased reservations for this SO
  FOR v_reservation IN
    SELECT id, batch_id, reserved_quantity
    FROM stock_reservations
    WHERE sales_order_id = p_so_id AND is_released = false
  LOOP
    -- Reduce batch reserved_stock
    UPDATE batches
    SET reserved_stock = GREATEST(0, reserved_stock - v_reservation.reserved_quantity)
    WHERE id = v_reservation.batch_id;
    
    -- Mark reservation as released
    UPDATE stock_reservations
    SET 
      is_released = true,
      released_at = now(),
      released_by = p_released_by
    WHERE id = v_reservation.id;
  END LOOP;
  
  RETURN true;
END;
$$;

-- Function: Release partial reservation (specific product/quantity)
CREATE OR REPLACE FUNCTION fn_release_partial_reservation(
  p_so_id uuid,
  p_product_id uuid,
  p_qty numeric,
  p_released_by uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reservation RECORD;
  v_remaining_qty numeric := p_qty;
  v_release_qty numeric;
BEGIN
  -- Loop through reservations for this SO and product
  FOR v_reservation IN
    SELECT id, batch_id, reserved_quantity
    FROM stock_reservations
    WHERE sales_order_id = p_so_id 
      AND product_id = p_product_id 
      AND is_released = false
    ORDER BY created_at ASC
  LOOP
    EXIT WHEN v_remaining_qty <= 0;
    
    v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);
    
    -- Reduce batch reserved_stock
    UPDATE batches
    SET reserved_stock = GREATEST(0, reserved_stock - v_release_qty)
    WHERE id = v_reservation.batch_id;
    
    -- Mark reservation as released or update quantity
    IF v_release_qty >= v_reservation.reserved_quantity THEN
      UPDATE stock_reservations
      SET 
        is_released = true,
        released_at = now(),
        released_by = p_released_by
      WHERE id = v_reservation.id;
    ELSE
      -- Partial release - reduce reserved quantity
      UPDATE stock_reservations
      SET reserved_quantity = reserved_quantity - v_release_qty
      WHERE id = v_reservation.id;
    END IF;
    
    v_remaining_qty := v_remaining_qty - v_release_qty;
  END LOOP;
  
  RETURN true;
END;
$$;

-- Function: Deduct stock and release reservation (for DC creation)
CREATE OR REPLACE FUNCTION fn_deduct_stock_and_release_reservation(
  p_so_id uuid,
  p_batch_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Deduct actual stock from batch
  UPDATE batches
  SET current_stock = current_stock - p_quantity
  WHERE id = p_batch_id;
  
  -- Release reservation for this quantity
  PERFORM fn_release_partial_reservation(p_so_id, p_product_id, p_quantity, p_user_id);
  
  RETURN true;
END;
$$;

-- Function: Restore reservation when DC is deleted
CREATE OR REPLACE FUNCTION fn_restore_reservation_on_dc_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- Only restore if DC was linked to a SO
  IF OLD.sales_order_id IS NOT NULL THEN
    -- Loop through DC items and restore stock + recreate reservations
    FOR v_item IN
      SELECT product_id, batch_id, quantity
      FROM delivery_challan_items
      WHERE challan_id = OLD.id
    LOOP
      -- Restore batch stock
      UPDATE batches
      SET current_stock = current_stock + v_item.quantity
      WHERE id = v_item.batch_id;
      
      -- Recreate reservation
      INSERT INTO stock_reservations (
        sales_order_id,
        sales_order_item_id,
        batch_id,
        product_id,
        reserved_quantity,
        is_released
      )
      SELECT 
        OLD.sales_order_id,
        soi.id,
        v_item.batch_id,
        v_item.product_id,
        v_item.quantity,
        false
      FROM sales_order_items soi
      WHERE soi.sales_order_id = OLD.sales_order_id 
        AND soi.product_id = v_item.product_id
      LIMIT 1;
      
      -- Update batch reserved_stock
      UPDATE batches
      SET reserved_stock = reserved_stock + v_item.quantity
      WHERE id = v_item.batch_id;
    END LOOP;
  END IF;
  
  RETURN OLD;
END;
$$;

-- Function: Auto-release reservations when SO is cancelled/rejected
CREATE OR REPLACE FUNCTION fn_auto_release_on_so_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Release reservations if status changes to cancelled or rejected
  IF NEW.status IN ('cancelled', 'rejected') AND OLD.status NOT IN ('cancelled', 'rejected') THEN
    PERFORM fn_release_reservation_by_so_id(NEW.id, NEW.updated_at::text::uuid);
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create triggers
DROP TRIGGER IF EXISTS trigger_auto_release_on_so_status ON sales_orders;
CREATE TRIGGER trigger_auto_release_on_so_status
  AFTER UPDATE ON sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION fn_auto_release_on_so_status_change();

DROP TRIGGER IF EXISTS trigger_restore_reservation_on_dc_delete ON delivery_challans;
CREATE TRIGGER trigger_restore_reservation_on_dc_delete
  BEFORE DELETE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION fn_restore_reservation_on_dc_delete();
