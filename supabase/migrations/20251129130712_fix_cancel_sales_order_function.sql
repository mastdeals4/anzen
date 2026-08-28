/*
  # Fix: Cancel Sales Order Function
  
  ## Problem
  1. fn_release_stock_reservations uses auth.uid() which doesn't work in SECURITY DEFINER
  2. Missing user_id parameter
  
  ## Solution
  - Update fn_release_stock_reservations to accept user_id parameter
  - Update fn_cancel_sales_order to pass user_id
  - Remove auth.uid() call
*/

-- Fix release function to accept user_id
CREATE OR REPLACE FUNCTION fn_release_stock_reservations(
  p_so_id uuid,
  p_reason text,
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE stock_reservations
  SET 
    status = 'released',
    released_at = now(),
    released_by = p_user_id,
    release_reason = p_reason
  WHERE sales_order_id = p_so_id
  AND status = 'active';
  
  RETURN true;
END;
$$;

-- Fix cancel function to pass user_id
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
