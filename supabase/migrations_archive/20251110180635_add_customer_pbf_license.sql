/*
  # Add PBF License to Customers

  1. Changes
    - Add `pbf_license` column to `customers` table
    - Store customer's PBF (Pedagang Besar Farmasi) license number
  
  2. Notes
    - PBF license is required for pharmaceutical trading documentation
    - Used in delivery challans and invoices
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'pbf_license'
  ) THEN
    ALTER TABLE customers ADD COLUMN pbf_license text;
  END IF;
END $$;