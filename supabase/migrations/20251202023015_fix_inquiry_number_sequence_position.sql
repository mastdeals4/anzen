/*
  # Fix Inquiry Number Sequence Position
  
  1. Problem
    - Inquiry numbers are being generated incorrectly: 0001, 0004, then next would clash
    - SUBSTRING(inquiry_number, 9, 4) extracts "-000" instead of "0004"
    - Position 9 starts at the dash before the number
    - Should be position 10 to get "0004"
  
  2. Solution
    - Fix generate_inquiry_number() function to use position 10
    - This will correctly get the highest number and increment it
    - Format: INQ-2025-0004
      - Position 1-9: "INQ-2025-"
      - Position 10-13: "0004"
  
  3. Result
    - Next inquiry will be INQ-2025-0005 (not 0001 again)
    - Sequence will work properly going forward
*/

-- Fix the generate_inquiry_number function with correct SUBSTRING position
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
  -- FIXED: Use position 10 (not 9) to get "0004" not "-000"
  SELECT COALESCE(MAX(CAST(SUBSTRING(inquiry_number, 10, 4) AS INTEGER)), 0)
  INTO v_last_number
  FROM crm_inquiries
  WHERE inquiry_number LIKE 'INQ-' || v_current_year || '-%';
  
  -- Increment and pad to 4 digits
  v_new_number := 'INQ-' || v_current_year || '-' || 
    LPAD((v_last_number + 1)::text, 4, '0');
  
  RETURN v_new_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;