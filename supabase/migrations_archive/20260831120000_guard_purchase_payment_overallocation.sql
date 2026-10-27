-- Purchase payment hardening: prevent a payment voucher from allocating more
-- than the outstanding Purchase Invoice balance.  This is a database guard;
-- the existing payment-voucher/allocation architecture remains unchanged.

CREATE OR REPLACE FUNCTION public.prevent_purchase_invoice_payment_overallocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total numeric;
  v_existing numeric;
BEGIN
  IF NEW.voucher_type <> 'payment' OR NEW.purchase_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT total_amount INTO v_total
    FROM public.purchase_invoices
   WHERE id = NEW.purchase_invoice_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice % not found', NEW.purchase_invoice_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_existing
    FROM public.voucher_allocations
   WHERE purchase_invoice_id = NEW.purchase_invoice_id
     AND voucher_type = 'payment'
     AND (TG_OP <> 'UPDATE' OR id <> NEW.id);

  IF v_existing + NEW.allocated_amount > COALESCE(v_total, 0) + 0.01 THEN
    RAISE EXCEPTION 'Payment allocation exceeds Purchase Invoice outstanding amount';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_purchase_invoice_payment_overallocation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_purchase_invoice_payment_overallocation() TO service_role;

DROP TRIGGER IF EXISTS trg_prevent_purchase_invoice_payment_overallocation
  ON public.voucher_allocations;
CREATE TRIGGER trg_prevent_purchase_invoice_payment_overallocation
  BEFORE INSERT OR UPDATE OF allocated_amount, purchase_invoice_id, voucher_type
  ON public.voucher_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_purchase_invoice_payment_overallocation();
