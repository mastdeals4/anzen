/*
  # Update Stock Deduction Triggers for Item-Level DC Tracking

  ## Overview
  Updates the inventory triggers to use the new `delivery_challan_item_id` column for
  item-level tracking instead of invoice-level `linked_challan_ids` checking.

  ## Key Changes
  
  1. **Item-Level Stock Management**
     - OLD: Checked if entire invoice was linked to DCs (all-or-nothing)
     - NEW: Checks each item individually via `delivery_challan_item_id`
     - Allows mixed invoices: Some items from DCs + some manual items

  2. **Stock Deduction Logic**
     - `delivery_challan_item_id IS NOT NULL`: Skip stock deduction (DC already deducted)
     - `delivery_challan_item_id IS NULL`: Deduct stock (manual item)

  3. **Stock Restoration Logic (on delete)**
     - `delivery_challan_item_id IS NOT NULL`: Skip restoration (DC still owns the stock)
     - `delivery_challan_item_id IS NULL`: Restore stock (manual item being removed)

  ## Benefits
  - Supports partial DC invoicing (invoicing 3 out of 5 DC items)
  - Supports mixed invoices (DC items + manual items in same invoice)
  - More accurate stock tracking at item level
  - Prevents double deduction for DC items
  - Allows manual items to properly deduct stock

  ## Backward Compatibility
  - Existing invoices without `delivery_challan_item_id` are treated as manual items
  - Stock behavior remains correct for historical data
*/

-- Drop existing trigger
DROP TRIGGER IF EXISTS trigger_sales_invoice_item_insert ON sales_invoice_items;
DROP TRIGGER IF EXISTS trigger_sales_invoice_item_delete ON sales_invoice_items;

-- Update the inventory trigger function for item-level DC tracking
CREATE OR REPLACE FUNCTION trg_sales_invoice_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_number text;
  v_invoice_date date;
  v_user_id uuid;
  v_is_from_dc boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Get invoice details
    SELECT si.invoice_number, si.invoice_date, si.created_by
    INTO v_invoice_number, v_invoice_date, v_user_id
    FROM sales_invoices si
    WHERE si.id = NEW.invoice_id;

    -- Check if this specific item is from a DC
    v_is_from_dc := (NEW.delivery_challan_item_id IS NOT NULL);

    IF v_is_from_dc THEN
      -- Item is from DC - stock already deducted by DC, do NOT deduct again
      RAISE NOTICE 'Invoice item % (Invoice: %) is from DC, NOT deducting stock (already deducted by DC)', 
        NEW.id, v_invoice_number;
    ELSE
      -- Manual item - deduct stock
      RAISE NOTICE 'Invoice item % (Invoice: %) is manual item, deducting stock', 
        NEW.id, v_invoice_number;

      -- Create inventory transaction to deduct stock
      INSERT INTO inventory_transactions (
        product_id,
        batch_id,
        transaction_type,
        quantity,
        transaction_date,
        reference_number,
        notes,
        created_by
      ) VALUES (
        NEW.product_id,
        NEW.batch_id,
        'sale',
        -NEW.quantity,
        v_invoice_date,
        v_invoice_number,
        'Manual sale via invoice: ' || v_invoice_number,
        v_user_id
      );
    END IF;

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- Get invoice details
    SELECT si.invoice_number
    INTO v_invoice_number
    FROM sales_invoices si
    WHERE si.id = OLD.invoice_id;

    -- Check if this specific item was from a DC
    v_is_from_dc := (OLD.delivery_challan_item_id IS NOT NULL);

    IF v_is_from_dc THEN
      -- Item was from DC - do NOT restore stock (DC still owns the deduction)
      RAISE NOTICE 'Deleting DC invoice item % (Invoice: %), NOT restoring stock (DC still owns deduction)', 
        OLD.id, v_invoice_number;
    ELSE
      -- Manual item - restore stock
      RAISE NOTICE 'Deleting manual invoice item % (Invoice: %), restoring stock', 
        OLD.id, v_invoice_number;

      -- Create inventory transaction to restore stock
      INSERT INTO inventory_transactions (
        product_id,
        batch_id,
        transaction_type,
        quantity,
        transaction_date,
        reference_number,
        notes,
        created_by
      ) VALUES (
        OLD.product_id,
        OLD.batch_id,
        'adjustment',
        OLD.quantity,
        CURRENT_DATE,
        v_invoice_number || '-REVERSED',
        'Restored stock from deleted manual invoice item',
        COALESCE(auth.uid(), OLD.id)
      );
    END IF;

    RETURN OLD;
  END IF;
END;
$$;

COMMENT ON FUNCTION trg_sales_invoice_item_inventory IS 
'Handles inventory transactions for sales invoice items at item level. Deducts stock only for manual items (delivery_challan_item_id IS NULL). Items from DCs (delivery_challan_item_id IS NOT NULL) skip stock deduction as DC already deducted it.';

-- Recreate triggers
CREATE TRIGGER trigger_sales_invoice_item_insert
  AFTER INSERT ON sales_invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_sales_invoice_item_inventory();

CREATE TRIGGER trigger_sales_invoice_item_delete
  AFTER DELETE ON sales_invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_sales_invoice_item_inventory();

-- Verify current stock status
DO $$
DECLARE
  v_negative_count integer;
  v_zero_count integer;
  v_positive_count integer;
BEGIN
  SELECT 
    COUNT(*) FILTER (WHERE current_stock < 0),
    COUNT(*) FILTER (WHERE current_stock = 0),
    COUNT(*) FILTER (WHERE current_stock > 0)
  INTO v_negative_count, v_zero_count, v_positive_count
  FROM batches;

  RAISE NOTICE 'Stock Status: % negative, % zero, % positive batches', 
    v_negative_count, v_zero_count, v_positive_count;

  IF v_negative_count > 0 THEN
    RAISE WARNING 'Found % batches with negative stock - may need review', v_negative_count;
  END IF;
END $$;
