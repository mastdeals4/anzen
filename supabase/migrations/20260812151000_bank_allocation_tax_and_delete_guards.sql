-- Integration guards for the allocation layer. Reuse existing expense payment
-- and PPh period engines; do not duplicate tax calculations.

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_expense_from_bank_allocation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_old_expense uuid; v_new_expense uuid; v_old_date date; v_new_date date; v_fallback date;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.document_type='expense' THEN
    v_old_expense:=OLD.document_id;
    SELECT transaction_date INTO v_old_date FROM public.bank_statement_lines WHERE id=OLD.bank_statement_line_id;
    PERFORM public.recalculate_expense_payment_state(v_old_expense);
    IF EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=v_old_expense AND (COALESCE(pph_amount,0)>0 OR COALESCE(pib_pph_amount,0)>0 OR expense_category='pph_import')) THEN
      PERFORM public.recompute_pph_periods_for_date(v_old_date);
      PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(v_old_expense));
      SELECT COALESCE(due_date,expense_date) INTO v_fallback FROM public.finance_expenses WHERE id=v_old_expense;
      PERFORM public.recompute_pph_periods_for_date(v_fallback);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.document_type='expense' THEN
    v_new_expense:=NEW.document_id;
    SELECT transaction_date INTO v_new_date FROM public.bank_statement_lines WHERE id=NEW.bank_statement_line_id;
    PERFORM public.recalculate_expense_payment_state(v_new_expense);
    IF EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=v_new_expense AND (COALESCE(pph_amount,0)>0 OR COALESCE(pib_pph_amount,0)>0 OR expense_category='pph_import')) THEN
      PERFORM public.recompute_pph_periods_for_date(v_new_date);
      PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(v_new_expense));
      SELECT COALESCE(due_date,expense_date) INTO v_fallback FROM public.finance_expenses WHERE id=v_new_expense;
      PERFORM public.recompute_pph_periods_for_date(v_fallback);
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE TRIGGER trg_sync_expense_from_bank_allocation
AFTER INSERT OR UPDATE OR DELETE ON public.bank_statement_allocations
FOR EACH ROW EXECUTE FUNCTION public.sync_expense_from_bank_allocation();

CREATE OR REPLACE FUNCTION public.prevent_deleting_allocated_finance_document()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.bank_statement_allocations WHERE document_type=TG_ARGV[0] AND document_id=OLD.id) THEN
    RAISE EXCEPTION 'Document has bank reconciliation allocations. Unlink them before deleting the document.';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER prevent_delete_allocated_expense BEFORE DELETE ON public.finance_expenses
FOR EACH ROW EXECUTE FUNCTION public.prevent_deleting_allocated_finance_document('expense');
CREATE TRIGGER prevent_delete_allocated_receipt BEFORE DELETE ON public.receipt_vouchers
FOR EACH ROW EXECUTE FUNCTION public.prevent_deleting_allocated_finance_document('receipt');
CREATE TRIGGER prevent_delete_allocated_payment BEFORE DELETE ON public.payment_vouchers
FOR EACH ROW EXECUTE FUNCTION public.prevent_deleting_allocated_finance_document('payment');
CREATE TRIGGER prevent_delete_allocated_petty_cash BEFORE DELETE ON public.petty_cash_transactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_deleting_allocated_finance_document('petty_cash');
CREATE TRIGGER prevent_delete_allocated_tax_payment BEFORE DELETE ON public.tax_payments
FOR EACH ROW EXECUTE FUNCTION public.prevent_deleting_allocated_finance_document('tax_payment');

REVOKE ALL ON FUNCTION public.sync_expense_from_bank_allocation(),
  public.prevent_deleting_allocated_finance_document() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_expense_from_bank_allocation(),
  public.prevent_deleting_allocated_finance_document() TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
