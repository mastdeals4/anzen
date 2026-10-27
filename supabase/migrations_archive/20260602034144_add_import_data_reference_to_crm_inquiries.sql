/*
  # Add import_data_reference to crm_inquiries

  Stores the import reference entered by Kunal in the pricing worksheet,
  so it persists on the inquiry and is visible in the Completed tab.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_inquiries' AND column_name = 'import_data_reference'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN import_data_reference text;
  END IF;
END $$;
