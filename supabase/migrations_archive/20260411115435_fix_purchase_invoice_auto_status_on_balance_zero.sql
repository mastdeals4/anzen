
/*
  # Auto-update purchase invoice status when balance reaches zero

  ## Problem
  - balance_amount is a GENERATED ALWAYS column (total_amount - paid_amount)
  - Frontend was trying to UPDATE balance_amount directly, causing 400 errors
  - When balance = 0, status was staying as "partial" instead of changing to "paid"

  ## Fix
  1. Add a trigger that fires AFTER UPDATE on purchase_invoices
  2. If balance_amount <= 0.01 and status is not 'paid', auto-set status = 'paid'
  3. Also fixes existing stale rows immediately (partial with balance = 0)

  ## Notes
  - balance_amount = total_amount - paid_amount (generated column, never set manually)
  - Status logic: balance=0 → paid, paid_amount>0 but balance>0 → partial, paid_amount=0 → unpaid
*/

CREATE OR REPLACE FUNCTION auto_update_purchase_invoice_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.balance_amount <= 0.01 AND NEW.status != 'paid' THEN
    NEW.status := 'paid';
  ELSIF NEW.balance_amount > 0.01 AND NEW.paid_amount > 0 AND NEW.status = 'paid' THEN
    NEW.status := 'partial';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_update_purchase_invoice_status ON purchase_invoices;

CREATE TRIGGER trg_auto_update_purchase_invoice_status
  BEFORE UPDATE ON purchase_invoices
  FOR EACH ROW
  EXECUTE FUNCTION auto_update_purchase_invoice_status();

UPDATE purchase_invoices
SET status = 'paid'
WHERE balance_amount <= 0.01
  AND status != 'paid';
