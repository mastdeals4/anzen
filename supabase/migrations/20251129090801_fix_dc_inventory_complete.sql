/*
  # Fix Delivery Challan Inventory - Complete Fix

  ## Issues Fixed:
  1. Add 'delivery_challan' to transaction_type CHECK constraint
  2. Remove double stock deduction from sales_invoice trigger
  3. Add DC inventory trigger
  4. Backfill missing transactions
*/

-- 1. Add 'delivery_challan' to allowed transaction types
ALTER TABLE inventory_transactions 
DROP CONSTRAINT IF EXISTS inventory_transactions_transaction_type_check;

ALTER TABLE inventory_transactions
ADD CONSTRAINT inventory_transactions_transaction_type_check 
CHECK (transaction_type IN ('purchase', 'sale', 'adjustment', 'return', 'delivery_challan'));

-- 2. FIX SALES INVOICE TRIGGER (Remove stock deduction)
CREATE OR REPLACE FUNCTION trg_sales_invoice_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_number text;
  v_user_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT si.invoice_number, si.created_by
    INTO v_invoice_number, v_user_id
    FROM sales_invoices si
    WHERE si.id = NEW.invoice_id;

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
      (SELECT invoice_date FROM sales_invoices WHERE id = NEW.invoice_id),
      v_invoice_number,
      'Sale via invoice: ' || v_invoice_number,
      v_user_id
    );

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    SELECT si.invoice_number INTO v_invoice_number
    FROM sales_invoices si WHERE si.id = OLD.invoice_id;

    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, notes, created_by
    ) VALUES (
      OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
      CURRENT_DATE, v_invoice_number,
      'Reversed sale from deleted invoice item', auth.uid()
    );

    RETURN OLD;
  END IF;
END;
$$;

-- 3. CREATE DC INVENTORY TRIGGER
CREATE OR REPLACE FUNCTION trg_delivery_challan_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challan_number text;
  v_user_id uuid;
  v_challan_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT dc.challan_number, dc.created_by, dc.challan_date
    INTO v_challan_number, v_user_id, v_challan_date
    FROM delivery_challans dc WHERE dc.id = NEW.challan_id;

    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, notes, created_by
    ) VALUES (
      NEW.product_id, NEW.batch_id, 'delivery_challan', -NEW.quantity,
      v_challan_date, v_challan_number,
      'Delivery via DC: ' || v_challan_number, v_user_id
    );

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    SELECT dc.challan_number INTO v_challan_number
    FROM delivery_challans dc WHERE dc.id = OLD.challan_id;

    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, notes, created_by
    ) VALUES (
      OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
      CURRENT_DATE, v_challan_number,
      'Reversed delivery from deleted DC item', auth.uid()
    );

    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dc_item_insert ON delivery_challan_items;
CREATE TRIGGER trigger_dc_item_insert
  AFTER INSERT ON delivery_challan_items
  FOR EACH ROW EXECUTE FUNCTION trg_delivery_challan_item_inventory();

DROP TRIGGER IF EXISTS trigger_dc_item_delete ON delivery_challan_items;
CREATE TRIGGER trigger_dc_item_delete
  AFTER DELETE ON delivery_challan_items
  FOR EACH ROW EXECUTE FUNCTION trg_delivery_challan_item_inventory();

-- 4. BACKFILL MISSING DC TRANSACTIONS
DO $$
DECLARE
  v_item RECORD;
BEGIN
  FOR v_item IN
    SELECT dci.*, dc.challan_number, dc.created_by, dc.challan_date
    FROM delivery_challan_items dci
    JOIN delivery_challans dc ON dci.challan_id = dc.id
    WHERE NOT EXISTS (
      SELECT 1 FROM inventory_transactions it
      WHERE it.reference_number = dc.challan_number
      AND it.product_id = dci.product_id
      AND it.batch_id = dci.batch_id
      AND it.transaction_type = 'delivery_challan'
    )
  LOOP
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, notes, created_by
    ) VALUES (
      v_item.product_id, v_item.batch_id, 'delivery_challan', -v_item.quantity,
      v_item.challan_date, v_item.challan_number,
      'Backfilled: Delivery via DC ' || v_item.challan_number, v_item.created_by
    );
  END LOOP;
END $$;