/*
  # Prevent Empty Delivery Challans - Bulletproof System
  
  ## Problem
  - DC-0004 and DC-0009 were created without items
  - This corrupts stock calculations and causes blank displays
  
  ## Solution
  Create a database constraint that automatically deletes any DC that has no items.
  This ensures no DC can exist without at least one item.
  
  ## Changes
  1. Create function to check if DC has items
  2. Create trigger to enforce the constraint
  3. This runs AFTER any operation that might leave a DC empty
*/

-- Function to check and delete empty DCs
CREATE OR REPLACE FUNCTION prevent_empty_delivery_challans()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if the DC has any items
  IF NOT EXISTS (
    SELECT 1 FROM delivery_challan_items
    WHERE challan_id = OLD.challan_id
  ) THEN
    -- If no items exist after delete, delete the DC
    DELETE FROM delivery_challans WHERE id = OLD.challan_id;
  END IF;
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger that runs after items are deleted
DROP TRIGGER IF EXISTS check_empty_dc_after_item_delete ON delivery_challan_items;
CREATE TRIGGER check_empty_dc_after_item_delete
AFTER DELETE ON delivery_challan_items
FOR EACH ROW
EXECUTE FUNCTION prevent_empty_delivery_challans();

-- Function to verify DC has items before approval
CREATE OR REPLACE FUNCTION verify_dc_has_items_before_approval()
RETURNS TRIGGER AS $$
DECLARE
  v_item_count integer;
BEGIN
  -- Only check when approval_status is being changed to 'approved'
  IF NEW.approval_status = 'approved' AND (OLD.approval_status IS NULL OR OLD.approval_status != 'approved') THEN
    -- Check if DC has items
    SELECT COUNT(*) INTO v_item_count
    FROM delivery_challan_items
    WHERE challan_id = NEW.id;
    
    IF v_item_count = 0 THEN
      RAISE EXCEPTION 'Cannot approve Delivery Challan %. It has no items. Please add items before approving.',
        NEW.challan_number;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to prevent approving empty DCs
DROP TRIGGER IF EXISTS verify_dc_items_before_approval ON delivery_challans;
CREATE TRIGGER verify_dc_items_before_approval
BEFORE UPDATE ON delivery_challans
FOR EACH ROW
EXECUTE FUNCTION verify_dc_has_items_before_approval();
