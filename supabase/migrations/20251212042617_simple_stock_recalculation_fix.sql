/*
  # Simple Stock Recalculation - Recalculate All Batch Stock

  ## The Real Issue:
  The negative stock is caused by:
  1. DCs being created/deleted multiple times
  2. Direct invoices using same batches as DCs
  3. Stock not properly recalculated

  ## Solution:
  Simply recalculate ALL batch stock from their transactions.
  This is the source of truth.
*/

-- Recalculate current_stock for ALL batches from their transactions
UPDATE batches b
SET current_stock = (
  SELECT COALESCE(SUM(it.quantity), 0)
  FROM inventory_transactions it
  WHERE it.batch_id = b.id
);

-- Show results
DO $$
DECLARE
  v_negative_count integer;
  v_batch RECORD;
BEGIN
  SELECT COUNT(*) INTO v_negative_count
  FROM batches
  WHERE current_stock < 0;

  IF v_negative_count > 0 THEN
    RAISE NOTICE '⚠️  Still have % batches with negative stock:', v_negative_count;
    
    FOR v_batch IN 
      SELECT batch_number, current_stock 
      FROM batches 
      WHERE current_stock < 0 
      ORDER BY current_stock 
      LIMIT 5
    LOOP
      RAISE NOTICE '  - Batch %: % kg', v_batch.batch_number, v_batch.current_stock;
    END LOOP;
    
    RAISE NOTICE '';
    RAISE NOTICE 'This means more stock was sold/delivered than was purchased.';
    RAISE NOTICE 'You need to either:';
    RAISE NOTICE '  1. Delete some invoices/DCs that used this batch';
    RAISE NOTICE '  2. Add purchase transactions to increase stock';
    RAISE NOTICE '  3. Manually adjust stock levels';
  ELSE
    RAISE NOTICE '✅ SUCCESS: All batches have correct stock levels!';
  END IF;
END $$;
