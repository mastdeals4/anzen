/*
  # Fix Product Stock Discrepancies - Sync with Batch Current Stock

  1. Problem Found
    - Corn Starch BP (PROD-0008): product shows 2800, batches show 25 (discrepancy: 2775)
    - Ibuprofen BP (PROD-0011): product shows 2250, batches show 550 (discrepancy: 1700)
    - Piroxicam USP (PROD-0006): product shows 200, batches show 100 (discrepancy: 100)
    - Meloxicam (PROD-0015): product shows 0, batches show 50 (discrepancy: -50)
    
  2. Root Cause
    - The products.current_stock trigger was added in migration 20260111164536
    - But prior to that, stock was tracked inconsistently with many duplicate adjustments
    - The batch.current_stock values are the ground truth (directly maintained by all transactions)
    
  3. Fix
    - Recalculate ALL products.current_stock to match sum of active batch current_stocks
    - Update the trigger to be more reliable
    
  4. Important Notes
    - SAFE operation - only updates product totals to match actual batch inventory
    - Batch values = ground truth (directly updated by each transaction trigger)
    - Product current_stock = derived aggregate (sum of batches)
*/

-- Recalculate ALL product current_stock values to match sum of batch current_stocks
UPDATE products p
SET current_stock = COALESCE((
  SELECT SUM(b.current_stock)
  FROM batches b
  WHERE b.product_id = p.id
    AND b.is_active = true
    AND b.current_stock > 0
), 0)
WHERE p.is_active = true;

-- Verify the fix
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM products p
  WHERE ABS(p.current_stock - COALESCE((
    SELECT SUM(b.current_stock)
    FROM batches b
    WHERE b.product_id = p.id AND b.is_active = true AND b.current_stock > 0
  ), 0)) > 0.5;
  
  IF v_count > 0 THEN
    RAISE WARNING 'Still % products with stock discrepancies after fix', v_count;
  ELSE
    RAISE NOTICE 'All product stocks successfully synchronized with batch stocks';
  END IF;
END $$;

-- Ensure the product stock trigger function properly aggregates from batches
CREATE OR REPLACE FUNCTION update_product_current_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_product_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_product_id := OLD.product_id;
  ELSE
    v_product_id := NEW.product_id;
  END IF;

  -- Update the product's current_stock to the sum of all active batch current_stocks
  UPDATE products
  SET current_stock = COALESCE((
    SELECT SUM(b.current_stock)
    FROM batches b
    WHERE b.product_id = v_product_id
      AND b.is_active = true
      AND b.current_stock > 0
  ), 0)
  WHERE id = v_product_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- Drop and recreate the trigger to ensure it fires on all relevant operations
DROP TRIGGER IF EXISTS trigger_update_product_current_stock ON batches;

CREATE TRIGGER trigger_update_product_current_stock
AFTER INSERT OR UPDATE OR DELETE ON batches
FOR EACH ROW
EXECUTE FUNCTION update_product_current_stock();
