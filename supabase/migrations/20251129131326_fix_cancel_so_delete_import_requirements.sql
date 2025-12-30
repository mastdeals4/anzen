/*
  # Fix: Cancel Sales Order - Delete Import Requirements
  
  ## Problem
  When a Sales Order is cancelled:
  1. Import requirements are not deleted
  2. This causes Stock page to show negative reserved quantities
  3. Duplicate import requirements showing in system
  
  ## Solution
  Update fn_cancel_sales_order to delete associated import requirements
  
  ## Changes
  - Delete all import requirements linked to the cancelled SO
  - This happens before updating SO status to cancelled
*/

CREATE OR REPLACE FUNCTION fn_cancel_sales_order(
  p_so_id uuid,
  p_canceller_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete any import requirements for this SO
  DELETE FROM import_requirements
  WHERE sales_order_id = p_so_id;
  
  -- Release any existing reservations with user_id
  PERFORM fn_release_stock_reservations(p_so_id, 'SO cancelled: ' || p_reason, p_canceller_id);
  
  -- Update SO to cancelled
  UPDATE sales_orders
  SET 
    status = 'cancelled',
    updated_at = now()
  WHERE id = p_so_id;
  
  RETURN true;
END;
$$;

-- Also add a trigger to auto-delete import requirements when SO is cancelled
CREATE OR REPLACE FUNCTION fn_auto_delete_import_requirements_on_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete import requirements if SO is cancelled or rejected
  IF NEW.status IN ('cancelled', 'rejected') AND OLD.status NOT IN ('cancelled', 'rejected') THEN
    DELETE FROM import_requirements
    WHERE sales_order_id = NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger
DROP TRIGGER IF EXISTS trigger_auto_delete_import_requirements ON sales_orders;
CREATE TRIGGER trigger_auto_delete_import_requirements
  BEFORE UPDATE ON sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION fn_auto_delete_import_requirements_on_cancel();
