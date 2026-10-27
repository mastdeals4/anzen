/*
  # Update Inquiry Number Format to Short Year

  ## Overview
  Changes inquiry number format from INQ-2025-0001 to INQ-25-0001
  to make it more compact and easier to read.

  ## Changes
  1. Function: generate_inquiry_number()
     - Updated to generate INQ-25-0001 format (2-digit year)
     - Uses last 2 digits of current year
     - Maintains sequential numbering

  2. Data Migration
     - Converts all existing INQ-2025-NNNN to INQ-25-NNNN
     - Updates pattern matching to work with new format

  ## Security
  - Uses existing RLS policies
  - SECURITY DEFINER maintained for consistency
*/

-- Drop and recreate function with new format
CREATE OR REPLACE FUNCTION generate_inquiry_number()
RETURNS text AS $$
DECLARE
  v_current_year text;
  v_last_number integer;
  v_new_number text;
BEGIN
  -- Get last 2 digits of current year (e.g., "25" for 2025)
  v_current_year := TO_CHAR(NOW(), 'YY');

  -- Get the highest number for this year
  -- Looks for pattern like INQ-25-0001
  SELECT COALESCE(MAX(CAST(SUBSTRING(inquiry_number, 8, 4) AS INTEGER)), 0)
  INTO v_last_number
  FROM crm_inquiries
  WHERE inquiry_number LIKE 'INQ-' || v_current_year || '-%';

  -- Increment and pad to 4 digits
  v_new_number := 'INQ-' || v_current_year || '-' ||
    LPAD((v_last_number + 1)::text, 4, '0');

  RETURN v_new_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Migrate existing data from INQ-2025-NNNN to INQ-25-NNNN
UPDATE crm_inquiries
SET inquiry_number = REPLACE(inquiry_number, 'INQ-2025-', 'INQ-25-')
WHERE inquiry_number LIKE 'INQ-2025-%';

-- Convert other years if they exist (2024 -> 24, etc.)
UPDATE crm_inquiries
SET inquiry_number = REGEXP_REPLACE(
  inquiry_number,
  '^INQ-20(\d{2})-',
  'INQ-\1-'
)
WHERE inquiry_number ~ '^INQ-20\d{2}-';
