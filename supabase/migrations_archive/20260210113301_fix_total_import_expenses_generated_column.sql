/*
  # Fix total_import_expenses Generated Column

  1. Changes
    - Drop and recreate the generated column to ensure it uses correct field names
    - Ensure it references bpom_ski_fees (not bpom_fees)

  2. Purpose
    - Fix any cached or incorrect generated column definition
    - Ensure OLD.total_import_expenses can be properly evaluated
*/

-- Drop the generated column
ALTER TABLE import_containers 
DROP COLUMN IF EXISTS total_import_expenses;

-- Recreate it with correct field names
ALTER TABLE import_containers
ADD COLUMN total_import_expenses numeric GENERATED ALWAYS AS (
  COALESCE(duty_bm, 0) +
  COALESCE(freight_charges, 0) +
  COALESCE(clearing_forwarding, 0) +
  COALESCE(port_charges, 0) +
  COALESCE(container_handling, 0) +
  COALESCE(transportation, 0) +
  COALESCE(loading_import, 0) +
  COALESCE(bpom_ski_fees, 0) +
  COALESCE(other_import_costs, 0)
) STORED;
