/*
  # Fix DC Item Delete - Only Release Reservations for Pending DCs
  
  1. Problem
    - When deleting items from a PENDING DC during edit, trigger adds stock back to current_stock
    - But pending DCs only RESERVED stock, they didn't DEDUCT it
    - So delete should only RELEASE reservations, not add to current_stock
    - This caused stock to incorrectly increase from 850kg → 1450kg → 2100kg
  
  2. Solution
    - Check DC approval status
    - If DC is PENDING: Only release reservations, don't touch current_stock
    - If DC is APPROVED: Add back to current_stock (reverse the deduction)
  
  3. Changes
    - Fix delete logic in trigger to check approval status
    - Only restore stock if DC was already approved
*/

-- Fix DC item trigger DELETE operation
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
    
    -- Only reserve stock, don't deduct yet
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
    -- Get DC details including approval status
    SELECT dc.challan_number, dc.approval_status
    INTO v_challan_number, v_approval_status
    FROM delivery_challans dc WHERE dc.id = OLD.challan_id;
    
    SELECT current_stock INTO v_current_stock
    FROM batches WHERE id = OLD.batch_id;
    
    -- Check if DC was approved or pending
    IF v_approval_status = 'approved' THEN
      -- DC was approved, so stock was already deducted
      -- Restore both current_stock and release reservation
      UPDATE batches
      SET 
        current_stock = current_stock + OLD.quantity,
        reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - OLD.quantity)
      WHERE id = OLD.batch_id;
      
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
        CURRENT_DATE, v_challan_number, 'dc_item_delete', OLD.id,
        'Restored stock from deleted approved DC item', COALESCE(auth.uid(), OLD.id),
        v_current_stock, v_current_stock + OLD.quantity
      );
    ELSE
      -- DC was pending, stock was only reserved not deducted
      -- Only release reservation, don't touch current_stock
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
        'Released reservation from deleted pending DC item', COALESCE(auth.uid(), OLD.id),
        v_current_stock, v_current_stock
      );
    END IF;
    
    RETURN OLD;
  END IF;
END;
$$;
