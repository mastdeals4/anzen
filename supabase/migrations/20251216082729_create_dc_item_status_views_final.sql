/*
  # Create DC Item Status Tracking Views

  ## Overview
  Creates views to efficiently track which DC items have been invoiced 
  and how much quantity remains available for invoicing.

  ## Views Created

  1. **dc_item_invoice_status**
     - Shows each DC item with its invoicing status
     - Calculates: original quantity, invoiced quantity, remaining quantity
     - Shows which invoices contain each DC item

  2. **dc_invoicing_summary**
     - Summarizes each DC's overall invoicing status
     - Shows linked invoice numbers and completion status

  3. **pending_dc_items_by_customer**
     - Lists all DC items available for invoicing per customer
     - Filters out fully invoiced items

  ## Usage
  - Frontend: Query these views for efficient DC item selection
  - Reports: Use for DC fulfillment tracking
  - Validation: Check remaining quantities before creating invoices
*/

-- View 1: DC Item Invoice Status
-- Shows each DC item with detailed invoicing information
CREATE OR REPLACE VIEW dc_item_invoice_status AS
SELECT 
  dci.id AS dc_item_id,
  dci.challan_id,
  dc.challan_number,
  dc.challan_date,
  dc.customer_id,
  c.company_name AS customer_name,
  dci.product_id,
  p.product_name,
  dci.batch_id,
  b.batch_number,
  dci.quantity AS original_quantity,
  p.unit,
  dci.pack_size,
  dci.pack_type,
  dci.number_of_packs,
  -- Calculate invoiced quantity
  COALESCE(SUM(sii.quantity), 0) AS invoiced_quantity,
  -- Calculate remaining quantity
  dci.quantity - COALESCE(SUM(sii.quantity), 0) AS remaining_quantity,
  -- Status flags
  CASE 
    WHEN COALESCE(SUM(sii.quantity), 0) = 0 THEN 'not_invoiced'
    WHEN COALESCE(SUM(sii.quantity), 0) >= dci.quantity THEN 'fully_invoiced'
    ELSE 'partially_invoiced'
  END AS status,
  -- List of invoice numbers that include this DC item
  ARRAY_AGG(DISTINCT si.invoice_number ORDER BY si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL) AS invoice_numbers,
  -- Count of invoices
  COUNT(DISTINCT sii.invoice_id) AS invoice_count
FROM delivery_challan_items dci
JOIN delivery_challans dc ON dci.challan_id = dc.id
LEFT JOIN customers c ON dc.customer_id = c.id
LEFT JOIN products p ON dci.product_id = p.id
LEFT JOIN batches b ON dci.batch_id = b.id
LEFT JOIN sales_invoice_items sii ON dci.id = sii.delivery_challan_item_id
LEFT JOIN sales_invoices si ON sii.invoice_id = si.id
GROUP BY 
  dci.id, dci.challan_id, dc.challan_number, dc.challan_date, dc.customer_id,
  c.company_name, dci.product_id, p.product_name, p.unit, dci.batch_id, b.batch_number,
  dci.quantity, dci.pack_size, dci.pack_type, dci.number_of_packs;

COMMENT ON VIEW dc_item_invoice_status IS 
'Shows each delivery challan item with its invoicing status: original quantity, invoiced quantity, remaining quantity, and linked invoices.';

-- View 2: DC Invoicing Summary
-- Summarizes each DC's overall status
CREATE OR REPLACE VIEW dc_invoicing_summary AS
SELECT 
  dc.id AS challan_id,
  dc.challan_number,
  dc.challan_date,
  dc.customer_id,
  c.company_name AS customer_name,
  -- Item counts
  COUNT(dci.id) AS total_items,
  COUNT(dci.id) FILTER (WHERE dis.status = 'not_invoiced') AS not_invoiced_items,
  COUNT(dci.id) FILTER (WHERE dis.status = 'partially_invoiced') AS partially_invoiced_items,
  COUNT(dci.id) FILTER (WHERE dis.status = 'fully_invoiced') AS fully_invoiced_items,
  -- Overall DC status
  CASE 
    WHEN COUNT(dci.id) = 0 THEN 'not_invoiced'
    WHEN COUNT(dci.id) FILTER (WHERE dis.status = 'fully_invoiced') = COUNT(dci.id) THEN 'fully_invoiced'
    WHEN COUNT(dci.id) FILTER (WHERE dis.status IN ('partially_invoiced', 'fully_invoiced')) > 0 THEN 'partially_invoiced'
    ELSE 'not_invoiced'
  END AS dc_status,
  -- Completion percentage
  ROUND(
    (COALESCE(SUM(dis.invoiced_quantity), 0) / NULLIF(SUM(dis.original_quantity), 0)) * 100, 
    2
  ) AS completion_percentage,
  -- Total quantities
  COALESCE(SUM(dis.original_quantity), 0) AS total_quantity,
  COALESCE(SUM(dis.invoiced_quantity), 0) AS total_invoiced_quantity,
  COALESCE(SUM(dis.remaining_quantity), 0) AS total_remaining_quantity,
  -- Linked invoices
  ARRAY_AGG(DISTINCT si.invoice_number ORDER BY si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL) AS linked_invoice_numbers,
  COUNT(DISTINCT sii.invoice_id) AS linked_invoice_count
FROM delivery_challans dc
LEFT JOIN customers c ON dc.customer_id = c.id
LEFT JOIN delivery_challan_items dci ON dc.id = dci.challan_id
LEFT JOIN dc_item_invoice_status dis ON dci.id = dis.dc_item_id
LEFT JOIN sales_invoice_items sii ON dci.id = sii.delivery_challan_item_id
LEFT JOIN sales_invoices si ON sii.invoice_id = si.id
GROUP BY 
  dc.id, dc.challan_number, dc.challan_date, dc.customer_id, c.company_name;

COMMENT ON VIEW dc_invoicing_summary IS 
'Summarizes each delivery challan overall invoicing status with item counts, completion percentage, and linked invoices.';

-- View 3: Pending DC Items by Customer
-- Shows available DC items for invoicing per customer
CREATE OR REPLACE VIEW pending_dc_items_by_customer AS
SELECT 
  dis.customer_id,
  dis.customer_name,
  dis.challan_id,
  dis.challan_number,
  dis.challan_date,
  dis.dc_item_id,
  dis.product_id,
  dis.product_name,
  dis.batch_id,
  dis.batch_number,
  dis.original_quantity,
  dis.invoiced_quantity,
  dis.remaining_quantity,
  dis.unit,
  dis.pack_size,
  dis.pack_type,
  dis.number_of_packs,
  dis.status
FROM dc_item_invoice_status dis
WHERE dis.status IN ('not_invoiced', 'partially_invoiced')
  AND dis.remaining_quantity > 0
ORDER BY 
  dis.customer_name, 
  dis.challan_date DESC, 
  dis.challan_number,
  dis.product_name;

COMMENT ON VIEW pending_dc_items_by_customer IS 
'Lists all delivery challan items that are available for invoicing (not fully invoiced), grouped by customer for easy selection.';

-- Create indexes on the underlying tables to speed up these views
CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_dc_item_lookup
ON sales_invoice_items(delivery_challan_item_id, quantity)
WHERE delivery_challan_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_challan
ON delivery_challan_items(challan_id, product_id, batch_id);

-- Grant select permissions on views (RLS handled by underlying tables)
GRANT SELECT ON dc_item_invoice_status TO authenticated;
GRANT SELECT ON dc_invoicing_summary TO authenticated;
GRANT SELECT ON pending_dc_items_by_customer TO authenticated;
