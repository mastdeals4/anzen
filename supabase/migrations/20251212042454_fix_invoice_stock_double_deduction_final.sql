/*
  # Fix Invoice Stock Double Deduction - FINAL FIX

  ## Root Cause:
  Invoices linked to Delivery Challans were STILL deducting stock even though
  DCs already deducted it. This caused double deduction and negative stock.

  ## Example:
  - DC deducts 500kg
  - Invoice linked to DC deducts another 500kg
  - Total: -1000kg (should be only -500kg)

  ## Solution:
  1. Identify all invoices linked to DCs that created sale transactions
  2. Reverse those duplicate sale transactions
  3. Update triggers to be bulletproof
  4. Recalculate batch stock accurately

  ## Changes:
  1. Reverse double deductions from linked invoices
  2. Update invoice trigger to NEVER deduct if linked to DC
  3. Update invoice DELETE to NEVER restore if linked to DC
  4. Recalculate current_stock from transactions
*/

-- Step 1: Reverse duplicate sale transactions from invoices linked to DCs
DO $$
DECLARE
  v_item RECORD;
  v_transaction_exists boolean;
BEGIN
  RAISE NOTICE 'Starting to reverse double deductions from invoices linked to DCs...';

  FOR v_item IN
    SELECT
      sii.product_id,
      sii.batch_id,
      sii.quantity,
      si.invoice_number,
      si.invoice_date,
      si.linked_challan_ids
    FROM sales_invoice_items sii
    JOIN sales_invoices si ON sii.invoice_id = si.id
    WHERE si.linked_challan_ids IS NOT NULL
    AND array_length(si.linked_challan_ids, 1) > 0
  LOOP
    -- Check if there's a 'sale' transaction for this invoice item
    SELECT EXISTS (
      SELECT 1 FROM inventory_transactions
      WHERE product_id = v_item.product_id
      AND batch_id = v_item.batch_id
      AND reference_number = v_item.invoice_number
      AND transaction_type = 'sale'
      AND quantity < 0
    ) INTO v_transaction_exists;

    -- If found, reverse it (this is the double deduction)
    IF v_transaction_exists THEN
      RAISE NOTICE 'Reversing double deduction for invoice % on batch %',
        v_item.invoice_number, v_item.batch_id;

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
        v_item.product_id,
        v_item.batch_id,
        'adjustment',
        v_item.quantity,
        CURRENT_DATE,
        v_item.invoice_number || '-FIX',
        'Fixed double deduction: Invoice ' || v_item.invoice_number || ' was linked to DC but still deducted stock',
        auth.uid()
      );
    END IF;
  END LOOP;

  RAISE NOTICE 'Completed reversing double deductions';
END $$;

-- Step 2: Recalculate current_stock for all batches from transactions
DO $$
DECLARE
  v_batch RECORD;
  v_calculated_stock numeric;
BEGIN
  RAISE NOTICE 'Recalculating batch stock from transactions...';

  FOR v_batch IN SELECT id, batch_number, current_stock FROM batches
  LOOP
    -- Calculate stock from transactions
    SELECT COALESCE(SUM(quantity), 0)
    INTO v_calculated_stock
    FROM inventory_transactions
    WHERE batch_id = v_batch.id;

    -- Update if different
    IF v_calculated_stock != v_batch.current_stock THEN
      RAISE NOTICE 'Updating batch % stock from % to %',
        v_batch.batch_number, v_batch.current_stock, v_calculated_stock;

      UPDATE batches
      SET current_stock = v_calculated_stock
      WHERE id = v_batch.id;
    END IF;
  END LOOP;

  RAISE NOTICE 'Completed stock recalculation';
END $$;

-- Step 3: Update invoice trigger to be bulletproof
CREATE OR REPLACE FUNCTION trg_sales_invoice_item_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_number text;
  v_user_id uuid;
  v_linked_challans uuid[];
  v_is_linked_to_dc boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT si.invoice_number, si.created_by, si.linked_challan_ids
    INTO v_invoice_number, v_user_id, v_linked_challans
    FROM sales_invoices si
    WHERE si.id = NEW.invoice_id;

    v_is_linked_to_dc := (v_linked_challans IS NOT NULL AND array_length(v_linked_challans, 1) > 0);

    IF NOT v_is_linked_to_dc THEN
      RAISE NOTICE 'Invoice % is direct sale (not linked to DC), deducting stock', v_invoice_number;

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
        'Direct sale via invoice: ' || v_invoice_number,
        v_user_id
      );
    ELSE
      RAISE NOTICE 'Invoice % is linked to DC, NOT deducting stock (already deducted by DC)', v_invoice_number;
    END IF;

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    SELECT si.invoice_number, si.linked_challan_ids
    INTO v_invoice_number, v_linked_challans
    FROM sales_invoices si
    WHERE si.id = OLD.invoice_id;

    v_is_linked_to_dc := (v_linked_challans IS NOT NULL AND array_length(v_linked_challans, 1) > 0);

    IF NOT v_is_linked_to_dc THEN
      RAISE NOTICE 'Deleting direct sale invoice %, restoring stock', v_invoice_number;

      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, notes, created_by
      ) VALUES (
        OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
        CURRENT_DATE, v_invoice_number,
        'Reversed direct sale from deleted invoice item', auth.uid()
      );
    ELSE
      RAISE NOTICE 'Deleting DC-linked invoice %, NOT restoring stock (DC still owns the deduction)', v_invoice_number;
    END IF;

    RETURN OLD;
  END IF;
END;
$$;

COMMENT ON FUNCTION trg_sales_invoice_item_inventory IS 'Handles inventory transactions for sales invoices. Only deducts/restores stock for DIRECT invoices (not linked to DCs).';

DROP TRIGGER IF EXISTS trigger_sales_invoice_item_insert ON sales_invoice_items;
CREATE TRIGGER trigger_sales_invoice_item_insert
  AFTER INSERT ON sales_invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_sales_invoice_item_inventory();

DROP TRIGGER IF EXISTS trigger_sales_invoice_item_delete ON sales_invoice_items;
CREATE TRIGGER trigger_sales_invoice_item_delete
  AFTER DELETE ON sales_invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_sales_invoice_item_inventory();

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM batches WHERE current_stock < 0;

  IF v_count > 0 THEN
    RAISE WARNING 'Still have % batches with negative stock - may need manual review', v_count;
  ELSE
    RAISE NOTICE 'SUCCESS: All batches have non-negative stock!';
  END IF;
END $$;
