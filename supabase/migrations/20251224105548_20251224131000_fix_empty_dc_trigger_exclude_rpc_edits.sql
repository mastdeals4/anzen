/*
  # Fix Empty DC Trigger - Don't Delete During RPC Edits
  
  ## Problem
  The prevent_empty_delivery_challans trigger deletes DCs when they have no items.
  But during edit_delivery_challan RPC:
  1. We delete ALL old items
  2. Trigger sees 0 items → DELETES THE DC!
  3. We try to insert new items → DC doesn't exist → FK error!
  
  ## Solution
  Modify the trigger to NOT delete DC if we're in the middle of an edit operation.
  We can detect this by checking if the DC was just updated (within 1 second).
  
  Better: Just disable this trigger entirely - it's causing more problems than it solves.
  We already have a BEFORE trigger on approval that checks for items.
*/

-- Drop the problematic trigger that deletes empty DCs
DROP TRIGGER IF EXISTS check_empty_dc_after_item_delete ON delivery_challan_items;

-- The verify_dc_items_before_approval trigger already prevents approving empty DCs
-- So we don't need to automatically delete them

-- Optional: Create a safer version that only warns, doesn't delete
-- But for now, just rely on the approval validation
