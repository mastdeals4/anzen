/*
  # Fix Corrupted DC State First
  
  ## Problem
  Multiple DCs have inconsistent approval state
  - approved_at SET but approval_status != 'approved'
  - Stock was deducted but status says pending
  
  ## Solution
  1. Find all corrupted DCs
  2. Restore their stock
  3. Clear their approval data
  4. Then add constraint to prevent future corruption
*/

-- Step 1: Find and fix all corrupted DCs
DO $$
DECLARE
  v_dc record;
  v_item record;
BEGIN
  RAISE NOTICE 'Finding corrupted DCs...';
  
  FOR v_dc IN 
    SELECT id, challan_number, approved_at, approval_status
    FROM delivery_challans
    WHERE approved_at IS NOT NULL 
      AND approval_status != 'approved'
  LOOP
    RAISE NOTICE 'Fixing corrupted DC: % (status=%, approved_at=%)', 
      v_dc.challan_number, v_dc.approval_status, v_dc.approved_at;
    
    -- Restore stock that was deducted
    FOR v_item IN
      SELECT dci.*, b.batch_number, b.current_stock
      FROM delivery_challan_items dci
      JOIN batches b ON dci.batch_id = b.id
      WHERE dci.challan_id = v_dc.id
    LOOP
      RAISE NOTICE '  Restoring %kg to batch % (current=%kg)', 
        v_item.quantity, v_item.batch_number, v_item.current_stock;
      
      -- Add back the deducted stock
      UPDATE batches
      SET current_stock = current_stock + v_item.quantity,
          reserved_stock = 0
      WHERE id = v_item.batch_id;
    END LOOP;
    
    -- Clear approval completely
    UPDATE delivery_challans
    SET approved_at = NULL,
        approved_by = NULL
    WHERE id = v_dc.id;
  END LOOP;
END $$;

-- Step 2: Verify DC-0009 specifically
SELECT 
  dc.challan_number,
  dc.approval_status,
  dc.approved_at,
  b.batch_number,
  b.current_stock::text || 'kg' as stock,
  b.reserved_stock::text || 'kg' as reserved
FROM delivery_challans dc
JOIN delivery_challan_items dci ON dc.id = dci.challan_id
JOIN batches b ON dci.batch_id = b.id
WHERE dc.challan_number = 'DO-25-0009';
