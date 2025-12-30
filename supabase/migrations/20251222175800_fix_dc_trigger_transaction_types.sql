/*
  # Fix DC Trigger - Use Correct Transaction Types
  
  1. Problem
    - Trigger uses 'delivery_challan_reserved' which is NOT allowed
    - Allowed types: purchase, sale, adjustment, return, delivery_challan
    - This causes constraint violation error
  
  2. Solution
    - Use 'adjustment' for reservations and releases
    - Use 'delivery_challan' only when stock is actually deducted (on approval)
  
  3. Changes
    - Fix transaction_type in all trigger functions
*/

-- Fix DC item trigger to use correct transaction types
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
    SELECT dc.challan_number, dc.created_by, dc.challan_date, dc.approval_status
    INTO v_challan_number, v_user_id, v_challan_date, v_approval_status
    FROM delivery_challans dc WHERE dc.id = NEW.challan_id;
    
    SELECT current_stock INTO v_current_stock
    FROM batches WHERE id = NEW.batch_id;
    
    UPDATE batches
    SET reserved_stock = COALESCE(reserved_stock, 0) + NEW.quantity
    WHERE id = NEW.batch_id;
    
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, created_by, stock_before, stock_after
    ) VALUES (
      NEW.product_id, NEW.batch_id, 'adjustment', NEW.quantity,
      v_challan_date, v_challan_number, 'delivery_challan_item', NEW.id,
      'Reserved for DC: ' || v_challan_number || ' (Pending Approval)', v_user_id,
      v_current_stock, v_current_stock
    );
    
    RETURN NEW;
    
  ELSIF TG_OP = 'DELETE' THEN
    SELECT dc.challan_number INTO v_challan_number
    FROM delivery_challans dc WHERE dc.id = OLD.challan_id;
    
    SELECT current_stock INTO v_current_stock
    FROM batches WHERE id = OLD.batch_id;
    
    UPDATE batches
    SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - OLD.quantity)
    WHERE id = OLD.batch_id;
    
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
