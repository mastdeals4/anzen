/*
  # Add Per-Product Minimum Stock Level and Make Product Code Optional

  ## Changes Made

  ### 1. Products Table Enhancements
  - Add `min_stock_level` (numeric) - Minimum stock threshold per product (uses product's unit)
  - Make `product_code` nullable while keeping uniqueness constraint for non-null values

  ## Purpose
  - Allow per-product low stock alerts instead of global threshold only
  - Make product code optional for simplified product creation (packaging details are in batches)

  ## Notes
  - min_stock_level uses the same unit as the product's unit field (kg, litre, ton, piece)
  - product_code remains unique when provided, but is no longer required
  - Existing products with product_code are unaffected
*/

-- Add min_stock_level column to products table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'min_stock_level'
  ) THEN
    ALTER TABLE products ADD COLUMN min_stock_level numeric(15,3);
  END IF;
END $$;

-- Make product_code nullable while preserving uniqueness
DO $$
BEGIN
  -- Drop the existing NOT NULL constraint if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products'
    AND column_name = 'product_code'
    AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE products ALTER COLUMN product_code DROP NOT NULL;
  END IF;
END $$;

-- Add comment to clarify min_stock_level usage
COMMENT ON COLUMN products.min_stock_level IS 'Minimum stock threshold for this product, in the product unit (kg/litre/ton/piece). When stock falls below this level, low stock alerts are triggered.';