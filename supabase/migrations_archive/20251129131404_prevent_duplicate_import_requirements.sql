/*
  # Prevent Duplicate Import Requirements
  
  ## Problem
  fn_create_import_requirements doesn't check for existing requirements
  This causes duplicates when function is called multiple times
  
  ## Solution
  1. Check if import requirement already exists before creating
  2. If exists and status is pending, update shortage quantity
  3. If exists and completed/cancelled, create new one
  
  ## Changes
  - Add duplicate check
  - Update existing pending requirements instead of creating duplicates
*/

CREATE OR REPLACE FUNCTION fn_create_import_requirements(
  p_so_id uuid,
  p_shortage_items jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shortage RECORD;
  v_customer_id uuid;
  v_delivery_date date;
  v_priority import_priority;
  v_existing_id uuid;
BEGIN
  -- Get SO details
  SELECT customer_id, expected_delivery_date 
  INTO v_customer_id, v_delivery_date
  FROM sales_orders
  WHERE id = p_so_id;
  
  -- If no delivery date, set default to 30 days from now
  IF v_delivery_date IS NULL THEN
    v_delivery_date := CURRENT_DATE + INTERVAL '30 days';
  END IF;
  
  -- Calculate priority
  v_priority := fn_calculate_import_priority(v_delivery_date);
  
  -- Loop through shortage items
  FOR v_shortage IN
    SELECT 
      (item->>'product_id')::uuid as product_id,
      (item->>'required_qty')::numeric as required_qty,
      (item->>'shortage_qty')::numeric as shortage_qty
    FROM jsonb_array_elements(p_shortage_items) as item
  LOOP
    -- Check if import requirement already exists for this SO and product
    SELECT id INTO v_existing_id
    FROM import_requirements
    WHERE sales_order_id = p_so_id
      AND product_id = v_shortage.product_id
      AND status IN ('pending', 'ordered')
    LIMIT 1;
    
    IF v_existing_id IS NOT NULL THEN
      -- Update existing requirement
      UPDATE import_requirements
      SET 
        shortage_quantity = v_shortage.shortage_qty,
        required_quantity = v_shortage.required_qty,
        priority = v_priority,
        required_delivery_date = v_delivery_date,
        updated_at = now()
      WHERE id = v_existing_id;
    ELSE
      -- Create new import requirement
      INSERT INTO import_requirements (
        product_id,
        sales_order_id,
        customer_id,
        required_quantity,
        shortage_quantity,
        required_delivery_date,
        priority,
        status,
        notes
      ) VALUES (
        v_shortage.product_id,
        p_so_id,
        v_customer_id,
        v_shortage.required_qty,
        v_shortage.shortage_qty,
        v_delivery_date,
        v_priority,
        'pending',
        'Auto-generated from SO shortage'
      );
    END IF;
  END LOOP;
  
  RETURN true;
END;
$$;
