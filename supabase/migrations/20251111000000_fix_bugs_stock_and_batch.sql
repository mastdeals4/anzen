/*
  # Fix Stock Page and Batch Save Bugs
  
  ## Bug Fixes
  
  ### 1. Ensure inventory_transactions uses 'quantity' column
     - The migration 20251101050656 renamed quantity_change to quantity
     - This ensures the column exists with correct name
  
  ### 2. Fix product_stock_summary view column names
     - The migration 20251110192537 recreated the view with wrong column names
     - This restores the correct column names that match the TypeScript code:
       * total_current_stock (not total_stock)
       * active_batch_count (not batch_count)  
       * expired_batch_count (new)
       * nearest_expiry_date (not earliest_expiry)
*/

-- Ensure inventory_transactions has 'quantity' column (not 'quantity_change')
DO $$
BEGIN
  -- Check if quantity_change exists and rename it
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'inventory_transactions' AND column_name = 'quantity_change'
  ) THEN
    ALTER TABLE inventory_transactions RENAME COLUMN quantity_change TO quantity;
  END IF;
  
  -- If neither column exists, create quantity
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'inventory_transactions' AND (column_name = 'quantity' OR column_name = 'quantity_change')
  ) THEN
    ALTER TABLE inventory_transactions ADD COLUMN quantity numeric(15,3) NOT NULL;
  END IF;
END $$;

-- Fix product_stock_summary view with correct column names
DROP VIEW IF EXISTS product_stock_summary;

CREATE VIEW product_stock_summary AS
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

-- Grant access to authenticated users
GRANT SELECT ON product_stock_summary TO authenticated;

-- Add helpful comment
COMMENT ON VIEW product_stock_summary IS 'Aggregated stock overview per product across all active batches - matches TypeScript interface';
