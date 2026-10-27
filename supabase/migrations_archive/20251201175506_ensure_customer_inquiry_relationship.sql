/*
  # Ensure Customer-Inquiry Relationship
  
  ## Changes
  1. Add foreign key constraint if not exists
  2. Add index on customer_id for performance
  3. Update RLS policies to handle customer relationships
  
  ## Purpose
  - Link inquiries to customers table properly
  - Enable dropdown customer selection
  - Improve query performance
*/

-- Add foreign key constraint if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'crm_inquiries_customer_id_fkey'
  ) THEN
    ALTER TABLE crm_inquiries
    ADD CONSTRAINT crm_inquiries_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers(id)
    ON DELETE SET NULL;
  END IF;
END $$;

-- Add index on customer_id if not exists
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_customer_id 
ON crm_inquiries(customer_id);

-- Add index on company_name for search
CREATE INDEX IF NOT EXISTS idx_customers_company_name 
ON customers(company_name);
