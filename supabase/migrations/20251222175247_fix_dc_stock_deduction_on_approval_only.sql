/*
  # Fix DC Stock Deduction - Only on Approval
  
  1. Problem
    - Trigger deducts stock immediately when DC items are inserted
    - But DCs are created with "pending_approval" status
    - Stock should only be deducted when DC is APPROVED
    - This causes negative stock errors
  
  2. Solution
    - Modify trigger to NOT deduct stock on DC creation
    - Reserve stock instead (reduce available but keep current_stock)
    - Add trigger on DC approval to deduct actual stock
    - On rejection, release reservations
  
  3. Changes
    - Disable automatic stock deduction on DC item insert
    - Add approval trigger to handle stock deduction
    - Add rejection trigger to release reservations
*/

-- Step 1: Modify DC item trigger to ONLY log, NOT deduct stock
CREATE OR REPLACE FUNCTION trg_delivery_challan_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challan_number text;
  v_user_id uuid;
  v_challan_date date;
  v_current_stock numeric;
  v_approval_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Get DC details including approval status
    SELECT dc.challan_number, dc.created_by, dc.challan_date, dc.approval_status
    INTO v_challan_number, v_user_id, v_challan_date, v_approval_status
    FROM delivery_challans dc WHERE dc.id = NEW.challan_id;
    
    -- Get current stock
    SELECT current_stock INTO v_current_stock
    FROM batches WHERE id = NEW.batch_id;
    
    -- Only reserve stock, don't deduct yet (DC needs approval first)
    UPDATE batches
    SET reserved_stock = COALESCE(reserved_stock, 0) + NEW.quantity
    WHERE id = NEW.batch_id;
    
    -- Log transaction
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, created_by, stock_before, stock_after
    ) VALUES (
      NEW.product_id, NEW.batch_id, 'delivery_challan_reserved', -NEW.quantity,
      v_challan_date, v_challan_number, 'delivery_challan_item', NEW.id,
      'Reserved for DC: ' || v_challan_number || ' (Pending Approval)', v_user_id,
      v_current_stock, v_current_stock
    );
    
    RETURN NEW;
    
  ELSIF TG_OP = 'DELETE' THEN
    -- Get DC details
    SELECT dc.challan_number INTO v_challan_number
    FROM delivery_challans dc WHERE dc.id = OLD.challan_id;
    
    -- Get current stock
    SELECT current_stock INTO v_current_stock
    FROM batches WHERE id = OLD.batch_id;
    
    -- Release reservation
    UPDATE batches
    SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - OLD.quantity)
    WHERE id = OLD.batch_id;
    
    -- Log transaction
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, created_by, stock_before, stock_after
    ) VALUES (
      OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
      CURRENT_DATE, v_challan_number, 'dc_item_delete', OLD.id,
      'Released reservation from deleted DC item', COALESCE(auth.uid(), OLD.id),
      v_current_stock, v_current_stock
    );
    
    RETURN OLD;
  END IF;
END;
$$;

-- Step 2: Add trigger on DC approval to deduct actual stock
CREATE OR REPLACE FUNCTION trg_dc_approval_deduct_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_current_stock numeric;
BEGIN
  -- Only process when status changes to 'approved'
  IF NEW.approval_status = 'approved' AND (OLD.approval_status IS NULL OR OLD.approval_status != 'approved') THEN
    
    -- Deduct actual stock for all items
    FOR v_item IN
      SELECT * FROM delivery_challan_items WHERE challan_id = NEW.id
    LOOP
      -- Get current stock
      SELECT current_stock INTO v_current_stock FROM batches WHERE id = v_item.batch_id;
      
      -- Deduct from current_stock and release from reserved_stock
      UPDATE batches
      SET 
        current_stock = current_stock - v_item.quantity,
        reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - v_item.quantity)
      WHERE id = v_item.batch_id;
      
      -- Log transaction
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        v_item.product_id, v_item.batch_id, 'delivery_challan', -v_item.quantity,
        NEW.challan_date, NEW.challan_number, 'delivery_challan', NEW.id,
        'Delivered via approved DC: ' || NEW.challan_number, NEW.approved_by,
        v_current_stock, v_current_stock - v_item.quantity
      );
    END LOOP;
    
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dc_approval_deduct_stock ON delivery_challans;
CREATE TRIGGER trigger_dc_approval_deduct_stock
  AFTER UPDATE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION trg_dc_approval_deduct_stock();

-- Step 3: Add trigger on DC rejection to release reservations
CREATE OR REPLACE FUNCTION trg_dc_rejection_release_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- Only process when status changes to 'rejected'
  IF NEW.approval_status = 'rejected' AND (OLD.approval_status IS NULL OR OLD.approval_status != 'rejected') THEN
    
    -- Release reservations for all items
    FOR v_item IN
      SELECT * FROM delivery_challan_items WHERE challan_id = NEW.id
    LOOP
      -- Release from reserved_stock
      UPDATE batches
      SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - v_item.quantity)
      WHERE id = v_item.batch_id;
      
      -- Log transaction
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by
      ) VALUES (
        v_item.product_id, v_item.batch_id, 'adjustment', v_item.quantity,
        CURRENT_DATE, NEW.challan_number, 'dc_rejected', NEW.id,
        'Released reservation from rejected DC: ' || NEW.challan_number, NEW.approved_by
      );
    END LOOP;
    
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dc_rejection_release_stock ON delivery_challans;
CREATE TRIGGER trigger_dc_rejection_release_stock
  AFTER UPDATE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION trg_dc_rejection_release_stock();
