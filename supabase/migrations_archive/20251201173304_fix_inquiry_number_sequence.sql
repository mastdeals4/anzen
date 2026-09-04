/*
  # Fix Inquiry Number Sequence
  
  ## Problem
  Old inquiry number "500" was converted to "INQ-2025-0500", causing the auto-generator
  to continue from 0501 instead of starting fresh at 0001.
  
  ## Solution
  1. Renumber all existing inquiries sequentially based on creation order
  2. Start from INQ-2025-0001, 0002, 0003, etc.
  3. Maintain chronological order (oldest = 0001, newest = highest number)
  
  ## Changes
  - Renumbers all crm_inquiries in order of created_at timestamp
  - Preserves all data, only changes inquiry_number format
  - Next new inquiry will get correct next number in sequence
*/

-- Renumber all inquiries sequentially based on creation order
DO $$
DECLARE
  v_row RECORD;
  v_counter INTEGER := 1;
BEGIN
  -- Loop through all inquiries in chronological order (oldest first)
  FOR v_row IN 
    SELECT id 
    FROM crm_inquiries 
    ORDER BY created_at ASC
  LOOP
    -- Update each inquiry with sequential number
    UPDATE crm_inquiries
    SET inquiry_number = 'INQ-2025-' || LPAD(v_counter::text, 4, '0')
    WHERE id = v_row.id;
    
    v_counter := v_counter + 1;
  END LOOP;
END $$;
