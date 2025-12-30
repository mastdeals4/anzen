/*
  # Add Inquiry Number Auto-Generator
  
  ## Overview
  Unified inquiry numbering system that auto-generates INQ-YYYY-NNNN format
  regardless of whether inquiry is created via manual form or Command Center.
  
  ## Changes
  1. Function: generate_inquiry_number()
     - Generates INQ-2025-0001, INQ-2025-0002 format
     - Gets highest number for current year and increments
     - Pads to 4 digits with leading zeros
  
  2. Trigger: auto_generate_inquiry_number
     - ON INSERT to crm_inquiries
     - BEFORE insert
     - Generates number if inquiry_number is NULL or empty
     - Allows explicit numbers if provided (for imports)
  
  3. Data Migration
     - Converts existing manual numbers (500, 501, etc.) to INQ-2025-0500, INQ-2025-0501
     - Preserves all existing inquiry_number values that are already formatted
  
  ## Security
  - SECURITY DEFINER on functions for consistent behavior
  - No RLS changes - uses existing policies
  - Backward compatible with existing data
  
  ## Implementation Notes
  - Works for both manual form submissions and Command Center emails
  - Prevents number conflicts
  - Maintains year-based separation for future years
*/

-- Function to generate inquiry_number (INQ-2025-0001 format)
CREATE OR REPLACE FUNCTION generate_inquiry_number()
RETURNS text AS $$
DECLARE
  v_current_year text;
  v_last_number integer;
  v_new_number text;
BEGIN
  v_current_year := TO_CHAR(NOW(), 'YYYY');
  
  -- Get the highest number for this year
  -- Looks for pattern like INQ-2025-0001
  SELECT COALESCE(MAX(CAST(SUBSTRING(inquiry_number, 9, 4) AS INTEGER)), 0)
  INTO v_last_number
  FROM crm_inquiries
  WHERE inquiry_number LIKE 'INQ-' || v_current_year || '-%';
  
  -- Increment and pad to 4 digits
  v_new_number := 'INQ-' || v_current_year || '-' || 
    LPAD((v_last_number + 1)::text, 4, '0');
  
  RETURN v_new_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger function to auto-generate inquiry_number on insert
CREATE OR REPLACE FUNCTION auto_generate_inquiry_number()
RETURNS TRIGGER AS $$
BEGIN
  -- If inquiry_number is NULL or empty, generate one
  IF NEW.inquiry_number IS NULL OR NEW.inquiry_number = '' THEN
    NEW.inquiry_number := generate_inquiry_number();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists (to avoid conflicts)
DROP TRIGGER IF EXISTS trg_auto_generate_inquiry_number ON crm_inquiries;

-- Create trigger to auto-generate inquiry_number before insert
CREATE TRIGGER trg_auto_generate_inquiry_number
  BEFORE INSERT ON crm_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_inquiry_number();

-- Data migration: Convert old manual numbers (500, 501, etc.) to new format
-- Only update entries that have pure numeric inquiry_number not already in INQ- format
DO $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN 
    SELECT id, inquiry_number 
    FROM crm_inquiries 
    WHERE inquiry_number ~ '^[0-9]+$' 
      AND inquiry_number NOT LIKE 'INQ-%'
  LOOP
    UPDATE crm_inquiries
    SET inquiry_number = 'INQ-2025-' || LPAD(v_row.inquiry_number, 4, '0')
    WHERE id = v_row.id;
  END LOOP;
END $$;
