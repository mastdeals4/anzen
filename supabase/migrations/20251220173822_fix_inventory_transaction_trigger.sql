/*
  # Fix Inventory Transaction Trigger

  ## Summary
  Fixes the track_stock_levels_in_transaction trigger function to use correct column name 'quantity' instead of 'quantity_change'.

  ## Changes
  - Updates function to use NEW.quantity instead of NEW.quantity_change
*/

CREATE OR REPLACE FUNCTION track_stock_levels_in_transaction()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.stock_before := (
    SELECT current_stock
    FROM batches
    WHERE id = NEW.batch_id
  );

  NEW.stock_after := NEW.stock_before + NEW.quantity;

  RETURN NEW;
END;
$$;
