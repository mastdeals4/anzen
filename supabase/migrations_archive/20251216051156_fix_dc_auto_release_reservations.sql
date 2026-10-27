/*
  # Auto-release reservations when Delivery Challan is created
  
  1. Problem
    - DC creation deducts stock via trg_delivery_challan_item_inventory()
    - But reservations are NOT automatically released
    - This causes negative available stock (total - phantom reservations)
  
  2. Solution
    - Create trigger to auto-release reservations when DC items are inserted
    - Only releases if DC is linked to a Sales Order
    - Matches product, batch, and quantity from the DC item
  
  3. Changes
    - New function: trg_auto_release_reservation_on_dc_item()
    - New trigger on delivery_challan_items AFTER INSERT
*/

-- Function: Auto-release stock reservations when DC item is created
CREATE OR REPLACE FUNCTION trg_auto_release_reservation_on_dc_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so_id uuid;
  v_reservation RECORD;
  v_remaining_qty numeric;
  v_release_qty numeric;
BEGIN
  -- Get the sales_order_id from the delivery challan
  SELECT sales_order_id INTO v_so_id
  FROM delivery_challans
  WHERE id = NEW.challan_id;
  
  -- Only process if DC is linked to a Sales Order
  IF v_so_id IS NOT NULL THEN
    v_remaining_qty := NEW.quantity;
    
    -- Find and release matching reservations (FIFO order)
    FOR v_reservation IN
      SELECT id, batch_id, reserved_quantity
      FROM stock_reservations
      WHERE sales_order_id = v_so_id
        AND product_id = NEW.product_id
        AND batch_id = NEW.batch_id
        AND status = 'active'
      ORDER BY id ASC
    LOOP
      EXIT WHEN v_remaining_qty <= 0;
      
      -- Calculate how much to release from this reservation
      v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);
      
      -- Reduce batch reserved_stock
      UPDATE batches
      SET reserved_stock = GREATEST(0, reserved_stock - v_release_qty)
      WHERE id = v_reservation.batch_id;
      
      -- If releasing full amount, mark as released. Otherwise reduce quantity
      IF v_release_qty >= v_reservation.reserved_quantity THEN
        UPDATE stock_reservations
        SET status = 'released'
        WHERE id = v_reservation.id;
      ELSE
        UPDATE stock_reservations
        SET reserved_quantity = reserved_quantity - v_release_qty
        WHERE id = v_reservation.id;
      END IF;
      
      v_remaining_qty := v_remaining_qty - v_release_qty;
    END LOOP;
    
    -- Check if all reservations for this SO are now released
    IF NOT EXISTS (
      SELECT 1 FROM stock_reservations
      WHERE sales_order_id = v_so_id AND status = 'active'
    ) THEN
      -- Update SO status to delivered
      UPDATE sales_orders
      SET status = 'delivered', updated_at = now()
      WHERE id = v_so_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger AFTER delivery_challan_items INSERT
DROP TRIGGER IF EXISTS trigger_auto_release_reservation_on_dc_item ON delivery_challan_items;
CREATE TRIGGER trigger_auto_release_reservation_on_dc_item
  AFTER INSERT ON delivery_challan_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_auto_release_reservation_on_dc_item();

-- Also update the restoration trigger to properly handle status field
CREATE OR REPLACE FUNCTION fn_restore_reservation_on_dc_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
      -- Restore batch stock (already handled by inventory trigger)
      -- Just recreate reservation
      INSERT INTO stock_reservations (
        sales_order_id,
        sales_order_item_id,
        batch_id,
        product_id,
        reserved_quantity,
        status
      )
      SELECT 
        OLD.sales_order_id,
        soi.id,
        v_item.batch_id,
        v_item.product_id,
        v_item.quantity,
        'active'
      FROM sales_order_items soi
      WHERE soi.sales_order_id = OLD.sales_order_id 
        AND soi.product_id = v_item.product_id
      LIMIT 1
      ON CONFLICT DO NOTHING;
      
      -- Update batch reserved_stock
      UPDATE batches
      SET reserved_stock = reserved_stock + v_item.quantity
      WHERE id = v_item.batch_id;
    END LOOP;
    
    -- Restore SO status to stock_reserved
    UPDATE sales_orders
    SET status = 'stock_reserved', updated_at = now()
    WHERE id = OLD.sales_order_id;
  END IF;
  
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_restore_reservation_on_dc_delete ON delivery_challans;
CREATE TRIGGER trigger_restore_reservation_on_dc_delete
  BEFORE DELETE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION fn_restore_reservation_on_dc_delete();
