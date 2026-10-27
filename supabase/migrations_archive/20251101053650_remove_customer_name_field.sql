/*
  # Remove Redundant customer_name Field

  ## Summary
  This migration removes the redundant customer_name field from the customers table.
  The company_name field will be used as the primary identifier for customers.

  ## Changes Made

  ### 1. Drop customer_name Column
  - Remove customer_name column from customers table
  - company_name becomes the primary identifier

  ### 2. Update Indexes
  - Remove search index that references customer_name
  - Create new search index using only company_name

  ## Important Notes
  - This is a destructive operation but customer_name was redundant
  - All references in the application have been updated to use company_name
  - The company_name field remains NOT NULL and contains the actual customer/company name
*/

-- Remove the text search index that includes customer_name
DROP INDEX IF EXISTS idx_customers_name_search;

-- Drop the customer_name column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'customer_name'
  ) THEN
    ALTER TABLE customers DROP COLUMN customer_name;
  END IF;
END $$;

-- Remove individual indexes on customer_name if they exist
DROP INDEX IF EXISTS idx_customers_name;

-- Create new text search index using only company_name
CREATE INDEX IF NOT EXISTS idx_customers_company_name_search
  ON customers USING gin(to_tsvector('english', company_name));

-- Add index on company_name for sorting
CREATE INDEX IF NOT EXISTS idx_customers_company_name
  ON customers(company_name);

-- Update comment on company_name to clarify it's the primary identifier
COMMENT ON COLUMN customers.company_name IS 'Primary company/customer name identifier';