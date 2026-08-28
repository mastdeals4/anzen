
/*
  # Fix: Invoice trigger must ALWAYS record sale transactions
  
  ROOT CAUSE: The trigger `trg_sales_invoice_item_inventory` skips creating 
  inventory_transactions when the invoice item has a delivery_challan_item_id.
  This meant all DC-linked sales were invisible in transaction history.
  
  THE FIX:
  - Always record a sale transaction regardless of whether item came from DC or manual entry
  - DC-linked items: stock was already deducted when DC was approved, so we only log the transaction
  - Manual items: deduct stock AND log transaction (unchanged behavior)
  
  BACKFILL:
  - Insert missing sale transactions for all existing DC-linked invoice items
*/

-- 1. Drop and recreate the trigger function to always log transactions
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
  v_current_stock numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT si.invoice_number, si.invoice_date, si.created_by
    INTO v_invoice_number, v_invoice_date, v_user_id
    FROM sales_invoices si WHERE si.id = NEW.invoice_id;

    v_is_from_dc := (NEW.delivery_challan_item_id IS NOT NULL);

    IF NOT v_is_from_dc THEN
      -- Manual item: deduct stock
      SELECT pim.new_stock + NEW.quantity
      INTO v_current_stock
      FROM post_inventory_movement(
        NEW.product_id,
        NEW.batch_id,
        -NEW.quantity,
        'sale',
        'sales_invoice_item',
        NEW.id,
        v_user_id
      ) AS pim;
    ELSE
      -- DC item: stock already deducted at DC approval; just read current value for audit
      SELECT current_stock INTO v_current_stock FROM batches WHERE id = NEW.batch_id;
    END IF;

    -- For DC items, record sale transaction without touching stock
    IF v_is_from_dc THEN
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by, stock_before, stock_after
      ) VALUES (
        NEW.product_id, NEW.batch_id, 'sale', -NEW.quantity,
        v_invoice_date, v_invoice_number, 'sales_invoice_item', NEW.id,
        'Sale via DC-linked invoice: ' || v_invoice_number,
        v_user_id,
        v_current_stock,
        v_current_stock
      );
    END IF;

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    SELECT si.invoice_number INTO v_invoice_number
    FROM sales_invoices si WHERE si.id = OLD.invoice_id;

    v_is_from_dc := (OLD.delivery_challan_item_id IS NOT NULL);

    IF NOT v_is_from_dc THEN
      -- Manual item: restore stock
      PERFORM post_inventory_movement(
        OLD.product_id,
        OLD.batch_id,
        OLD.quantity,
        'adjustment',
        'invoice_item_delete',
        OLD.id,
        COALESCE(auth.uid(), OLD.id)
      );
    ELSE
      -- DC item deletion: log the removal of the sale record (stock restoration handled by DC)
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, reference_type, reference_id,
        notes, created_by
      ) VALUES (
        OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
        CURRENT_DATE, v_invoice_number, 'invoice_item_delete', OLD.id,
        'Invoice line removed for DC-linked item: ' || v_invoice_number,
        COALESCE(auth.uid(), OLD.id)
      );
    END IF;

    RETURN OLD;
  END IF;
END;
$$;

-- 2. Backfill missing sale transactions for ALL existing DC-linked invoice items
INSERT INTO inventory_transactions (
  product_id, batch_id, transaction_type, quantity,
  transaction_date, reference_number, reference_type, reference_id,
  notes, created_by, stock_before, stock_after
)
SELECT
  sii.product_id,
  sii.batch_id,
  'sale',
  -sii.quantity,
  si.invoice_date,
  si.invoice_number,
  'sales_invoice_item',
  sii.id,
  'Sale via DC-linked invoice: ' || si.invoice_number || ' [backfilled]',
  si.created_by,
  b.current_stock,  -- current value (approximate, DC already deducted)
  b.current_stock
FROM sales_invoice_items sii
JOIN sales_invoices si ON si.id = sii.invoice_id
LEFT JOIN batches b ON b.id = sii.batch_id
WHERE sii.delivery_challan_item_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM inventory_transactions it
    WHERE it.reference_type = 'sales_invoice_item'
      AND it.reference_id = sii.id
  );
