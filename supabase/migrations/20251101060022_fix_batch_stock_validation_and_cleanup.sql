/*
  # Fix Batch Stock Validation and Data Cleanup

  ## Summary
  This migration adds database constraints to prevent invalid stock data and cleans up existing corrupted records.

  ## Changes Made

  ### 1. Add Check Constraint
  - Add constraint to ensure current_stock never exceeds import_quantity
  - Add constraint to ensure current_stock is never negative
  - These constraints prevent data corruption at the database level

  ### 2. Clean Up Corrupted Data
  - Identify all batches where current_stock > import_quantity
  - Recalculate correct current_stock based on actual sales
  - Update corrupted records with correct values

  ### 3. Add Helpful Comments
  - Document the relationship between import_quantity and current_stock
  - Clarify that current_stock should only decrease through sales

  ## Important Notes
  - This migration will fail if there are batches with current_stock > import_quantity and actual sales
  - In such cases, manual intervention may be required to resolve data conflicts
  - The constraint ensures this corruption cannot happen again
*/

-- First, let's create a function to fix corrupted batch stock data
CREATE OR REPLACE FUNCTION fix_batch_stock_corruption()
RETURNS void AS $$
DECLARE
  batch_record RECORD;
  actual_sold_qty numeric;
BEGIN
  -- Loop through all batches where current_stock doesn't make sense
  FOR batch_record IN 
    SELECT id, batch_number, import_quantity, current_stock 
    FROM batches 
    WHERE current_stock > import_quantity OR current_stock < 0
  LOOP
    -- Calculate actual sold quantity from sales_invoice_items
    SELECT COALESCE(SUM(quantity), 0) INTO actual_sold_qty
    FROM sales_invoice_items
    WHERE batch_id = batch_record.id;

    -- Update current_stock to correct value: import_quantity - actual_sold_quantity
    UPDATE batches
    SET current_stock = batch_record.import_quantity - actual_sold_qty
    WHERE id = batch_record.id;

    RAISE NOTICE 'Fixed batch %: import=%, was=%, sold=%, corrected to=%',
      batch_record.batch_number,
      batch_record.import_quantity,
      batch_record.current_stock,
      actual_sold_qty,
      (batch_record.import_quantity - actual_sold_qty);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Execute the fix function
SELECT fix_batch_stock_corruption();

-- Drop the function after use
DROP FUNCTION fix_batch_stock_corruption();

-- Add check constraints to prevent future corruption
DO $$
BEGIN
  -- Constraint: current_stock cannot be negative
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'batches_current_stock_non_negative'
  ) THEN
    ALTER TABLE batches 
    ADD CONSTRAINT batches_current_stock_non_negative 
    CHECK (current_stock >= 0);
  END IF;

  -- Constraint: current_stock cannot exceed import_quantity
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'batches_current_stock_max_import'
  ) THEN
    ALTER TABLE batches 
    ADD CONSTRAINT batches_current_stock_max_import 
    CHECK (current_stock <= import_quantity);
  END IF;
END $$;

-- Update comments to clarify the relationship
COMMENT ON COLUMN batches.current_stock IS 
'Current available stock for this batch. Must be between 0 and import_quantity. 
Calculated as: import_quantity - total_sold_quantity. 
Only decreases through sales, never increases unless import_quantity is adjusted.';

COMMENT ON COLUMN batches.import_quantity IS 
'Total quantity imported in this batch. This is the maximum stock that can ever be available. 
Can be adjusted upward if more stock is imported under the same batch, but cannot be reduced below the quantity already sold.';

-- Add constraint comments
COMMENT ON CONSTRAINT batches_current_stock_non_negative ON batches IS 
'Ensures current stock is never negative';

COMMENT ON CONSTRAINT batches_current_stock_max_import ON batches IS 
'Ensures current stock never exceeds the original import quantity - prevents data corruption';
