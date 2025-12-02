/*
  # Add Specification Column to Inquiries

  1. Changes
    - Add `specification` text column to crm_inquiries table
    - Position it after supplier_country for logical grouping

  2. Purpose
    - Store product specification details (e.g., "BP, Powder", "USP Grade")
    - Part of standard inquiry information alongside product details
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiries' AND column_name = 'specification'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN specification text;
  END IF;
END $$;
