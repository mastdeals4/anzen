/*
  # Link Inquiries to Customers

  1. Changes
    - Add customer_id column to crm_inquiries table
    - Create foreign key constraint to customers table
    - Add index for performance

  2. Purpose
    - Link each inquiry to a customer record
    - Enable customer history tracking
    - Allow customer data to be kept updated
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiries' AND column_name = 'customer_id'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN customer_id uuid REFERENCES customers(id);
    CREATE INDEX IF NOT EXISTS idx_crm_inquiries_customer_id ON crm_inquiries(customer_id);
  END IF;
END $$;
