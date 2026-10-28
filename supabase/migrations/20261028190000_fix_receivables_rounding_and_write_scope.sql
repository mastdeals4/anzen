-- Migration: 20261028190000_fix_receivables_rounding_and_write_scope.sql
-- Description: Unblock sales invoice settlement rounding adjustments in enforce_sales_invoice_write_scope
-- and ensure recalculate_sales_invoice_payment_state synchronizes balance_amount alongside paid_amount and payment_status.

-- 1. Update enforce_sales_invoice_write_scope to include invoice rounding adjustments when validating paid status
CREATE OR REPLACE FUNCTION public.enforce_sales_invoice_write_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_paid_actual numeric;
BEGIN
  -- Cascading updates from other triggers (e.g. recalculate_invoice_payment_status) are trusted
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();

  IF v_role NOT IN ('admin','accounts') THEN
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.paid_amount    IS DISTINCT FROM OLD.paid_amount
       OR NEW.total_amount   IS DISTINCT FROM OLD.total_amount
       OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id THEN
      RAISE EXCEPTION 'Sales/warehouse cannot modify invoice financial fields (payment_status, paid_amount, total_amount, customer_id)';
    END IF;
  END IF;

  IF NEW.payment_status = 'paid' AND NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    SELECT COALESCE(SUM(allocated_amount), 0) + COALESCE(public.get_invoice_rounding_adjustment_amount(NEW.id), 0)
    INTO v_paid_actual
    FROM public.voucher_allocations
    WHERE sales_invoice_id = NEW.id;

    IF v_paid_actual < COALESCE(NEW.total_amount, 0) THEN
      RAISE EXCEPTION 'Cannot mark invoice paid: allocated payments (%) < total (%)', v_paid_actual, NEW.total_amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. Update recalculate_sales_invoice_payment_state to synchronize balance_amount alongside paid_amount and payment_status
CREATE OR REPLACE FUNCTION public.recalculate_sales_invoice_payment_state(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice record;
  v_allocated numeric(18,2);
  v_adjustment numeric(18,2);
  v_paid numeric(18,2);
BEGIN
  SELECT id, total_amount
  INTO v_invoice
  FROM public.sales_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_allocated := public.get_invoice_allocation_amount(p_invoice_id, NULL);
  v_adjustment := public.get_invoice_rounding_adjustment_amount(p_invoice_id);

  v_paid := LEAST(
    GREATEST(COALESCE(v_allocated, 0) + COALESCE(v_adjustment, 0), 0),
    COALESCE(v_invoice.total_amount, 0)
  );

  UPDATE public.sales_invoices
  SET
    paid_amount = v_paid,
    balance_amount = GREATEST(COALESCE(v_invoice.total_amount, 0) - v_paid, 0),
    payment_status = CASE
      WHEN v_paid <= 0 THEN 'pending'
      WHEN v_paid >= v_invoice.total_amount THEN 'paid'
      ELSE 'partial'
    END
  WHERE id = p_invoice_id;
END;
$function$;

-- 3. Grants
REVOKE ALL ON FUNCTION public.enforce_sales_invoice_write_scope() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_sales_invoice_write_scope() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.recalculate_sales_invoice_payment_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_sales_invoice_payment_state(uuid) TO authenticated, service_role;

