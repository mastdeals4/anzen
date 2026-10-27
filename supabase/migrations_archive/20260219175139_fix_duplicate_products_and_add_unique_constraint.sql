/*
  # Fix duplicate products and add unique constraint

  1. Problem
    - Duplicate products with same name + HSN code exist
    - No constraint preventing this from happening

  2. Data Fixes
    - Cefixime USP (PROD-0027): No batches/invoices/DCs, deactivate it
    - Ibuprofen BP (PROD-0026): Has 3 batches but no invoices/DCs, merge batches to PROD-0011 then deactivate

  3. Constraint
    - Add unique partial index on (product_name, hsn_code) WHERE is_active = true
*/

-- Fix Cefixime USP: deactivate the unused duplicate (PROD-0027)
UPDATE products SET is_active = false
WHERE id = 'b509c4e4-d160-4d8b-bc63-b95a9e5ba802' AND product_name = 'Cefixime USP';

-- Fix Ibuprofen BP: migrate batches from PROD-0026 to PROD-0011
UPDATE batches SET product_id = '4fd7e5b5-1226-4044-b9bd-e16e1e8a516a'
WHERE product_id = 'd3e2668e-22fd-42e2-abde-7ed1d8994781';

-- Migrate inventory transactions from PROD-0026 to PROD-0011
UPDATE inventory_transactions SET product_id = '4fd7e5b5-1226-4044-b9bd-e16e1e8a516a'
WHERE product_id = 'd3e2668e-22fd-42e2-abde-7ed1d8994781';

-- Migrate stock reservations from PROD-0026 to PROD-0011
UPDATE stock_reservations SET product_id = '4fd7e5b5-1226-4044-b9bd-e16e1e8a516a'
WHERE product_id = 'd3e2668e-22fd-42e2-abde-7ed1d8994781';

-- Update current_stock on PROD-0011 to include merged stock
UPDATE products SET current_stock = (
  SELECT COALESCE(SUM(current_stock), 0) FROM batches
  WHERE product_id = '4fd7e5b5-1226-4044-b9bd-e16e1e8a516a' AND is_active = true
)
WHERE id = '4fd7e5b5-1226-4044-b9bd-e16e1e8a516a';

-- Deactivate the duplicate PROD-0026
UPDATE products SET is_active = false
WHERE id = 'd3e2668e-22fd-42e2-abde-7ed1d8994781' AND product_name = 'Ibuprofen BP';

-- Add unique partial index to prevent future duplicates (same name + hsn_code for active products)
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_unique_name_hsn_active
ON products (LOWER(product_name), hsn_code)
WHERE is_active = true;
