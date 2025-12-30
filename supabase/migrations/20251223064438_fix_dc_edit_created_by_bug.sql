/*
  # Fix DC Edit - created_by Foreign Key Bug
  
  1. Problem
    - When editing DC, the trigger uses COALESCE(auth.uid(), OLD.id)
    - OLD.id is the DC item ID, not a user ID
    - This causes foreign key violation in inventory_transactions
    - Error: created_by not present in user_profiles table
  
  2. Solution
    - Use proper fallback: get the DC creator user_id
    - Never use OLD.id as created_by
  
  3. Changes
    - Fix trg_delivery_challan_item_inventory() to use proper user ID
*/

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
    -- Get DC details and user_id
    SELECT dc.challan_number, dc.created_by INTO v_challan_number, v_user_id
    FROM delivery_challans dc WHERE dc.id = OLD.challan_id;
    
    -- Get current stock
    SELECT current_stock INTO v_current_stock
    FROM batches WHERE id = OLD.batch_id;
    
    -- Release reservation
    UPDATE batches
    SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - OLD.quantity)
    WHERE id = OLD.batch_id;
    
    -- Log transaction with proper user ID
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, created_by, stock_before, stock_after
    ) VALUES (
      OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
      CURRENT_DATE, v_challan_number, 'dc_item_delete', OLD.challan_id,
      'Released reservation from deleted pending DC item', COALESCE(auth.uid(), v_user_id),
      v_current_stock, v_current_stock
    );
    
    RETURN OLD;
  END IF;
END;
$$;
