-- ============================================================================
-- Fix Imron Salary Payment Display & Canonical Advance Recovery Linkage
-- ============================================================================
-- 1. Hardens prevent_expense_payment_overallocation() to bypass non-cash
--    advance settlements (payment_purpose IN ('salary_advance', 'salary_advance_settlement')),
--    which are tracked via salary_advance_applications and do not consume cash payable.
-- 2. Relinks voucher_allocations for PV/26-26/022 to June EXP/26-26/087,
--    matching its canonical salary_advance_applications record.
-- 3. Updates PV/26-26/022 description to reference EXP/26-26/087.
-- 4. Recomputes payment state for EXP/26/287 and EXP/26-26/087.
-- ============================================================================

-- 1. Update prevent_expense_payment_overallocation()
CREATE OR REPLACE FUNCTION public.prevent_expense_payment_overallocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_exp RECORD;
  v_payable numeric := 0;
  v_settled_va numeric := 0;
  v_settled_bsa numeric := 0;
  v_settled_bsl numeric := 0;
  v_total_settled numeric := 0;
  v_remaining numeric := 0;
  v_kind text;
  v_purpose text;
BEGIN
  IF NEW.finance_expense_id IS NULL OR NEW.voucher_type <> 'payment' THEN
    RETURN NEW;
  END IF;

  -- Salary advance settlements are non-cash adjustments tracked via salary_advance_applications
  -- and do not consume standard cash payable limits.
  SELECT payment_purpose INTO v_purpose
    FROM public.payment_vouchers
   WHERE id = NEW.payment_voucher_id;

  IF v_purpose IN ('salary_advance', 'salary_advance_settlement') THEN
    RETURN NEW;
  END IF;

  v_kind := COALESCE(NEW.payment_kind, 'supplier');

  -- Lock the finance_expense row inside the same transaction
  SELECT * INTO v_exp 
    FROM public.finance_expenses 
   WHERE id = NEW.finance_expense_id 
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced finance_expense % does not exist', NEW.finance_expense_id;
  END IF;

  -- Determine total payable for this payment kind
  IF v_kind = 'pph23' THEN
    v_payable := COALESCE(v_exp.pph_amount, 0);
  ELSE
    v_payable := COALESCE(public.calculate_finance_expense_payable(v_exp.id), 0);
  END IF;

  -- Existing posted settlements from voucher_allocations (excluding current row on update)
  SELECT COALESCE(SUM(va.allocated_amount), 0) INTO v_settled_va
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
   WHERE va.finance_expense_id = v_exp.id
     AND COALESCE(va.payment_kind, 'supplier') = v_kind
     AND COALESCE(pv.payment_purpose, 'general') NOT IN ('salary_advance', 'salary_advance_settlement')
     AND (TG_OP <> 'UPDATE' OR va.id <> NEW.id);

  -- Existing posted settlements from bank_statement_allocations
  SELECT COALESCE(SUM(bsa.allocation_amount), 0) INTO v_settled_bsa
    FROM public.bank_statement_allocations bsa
   WHERE bsa.document_type = 'expense'
     AND bsa.document_id = v_exp.id
     AND COALESCE(bsa.payment_kind, 'supplier') = v_kind;

  -- Existing legacy settlements from bank_statement_lines without allocations
  SELECT COALESCE(SUM(COALESCE(NULLIF(bsl.debit_amount, 0), bsl.credit_amount, 0)), 0) INTO v_settled_bsl
    FROM public.bank_statement_lines bsl
   WHERE bsl.matched_expense_id = v_exp.id
     AND COALESCE(bsl.payment_kind, 'supplier') = v_kind
     AND NOT EXISTS (
       SELECT 1 FROM public.bank_statement_allocations a 
        WHERE a.bank_statement_line_id = bsl.id
     );

  v_total_settled := v_settled_va + v_settled_bsa + v_settled_bsl;
  v_remaining := round(v_payable - v_total_settled, 2);

  IF NEW.allocated_amount > (v_remaining + 0.01) THEN
    RAISE EXCEPTION 'Expense payment allocation (%) exceeds remaining payable (%) for expense % (Total Payable: %, Already Settled: %)',
      NEW.allocated_amount, v_remaining, COALESCE(v_exp.voucher_number, v_exp.id::text), v_payable, v_total_settled;
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. Relink voucher_allocations for PV/26-26/022 to June expense EXP/26-26/087
UPDATE public.voucher_allocations
   SET finance_expense_id = 'c5c17015-dbec-4b42-8cdf-9c20ef752a9b'::uuid
 WHERE payment_voucher_id = (SELECT id FROM public.payment_vouchers WHERE voucher_number = 'PV/26-26/022');

-- 3. Update PV/26-26/022 description to accurately reference June expense EXP/26-26/087
UPDATE public.payment_vouchers
   SET description = 'Salary Advance Recovery - EXP/26-26/087'
 WHERE voucher_number = 'PV/26-26/022';

-- 4. Recalculate payment states for EXP/26/287 (September) and EXP/26-26/087 (June)
DO $$
BEGIN
  PERFORM public.recalculate_expense_payment_state('bb736f95-c026-42d5-9dc3-36c7768fd7f5'::uuid);
  PERFORM public.recalculate_expense_payment_state('c5c17015-dbec-4b42-8cdf-9c20ef752a9b'::uuid);
END;
$$;
