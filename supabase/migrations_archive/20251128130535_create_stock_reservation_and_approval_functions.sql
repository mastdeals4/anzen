/*
  # Stock Reservation and Approval Functions

  ## Overview
  Functions and triggers to handle stock reservation, release, and approval workflows

  ## Functions Created

  1. **fn_get_free_stock(batch_id)** - Calculate free stock for a batch
  2. **fn_check_product_availability(product_id, required_qty)** - Check if product has sufficient stock
  3. **fn_reserve_stock_for_so(so_id)** - Reserve stock using FIFO logic
  4. **fn_release_stock_reservations(so_id, reason)** - Release all reservations for an SO
  5. **fn_approve_sales_order(so_id, approver_id, remarks)** - Approve SO and trigger reservation
  6. **fn_reject_sales_order(so_id, rejector_id, reason)** - Reject SO and release any stock
  7. **fn_cancel_sales_order(so_id, canceller_id, reason)** - Cancel SO and release stock
  8. **fn_approve_delivery_challan(dc_id, approver_id, remarks)** - Approve DC
  9. **fn_reject_delivery_challan(dc_id, rejector_id, reason)** - Reject DC

  ## Triggers
  - Auto-reserve stock when SO is approved
  - Auto-release stock when SO is cancelled or rejected
  - Auto-consume reservations when DC is approved
*/

-- Function to calculate free stock for a batch
CREATE OR REPLACE FUNCTION fn_get_free_stock(p_batch_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_stock numeric;
  v_reserved_qty numeric;
  v_free_stock numeric;
BEGIN
  -- Get current stock from batches
  SELECT current_stock INTO v_current_stock
  FROM batches
  WHERE id = p_batch_id;
  
  IF v_current_stock IS NULL THEN
    RETURN 0;
  END IF;
  
  -- Get total active reservations
  SELECT COALESCE(SUM(reserved_quantity), 0) INTO v_reserved_qty
  FROM stock_reservations
  WHERE batch_id = p_batch_id
  AND status = 'active';
  
  v_free_stock := v_current_stock - v_reserved_qty;
  
  RETURN GREATEST(v_free_stock, 0);
END;
$$;

-- Function to check product availability across all batches
CREATE OR REPLACE FUNCTION fn_check_product_availability(
  p_product_id uuid,
  p_required_qty numeric
)
RETURNS TABLE(
  batch_id uuid,
  batch_number text,
  expiry_date date,
  free_stock numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    b.id,
    b.batch_number,
    b.expiry_date,
    fn_get_free_stock(b.id) as free_stock
  FROM batches b
  WHERE b.product_id = p_product_id
  AND b.current_stock > 0
  AND fn_get_free_stock(b.id) > 0
  ORDER BY b.expiry_date ASC, b.created_at ASC;
END;
$$;

-- Function to reserve stock for sales order using FIFO
CREATE OR REPLACE FUNCTION fn_reserve_stock_for_so(p_so_id uuid)
RETURNS TABLE(
  success boolean,
  message text,
  shortage_items jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_batch RECORD;
  v_remaining_qty numeric;
  v_reserve_qty numeric;
  v_user_id uuid;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  -- Get user ID from SO
  SELECT created_by INTO v_user_id FROM sales_orders WHERE id = p_so_id;
  
  -- Loop through each SO item
  FOR v_item IN 
    SELECT * FROM sales_order_items 
    WHERE sales_order_id = p_so_id 
    ORDER BY created_at
  LOOP
    v_remaining_qty := v_item.quantity;
    
    -- Find available batches using FIFO (earliest expiry first)
    FOR v_batch IN
      SELECT 
        b.id,
        b.batch_number,
        fn_get_free_stock(b.id) as free_stock
      FROM batches b
      WHERE b.product_id = v_item.product_id
      AND b.current_stock > 0
      ORDER BY b.expiry_date ASC, b.created_at ASC
    LOOP
      EXIT WHEN v_remaining_qty <= 0;
      
      IF v_batch.free_stock > 0 THEN
        -- Reserve from this batch
        v_reserve_qty := LEAST(v_remaining_qty, v_batch.free_stock);
        
        INSERT INTO stock_reservations (
          sales_order_id,
          sales_order_item_id,
          batch_id,
          product_id,
          reserved_quantity,
          reserved_by,
          status
        ) VALUES (
          p_so_id,
          v_item.id,
          v_batch.id,
          v_item.product_id,
          v_reserve_qty,
          v_user_id,
          'active'
        );
        
        v_remaining_qty := v_remaining_qty - v_reserve_qty;
      END IF;
    END LOOP;
    
    -- Check if there's still shortage
    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id,
        'required_qty', v_item.quantity,
        'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;
  
  -- Update SO status
  IF v_has_shortage THEN
    UPDATE sales_orders 
    SET status = 'shortage', updated_at = now()
    WHERE id = p_so_id;
    
    RETURN QUERY SELECT false, 'Partial stock reserved - shortage detected', v_shortage_list;
  ELSE
    UPDATE sales_orders 
    SET status = 'stock_reserved', updated_at = now()
    WHERE id = p_so_id;
    
    RETURN QUERY SELECT true, 'Stock reserved successfully', '[]'::jsonb;
  END IF;
END;
$$;

-- Function to release stock reservations
CREATE OR REPLACE FUNCTION fn_release_stock_reservations(
  p_so_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE stock_reservations
  SET 
    status = 'released',
    released_at = now(),
    released_by = auth.uid(),
    release_reason = p_reason
  WHERE sales_order_id = p_so_id
  AND status = 'active';
  
  RETURN true;
END;
$$;

-- Function to approve sales order
CREATE OR REPLACE FUNCTION fn_approve_sales_order(
  p_so_id uuid,
  p_approver_id uuid,
  p_remarks text DEFAULT NULL
)
RETURNS TABLE(
  success boolean,
  message text,
  shortage_info jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result RECORD;
BEGIN
  -- Update SO to approved
  UPDATE sales_orders
  SET 
    status = 'approved',
    approved_by = p_approver_id,
    approved_at = now(),
    updated_at = now()
  WHERE id = p_so_id;
  
  -- Reserve stock
  SELECT * INTO v_result FROM fn_reserve_stock_for_so(p_so_id);
  
  RETURN QUERY SELECT v_result.success, v_result.message, v_result.shortage_items;
END;
$$;

-- Function to reject sales order
CREATE OR REPLACE FUNCTION fn_reject_sales_order(
  p_so_id uuid,
  p_rejector_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Release any existing reservations
  PERFORM fn_release_stock_reservations(p_so_id, 'SO rejected: ' || p_reason);
  
  -- Update SO to rejected
  UPDATE sales_orders
  SET 
    status = 'rejected',
    rejected_by = p_rejector_id,
    rejected_at = now(),
    rejection_reason = p_reason,
    updated_at = now()
  WHERE id = p_so_id;
  
  RETURN true;
END;
$$;

-- Function to cancel sales order
CREATE OR REPLACE FUNCTION fn_cancel_sales_order(
  p_so_id uuid,
  p_canceller_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Release any existing reservations
  PERFORM fn_release_stock_reservations(p_so_id, 'SO cancelled: ' || p_reason);
  
  -- Update SO to cancelled
  UPDATE sales_orders
  SET 
    status = 'cancelled',
    updated_at = now()
  WHERE id = p_so_id;
  
  RETURN true;
END;
$$;

-- Function to approve delivery challan
CREATE OR REPLACE FUNCTION fn_approve_delivery_challan(
  p_dc_id uuid,
  p_approver_id uuid,
  p_remarks text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so_id uuid;
  v_dc_item RECORD;
BEGIN
  -- Get SO ID from DC
  SELECT sales_order_id INTO v_so_id FROM delivery_challans WHERE id = p_dc_id;
  
  -- Update DC to approved
  UPDATE delivery_challans
  SET 
    approval_status = 'approved',
    approved_by = p_approver_id,
    approved_at = now()
  WHERE id = p_dc_id;
  
  -- If linked to SO, consume reservations and update delivered quantities
  IF v_so_id IS NOT NULL THEN
    -- Loop through DC items and update delivered quantities
    FOR v_dc_item IN
      SELECT dci.product_id, dci.quantity, dci.batch_id
      FROM delivery_challan_items dci
      WHERE dci.delivery_challan_id = p_dc_id
    LOOP
      -- Update delivered quantity in SO items
      UPDATE sales_order_items
      SET delivered_quantity = delivered_quantity + v_dc_item.quantity
      WHERE sales_order_id = v_so_id
      AND product_id = v_dc_item.product_id;
      
      -- Mark reservations as consumed for this batch
      UPDATE stock_reservations
      SET status = 'consumed'
      WHERE sales_order_id = v_so_id
      AND product_id = v_dc_item.product_id
      AND batch_id = v_dc_item.batch_id
      AND status = 'active';
    END LOOP;
    
    -- Check if SO is fully delivered
    UPDATE sales_orders
    SET status = CASE
      WHEN (SELECT SUM(quantity) FROM sales_order_items WHERE sales_order_id = v_so_id) =
           (SELECT SUM(delivered_quantity) FROM sales_order_items WHERE sales_order_id = v_so_id)
      THEN 'delivered'
      ELSE 'partially_delivered'
    END
    WHERE id = v_so_id;
  END IF;
  
  RETURN true;
END;
$$;

-- Function to reject delivery challan
CREATE OR REPLACE FUNCTION fn_reject_delivery_challan(
  p_dc_id uuid,
  p_rejector_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE delivery_challans
  SET 
    approval_status = 'rejected',
    rejection_reason = p_reason
  WHERE id = p_dc_id;
  
  RETURN true;
END;
$$;

-- Trigger function to handle SO deletion
CREATE OR REPLACE FUNCTION trg_sales_order_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Release reservations when SO is deleted
  PERFORM fn_release_stock_reservations(OLD.id, 'Sales order deleted');
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sales_order_deleted ON sales_orders;
CREATE TRIGGER trigger_sales_order_deleted
  BEFORE DELETE ON sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_sales_order_deleted();
