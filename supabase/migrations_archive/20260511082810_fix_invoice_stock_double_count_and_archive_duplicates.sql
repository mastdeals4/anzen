/*
  # Fix invoice-side stock double-counting and archive historical duplicates

  ## Problem
  The sales_invoice_items trigger writes a `sale` inventory_transaction for EVERY
  invoice item, including those sourced from an approved Delivery Challan.
  The DC-approval trigger already writes a `delivery_challan` transaction for
  the same physical movement, so for every DC-linked invoice we were recording
  the stock-out twice. The batch `current_stock` stayed correct (only the DC
  path actually mutates it), but the transaction ledger — and therefore the
  drill-down In/Out/Reserved/Free math — was doubled. 21 batches are affected.

  ## Fix
  1. Rewrite `trg_sales_invoice_item_inventory` so that:
     - For DC-linked items: NO inventory_transaction row is inserted. The DC
       row is the single source of truth for the physical movement. No batch
       mutation (DC already did it).
     - For manual (non-DC) invoice items: behaviour unchanged (deduct stock,
       insert one `sale` row).
     - On DELETE of a DC-linked item: no inventory_transactions mutation,
       no batch mutation (DC owns the reversal).
     - On DELETE of a manual item: behaviour unchanged (restore stock, log
       one `adjustment` row).

  2. Archive historical duplicate `sale` rows by setting
     `metadata->>'superseded'='true'` on every sale transaction whose
     sales_invoice_item is DC-linked. Rows are kept intact for finance
     traceability. The drill-down UI will exclude superseded rows.

  ## Safety
  - No rows are deleted.
  - `batches.current_stock` and `reserved_stock` are NOT modified by this
    migration — their current values are correct (the DC trigger maintained
    them; the invoice trigger only polluted the ledger).
  - The fix is idempotent: re-running leaves the DB in the same state.
*/

-- =============================================================================
-- 1. Rewrite the invoice-item trigger function
-- =============================================================================
CREATE OR REPLACE FUNCTION public.trg_sales_invoice_item_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_number text;
  v_invoice_date   date;
  v_user_id        uuid;
  v_is_from_dc     boolean;
  v_current_stock  numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_is_from_dc := (NEW.delivery_challan_item_id IS NOT NULL);

    -- DC-linked items: DC trigger already handled everything. Exit cleanly.
    IF v_is_from_dc THEN
      RETURN NEW;
    END IF;

    SELECT si.invoice_number, si.invoice_date, si.created_by
      INTO v_invoice_number, v_invoice_date, v_user_id
      FROM sales_invoices si WHERE si.id = NEW.invoice_id;

    -- Manual item: deduct batch stock and log a single sale transaction
    SELECT current_stock INTO v_current_stock FROM batches WHERE id = NEW.batch_id;
    UPDATE batches SET current_stock = current_stock - NEW.quantity WHERE id = NEW.batch_id;

    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, created_by, stock_before, stock_after
    ) VALUES (
      NEW.product_id, NEW.batch_id, 'sale', -NEW.quantity,
      v_invoice_date, v_invoice_number, 'sales_invoice_item', NEW.id,
      'Manual sale via invoice: ' || v_invoice_number,
      v_user_id,
      v_current_stock, v_current_stock - NEW.quantity
    );

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    v_is_from_dc := (OLD.delivery_challan_item_id IS NOT NULL);

    -- DC-linked delete: DC trigger owns reversal. Nothing to do here.
    IF v_is_from_dc THEN
      RETURN OLD;
    END IF;

    SELECT si.invoice_number INTO v_invoice_number
      FROM sales_invoices si WHERE si.id = OLD.invoice_id;

    SELECT current_stock INTO v_current_stock FROM batches WHERE id = OLD.batch_id;
    UPDATE batches SET current_stock = current_stock + OLD.quantity WHERE id = OLD.batch_id;

    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity,
      transaction_date, reference_number, reference_type, reference_id,
      notes, created_by, stock_before, stock_after
    ) VALUES (
      OLD.product_id, OLD.batch_id, 'adjustment', OLD.quantity,
      CURRENT_DATE, v_invoice_number, 'invoice_item_delete', OLD.id,
      'Restored stock from deleted manual invoice item',
      COALESCE(auth.uid(), OLD.id),
      v_current_stock, v_current_stock + OLD.quantity
    );

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$function$;

-- =============================================================================
-- 2. Archive historical duplicate sale rows (DC-linked invoice items)
-- =============================================================================
UPDATE inventory_transactions it
SET metadata = COALESCE(it.metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'superseded', 'true',
                   'superseded_reason', 'DC-linked invoice sale — duplicate of delivery_challan transaction',
                   'superseded_at', now()::text
                 )
WHERE it.transaction_type = 'sale'
  AND it.reference_type = 'sales_invoice_item'
  AND EXISTS (
    SELECT 1 FROM sales_invoice_items sii
    WHERE sii.id = it.reference_id
      AND sii.delivery_challan_item_id IS NOT NULL
  )
  AND COALESCE(it.metadata->>'superseded','false') <> 'true';
