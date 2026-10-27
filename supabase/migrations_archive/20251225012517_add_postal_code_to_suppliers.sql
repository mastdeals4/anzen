/*
  # Add postal_code to suppliers table

  1. Changes
    - Add postal_code column to suppliers table for complete address information
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'suppliers' AND column_name = 'postal_code'
  ) THEN
    ALTER TABLE suppliers ADD COLUMN postal_code VARCHAR(20);
  END IF;
END $$;
