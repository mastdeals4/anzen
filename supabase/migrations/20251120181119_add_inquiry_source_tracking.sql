/*
  # Add Inquiry Source Tracking
  
  1. Changes
    - Add `inquiry_source` column to `crm_inquiries` table to track origin
    - Supports: email, whatsapp, phone_call, walk_in, other
    - Defaults to 'other' for existing records
    - Add index for performance
  
  2. Purpose
    - Track where inquiries come from (Email, WhatsApp, Calls, etc.)
    - Enable unified inquiry dashboard across all sources
    - Support multi-channel inquiry management
*/

-- Add inquiry_source column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'inquiry_source'
  ) THEN
    ALTER TABLE crm_inquiries 
    ADD COLUMN inquiry_source text DEFAULT 'other' CHECK (
      inquiry_source IN ('email', 'whatsapp', 'phone_call', 'walk_in', 'other')
    );
    
    -- Add index for filtering by source
    CREATE INDEX IF NOT EXISTS idx_crm_inquiries_source 
    ON crm_inquiries(inquiry_source);
    
    -- Update existing email-sourced inquiries
    UPDATE crm_inquiries 
    SET inquiry_source = 'email' 
    WHERE email_subject IS NOT NULL;
  END IF;
END $$;
