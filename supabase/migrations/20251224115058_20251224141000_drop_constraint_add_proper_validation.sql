/*
  # Drop Problematic Constraint and Add Proper Validation
  
  ## Problem
  - CHECK constraint blocks edit because it checks DURING transaction
  - Stock is 250kg (already deducted) but trying to reserve 600kg
  - Can't make CHECK constraints deferrable in Postgres
  
  ## Solution
  - DROP the constraint entirely
  - Add validation in the trigger that understands edit flow
  - Restore stock to correct value
  - Clear bogus approved_at
*/

-- Step 1: DROP the problematic constraint
ALTER TABLE batches DROP CONSTRAINT IF EXISTS chk_batch_reserved_not_exceed_current;

-- Step 2: Restore stock (was incorrectly deducted)
UPDATE batches
SET current_stock = 850.000, reserved_stock = 0
WHERE batch_number = '4001/1101/25/A-3145';

UPDATE batches
SET current_stock = 450.000, reserved_stock = 0
WHERE batch_number = '4001/1101/25/A-3146';

UPDATE batches
SET current_stock = 600.000, reserved_stock = 0
WHERE batch_number = '4001/1101/25/A-3147';

-- Step 3: Clear bogus approved_at from DO-25-0009
UPDATE delivery_challans
SET approved_at = NULL, approved_by = NULL
WHERE challan_number = 'DO-25-0009' AND approval_status = 'pending_approval';

-- Step 4: Add validation to trigger instead
CREATE OR REPLACE FUNCTION trg_delivery_challan_item_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challan_number text;
  v_user_id uuid;
  v_challan_date date;
  v_current_stock numeric;
  v_reserved_stock numeric;
  v_approval_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Get DC details
    SELECT dc.challan_number, dc.created_by, dc.challan_date, dc.approval_status
    INTO v_challan_number, v_user_id, v_challan_date, v_approval_status
    FROM delivery_challans dc WHERE dc.id = NEW.challan_id;
    
    -- Get current batch state
    SELECT current_stock, reserved_stock 
    INTO v_current_stock, v_reserved_stock
    FROM batches WHERE id = NEW.batch_id;
    
    -- Reserve stock (don't deduct yet)
    UPDATE batches
    SET reserved_stock = COALESCE(reserved_stock, 0) + NEW.quantity
    WHERE id = NEW.batch_id;
    
    -- Validate AFTER update (in case of edit, old reservations were released first)
    SELECT reserved_stock INTO v_reserved_stock
    FROM batches WHERE id = NEW.batch_id;
    
    IF v_reserved_stock > v_current_stock THEN
      RAISE EXCEPTION 'Insufficient stock: Batch has %kg available but trying to reserve %kg total', 
        v_current_stock, v_reserved_stock;
    END IF;
    
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
    SELECT dc.challan_number, dc.created_by 
    INTO v_challan_number, v_user_id
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
      CURRENT_DATE, v_challan_number, 'dc_item_delete', OLD.challan_id,
      'Released reservation from deleted/edited DC item', COALESCE(auth.uid(), v_user_id),
      v_current_stock, v_current_stock
    );
    
    RETURN OLD;
  END IF;
END;
$$;
