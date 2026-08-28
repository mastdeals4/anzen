/*
  # Add parsed_data column to CRM email inbox

  1. Changes
    - Add `parsed_data` (jsonb) column to store AI-parsed email data
    - This prevents duplicate inquiry creation by storing parsed data for manual review

  2. Purpose
    - Email sync will flag emails as inquiries but NOT auto-create inquiry records
    - Users manually review and create inquiries from Command Center
    - Eliminates duplicate inquiries from auto-creation + manual creation
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_email_inbox' AND column_name = 'parsed_data'
  ) THEN
    ALTER TABLE crm_email_inbox ADD COLUMN parsed_data jsonb;
  END IF;
END $$;