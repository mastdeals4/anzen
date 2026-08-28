-- Salary Advance workflow on the existing Payment Voucher + Expense engines.
-- The application table is relationship metadata only. Salary Advance cash
-- still uses the normal Payment Voucher posting path, and salary recovery uses
-- the existing advance_adjustment posting path.

ALTER TABLE public.payment_vouchers
  ADD COLUMN IF NOT EXISTS payment_purpose text NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS salary_advance_applied_amount numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS salary_advance_status text NOT NULL DEFAULT 'not_applicable';

ALTER TABLE public.payment_vouchers
  DROP CONSTRAINT IF EXISTS payment_vouchers_payment_purpose_check;
ALTER TABLE public.payment_vouchers
  ADD CONSTRAINT payment_vouchers_payment_purpose_check
  CHECK (payment_purpose IN ('general', 'salary_advance', 'salary_advance_settlement'));

ALTER TABLE public.payment_vouchers
  DROP CONSTRAINT IF EXISTS payment_vouchers_salary_advance_status_check;
ALTER TABLE public.payment_vouchers
  ADD CONSTRAINT payment_vouchers_salary_advance_status_check
  CHECK (salary_advance_status IN ('not_applicable', 'outstanding', 'partially_settled', 'settled'));

COMMENT ON COLUMN public.payment_vouchers.payment_purpose IS
  'Business purpose of the payment. salary_advance is a staff advance; settlement uses the existing advance_adjustment posting path.';

CREATE TABLE IF NOT EXISTS public.salary_advance_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_payment_voucher_id uuid NOT NULL REFERENCES public.payment_vouchers(id) ON DELETE RESTRICT,
  salary_expense_id uuid NOT NULL REFERENCES public.finance_expenses(id) ON DELETE RESTRICT,
  settlement_payment_voucher_id uuid NOT NULL REFERENCES public.payment_vouchers(id) ON DELETE RESTRICT,
  applied_amount numeric(18,2) NOT NULL CHECK (applied_amount > 0),
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advance_payment_voucher_id, salary_expense_id)
);

CREATE INDEX IF NOT EXISTS idx_salary_advance_applications_expense
  ON public.salary_advance_applications(salary_expense_id);
CREATE INDEX IF NOT EXISTS idx_salary_advance_applications_advance
  ON public.salary_advance_applications(advance_payment_voucher_id);

ALTER TABLE public.salary_advance_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS salary_advance_applications_read ON public.salary_advance_applications;
CREATE POLICY salary_advance_applications_read
  ON public.salary_advance_applications FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.role IN ('admin', 'accounts', 'auditor_ca')
  ));

-- Keep the status fields derived from the application rows. This does not
-- touch journals, bank rows, or payment amounts.
CREATE OR REPLACE FUNCTION public.refresh_salary_advance_status(p_advance_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_amount numeric;
  v_applied numeric;
BEGIN
  SELECT amount INTO v_amount
  FROM public.payment_vouchers
  WHERE id = p_advance_id AND payment_purpose = 'salary_advance';
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(sum(applied_amount), 0) INTO v_applied
  FROM public.salary_advance_applications
  WHERE advance_payment_voucher_id = p_advance_id;

  UPDATE public.payment_vouchers
  SET salary_advance_applied_amount = v_applied,
      salary_advance_status = CASE
        WHEN v_applied >= v_amount THEN 'settled'
        WHEN v_applied > 0 THEN 'partially_settled'
        ELSE 'outstanding'
      END
  WHERE id = p_advance_id;
END;
$$;

-- Staff advances are consumed oldest first and expose the remaining balance
-- without requiring the UI to duplicate accounting calculations.
CREATE OR REPLACE FUNCTION public.get_outstanding_salary_advances(
  p_staff_id uuid,
  p_as_of_date date DEFAULT current_date
)
RETURNS TABLE (
  advance_id uuid,
  voucher_number text,
  voucher_date date,
  staff_id uuid,
  staff_name text,
  amount numeric,
  applied_amount numeric,
  available_amount numeric,
  status text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  RETURN QUERY
  SELECT pv.id,
    pv.voucher_number,
    pv.voucher_date,
    pv.staff_id,
    sm.full_name::text,
    pv.amount,
    COALESCE(sum(sa.applied_amount), 0),
    greatest(pv.amount - COALESCE(sum(sa.applied_amount), 0), 0),
    CASE
      WHEN COALESCE(sum(sa.applied_amount), 0) >= pv.amount THEN 'settled'
      WHEN COALESCE(sum(sa.applied_amount), 0) > 0 THEN 'partially_settled'
      ELSE 'outstanding'
    END
  FROM public.payment_vouchers pv
  JOIN public.finance_staff_master sm ON sm.id = pv.staff_id
  LEFT JOIN public.salary_advance_applications sa ON sa.advance_payment_voucher_id = pv.id
  WHERE pv.payment_purpose = 'salary_advance'
    AND pv.is_posted = true
    AND pv.staff_id = p_staff_id
    AND pv.voucher_date <= p_as_of_date
  GROUP BY pv.id, pv.voucher_number, pv.voucher_date, pv.staff_id, sm.full_name, pv.amount
  HAVING pv.amount > COALESCE(sum(sa.applied_amount), 0)
  ORDER BY pv.voucher_date, pv.created_at, pv.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_salary_advance_applications(p_salary_expense_id uuid)
RETURNS TABLE (
  application_id uuid,
  advance_payment_voucher_id uuid,
  advance_voucher_number text,
  salary_expense_id uuid,
  salary_voucher_number text,
  settlement_payment_voucher_id uuid,
  settlement_voucher_number text,
  applied_amount numeric,
  applied_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT sa.id, sa.advance_payment_voucher_id, advance.voucher_number,
    sa.salary_expense_id, salary.voucher_number,
    sa.settlement_payment_voucher_id, settlement.voucher_number,
    sa.applied_amount, sa.applied_at
  FROM public.salary_advance_applications sa
  JOIN public.payment_vouchers advance ON advance.id = sa.advance_payment_voucher_id
  JOIN public.finance_expenses salary ON salary.id = sa.salary_expense_id
  JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
  WHERE sa.salary_expense_id = p_salary_expense_id
  ORDER BY sa.applied_at, sa.id;
END;
$$;

-- Apply FIFO advances through one existing advance_adjustment Payment Voucher.
-- Repeated calls are safe: an advance/salary pair has one application and the
-- remaining salary capacity is calculated from existing applications.
CREATE OR REPLACE FUNCTION public.apply_salary_advances_to_expense(
  p_salary_expense_id uuid,
  p_apply boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_salary public.finance_expenses%ROWTYPE;
  v_staff_name text;
  v_remaining numeric;
  v_total numeric := 0;
  v_settlement jsonb;
  v_settlement_id uuid;
  v_advance record;
  v_advance_applied numeric;
  v_available numeric;
  v_to_apply numeric;
  v_currency text;
  v_application_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM public._sec_check_finance_role();

  SELECT * INTO v_salary
  FROM public.finance_expenses
  WHERE id = p_salary_expense_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Salary expense not found'; END IF;
  IF v_salary.expense_category <> 'salary' OR v_salary.staff_id IS NULL THEN
    RAISE EXCEPTION 'Salary advances require a Salary expense with a selected staff member';
  END IF;

  SELECT full_name INTO v_staff_name
  FROM public.finance_staff_master WHERE id = v_salary.staff_id;
  SELECT upper(COALESCE(v_salary.transaction_currency, v_salary.currency_code, 'IDR')) INTO v_currency;

  SELECT greatest(v_salary.amount - COALESCE(sum(applied_amount), 0), 0)
  INTO v_remaining
  FROM public.salary_advance_applications
  WHERE salary_expense_id = p_salary_expense_id;
  v_remaining := COALESCE(v_remaining, v_salary.amount);

  IF NOT p_apply OR v_remaining <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'total_applied', 0, 'remaining_salary', v_remaining);
  END IF;

  FOR v_advance IN
    SELECT pv.id, pv.voucher_number, pv.voucher_date, pv.amount
    FROM public.payment_vouchers pv
    WHERE pv.payment_purpose = 'salary_advance'
      AND pv.is_posted = true
      AND pv.staff_id = v_salary.staff_id
      AND NOT EXISTS (
        SELECT 1 FROM public.salary_advance_applications existing
        WHERE existing.advance_payment_voucher_id = pv.id
          AND existing.salary_expense_id = p_salary_expense_id
      )
    ORDER BY pv.voucher_date, pv.created_at, pv.id
    FOR UPDATE OF pv
  LOOP
    SELECT COALESCE(sum(applied_amount), 0) INTO v_advance_applied
    FROM public.salary_advance_applications
    WHERE advance_payment_voucher_id = v_advance.id;
    v_available := greatest(v_advance.amount - v_advance_applied, 0);
    v_to_apply := least(v_available, v_remaining - v_total);
    IF v_to_apply > 0 THEN
      v_total := v_total + v_to_apply;
      v_application_ids := array_append(v_application_ids, v_advance.id);
    END IF;
    EXIT WHEN v_total >= v_remaining;
  END LOOP;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'total_applied', 0, 'remaining_salary', v_remaining);
  END IF;

  -- The normal Payment Voucher command creates the allocation; the existing
  -- posting function creates the adjustment journal. No duplicate salary or
  -- cash payment is created.
  v_settlement := public.save_payment_voucher_command(
    p_voucher_id => NULL,
    p_payload => jsonb_build_object(
      'voucher_date', v_salary.expense_date,
      'staff_id', v_salary.staff_id,
      'payment_method', 'advance_adjustment',
      'amount', v_total,
      'payment_currency', v_currency,
      'exchange_rate', CASE WHEN v_currency = 'IDR' THEN 1 ELSE COALESCE(v_salary.exchange_rate, 1) END,
      'description', 'Salary Advance Recovery - ' || COALESCE(v_salary.voucher_number, v_salary.id::text),
      'created_by', auth.uid()
    ),
    p_allocations => jsonb_build_array(jsonb_build_object(
      'finance_expense_id', v_salary.id,
      'amount', v_total,
      'currency', v_currency
    ))
  );
  v_settlement_id := (v_settlement->>'id')::uuid;

  UPDATE public.payment_vouchers
  SET payment_purpose = 'salary_advance_settlement'
  WHERE id = v_settlement_id;

  PERFORM public.post_payment_voucher(v_settlement_id, auth.uid());

  -- Re-walk the same FIFO order and persist the exact split for the audit
  -- links. The locks held above prevent concurrent salary applications from
  -- consuming the same balance.
  v_remaining := v_total;
  FOR v_advance IN
    SELECT pv.id, pv.amount
    FROM public.payment_vouchers pv
    WHERE pv.id = ANY(v_application_ids)
    ORDER BY pv.voucher_date, pv.created_at, pv.id
  LOOP
    SELECT COALESCE(sum(applied_amount), 0) INTO v_advance_applied
    FROM public.salary_advance_applications
    WHERE advance_payment_voucher_id = v_advance.id;
    v_available := greatest(v_advance.amount - v_advance_applied, 0);
    v_to_apply := least(v_available, v_remaining);
    IF v_to_apply > 0 THEN
      INSERT INTO public.salary_advance_applications(
        advance_payment_voucher_id, salary_expense_id,
        settlement_payment_voucher_id, applied_amount
      ) VALUES (v_advance.id, v_salary.id, v_settlement_id, v_to_apply);
      PERFORM public.refresh_salary_advance_status(v_advance.id);
      v_remaining := v_remaining - v_to_apply;
    END IF;
    EXIT WHEN v_remaining <= 0;
  END LOOP;

  RETURN jsonb_build_object(
    'applied', true,
    'total_applied', v_total,
    'remaining_salary', greatest(v_salary.amount - v_total, 0),
    'settlement_payment_voucher_id', v_settlement_id,
    'settlement_payment_voucher_number', v_settlement->>'voucher_number'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_salary_advance_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_outstanding_salary_advances(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_salary_advance_applications(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_salary_advances_to_expense(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_salary_advance_status(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_outstanding_salary_advances(uuid, date),
  public.get_salary_advance_applications(uuid),
  public.apply_salary_advances_to_expense(uuid, boolean) TO authenticated, service_role;

-- Validate purpose at the same document boundary used by the existing payment
-- module. Existing payment methods and posting logic remain untouched.
CREATE OR REPLACE FUNCTION public.validate_salary_advance_payment_purpose()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.payment_purpose = 'salary_advance' THEN
    IF NEW.staff_id IS NULL OR NEW.supplier_id IS NOT NULL THEN
      RAISE EXCEPTION 'Salary Advance payments require a staff payee';
    END IF;
    IF NEW.payment_method = 'advance_adjustment' THEN
      RAISE EXCEPTION 'Salary Advance cash payments cannot use advance_adjustment';
    END IF;
  ELSIF NEW.payment_purpose = 'salary_advance_settlement'
    AND NEW.payment_method <> 'advance_adjustment' THEN
    RAISE EXCEPTION 'Salary Advance settlement must use advance_adjustment';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_salary_advance_payment_purpose ON public.payment_vouchers;
CREATE TRIGGER trg_validate_salary_advance_payment_purpose
  BEFORE INSERT OR UPDATE OF payment_purpose, staff_id, supplier_id, payment_method
  ON public.payment_vouchers
  FOR EACH ROW EXECUTE FUNCTION public.validate_salary_advance_payment_purpose();

-- The shared Payment Voucher command remains the writer. This small wrapper
-- carries the new purpose through after its normal save/allocation operation;
-- it does not duplicate payment validation or accounting logic.
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_purpose(
  p_voucher_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_payment_purpose text DEFAULT 'general'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_result jsonb;
  v_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  IF p_payment_purpose NOT IN ('general', 'salary_advance', 'salary_advance_settlement') THEN
    RAISE EXCEPTION 'Unsupported payment purpose %', p_payment_purpose;
  END IF;
  v_result := public.save_payment_voucher_command(p_voucher_id, p_payload, p_allocations);
  v_id := (v_result->>'id')::uuid;
  UPDATE public.payment_vouchers SET payment_purpose = p_payment_purpose WHERE id = v_id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_salary_advance_payment_purpose() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_payment_voucher_with_purpose(uuid,jsonb,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_salary_advance_payment_purpose() TO service_role;
GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_purpose(uuid,jsonb,jsonb,text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
