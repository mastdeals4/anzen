/*
  # Fix BPOM Fees Field Name in Container Update Trigger

  1. Changes
    - Fix trigger_reallocate_on_container_update() function
    - Change OLD.bpom_fees to OLD.bpom_ski_fees
    - Change NEW.bpom_fees to NEW.bpom_ski_fees

  2. Security
    - Maintains existing security definer
    - No changes to RLS policies
*/

-- Fix the trigger function to use correct field name
CREATE OR REPLACE FUNCTION trigger_reallocate_on_container_update()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only reallocate if cost-related fields change
  IF (OLD.total_import_expenses IS DISTINCT FROM NEW.total_import_expenses OR
      OLD.duty_bm IS DISTINCT FROM NEW.duty_bm OR
      OLD.ppn_import IS DISTINCT FROM NEW.ppn_import OR
      OLD.pph_import IS DISTINCT FROM NEW.pph_import OR
      OLD.freight_charges IS DISTINCT FROM NEW.freight_charges OR
      OLD.other_import_costs IS DISTINCT FROM NEW.other_import_costs OR
      OLD.bpom_ski_fees IS DISTINCT FROM NEW.bpom_ski_fees OR
      OLD.ski_fees IS DISTINCT FROM NEW.ski_fees) THEN
    PERFORM reallocate_container_costs(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
