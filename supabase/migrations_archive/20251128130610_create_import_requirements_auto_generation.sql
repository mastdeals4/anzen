/*
  # Import Requirements Auto-Generation

  ## Overview
  Automatically create import requirements when stock shortage is detected during SO approval

  ## Functions Created

  1. **fn_create_import_requirements(so_id, shortage_items)** - Create import requirements from shortage data
  2. **fn_calculate_import_priority(delivery_date)** - Calculate priority based on delivery date
  
  ## Logic
  - When SO approval results in shortage, auto-create import requirements
  - Priority: High (< 7 days), Medium (7-30 days), Low (> 30 days)
  - Links to SO, customer, and product for full traceability
*/

-- Function to calculate import priority based on required delivery date
CREATE OR REPLACE FUNCTION fn_calculate_import_priority(p_delivery_date date)
RETURNS import_priority
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_days_until_delivery integer;
BEGIN
  v_days_until_delivery := p_delivery_date - CURRENT_DATE;
  
  IF v_days_until_delivery < 7 THEN
    RETURN 'high'::import_priority;
  ELSIF v_days_until_delivery <= 30 THEN
    RETURN 'medium'::import_priority;
  ELSE
    RETURN 'low'::import_priority;
  END IF;
END;
$$;

-- Function to create import requirements from shortage data
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
    -- Create import requirement
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
  END LOOP;
  
  RETURN true;
END;
$$;

-- Enhanced approve function that creates import requirements
CREATE OR REPLACE FUNCTION fn_approve_sales_order_with_import(
  p_so_id uuid,
  p_approver_id uuid,
  p_remarks text DEFAULT NULL
)
RETURNS TABLE(
  success boolean,
  message text,
  shortage_info jsonb,
  import_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result RECORD;
  v_import_created boolean := false;
BEGIN
  -- Update SO to approved
  UPDATE sales_orders
  SET 
    status = 'approved',
    approved_by = p_approver_id,
    approved_at = now(),
    updated_at = now()
  WHERE id = p_so_id;
  
  -- Reserve stock
  SELECT * INTO v_result FROM fn_reserve_stock_for_so(p_so_id);
  
  -- If there's shortage, create import requirements
  IF NOT v_result.success AND jsonb_array_length(v_result.shortage_items) > 0 THEN
    PERFORM fn_create_import_requirements(p_so_id, v_result.shortage_items);
    v_import_created := true;
  END IF;
  
  RETURN QUERY SELECT 
    v_result.success, 
    v_result.message, 
    v_result.shortage_items,
    v_import_created;
END;
$$;

-- Function to get import requirements summary for dashboard
CREATE OR REPLACE FUNCTION fn_get_import_requirements_summary()
RETURNS TABLE(
  product_id uuid,
  product_name text,
  total_shortage numeric,
  pending_orders integer,
  highest_priority import_priority,
  earliest_delivery_date date
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ir.product_id,
    p.product_name,
    SUM(ir.shortage_quantity) as total_shortage,
    COUNT(DISTINCT ir.sales_order_id)::integer as pending_orders,
    MIN(ir.priority) as highest_priority,
    MIN(ir.required_delivery_date) as earliest_delivery_date
  FROM import_requirements ir
  JOIN products p ON p.id = ir.product_id
  WHERE ir.status = 'pending'
  GROUP BY ir.product_id, p.product_name
  ORDER BY MIN(ir.priority), MIN(ir.required_delivery_date);
END;
$$;
