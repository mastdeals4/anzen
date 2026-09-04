/*
  # Add Pharmacy License and PO Fields

  1. Changes to customers table
    - Add `pharmacy_license` (text) - for "Izin Industri Farmasi" / pharmacy license number
    
  2. Changes to sales_invoices table
    - Add `po_number` (text) - for customer purchase order reference
    - Add `payment_terms_days` (integer) - for payment terms in days (e.g., 30 days)

  These fields are needed for the professional invoice format.
*/

-- Add pharmacy license to customers
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'pharmacy_license'
  ) THEN
    ALTER TABLE customers ADD COLUMN pharmacy_license text;
  END IF;
END $$;

-- Add PO number and payment terms to sales_invoices
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_invoices' AND column_name = 'po_number'
  ) THEN
    ALTER TABLE sales_invoices ADD COLUMN po_number text;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_invoices' AND column_name = 'payment_terms_days'
  ) THEN
    ALTER TABLE sales_invoices ADD COLUMN payment_terms_days integer DEFAULT 30;
  END IF;
END $$;