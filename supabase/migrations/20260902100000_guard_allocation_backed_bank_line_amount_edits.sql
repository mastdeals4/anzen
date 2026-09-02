/*
  Canonical bank allocations are authoritative settlement evidence.  A bank
  statement correction may increase an allocated line (leaving more to
  reconcile), but it must not reduce the line below its persisted allocations.
  Allocation amounts themselves are changed only through their canonical
  unlink/relink workflow.
*/

CREATE OR REPLACE FUNCTION public.prevent_bank_line_amount_below_allocations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line_total numeric;
  v_allocated_total numeric;
BEGIN
  v_line_total := COALESCE(NULLIF(NEW.debit_amount, 0), NEW.credit_amount, 0);

  SELECT COALESCE(sum(allocation_amount), 0)
    INTO v_allocated_total
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = NEW.id;

  IF v_allocated_total > v_line_total + 0.01 THEN
    RAISE EXCEPTION 'Bank statement amount cannot be less than its allocated amount'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_bank_line_amount_below_allocations
  ON public.bank_statement_lines;
CREATE TRIGGER trg_prevent_bank_line_amount_below_allocations
BEFORE UPDATE OF debit_amount, credit_amount ON public.bank_statement_lines
FOR EACH ROW EXECUTE FUNCTION public.prevent_bank_line_amount_below_allocations();
