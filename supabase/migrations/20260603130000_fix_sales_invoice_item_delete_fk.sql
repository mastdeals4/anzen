/*
  # Fix sales_invoice_item DELETE trigger FK violation

  ## Problem
  `trg_sales_invoice_item_inventory` (DELETE branch) writes the restoring
  `inventory_transactions` row with
    created_by = COALESCE(auth.uid(), OLD.id)
  When `auth.uid()` is NULL (service-role, raw SQL, system cleanup), the
  fallback `OLD.id` is the *invoice-item* UUID, not a user UUID. The FK
  `inventory_transactions.created_by -> user_profiles.id` then fails and
  the DELETE is blocked.

  ## Fix
  Use the invoice's `created_by` as the trustworthy fallback. Same
  approach the INSERT branch already takes (reads `si.created_by`).
*/

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
    IF v_is_from_dc THEN
      RETURN NEW;
    END IF;

    SELECT si.invoice_number, si.invoice_date, si.created_by
      INTO v_invoice_number, v_invoice_date, v_user_id
      FROM sales_invoices si WHERE si.id = NEW.invoice_id;

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
    IF v_is_from_dc THEN
      RETURN OLD;
    END IF;

    -- Pull the invoice's created_by as the trustworthy actor fallback.
    SELECT si.invoice_number, si.created_by
      INTO v_invoice_number, v_user_id
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
      COALESCE(auth.uid(), v_user_id),
      v_current_stock, v_current_stock + OLD.quantity
    );

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$function$;
