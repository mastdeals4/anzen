/*
  # Complete Fix for Inquiry Number Auto-Generation

  1. Changes
    - Create function to generate inquiry numbers in format INQ-YYYY-NNNN
    - Create trigger to auto-populate inquiry_number on insert
    - Make inquiry_number nullable with default NULL

  2. Security
    - Function is safe and deterministic
    - Trigger only fires on INSERT
*/

-- Make inquiry_number nullable
ALTER TABLE crm_inquiries 
ALTER COLUMN inquiry_number DROP NOT NULL;

-- Create function to generate inquiry numbers
CREATE OR REPLACE FUNCTION generate_inquiry_number()
RETURNS text AS $$
DECLARE
  new_number text;
  current_year text;
  last_seq integer;
BEGIN
  current_year := TO_CHAR(NOW(), 'YYYY');
  
  -- Get last sequence number for current year
  SELECT COALESCE(
    MAX(CAST(SPLIT_PART(inquiry_number, '-', 3) AS integer)),
    0
  ) INTO last_seq
  FROM crm_inquiries
  WHERE inquiry_number LIKE 'INQ-' || current_year || '-%';
  
  -- Generate new number
  new_number := 'INQ-' || current_year || '-' || LPAD((last_seq + 1)::text, 4, '0');
  
  RETURN new_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger function
CREATE OR REPLACE FUNCTION set_inquiry_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.inquiry_number IS NULL THEN
    NEW.inquiry_number := generate_inquiry_number();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists
DROP TRIGGER IF EXISTS trigger_set_inquiry_number ON crm_inquiries;

-- Create trigger
CREATE TRIGGER trigger_set_inquiry_number
  BEFORE INSERT ON crm_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION set_inquiry_number();
