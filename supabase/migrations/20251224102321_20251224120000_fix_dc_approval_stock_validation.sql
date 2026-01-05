/*
  # Fix DC Approval Stock Validation
  
  ## Problem
  1. User tries to approve DC with insufficient stock  
  2. Trigger fires AFTER update and tries to deduct stock
  3. Stock goes negative → constraint violation
  4. Entire transaction ROLLS BACK (including approval_status update)
  5. DC stays as "pending_approval"  
  6. User can click approve again → same error loop!
  
  ## Root Cause
  - Stock validation happens AFTER the UPDATE in trigger
  - When validation fails, rollback reverts approval_status
  - User sees error but DC status doesn't change
  
  ## Solution
  - Add stock validation in BEFORE trigger  
  - Check if sufficient stock available BEFORE committing approval
  - Raise clear error if insufficient stock
  - This prevents the approval from even starting if stock is insufficient
  
  ## Changes
  1. Modify approval trigger to validate stock FIRST
  2. Move from AFTER to BEFORE trigger for validation
  3. Keep AFTER trigger for actual deduction
*/

-- Drop existing triggers
DROP TRIGGER IF EXISTS trigger_dc_approval_deduct_stock ON delivery_challans;
DROP TRIGGER IF EXISTS trigger_dc_approval_validate_stock ON delivery_challans;

-- Step 1: Create BEFORE trigger to validate stock availability
CREATE OR REPLACE FUNCTION trg_dc_approval_validate_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_available_stock numeric;
  v_product_name text;
  v_batch_number text;
  v_unit text;
BEGIN
  -- Only validate when status changes to 'approved'
  IF NEW.approval_status = 'approved' AND (OLD.approval_status IS NULL OR OLD.approval_status != 'approved') THEN
    
    -- Check stock for all items
    FOR v_item IN
      SELECT dci.*, p.product_name, p.unit, b.batch_number, b.current_stock, b.reserved_stock
      FROM delivery_challan_items dci
      JOIN products p ON dci.product_id = p.id
      JOIN batches b ON dci.batch_id = b.id
      WHERE dci.challan_id = NEW.id
    LOOP
      -- Calculate available stock
      v_available_stock := v_item.current_stock;
      
      -- Check if enough stock
      IF v_available_stock < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for batch %!

Product: %
Batch: %
Available: % %
Requested: % %

Please reduce quantity or select a different batch.',
          v_item.batch_number,
          v_item.product_name,
          v_item.batch_number,
          v_available_stock,
          COALESCE(v_item.unit, 'units'),
          v_item.quantity,
          COALESCE(v_item.unit, 'units');
      END IF;
    END LOOP;
    
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_dc_approval_validate_stock
  BEFORE UPDATE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION trg_dc_approval_validate_stock();

-- Step 2: Keep AFTER trigger for stock deduction (only if validation passed)
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
  IF NEW.approval_status = 'approved' AND (OLD.approval_status != 'approved') THEN
    
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

CREATE TRIGGER trigger_dc_approval_deduct_stock
  AFTER UPDATE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION trg_dc_approval_deduct_stock();
