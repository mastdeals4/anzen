/*
  # Remove All Sale Transactions for DC-Linked Invoices
  
  ## Problem:
  - Invoices SAPJ-001 and SAPJ-002 are linked to delivery challans
  - BUT they ALSO have sale transactions (both old and new)
  - This causes double/triple deduction
  
  ## Solution:
  - Remove ALL sale transactions for invoices that have linked_challan_ids
  - Keep only the DC transactions (which already deducted stock)
  
  ## Example:
  - Invoice SAPJ-002 linked to DC DO-25-0002
  - DC transaction: -750kg ✓ (keep this)
  - Sale transactions: -750kg, -1500kg ✗ (remove these)
*/

-- Remove ALL sale transactions (both backfilled and regular) for invoices linked to DCs
DELETE FROM inventory_transactions it
WHERE it.transaction_type = 'sale'
AND it.reference_number IN (
  SELECT invoice_number 
  FROM sales_invoices 
  WHERE linked_challan_ids IS NOT NULL 
  AND array_length(linked_challan_ids, 1) > 0
);

-- Verify results
DO $$
DECLARE
  v_batch RECORD;
  v_neg integer := 0;
  v_ok integer := 0;
  v_total_neg numeric := 0;
BEGIN
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  RAISE NOTICE 'STOCK STATUS AFTER CLEANUP:';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  
  FOR v_batch IN 
    SELECT 
      p.product_name, 
      b.batch_number, 
      b.import_quantity, 
      b.current_stock,
      (b.import_quantity - b.current_stock) as sold
    FROM batches b 
    JOIN products p ON b.product_id = p.id
    WHERE b.current_stock < 0 OR b.import_quantity > 0
    ORDER BY b.current_stock, p.product_name
  LOOP
    IF v_batch.current_stock < 0 THEN
      v_neg := v_neg + 1;
      v_total_neg := v_total_neg + v_batch.current_stock;
      RAISE WARNING '❌ % | % | Import: %kg | Stock: %kg | Oversold: %kg', 
        v_batch.product_name, 
        v_batch.batch_number, 
        v_batch.import_quantity, 
        v_batch.current_stock,
        -v_batch.current_stock;
    ELSE
      v_ok := v_ok + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  IF v_neg = 0 THEN
    RAISE NOTICE '✅ SUCCESS! All % batches have POSITIVE stock!', v_ok;
  ELSE
    RAISE NOTICE '📊 SUMMARY: % batches OK, % batches NEGATIVE (total: %kg)', 
      v_ok, v_neg, v_total_neg;
    RAISE NOTICE '⚠️  ACTION REQUIRED: Review negative batches above';
  END IF;
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
END $$;
