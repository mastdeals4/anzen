/*
  # Set Default Values for Price and COA Required

  1. Changes
    - Set `price_required` default to `true` on `crm_inquiries` table
    - Set `coa_required` default to `true` on `crm_inquiries` table
    - Update existing NULL values to `true`

  2. Purpose
    - All inquiries should have Price (P) and COA (C) tracking by default
    - Users can still manually toggle these fields if needed
*/

-- Set defaults for new inquiries
ALTER TABLE crm_inquiries 
  ALTER COLUMN price_required SET DEFAULT true,
  ALTER COLUMN coa_required SET DEFAULT true;

-- Update existing inquiries with NULL values to true
UPDATE crm_inquiries 
SET 
  price_required = COALESCE(price_required, true),
  coa_required = COALESCE(coa_required, true)
WHERE price_required IS NULL OR coa_required IS NULL;
