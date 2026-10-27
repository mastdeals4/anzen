-- Finance V1 release hardening:
-- 1. Payment-state updates must not rewrite historical journal currency data.
-- 2. Bank statement link/unlink operations must recalculate expense paid state.

BEGIN;

DROP TRIGGER IF EXISTS trigger_sync_expense_journal_currency
  ON public.finance_expenses;

CREATE TRIGGER trigger_sync_expense_journal_currency
  AFTER INSERT OR UPDATE OF
    approval_status,
    amount,
    expense_category,
    expense_date,
    description,
    supplier_id,
    fixed_asset_account_id,
    ppn_amount,
    pph_amount,
    pib_bm_amount,
    pib_ppn_amount,
    pib_pph_amount,
    stamp_duty_amount,
    bank_charges_amount,
    broker_items,
    currency_code,
    transaction_currency,
    functional_currency,
    exchange_rate,
    bank_account_currency
  ON public.finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_expense_journal_currency_and_state();

CREATE OR REPLACE FUNCTION public.bsl_recalc_expense_paid_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.matched_expense_id IS NOT NULL THEN
      PERFORM public.recalculate_expense_payment_state(OLD.matched_expense_id);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.matched_expense_id IS NOT NULL THEN
      PERFORM public.recalculate_expense_payment_state(NEW.matched_expense_id);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.matched_expense_id IS DISTINCT FROM OLD.matched_expense_id THEN
    IF OLD.matched_expense_id IS NOT NULL THEN
      PERFORM public.recalculate_expense_payment_state(OLD.matched_expense_id);
    END IF;
    IF NEW.matched_expense_id IS NOT NULL THEN
      PERFORM public.recalculate_expense_payment_state(NEW.matched_expense_id);
    END IF;
  ELSIF NEW.matched_expense_id IS NOT NULL
    AND (
      NEW.payment_kind IS DISTINCT FROM OLD.payment_kind
      OR NEW.debit_amount IS DISTINCT FROM OLD.debit_amount
      OR NEW.credit_amount IS DISTINCT FROM OLD.credit_amount
    ) THEN
    PERFORM public.recalculate_expense_payment_state(NEW.matched_expense_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bsl_recalc_expense_paid_state
  ON public.bank_statement_lines;

CREATE TRIGGER trg_bsl_recalc_expense_paid_state
  AFTER INSERT OR UPDATE OF
    matched_expense_id,
    payment_kind,
    debit_amount,
    credit_amount
    OR DELETE
  ON public.bank_statement_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.bsl_recalc_expense_paid_state();

REVOKE ALL ON FUNCTION public.bsl_recalc_expense_paid_state()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bsl_recalc_expense_paid_state()
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
