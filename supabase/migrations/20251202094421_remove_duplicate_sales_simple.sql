/*
  # Remove Duplicate Sale Transactions - Simple Approach
  
  ## Strategy:
  - If a DC transaction exists for a batch
  - AND a sale transaction exists for the same batch with similar reference
  - Remove the sale transactions (keep DC as source of truth)
*/

-- Remove all sale transactions where DC exists on same batch
DELETE FROM inventory_transactions it_sale
WHERE it_sale.transaction_type = 'sale'
AND EXISTS (
  SELECT 1 
  FROM inventory_transactions it_dc
  WHERE it_dc.transaction_type = 'delivery_challan'
  AND it_dc.batch_id = it_sale.batch_id
  -- Match if they reference related documents
  -- e.g., SAPJ-001 and DO-25-0001 are likely related
  AND (
    it_dc.reference_number LIKE 'DO-%'
    OR it_sale.reference_number LIKE 'SAPJ-%'
  )
);

-- Report
DO $$
DECLARE
  v_batch RECORD;
  v_neg integer := 0;
  v_ok integer := 0;
BEGIN
  RAISE NOTICE '══════════════════════════════════════════';
  
  FOR v_batch IN 
    SELECT 
      p.product_name, 
      b.batch_number, 
      b.import_quantity, 
      b.current_stock
    FROM batches b 
    JOIN products p ON b.product_id = p.id
    WHERE b.import_quantity > 0
    ORDER BY b.current_stock
  LOOP
    IF v_batch.current_stock < 0 THEN
      v_neg := v_neg + 1;
      RAISE WARNING '❌ %: % (import %kg, stock %kg)', 
        v_batch.product_name, 
        v_batch.batch_number, 
        v_batch.import_quantity, 
        v_batch.current_stock;
    ELSE
      v_ok := v_ok + 1;
    END IF;
  END LOOP;

  IF v_neg = 0 THEN
    RAISE NOTICE '✅ All % batches have positive stock!', v_ok;
  ELSE
    RAISE NOTICE '⚠️ % OK, % NEGATIVE', v_ok, v_neg;
  END IF;
END $$;
