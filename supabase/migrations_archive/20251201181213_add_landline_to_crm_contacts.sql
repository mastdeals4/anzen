/*
  # Add Landline Field to CRM Contacts

  ## Changes
  1. Add landline field to crm_contacts table
  2. This allows storing office landline numbers separately from mobile

  ## Purpose
  - Support complete contact information in CRM
  - Differentiate between mobile and landline numbers
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_contacts' AND column_name = 'landline'
  ) THEN
    ALTER TABLE crm_contacts ADD COLUMN landline text;
  END IF;
END $$;
