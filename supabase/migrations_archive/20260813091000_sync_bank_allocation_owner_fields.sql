-- Complete allocation lifecycle synchronization by keeping the legacy typed
-- owner columns aligned with the current allocation rows. These columns remain
-- compatibility metadata; bank_statement_allocations stays authoritative.

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_bank_line_allocation_owner(p_bank_line_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
  v_only public.bank_statement_allocations%ROWTYPE;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_line_id;

  IF v_count = 1 THEN
    SELECT * INTO v_only
      FROM public.bank_statement_allocations
     WHERE bank_statement_line_id = p_bank_line_id;
    UPDATE public.bank_statement_lines SET
      matched_expense_id = CASE WHEN v_only.document_type = 'expense' THEN v_only.document_id END,
      matched_receipt_id = CASE WHEN v_only.document_type = 'receipt' THEN v_only.document_id END,
      matched_payment_id = CASE WHEN v_only.document_type = 'payment' THEN v_only.document_id END,
      matched_fund_transfer_id = CASE WHEN v_only.document_type = 'fund_transfer' THEN v_only.document_id END,
      matched_petty_cash_id = CASE WHEN v_only.document_type = 'petty_cash' THEN v_only.document_id END,
      matched_tax_payment_id = CASE WHEN v_only.document_type = 'tax_payment' THEN v_only.document_id END,
      matched_entry_id = v_only.journal_entry_id,
      payment_kind = v_only.payment_kind
    WHERE id = p_bank_line_id;
  ELSE
    UPDATE public.bank_statement_lines SET
      matched_expense_id = NULL,
      matched_receipt_id = NULL,
      matched_payment_id = NULL,
      matched_fund_transfer_id = NULL,
      matched_petty_cash_id = NULL,
      matched_tax_payment_id = NULL,
      matched_entry_id = NULL
    WHERE id = p_bank_line_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_bank_line_from_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_line uuid;
  v_new_line uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_line := OLD.bank_statement_line_id;
    PERFORM public.sync_bank_line_allocation_owner(v_old_line);
    PERFORM public.refresh_bank_statement_allocation_status(v_old_line);
    IF OLD.document_type = 'expense' AND EXISTS (
      SELECT 1 FROM public.finance_expenses WHERE id = OLD.document_id
    ) THEN
      PERFORM public.recalculate_expense_payment_state(OLD.document_id);
    ELSIF OLD.document_type = 'tax_payment' THEN
      UPDATE public.tax_payments
         SET status = 'posted'
       WHERE id = OLD.document_id
         AND NOT EXISTS (
           SELECT 1 FROM public.bank_statement_allocations
            WHERE document_type = 'tax_payment' AND document_id = OLD.document_id
         );
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_line := NEW.bank_statement_line_id;
    IF v_new_line IS DISTINCT FROM v_old_line THEN
      PERFORM public.sync_bank_line_allocation_owner(v_new_line);
      PERFORM public.refresh_bank_statement_allocation_status(v_new_line);
    END IF;
    IF NEW.document_type = 'expense' AND EXISTS (
      SELECT 1 FROM public.finance_expenses WHERE id = NEW.document_id
    ) THEN
      PERFORM public.recalculate_expense_payment_state(NEW.document_id);
    ELSIF NEW.document_type = 'tax_payment' THEN
      UPDATE public.tax_payments SET status = 'reconciled' WHERE id = NEW.document_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_bank_line_allocation_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_bank_line_allocation_owner(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
