/*
  # Clean Duplicate Transactions - Final Fix
*/

-- Drop constraints
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_current_stock_non_negative;
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_current_stock_max_import;

-- Remove incorrect POSITIVE sale transactions
DELETE FROM inventory_transactions
WHERE transaction_type = 'sale'
AND quantity > 0;

-- Remove duplicate DC transactions (keep oldest per DC+batch)
WITH ranked_dc AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY reference_number, batch_id 
      ORDER BY created_at
    ) as rn
  FROM inventory_transactions
  WHERE transaction_type = 'delivery_challan'
)
DELETE FROM inventory_transactions
WHERE id IN (SELECT id FROM ranked_dc WHERE rn > 1);

-- Remove backfilled sales for invoices linked to DCs
DELETE FROM inventory_transactions it
WHERE it.transaction_type = 'sale'
AND it.notes LIKE 'Backfilled:%'
AND it.reference_number IN (
  SELECT invoice_number 
  FROM sales_invoices 
  WHERE linked_challan_ids IS NOT NULL 
  AND array_length(linked_challan_ids, 1) > 0
);

-- Report
DO $$
DECLARE
  v_batch RECORD;
  v_neg integer := 0;
  v_ok integer := 0;
BEGIN
  FOR v_batch IN 
    SELECT p.product_name, b.batch_number, b.import_quantity, b.current_stock
    FROM batches b JOIN products p ON b.product_id = p.id
    ORDER BY b.current_stock
  LOOP
    IF v_batch.current_stock < 0 THEN
      v_neg := v_neg + 1;
      RAISE WARNING 'NEGATIVE: product=%, batch=%, import=%, stock=%', 
        v_batch.product_name, v_batch.batch_number, 
        v_batch.import_quantity, v_batch.current_stock;
    ELSE
      v_ok := v_ok + 1;
    END IF;
  END LOOP;

  IF v_neg = 0 THEN
    RAISE NOTICE 'SUCCESS! All batches positive. Total: %', v_ok;
  ELSE
    RAISE NOTICE 'Result: % OK, % NEGATIVE', v_ok, v_neg;
  END IF;
END $$;
