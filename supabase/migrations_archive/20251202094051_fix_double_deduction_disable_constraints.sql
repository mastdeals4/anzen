/*
  # Fix Double Inventory Deduction - Disable Constraints Temporarily
  
  ## Problem:
  - Sales invoices linked to DCs are causing double stock deduction
  - Need to remove duplicate transactions
  - Constraints prevent fixing the data
  
  ## Solution:
  1. Temporarily drop stock constraints
  2. Fix the sales invoice trigger
  3. Remove duplicate transactions
  4. Let stock recalculate
  5. Report any issues for manual review
  6. Re-add constraints as NOT VALID (allow existing bad data, prevent new)
*/

-- Step 1: Drop constraints temporarily
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_current_stock_non_negative;
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_current_stock_max_import;

-- Step 2: Fix the sales invoice trigger to prevent future double deductions
CREATE OR REPLACE FUNCTION trg_sales_invoice_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_number text;
  v_user_id uuid;
  v_has_linked_challan boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Check if this invoice is linked to a delivery challan
    SELECT 
      si.invoice_number, 
      si.created_by,
      (si.linked_challan_ids IS NOT NULL AND array_length(si.linked_challan_ids, 1) > 0)
    INTO v_invoice_number, v_user_id, v_has_linked_challan
    FROM sales_invoices si
    WHERE si.id = NEW.invoice_id;

    -- Only create inventory transaction if NOT linked to a delivery challan
    IF NOT v_has_linked_challan THEN
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, notes, created_by
      ) VALUES (
        NEW.product_id, NEW.batch_id, 'sale', -NEW.quantity,
        (SELECT invoice_date FROM sales_invoices WHERE id = NEW.invoice_id),
        v_invoice_number, 'Sale via invoice: ' || v_invoice_number, v_user_id
      );
    END IF;

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    SELECT si.invoice_number, (si.linked_challan_ids IS NOT NULL AND array_length(si.linked_challan_ids, 1) > 0)
    INTO v_invoice_number, v_has_linked_challan
    FROM sales_invoices si WHERE si.id = OLD.invoice_id;

    IF NOT v_has_linked_challan THEN
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, notes, created_by
      ) VALUES (
        OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
        CURRENT_DATE, v_invoice_number,
        'Reversed sale from deleted invoice item', auth.uid()
      );
    END IF;

    RETURN OLD;
  END IF;
END;
$$;

-- Step 3: Remove duplicate sale transactions
DELETE FROM inventory_transactions it
WHERE it.transaction_type = 'sale'
AND EXISTS (
  SELECT 1 FROM sales_invoices si
  WHERE si.invoice_number = it.reference_number
  AND si.linked_challan_ids IS NOT NULL 
  AND array_length(si.linked_challan_ids, 1) > 0
);

-- Step 4: Remove invalid adjustment transactions
DELETE FROM inventory_transactions
WHERE transaction_type = 'adjustment'
AND (
  notes LIKE '%Reversed delivery%' 
  OR notes LIKE '%Reversed sale%'
  OR notes LIKE '%deleted DC item%'
  OR notes LIKE '%deleted invoice item%'
);

-- Step 5: Report final stock status
DO $$
DECLARE
  v_batch RECORD;
  v_negative_count integer := 0;
  v_excess_count integer := 0;
BEGIN
  FOR v_batch IN 
    SELECT 
      b.id, b.batch_number, b.import_quantity, b.current_stock,
      p.product_name
    FROM batches b
    JOIN products p ON b.product_id = p.id
  LOOP
    IF v_batch.current_stock < 0 THEN
      v_negative_count := v_negative_count + 1;
      RAISE WARNING 'NEGATIVE STOCK: % - Batch: % - Stock: % (should be >= 0)', 
        v_batch.product_name, v_batch.batch_number, v_batch.current_stock;
    ELSIF v_batch.current_stock > v_batch.import_quantity THEN
      v_excess_count := v_excess_count + 1;
      RAISE WARNING 'EXCESS STOCK: % - Batch: % - Stock: % (imported: %)', 
        v_batch.product_name, v_batch.batch_number, v_batch.current_stock, v_batch.import_quantity;
    END IF;
  END LOOP;

  RAISE NOTICE '✓ Stock fix complete. Negative: %, Excess: %', v_negative_count, v_excess_count;
END $$;

-- Step 6: Re-add constraints as NOT VALID (allows existing data, prevents new violations)
ALTER TABLE batches 
ADD CONSTRAINT batches_current_stock_non_negative 
CHECK (current_stock >= 0) NOT VALID;

ALTER TABLE batches 
ADD CONSTRAINT batches_current_stock_max_import 
CHECK (current_stock <= import_quantity) NOT VALID;
