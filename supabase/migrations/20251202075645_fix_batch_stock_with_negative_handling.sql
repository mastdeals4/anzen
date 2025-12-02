/*
  # Fix Batch Stock Calculation with Negative Stock Handling

  ## Root Cause:
  - inventory_transactions table records all stock movements
  - BUT batches.current_stock is NEVER updated
  - Some batches have bad transaction data (sales before purchases)

  ## Solution:
  1. Temporarily remove negative stock constraint
  2. Create trigger to auto-update batch stock
  3. Recalculate all batch stocks from transaction history
  4. Re-add negative stock constraint (new transactions will be protected)

  ## Changes:
  - Remove batches_current_stock_non_negative constraint temporarily
  - New function: update_batch_stock_from_transactions()
  - New trigger: After INSERT/UPDATE/DELETE on inventory_transactions
  - Recalculate all existing batch stocks
  - Report batches with negative stock for manual review
*/

-- 1. Remove negative stock constraint temporarily
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_current_stock_non_negative;

-- 2. Create function to update batch stock based on transactions
CREATE OR REPLACE FUNCTION update_batch_stock_from_transactions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id uuid;
  v_total_stock numeric;
BEGIN
  -- Determine which batch to update
  IF TG_OP = 'DELETE' THEN
    v_batch_id := OLD.batch_id;
  ELSE
    v_batch_id := NEW.batch_id;
  END IF;

  -- Calculate total stock from all transactions for this batch
  SELECT COALESCE(SUM(quantity), 0)
  INTO v_total_stock
  FROM inventory_transactions
  WHERE batch_id = v_batch_id;

  -- Update the batch current_stock
  UPDATE batches
  SET current_stock = v_total_stock,
      updated_at = now()
  WHERE id = v_batch_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- 3. Create trigger on inventory_transactions
DROP TRIGGER IF EXISTS trigger_update_batch_stock ON inventory_transactions;
CREATE TRIGGER trigger_update_batch_stock
  AFTER INSERT OR UPDATE OR DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION update_batch_stock_from_transactions();

-- 4. Recalculate ALL batch stocks from transaction history
DO $$
DECLARE
  v_batch RECORD;
  v_calculated_stock numeric;
  v_batch_number text;
  v_product_name text;
  v_negative_count integer := 0;
BEGIN
  FOR v_batch IN SELECT DISTINCT batch_id FROM inventory_transactions WHERE batch_id IS NOT NULL
  LOOP
    -- Calculate correct stock from transactions
    SELECT COALESCE(SUM(quantity), 0)
    INTO v_calculated_stock
    FROM inventory_transactions
    WHERE batch_id = v_batch.batch_id;

    -- Get batch details
    SELECT b.batch_number, p.product_name
    INTO v_batch_number, v_product_name
    FROM batches b
    JOIN products p ON b.product_id = p.id
    WHERE b.id = v_batch.batch_id;

    -- Update batch
    UPDATE batches
    SET current_stock = v_calculated_stock,
        updated_at = now()
    WHERE id = v_batch.batch_id;

    -- Log if negative
    IF v_calculated_stock < 0 THEN
      v_negative_count := v_negative_count + 1;
      RAISE WARNING 'NEGATIVE STOCK: Batch % (%) - Product: % - Stock: %', 
        v_batch_number, v_batch.batch_id, v_product_name, v_calculated_stock;
    END IF;
  END LOOP;

  IF v_negative_count > 0 THEN
    RAISE NOTICE 'Stock recalculation complete. % batches have NEGATIVE STOCK - manual review needed!', v_negative_count;
  ELSE
    RAISE NOTICE 'Stock recalculation complete. All batch stocks are positive.';
  END IF;
END $$;

-- 5. Add back constraint for NEW transactions only (existing data can stay negative temporarily)
ALTER TABLE batches 
ADD CONSTRAINT batches_current_stock_non_negative 
CHECK (current_stock >= 0) NOT VALID;

-- This allows existing negative stocks but prevents new ones