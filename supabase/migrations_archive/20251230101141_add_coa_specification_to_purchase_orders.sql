/*
  # Add COA No. and Specifications to Purchase Order Items

  ## Changes Made
  1. **New Columns Added**
    - `purchase_order_items.coa_code` (VARCHAR 20) - Chart of Accounts code for expense allocation
    - `purchase_order_items.specification` (TEXT) - Detailed product specifications

  ## Purpose
  - Track expense allocation at line item level for better accounting
  - Store detailed specifications for each product ordered
  - Display on PO prints and views for supplier clarity

  ## Impact
  - Existing records will have NULL values (acceptable)
  - Forms updated to capture these fields
  - PDF exports will show both fields
*/

-- Add COA code column
ALTER TABLE purchase_order_items
ADD COLUMN IF NOT EXISTS coa_code VARCHAR(20);

-- Add specification column
ALTER TABLE purchase_order_items
ADD COLUMN IF NOT EXISTS specification TEXT;

-- Add index for COA lookups
CREATE INDEX IF NOT EXISTS idx_poi_coa_code ON purchase_order_items(coa_code);

-- Add helpful comment
COMMENT ON COLUMN purchase_order_items.coa_code IS 'Chart of Accounts code for expense allocation';
COMMENT ON COLUMN purchase_order_items.specification IS 'Detailed product specifications';

-- Migration complete
DO $$
BEGIN
  RAISE NOTICE '✅ Added COA No. and Specifications to Purchase Order Items';
  RAISE NOTICE 'Columns: coa_code (VARCHAR 20), specification (TEXT)';
END $$;
