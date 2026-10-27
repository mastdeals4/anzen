/*
  # Fix Inventory Transactions Schema

  ## Summary
  This migration updates the inventory_transactions table to match the application requirements
  for tracking sales and inventory movements properly.

  ## Changes Made

  1. **Column Modifications**
     - Rename `quantity_change` to `quantity` for clearer semantics
     - Make `batch_id` nullable (products without batch tracking)
     - Add `product_id` column to directly reference products
     - Add `reference_number` column for invoice/document references
     - Add `transaction_date` column to track when the transaction occurred

  2. **Why These Changes**
     - The application code expects these specific column names
     - Some products may not use batch tracking, so batch_id must be nullable
     - Direct product_id reference enables faster reporting without joins
     - reference_number provides human-readable transaction references
     - transaction_date allows filtering transactions by date range

  3. **Data Integrity**
     - Foreign key constraints maintained for data integrity
     - Existing indexes preserved for performance
     - Backward compatible - existing data remains valid

  ## Notes
  - This migration uses IF EXISTS checks to be safely rerunnable
  - The old reference_type and reference_id columns are kept for backward compatibility
  - Generated columns and constraints are preserved
*/

-- Add product_id column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'product_id'
  ) THEN
    ALTER TABLE inventory_transactions
    ADD COLUMN product_id uuid REFERENCES products(id);
  END IF;
END $$;

-- Make batch_id nullable (some products don't use batches)
ALTER TABLE inventory_transactions
ALTER COLUMN batch_id DROP NOT NULL;

-- Add reference_number column for human-readable references
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'reference_number'
  ) THEN
    ALTER TABLE inventory_transactions
    ADD COLUMN reference_number text;
  END IF;
END $$;

-- Add transaction_date column to track when transaction occurred
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'transaction_date'
  ) THEN
    ALTER TABLE inventory_transactions
    ADD COLUMN transaction_date date DEFAULT CURRENT_DATE;
  END IF;
END $$;

-- Rename quantity_change to quantity if not already done
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'quantity_change'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'quantity'
  ) THEN
    ALTER TABLE inventory_transactions
    RENAME COLUMN quantity_change TO quantity;
  END IF;
END $$;

-- Create index on product_id for better query performance
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_product
ON inventory_transactions(product_id);

-- Create index on reference_number for faster lookups
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_reference
ON inventory_transactions(reference_number);

-- Create index on transaction_date for date-based queries
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_transaction_date
ON inventory_transactions(transaction_date);
