/*
  # Add DC Item Tracking to Sales Invoice Items

  ## Overview
  This migration enables partial invoicing of Delivery Challan items by linking invoice line items
  back to their source DC items. This prevents double stock deduction and enables tracking of
  which DC items have been invoiced.

  ## Changes

  1. **New Columns**
     - `sales_invoice_items.delivery_challan_item_id` - Links to source DC item (nullable)
       - NULL = Manual item (not from DC)
       - NOT NULL = From DC (stock already deducted by DC)

  2. **Constraints**
     - Foreign key to `delivery_challan_items(id)` with SET NULL on delete
     - This preserves invoice integrity if DC is deleted

  3. **Indexes**
     - Index on `delivery_challan_item_id` for efficient querying
     - Composite index on (delivery_challan_item_id, invoice_id) for relationship queries

  ## Stock Management Impact
  - Items with delivery_challan_item_id NOT NULL: Stock NOT deducted (already done by DC)
  - Items with delivery_challan_item_id IS NULL: Stock IS deducted (manual items)
  - Triggers will be updated in subsequent migration to implement this logic
*/

-- Add delivery_challan_item_id column to sales_invoice_items
ALTER TABLE sales_invoice_items 
ADD COLUMN IF NOT EXISTS delivery_challan_item_id UUID REFERENCES delivery_challan_items(id) ON DELETE SET NULL;

-- Add index for efficient querying of DC item relationships
CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_dc_item 
ON sales_invoice_items(delivery_challan_item_id) 
WHERE delivery_challan_item_id IS NOT NULL;

-- Add composite index for DC item to invoice lookups
CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_dc_item_invoice 
ON sales_invoice_items(delivery_challan_item_id, invoice_id) 
WHERE delivery_challan_item_id IS NOT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN sales_invoice_items.delivery_challan_item_id IS 
'Links to source delivery challan item. NULL = manual item (deduct stock), NOT NULL = from DC (stock already deducted)';
