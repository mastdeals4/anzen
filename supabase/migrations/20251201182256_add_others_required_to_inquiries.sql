/*
  # Add Others Required Field to CRM Inquiries

  ## Changes
  1. Add others_required boolean field to crm_inquiries table
  2. Add others_sent_at timestamp field to track when others was sent
  3. Set default value to false for others_required

  ## Purpose
  - Support additional customer requirements beyond Price, COA, Sample, Agency Letter
  - Track when "Others" requirement was fulfilled
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'others_required'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN others_required boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'others_sent_at'
  ) THEN
    ALTER TABLE crm_inquiries ADD COLUMN others_sent_at timestamptz;
  END IF;
END $$;
