-- Description: Allow safe salary expense amount edits for approved and unapproved expenses with applied advances
-- Preserves accounting controls: prevents staff reassignment, category modification, and reducing gross below committed advances and bank payouts.

BEGIN;

CREATE OR REPLACE FUNCTION public.prevent_unsafe_settled_salary_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_advance_applied numeric := 0;
  v_bank_allocated numeric := 0;
  v_direct_bank numeric := 0;
  v_voucher_paid numeric := 0;
  v_non_advance_paid numeric := 0;
  v_committed_total numeric := 0;
BEGIN
  -- Only applies to salary expenses that have applied salary advances
  IF OLD.expense_category = 'salary'
     AND EXISTS (
       SELECT 1
       FROM public.salary_advance_applications sa
       WHERE sa.salary_expense_id = OLD.id
     ) THEN

    -- 1. Staff change is NEVER allowed while advances are applied
    IF OLD.staff_id IS DISTINCT FROM NEW.staff_id THEN
      RAISE EXCEPTION 'Salary % has applied advance settlements for the assigned staff member and cannot be reassigned to a different employee. Reverse or remove the advance application first.',
        COALESCE(OLD.voucher_number, OLD.id::text)
        USING ERRCODE = 'check_violation';
    END IF;

    -- 2. Expense category change is NEVER allowed while advances are applied
    IF NEW.expense_category <> 'salary' THEN
      RAISE EXCEPTION 'Salary % has applied advance settlements and cannot have its category changed. Reverse or remove the advance application first.',
        COALESCE(OLD.voucher_number, OLD.id::text)
        USING ERRCODE = 'check_violation';
    END IF;

    -- Calculate total advance applied to this salary
    SELECT COALESCE(sum(sa.applied_amount), 0)
      INTO v_advance_applied
      FROM public.salary_advance_applications sa
     WHERE sa.salary_expense_id = OLD.id;

    -- Calculate non-advance payments already committed/disbursed
    SELECT COALESCE(sum(va.allocated_amount), 0)
      INTO v_voucher_paid
      FROM public.voucher_allocations va
      JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
     WHERE va.finance_expense_id = OLD.id
       AND COALESCE(va.payment_kind, 'supplier') = 'supplier'
       AND COALESCE(pv.payment_purpose, 'general') NOT IN ('salary_advance', 'salary_advance_settlement')
       AND pv.is_posted = true;

    SELECT COALESCE(sum(bsa.allocation_amount), 0)
      INTO v_bank_allocated
      FROM public.bank_statement_allocations bsa
     WHERE bsa.document_type = 'expense'
       AND bsa.document_id = OLD.id
       AND COALESCE(bsa.payment_kind, 'supplier') = 'supplier';

    SELECT COALESCE(sum(COALESCE(NULLIF(bsl.debit_amount, 0), bsl.credit_amount, 0)), 0)
      INTO v_direct_bank
      FROM public.bank_statement_lines bsl
     WHERE bsl.matched_expense_id = OLD.id
       AND bsl.payment_kind = 'supplier'
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id = bsl.id
       );

    v_non_advance_paid := v_voucher_paid + v_bank_allocated + v_direct_bank;
    v_committed_total := v_advance_applied + v_non_advance_paid + COALESCE(NEW.pph_amount, 0);

    -- 3. Gross amount cannot be reduced below the committed total (applied advances + actual disbursements + tax)
    IF NEW.amount < v_committed_total - 0.01 THEN
      RAISE EXCEPTION 'Cannot reduce salary % gross amount to %: % is already committed (% applied advances, % bank/payment disbursements, % withholding tax). Adjust or reverse the advance settlement or unlink bank transactions before reducing below the committed amount.',
        COALESCE(OLD.voucher_number, OLD.id::text),
        to_char(NEW.amount, 'FM999,999,999,999.00'),
        to_char(v_committed_total, 'FM999,999,999,999.00'),
        to_char(v_advance_applied, 'FM999,999,999,999.00'),
        to_char(v_non_advance_paid, 'FM999,999,999,999.00'),
        to_char(COALESCE(NEW.pph_amount, 0), 'FM999,999,999,999.00')
        USING ERRCODE = 'check_violation';
    END IF;

    -- 4. If bank account is being changed while active bank statement allocations exist:
    IF (OLD.bank_account_id IS DISTINCT FROM NEW.bank_account_id)
       AND (v_bank_allocated > 0 OR v_direct_bank > 0) THEN
      RAISE EXCEPTION 'Salary % has % in reconciled/linked bank statement allocations. Unlink the bank statement line before changing the bank account.',
        COALESCE(OLD.voucher_number, OLD.id::text),
        to_char(v_bank_allocated + v_direct_bank, 'FM999,999,999,999.00')
        USING ERRCODE = 'check_violation';
    END IF;

  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_supplier_paid numeric := 0;
  v_pph_paid numeric := 0;
  v_payable numeric := 0;
  v_target_paid numeric;
  v_target_pph_paid numeric;
BEGIN
  IF public.historical_repair_context_active() THEN RETURN; END IF;

  SELECT COALESCE(sum(va.allocated_amount),0) INTO v_supplier_paid
    FROM public.voucher_allocations va
    LEFT JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id
     AND COALESCE(va.payment_kind,'supplier')='supplier'
     AND COALESCE(pv.payment_purpose,'general') NOT IN ('salary_advance','salary_advance_settlement');

  SELECT v_supplier_paid+COALESCE(sum(allocation_amount),0) INTO v_supplier_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id
     AND COALESCE(payment_kind,'supplier')='supplier';

  SELECT v_supplier_paid+COALESCE(sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)),0) INTO v_supplier_paid
    FROM public.bank_statement_lines b
   WHERE b.matched_expense_id=p_expense_id AND b.payment_kind='supplier'
     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id);

  -- Include posted salary advance applications (advance recovery)
  SELECT v_supplier_paid+COALESCE(sum(sa.applied_amount),0) INTO v_supplier_paid
    FROM public.salary_advance_applications sa
    JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
   WHERE sa.salary_expense_id = p_expense_id AND settlement.is_posted = true;

  SELECT COALESCE(sum(allocated_amount),0) INTO v_pph_paid
    FROM public.voucher_allocations va
    LEFT JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id AND va.payment_kind='pph23'
     AND (va.payment_voucher_id IS NULL OR pv.is_posted = true);

  SELECT v_pph_paid+COALESCE(sum(allocation_amount),0) INTO v_pph_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='pph23';

  v_payable := COALESCE(public.calculate_finance_expense_payable(p_expense_id),0);
  v_target_paid := LEAST(GREATEST(v_supplier_paid,0),GREATEST(v_payable,0));
  v_target_pph_paid := GREATEST(v_pph_paid,0);

  UPDATE public.finance_expenses
     SET paid_amount=v_target_paid,
         pph_paid_amount=v_target_pph_paid
   WHERE id=p_expense_id
     AND (paid_amount IS DISTINCT FROM v_target_paid OR pph_paid_amount IS DISTINCT FROM v_target_pph_paid);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_salary_advance_application_recalc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recalculate_expense_payment_state(OLD.salary_expense_id);
    RETURN OLD;
  ELSE
    PERFORM public.recalculate_expense_payment_state(NEW.salary_expense_id);
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_salary_advance_application_recalc ON public.salary_advance_applications;
CREATE TRIGGER trg_salary_advance_application_recalc
  AFTER INSERT OR UPDATE OR DELETE ON public.salary_advance_applications
  FOR EACH ROW EXECUTE FUNCTION public.trg_salary_advance_application_recalc();

REVOKE ALL ON FUNCTION public.prevent_unsafe_settled_salary_edit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_unsafe_settled_salary_edit() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.recalculate_expense_payment_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalculate_expense_payment_state(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.trg_salary_advance_application_recalc() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_salary_advance_application_recalc() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
