/*
  # Add Duty A1 field to Products

  1. Changes
    - Add `duty_a1` column to `products` table
      - Type: text (to store import duty information as reference)
      - Nullable: true (not required, existing products won't have this data)
      - Purpose: Store import duty rates/information for each product as a database reference

  2. Notes
    - This field will help track duty information for products
    - Can store duty rates, percentages, or notes about import duties
    - Useful for calculating costs when importing products
*/

-- Add duty_a1 column to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS duty_a1 text DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN products.duty_a1 IS 'Import duty information/rate for the product (A1 category)';