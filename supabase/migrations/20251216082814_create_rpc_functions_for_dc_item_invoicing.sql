/*
  # Create RPC Functions for DC Item Invoicing

  ## Overview
  Creates stored procedures (RPC functions) to support partial DC invoicing in the frontend.

  ## Functions Created

  1. **get_pending_dc_items_for_customer**
     - Returns all delivery challans with their pending items for a customer
     - Groups items by DC for easy selection
     - Optionally excludes items from a specific invoice (for edit mode)
     - Calculates remaining quantities

  2. **validate_invoice_dc_items**
     - Validates that DC items haven't been over-invoiced
     - Checks remaining quantities before allowing invoice save
     - Prevents concurrent over-invoicing
     - Returns validation errors or success

  3. **get_dc_item_details**
     - Gets detailed info for specific DC items
     - Used when loading existing invoice for editing
     - Returns product, batch, pricing info

  ## Usage
  - Frontend calls these functions via Supabase client
  - Enables efficient querying without complex joins in frontend
  - Ensures data consistency and validation
*/

-- Function 1: Get Pending DC Items for Customer
-- Returns all DCs with their pending items for invoice creation
CREATE OR REPLACE FUNCTION get_pending_dc_items_for_customer(
  p_customer_id UUID,
  p_exclude_invoice_id UUID DEFAULT NULL
)
RETURNS TABLE (
  challan_id UUID,
  challan_number TEXT,
  challan_date DATE,
  dc_status TEXT,
  items JSONB
) 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH item_data AS (
    SELECT 
      dis.challan_id,
      dis.challan_number,
      dis.challan_date,
      dis.dc_item_id,
      dis.product_id,
      dis.product_name,
      dis.batch_id,
      dis.batch_number,
      dis.unit,
      dis.pack_size,
      dis.pack_type,
      dis.number_of_packs,
      dis.original_quantity,
      dis.invoiced_quantity,
      dis.remaining_quantity,
      dis.status,
      -- Get current batch price (may have changed since DC was created)
      b.purchase_price,
      b.selling_price,
      b.mrp
    FROM dc_item_invoice_status dis
    LEFT JOIN batches b ON dis.batch_id = b.id
    WHERE dis.customer_id = p_customer_id
      AND dis.remaining_quantity > 0
      AND dis.status IN ('not_invoiced', 'partially_invoiced')
  ),
  -- If editing an invoice, add back the items from that invoice
  editing_items AS (
    SELECT 
      dci.id AS dc_item_id,
      dci.challan_id,
      dc.challan_number,
      dc.challan_date,
      dci.product_id,
      p.product_name,
      dci.batch_id,
      b.batch_number,
      p.unit,
      dci.pack_size,
      dci.pack_type,
      dci.number_of_packs,
      dci.quantity AS original_quantity,
      sii.quantity AS editing_quantity,
      b.purchase_price,
      b.selling_price,
      b.mrp
    FROM sales_invoice_items sii
    JOIN delivery_challan_items dci ON sii.delivery_challan_item_id = dci.id
    JOIN delivery_challans dc ON dci.challan_id = dc.id
    JOIN products p ON dci.product_id = p.id
    JOIN batches b ON dci.batch_id = b.id
    WHERE sii.invoice_id = p_exclude_invoice_id
      AND sii.delivery_challan_item_id IS NOT NULL
  ),
  -- Combine both sets of items
  all_items AS (
    SELECT 
      challan_id,
      challan_number,
      challan_date,
      dc_item_id,
      product_id,
      product_name,
      batch_id,
      batch_number,
      unit,
      pack_size,
      pack_type,
      number_of_packs,
      original_quantity,
      remaining_quantity,
      purchase_price,
      selling_price,
      mrp,
      FALSE AS is_from_editing
    FROM item_data
    
    UNION ALL
    
    SELECT 
      ei.challan_id,
      ei.challan_number,
      ei.challan_date,
      ei.dc_item_id,
      ei.product_id,
      ei.product_name,
      ei.batch_id,
      ei.batch_number,
      ei.unit,
      ei.pack_size,
      ei.pack_type,
      ei.number_of_packs,
      ei.original_quantity,
      ei.editing_quantity AS remaining_quantity,
      ei.purchase_price,
      ei.selling_price,
      ei.mrp,
      TRUE AS is_from_editing
    FROM editing_items ei
    WHERE p_exclude_invoice_id IS NOT NULL
      -- Only include if not already in item_data (avoid duplicates)
      AND NOT EXISTS (
        SELECT 1 FROM item_data id 
        WHERE id.dc_item_id = ei.dc_item_id
      )
  )
  SELECT 
    ai.challan_id,
    ai.challan_number,
    ai.challan_date,
    CASE 
      WHEN COUNT(*) FILTER (WHERE NOT is_from_editing) = 0 THEN 'fully_invoiced'
      ELSE 'partially_invoiced'
    END AS dc_status,
    jsonb_agg(
      jsonb_build_object(
        'dc_item_id', ai.dc_item_id,
        'product_id', ai.product_id,
        'product_name', ai.product_name,
        'batch_id', ai.batch_id,
        'batch_number', ai.batch_number,
        'unit', ai.unit,
        'pack_size', ai.pack_size,
        'pack_type', ai.pack_type,
        'number_of_packs', ai.number_of_packs,
        'original_quantity', ai.original_quantity,
        'remaining_quantity', ai.remaining_quantity,
        'purchase_price', ai.purchase_price,
        'selling_price', ai.selling_price,
        'mrp', ai.mrp,
        'is_from_editing', ai.is_from_editing
      )
      ORDER BY ai.product_name
    ) AS items
  FROM all_items ai
  GROUP BY ai.challan_id, ai.challan_number, ai.challan_date
  ORDER BY ai.challan_date DESC, ai.challan_number;
END;
$$;

COMMENT ON FUNCTION get_pending_dc_items_for_customer IS
'Returns all delivery challans with pending items for a customer. Used in invoice creation to show available DC items for selection.';

-- Function 2: Validate Invoice DC Items
-- Validates that DC items can be invoiced (not over-invoiced)
CREATE OR REPLACE FUNCTION validate_invoice_dc_items(
  p_items JSONB,
  p_exclude_invoice_id UUID DEFAULT NULL
)
RETURNS TABLE (
  is_valid BOOLEAN,
  error_message TEXT,
  invalid_items JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item JSONB;
  v_dc_item_id UUID;
  v_requested_quantity NUMERIC;
  v_available_quantity NUMERIC;
  v_errors JSONB := '[]'::JSONB;
  v_has_errors BOOLEAN := FALSE;
BEGIN
  -- Loop through each item to validate
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_dc_item_id := (v_item->>'dc_item_id')::UUID;
    v_requested_quantity := (v_item->>'quantity')::NUMERIC;
    
    -- Skip validation for manual items (no dc_item_id)
    IF v_dc_item_id IS NULL THEN
      CONTINUE;
    END IF;
    
    -- Get available quantity for this DC item
    SELECT 
      dis.original_quantity - dis.invoiced_quantity +
      -- Add back quantity from the invoice being edited (if any)
      COALESCE(
        (SELECT SUM(sii.quantity) 
         FROM sales_invoice_items sii 
         WHERE sii.delivery_challan_item_id = v_dc_item_id 
           AND sii.invoice_id = p_exclude_invoice_id),
        0
      )
    INTO v_available_quantity
    FROM dc_item_invoice_status dis
    WHERE dis.dc_item_id = v_dc_item_id;
    
    -- Check if requested quantity exceeds available
    IF v_requested_quantity > v_available_quantity THEN
      v_has_errors := TRUE;
      v_errors := v_errors || jsonb_build_object(
        'dc_item_id', v_dc_item_id,
        'product_name', v_item->>'product_name',
        'batch_number', v_item->>'batch_number',
        'requested_quantity', v_requested_quantity,
        'available_quantity', v_available_quantity,
        'error', format('Requested quantity %s exceeds available quantity %s', 
                       v_requested_quantity, v_available_quantity)
      );
    END IF;
  END LOOP;
  
  -- Return results
  RETURN QUERY SELECT 
    NOT v_has_errors,
    CASE 
      WHEN v_has_errors THEN 'Some DC items have insufficient quantity available'
      ELSE 'All items validated successfully'
    END,
    v_errors;
END;
$$;

COMMENT ON FUNCTION validate_invoice_dc_items IS
'Validates that requested DC item quantities do not exceed available quantities. Prevents over-invoicing of DC items.';

-- Function 3: Get DC Item Details
-- Gets detailed information for specific DC items
CREATE OR REPLACE FUNCTION get_dc_item_details(
  p_dc_item_ids UUID[]
)
RETURNS TABLE (
  dc_item_id UUID,
  challan_id UUID,
  challan_number TEXT,
  product_id UUID,
  product_name TEXT,
  batch_id UUID,
  batch_number TEXT,
  unit TEXT,
  pack_size NUMERIC,
  pack_type TEXT,
  number_of_packs INTEGER,
  original_quantity NUMERIC,
  remaining_quantity NUMERIC,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    dis.dc_item_id,
    dis.challan_id,
    dis.challan_number,
    dis.product_id,
    dis.product_name,
    dis.batch_id,
    dis.batch_number,
    dis.unit,
    dis.pack_size,
    dis.pack_type,
    dis.number_of_packs,
    dis.original_quantity,
    dis.remaining_quantity,
    dis.status
  FROM dc_item_invoice_status dis
  WHERE dis.dc_item_id = ANY(p_dc_item_ids);
END;
$$;

COMMENT ON FUNCTION get_dc_item_details IS
'Returns detailed information for specific DC items. Used when loading an existing invoice for editing.';

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_pending_dc_items_for_customer TO authenticated;
GRANT EXECUTE ON FUNCTION validate_invoice_dc_items TO authenticated;
GRANT EXECUTE ON FUNCTION get_dc_item_details TO authenticated;
