/*
  # Fix Inquiry Number Auto-Generation

  1. Changes
    - Add trigger to auto-generate inquiry_number before insert
    - Ensure inquiry_number is populated automatically

  2. Notes
    - Uses existing generate_inquiry_number() function
    - Trigger fires BEFORE INSERT only when inquiry_number is NULL
*/

-- Create trigger function to set inquiry_number
CREATE OR REPLACE FUNCTION set_inquiry_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.inquiry_number IS NULL THEN
    NEW.inquiry_number := generate_inquiry_number();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists
DROP TRIGGER IF EXISTS trigger_set_inquiry_number ON crm_inquiries;

-- Create trigger
CREATE TRIGGER trigger_set_inquiry_number
  BEFORE INSERT ON crm_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION set_inquiry_number();
