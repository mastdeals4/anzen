/*
  # Fix Sales Invoice Trigger - Don't Deduct Stock If Linked to DC

  ## Issue:
  Sales invoice trigger always deducts stock, even when invoice is linked to a DC.
  This causes double deduction because DC already deducted the stock.

  ## Logic:
  - If invoice has linked_challan_ids (linked to DC), DO NOT deduct stock
  - If invoice is direct (no DC), deduct stock normally
  - On delete, only restore stock if it was a direct invoice

  ## Changes:
  - Update trg_sales_invoice_item_inventory() to check linked_challan_ids
*/

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
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Get invoice details
    SELECT si.invoice_number, si.created_by, si.linked_challan_ids
    INTO v_invoice_number, v_user_id, v_linked_challans
    FROM sales_invoices si
    WHERE si.id = NEW.invoice_id;

    -- Only deduct stock if invoice is NOT linked to any DC
    -- If linked to DC, stock was already deducted when DC was created
    IF v_linked_challans IS NULL OR array_length(v_linked_challans, 1) IS NULL THEN
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
    END IF;

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- Get invoice details
    SELECT si.invoice_number, si.linked_challan_ids
    INTO v_invoice_number, v_linked_challans
    FROM sales_invoices si 
    WHERE si.id = OLD.invoice_id;

    -- Only restore stock if invoice was direct (not linked to DC)
    IF v_linked_challans IS NULL OR array_length(v_linked_challans, 1) IS NULL THEN
      INSERT INTO inventory_transactions (
        product_id, batch_id, transaction_type, quantity,
        transaction_date, reference_number, notes, created_by
      ) VALUES (
        OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
        CURRENT_DATE, v_invoice_number,
        'Reversed direct sale from deleted invoice item', auth.uid()
      );
    END IF;

    RETURN OLD;
  END IF;
END;
$$;