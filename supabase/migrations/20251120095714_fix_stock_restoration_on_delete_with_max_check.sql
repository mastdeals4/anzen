/*
  # Fix Stock Restoration on Invoice Delete

  ## Problem
  When deleting invoices, the trigger tries to restore stock but fails if stock would exceed import_quantity.
  This happens when:
  - Invoice was linked to delivery challan (stock never deducted)
  - Or stock was already manually restored

  ## Solution
  Update the trigger to check if restoring stock would exceed import_quantity.
  Only restore stock if it won't violate the constraint.

  ## Changes
  - Add validation in DELETE operation to prevent over-restoration
  - Log cases where stock restoration is skipped
*/

CREATE OR REPLACE FUNCTION sync_batch_stock_on_sale()
RETURNS TRIGGER AS $$
DECLARE
  v_is_linked_to_challan BOOLEAN;
  v_current_stock NUMERIC;
  v_import_quantity NUMERIC;
BEGIN
  -- Check if this invoice is linked to a delivery challan
  SELECT (linked_challan_ids IS NOT NULL AND array_length(linked_challan_ids, 1) > 0)
  INTO v_is_linked_to_challan
  FROM sales_invoices
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- Skip stock operations if linked to delivery challan (stock already deducted)
  IF v_is_linked_to_challan THEN
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  -- Original logic for non-linked invoices
  IF (TG_OP = 'INSERT') THEN
    -- Only deduct stock if batch_id is provided
    IF NEW.batch_id IS NOT NULL THEN
      -- Decrease batch stock when sale is created
      UPDATE batches
      SET current_stock = current_stock - NEW.quantity
      WHERE id = NEW.batch_id;
      
      -- Create inventory transaction for the sale
      INSERT INTO inventory_transactions (
        transaction_type,
        product_id,
        batch_id,
        quantity,
        reference_number,
        notes,
        transaction_date,
        created_by
      )
      SELECT
        'sale',
        NEW.product_id,
        NEW.batch_id,
        -NEW.quantity,
        si.invoice_number,
        'Sale: Invoice ' || si.invoice_number,
        si.invoice_date,
        si.created_by
      FROM sales_invoices si
      WHERE si.id = NEW.invoice_id;
    END IF;
    
    RETURN NEW;
    
  ELSIF (TG_OP = 'UPDATE') THEN
    -- Only adjust if batch_id is provided
    IF NEW.batch_id IS NOT NULL AND OLD.quantity IS DISTINCT FROM NEW.quantity THEN
      -- Restore old quantity and deduct new quantity
      UPDATE batches
      SET current_stock = current_stock + OLD.quantity - NEW.quantity
      WHERE id = NEW.batch_id;
      
      -- Update the inventory transaction
      UPDATE inventory_transactions
      SET quantity = -NEW.quantity
      WHERE batch_id = NEW.batch_id
        AND transaction_type = 'sale'
        AND reference_number IN (
          SELECT invoice_number FROM sales_invoices WHERE id = NEW.invoice_id
        );
    END IF;
    
    RETURN NEW;
    
  ELSIF (TG_OP = 'DELETE') THEN
    -- Only restore stock if batch_id is provided
    IF OLD.batch_id IS NOT NULL THEN
      -- Check current stock and import quantity to avoid over-restoration
      SELECT current_stock, import_quantity 
      INTO v_current_stock, v_import_quantity
      FROM batches 
      WHERE id = OLD.batch_id;
      
      -- Only restore if it won't exceed import quantity
      IF (v_current_stock + OLD.quantity) <= v_import_quantity THEN
        -- Restore stock when sale is deleted
        UPDATE batches
        SET current_stock = current_stock + OLD.quantity
        WHERE id = OLD.batch_id;
        
        -- Delete the inventory transaction
        DELETE FROM inventory_transactions
        WHERE batch_id = OLD.batch_id
          AND transaction_type = 'sale'
          AND reference_number IN (
            SELECT invoice_number FROM sales_invoices WHERE id = OLD.invoice_id
          );
      ELSE
        -- Stock is already at maximum, skip restoration
        -- This can happen if invoice was created from delivery challan or stock was manually adjusted
        RAISE NOTICE 'Skipping stock restoration for batch % - would exceed import quantity (current: %, import: %, restore: %)', 
          OLD.batch_id, v_current_stock, v_import_quantity, OLD.quantity;
      END IF;
    END IF;
    
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION sync_batch_stock_on_sale() IS 'Automatically syncs batch stock when sales invoice items are created, updated, or deleted. Skips stock operations for invoices linked to delivery challans. Prevents stock over-restoration on delete.';
