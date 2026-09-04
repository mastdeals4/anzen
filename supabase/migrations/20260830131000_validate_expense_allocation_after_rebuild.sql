/*
 * Validate a linked expense after the canonical edit RPC has rebuilt its
 * journal/allocation. Running this guard on the allocation write (rather than
 * the preceding expense-row update) preserves atomic bank-account changes.
 */

BEGIN;

DROP TRIGGER IF EXISTS zz_validate_expense_bank_allocations_after_edit
  ON public.finance_expenses;
DROP FUNCTION IF EXISTS public.validate_expense_bank_allocations_after_edit();

CREATE OR REPLACE FUNCTION public.validate_expense_bank_allocation_against_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bank_coa uuid;
  v_bank_account_id uuid;
  v_statement_is_debit boolean;
  v_journal_bank_amount numeric;
  v_document_bank_allocated numeric;
BEGIN
  IF NEW.document_type <> 'expense' OR NEW.payment_kind <> 'supplier' THEN
    RETURN NEW;
  END IF;

  SELECT b.bank_account_id, COALESCE(b.debit_amount, 0) > 0
    INTO v_bank_account_id, v_statement_is_debit
    FROM public.bank_statement_lines b
   WHERE b.id = NEW.bank_statement_line_id;
  SELECT coa_id INTO v_bank_coa
    FROM public.bank_accounts WHERE id = v_bank_account_id;
  SELECT COALESCE(sum(
           CASE WHEN v_statement_is_debit
             THEN COALESCE(l.transaction_credit, l.credit)
             ELSE COALESCE(l.transaction_debit, l.debit)
           END
         ), 0)
    INTO v_journal_bank_amount
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = NEW.journal_entry_id
     AND l.account_id = v_bank_coa;
  SELECT COALESCE(sum(a.allocation_amount), 0) + NEW.allocation_amount
    INTO v_document_bank_allocated
    FROM public.bank_statement_allocations a
    JOIN public.bank_statement_lines b ON b.id = a.bank_statement_line_id
   WHERE a.document_type = 'expense'
     AND a.document_id = NEW.document_id
     AND a.payment_kind = 'supplier'
     AND b.bank_account_id = v_bank_account_id
     AND (TG_OP <> 'UPDATE' OR a.id <> NEW.id);
  IF v_journal_bank_amount + 0.01 < v_document_bank_allocated THEN
    RAISE EXCEPTION
      'Edited expense no longer supports its existing bank allocation. Select a matching bank transaction or unlink first.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_validate_expense_bank_allocation_against_journal
  ON public.bank_statement_allocations;
CREATE TRIGGER zz_validate_expense_bank_allocation_against_journal
BEFORE INSERT OR UPDATE OF bank_statement_line_id, document_type, document_id,
  journal_entry_id, allocation_amount, payment_kind
ON public.bank_statement_allocations
FOR EACH ROW EXECUTE FUNCTION public.validate_expense_bank_allocation_against_journal();

REVOKE ALL ON FUNCTION public.validate_expense_bank_allocation_against_journal()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_expense_bank_allocation_against_journal()
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
