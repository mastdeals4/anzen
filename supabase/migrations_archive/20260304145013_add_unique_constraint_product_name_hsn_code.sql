/*
  # Add unique constraint: product_name + hsn_code

  Prevents duplicate products where both the name AND HSN code are identical.
  Two products with the same name but different HSN codes are allowed (they are
  genuinely different products). This enforces the rule at the database level
  so no duplicate can slip through regardless of how data is inserted.

  1. Changes
    - Adds a unique index on (LOWER(product_name), hsn_code) for active products
    - Uses a partial index (WHERE is_active = true) so archived/deleted products
      don't block re-creation

  Note: Existing duplicates (same name + same HSN) would need to be resolved
  before this constraint can be applied. The constraint uses a partial unique index.
*/

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_unique_name_hsn
  ON products (LOWER(TRIM(product_name)), TRIM(hsn_code))
  WHERE is_active = true;
