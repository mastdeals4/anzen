-- Migration to fix validate_expense_bank_allocation_against_journal for multi-bank and partial expense allocations
CREATE OR REPLACE FUNCTION public.validate_expense_bank_allocation_against_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payable numeric;
  v_document_bank_allocated numeric;
BEGIN
  IF NEW.document_type <> 'expense' OR NEW.payment_kind <> 'supplier' THEN
    RETURN NEW;
  END IF;

  v_payable := COALESCE(public.calculate_finance_expense_payable(NEW.document_id), 0);

  SELECT COALESCE(sum(a.allocation_amount), 0) + NEW.allocation_amount
    INTO v_document_bank_allocated
    FROM public.bank_statement_allocations a
   WHERE a.document_type = 'expense'
     AND a.document_id = NEW.document_id
     AND a.payment_kind = 'supplier'
     AND (TG_OP <> 'UPDATE' OR a.id <> NEW.id);

  IF v_payable > 0 AND v_payable + 0.01 < v_document_bank_allocated THEN
    RAISE EXCEPTION
      'Edited expense no longer supports its existing bank allocation. Select a matching bank transaction or unlink first.';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
