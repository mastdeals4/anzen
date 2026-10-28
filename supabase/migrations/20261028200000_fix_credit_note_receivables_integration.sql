-- Migration: 20261028200000_fix_credit_note_receivables_integration.sql
-- Description: Integrates Credit Notes into Sales Invoice settlement, Receivables balance calculation, write scope, and dynamic synchronization.

-- 1. Helper function: Get total approved credit notes for a sales invoice
CREATE OR REPLACE FUNCTION public.get_invoice_credit_note_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(total_amount), 0)
  FROM public.credit_notes
  WHERE original_invoice_id = p_invoice_id
    AND status = 'approved';
$$;

COMMENT ON FUNCTION public.get_invoice_credit_note_amount(uuid) IS
  'Returns total approved credit note amount applied to a given sales invoice.';

-- 2. Update get_invoice_paid_amount to include credit notes and rounding adjustments
CREATE OR REPLACE FUNCTION public.get_invoice_paid_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT LEAST(
    GREATEST(
      public.get_invoice_allocation_amount(p_invoice_id, NULL)
      + public.get_invoice_rounding_adjustment_amount(p_invoice_id)
      + public.get_invoice_credit_note_amount(p_invoice_id),
      0
    ),
    COALESCE((SELECT total_amount FROM public.sales_invoices WHERE id = p_invoice_id), 0)
  );
$$;

-- 3. Update recalculate_sales_invoice_payment_state to include credit notes and update balance_amount
CREATE OR REPLACE FUNCTION public.recalculate_sales_invoice_payment_state(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invoice record;
  v_allocated numeric(18,2);
  v_adjustment numeric(18,2);
  v_credit_note numeric(18,2);
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
  v_credit_note := public.get_invoice_credit_note_amount(p_invoice_id);

  v_paid := LEAST(
    GREATEST(COALESCE(v_allocated, 0) + COALESCE(v_adjustment, 0) + COALESCE(v_credit_note, 0), 0),
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
$$;

-- 4. Update enforce_sales_invoice_write_scope to account for allocations, adjustments, and credit notes
CREATE OR REPLACE FUNCTION public.enforce_sales_invoice_write_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role text;
  v_paid_actual numeric;
BEGIN
  -- Cascading updates from trusted triggers are permitted
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
    SELECT COALESCE(SUM(allocated_amount), 0) INTO v_paid_actual
    FROM public.voucher_allocations
    WHERE sales_invoice_id = NEW.id;

    v_paid_actual := v_paid_actual
      + COALESCE(public.get_invoice_rounding_adjustment_amount(NEW.id), 0)
      + COALESCE(public.get_invoice_credit_note_amount(NEW.id), 0);

    IF v_paid_actual < COALESCE(NEW.total_amount, 0) THEN
      RAISE EXCEPTION 'Cannot mark invoice paid: allocated payments (%) < total (%)', v_paid_actual, NEW.total_amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 5. Trigger function to synchronize sales invoice payment state whenever credit notes are inserted, updated, or deleted
CREATE OR REPLACE FUNCTION public.trg_sync_credit_note_invoice_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.original_invoice_id IS NOT NULL THEN
      PERFORM public.recalculate_sales_invoice_payment_state(NEW.original_invoice_id);
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.original_invoice_id IS NOT NULL AND OLD.original_invoice_id IS DISTINCT FROM NEW.original_invoice_id THEN
      PERFORM public.recalculate_sales_invoice_payment_state(OLD.original_invoice_id);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.original_invoice_id IS NOT NULL THEN
      PERFORM public.recalculate_sales_invoice_payment_state(OLD.original_invoice_id);
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_credit_note_invoice ON public.credit_notes;
CREATE TRIGGER trg_sync_credit_note_invoice
AFTER INSERT OR UPDATE OR DELETE ON public.credit_notes
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_credit_note_invoice_payment();

-- 6. Synchronize all invoices that currently have approved credit notes
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT original_invoice_id
    FROM public.credit_notes
    WHERE original_invoice_id IS NOT NULL
      AND status = 'approved'
  LOOP
    PERFORM public.recalculate_sales_invoice_payment_state(r.original_invoice_id);
  END LOOP;
END;
$$;

