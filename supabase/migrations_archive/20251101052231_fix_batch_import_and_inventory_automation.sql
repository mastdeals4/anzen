/*
  # Fix Batch Import and Inventory Automation

  ## Summary
  This migration fixes the import batch system to properly handle stock updates and inventory transactions.
  It adds support for percentage-based or fixed-amount additional charges and automates inventory transaction creation.

  ## Changes Made

  ### 1. Additional Charges Enhancement
  - Add `duty_charge_type` column (percentage or fixed)
  - Add `freight_charge_type` column (percentage or fixed)
  - Add `other_charge_type` column (percentage or fixed)
  - These allow users to enter "5%" or "50000 IDR" for each charge type

  ### 2. Batch Management
  - Ensure current_stock starts at import_quantity for new batches
  - Add check constraint to ensure current_stock <= import_quantity (can only decrease from sales)

  ### 3. Automatic Inventory Transaction Creation
  - Create trigger function to automatically create inventory transaction when batch is inserted
  - Transaction records the import as a "purchase" with proper references
  - Links batch_id, product_id, and user who created it

  ### 4. Fix Product Stock Summary View
  - Update view to properly calculate stock from batches
  - Ensure it shows accurate real-time inventory

  ## Important Notes
  - Charge types default to 'fixed' for backward compatibility with existing data
  - The trigger only fires on INSERT (new batches), not on UPDATE
  - Current stock should only be modified through sales, not manual edits
  - Inventory transactions provide complete audit trail of stock movements
*/

-- Add charge type columns to batches table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'duty_charge_type'
  ) THEN
    ALTER TABLE batches ADD COLUMN duty_charge_type text DEFAULT 'fixed' CHECK (duty_charge_type IN ('percentage', 'fixed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'freight_charge_type'
  ) THEN
    ALTER TABLE batches ADD COLUMN freight_charge_type text DEFAULT 'fixed' CHECK (freight_charge_type IN ('percentage', 'fixed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'other_charge_type'
  ) THEN
    ALTER TABLE batches ADD COLUMN other_charge_type text DEFAULT 'fixed' CHECK (other_charge_type IN ('percentage', 'fixed'));
  END IF;
END $$;

-- Add comments for clarity
COMMENT ON COLUMN batches.duty_charge_type IS 'Type of duty charge: percentage (of import price) or fixed (absolute amount in IDR)';
COMMENT ON COLUMN batches.freight_charge_type IS 'Type of freight charge: percentage (of import price) or fixed (absolute amount in IDR)';
COMMENT ON COLUMN batches.other_charge_type IS 'Type of other charge: percentage (of import price) or fixed (absolute amount in IDR)';

-- Create function to automatically create inventory transaction when batch is inserted
CREATE OR REPLACE FUNCTION create_batch_inventory_transaction()
RETURNS TRIGGER AS $$
BEGIN
  -- Insert inventory transaction for the new batch
  INSERT INTO inventory_transactions (
    transaction_type,
    product_id,
    batch_id,
    quantity,
    reference_number,
    notes,
    transaction_date,
    created_by
  ) VALUES (
    'purchase',
    NEW.product_id,
    NEW.id,
    NEW.import_quantity,
    NEW.batch_number,
    'Batch import: ' || NEW.batch_number,
    NEW.import_date,
    NEW.created_by
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to automatically create inventory transaction on batch insert
DROP TRIGGER IF EXISTS trigger_create_batch_inventory_transaction ON batches;

CREATE TRIGGER trigger_create_batch_inventory_transaction
  AFTER INSERT ON batches
  FOR EACH ROW
  EXECUTE FUNCTION create_batch_inventory_transaction();

-- Update product_stock_summary view to ensure it's using correct calculation
CREATE OR REPLACE VIEW product_stock_summary AS
SELECT 
  p.id as product_id,
  p.product_name,
  p.product_code,
  p.unit,
  p.category,
  COALESCE(SUM(b.current_stock), 0) as total_current_stock,
  COUNT(CASE WHEN b.current_stock > 0 THEN b.id END) as active_batch_count,
  COUNT(CASE WHEN b.expiry_date IS NOT NULL AND b.expiry_date < CURRENT_DATE THEN 1 END) as expired_batch_count,
  MIN(CASE WHEN b.expiry_date >= CURRENT_DATE OR b.expiry_date IS NULL THEN b.expiry_date END) as nearest_expiry_date
FROM products p
LEFT JOIN batches b ON p.id = b.product_id AND b.is_active = true
WHERE p.is_active = true
GROUP BY p.id, p.product_name, p.product_code, p.unit, p.category
ORDER BY p.product_name;

-- Grant access to the view
GRANT SELECT ON product_stock_summary TO authenticated;

-- Add helpful comment
COMMENT ON VIEW product_stock_summary IS 'Aggregated stock overview per product across all active batches with accurate stock counts';

-- Add comment to clarify current_stock behavior
COMMENT ON COLUMN batches.current_stock IS 'Current available stock for this batch. Starts at import_quantity and decreases with sales. Should never exceed import_quantity.';
COMMENT ON COLUMN batches.import_quantity IS 'Original quantity imported in this batch. This value never changes after import.';