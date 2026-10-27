/*
  # Fix trigger_reallocate_on_container_update - Wrong Column Name

  1. Problem
    - Function references OLD.ski_fees but column is actually bpom_ski_fees
    - Causes error: record "old" has no field "ski_fees"
    - This breaks ALL expense edits for bpom_ski_fees category
    
  2. Root Cause Chain
    - User edits expense -> update_container_bpom_fees trigger fires
    - Updates import_containers.bpom_ski_fees
    - Triggers trigger_reallocate_on_container_update
    - Function tries OLD.ski_fees -> CRASH
    
  3. Fix
    - Replace OLD.ski_fees with OLD.bpom_ski_fees
    - Replace NEW.ski_fees with NEW.bpom_ski_fees
    - Also remove duplicate trigger (two triggers calling same function)
*/

-- Fix the function with correct column name
CREATE OR REPLACE FUNCTION trigger_reallocate_on_container_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (OLD.total_import_expenses IS DISTINCT FROM NEW.total_import_expenses OR
      OLD.duty_bm IS DISTINCT FROM NEW.duty_bm OR
      OLD.ppn_import IS DISTINCT FROM NEW.ppn_import OR
      OLD.pph_import IS DISTINCT FROM NEW.pph_import OR
      OLD.freight_charges IS DISTINCT FROM NEW.freight_charges OR
      OLD.other_import_costs IS DISTINCT FROM NEW.other_import_costs OR
      OLD.bpom_ski_fees IS DISTINCT FROM NEW.bpom_ski_fees) THEN
    PERFORM reallocate_container_costs(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

-- Remove duplicate trigger (keep only one)
DROP TRIGGER IF EXISTS auto_reallocate_container_costs ON import_containers;
