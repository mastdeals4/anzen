/*
  # Fix RPC Function for DC Item Invoicing

  ## Problem
  The get_pending_dc_items_for_customer function references columns that don't exist:
  - b.purchase_price
  - b.selling_price  
  - b.mrp

  ## Solution
  Replace these with actual columns from the batches table:
  - import_price (cost price)
  - Calculate unit price from import costs

  This allows the UI to load pending DC items for invoice creation.
*/

-- Drop and recreate the function with correct column references
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
      -- Use actual batch cost columns
      b.import_price,
      COALESCE(b.duty_charges, 0) AS duty_charges,
      COALESCE(b.freight_charges, 0) AS freight_charges,
      COALESCE(b.other_charges, 0) AS other_charges,
      b.import_quantity,
      -- Calculate unit price from total cost / quantity with 25% markup
      CASE 
        WHEN b.import_quantity > 0 THEN 
          ROUND(((b.import_price + COALESCE(b.duty_charges, 0) + COALESCE(b.freight_charges, 0) + COALESCE(b.other_charges, 0)) / b.import_quantity) * 1.25, 2)
        ELSE 0
      END AS selling_price
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
      b.import_price,
      COALESCE(b.duty_charges, 0) AS duty_charges,
      COALESCE(b.freight_charges, 0) AS freight_charges,
      COALESCE(b.other_charges, 0) AS other_charges,
      b.import_quantity,
      -- Calculate unit price
      CASE 
        WHEN b.import_quantity > 0 THEN 
          ROUND(((b.import_price + COALESCE(b.duty_charges, 0) + COALESCE(b.freight_charges, 0) + COALESCE(b.other_charges, 0)) / b.import_quantity) * 1.25, 2)
        ELSE 0
      END AS selling_price
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
      import_price,
      selling_price,
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
      ei.import_price,
      ei.selling_price,
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
        'purchase_price', ai.import_price,
        'selling_price', ai.selling_price,
        'mrp', ai.selling_price,
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
'Returns all delivery challans with pending items for a customer. Uses actual batch cost columns and calculates selling price from import costs.';
