-- Require explicit, reviewed advance voucher IDs before creating a salary settlement.
-- The legacy FIFO function is retained until the new UI is deployed; new code calls this function.
BEGIN;

CREATE OR REPLACE FUNCTION public.apply_selected_salary_advances_to_expense(
  p_salary_expense_id uuid,
  p_advance_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_salary public.finance_expenses%ROWTYPE;
  v_remaining numeric;
  v_total numeric := 0;
  v_settlement jsonb;
  v_settlement_id uuid;
  v_advance record;
  v_advance_applied numeric;
  v_available numeric;
  v_take numeric;
  v_currency text;
  v_selected_ids uuid[] := ARRAY[]::uuid[];
  v_selected_amounts numeric[] := ARRAY[]::numeric[];
  v_selected_count integer := 0;
  v_idx integer;
  v_bpjs numeric := 0;
BEGIN
  PERFORM public._sec_check_finance_role();

  IF p_advance_ids IS NULL OR cardinality(p_advance_ids) = 0 THEN
    RETURN jsonb_build_object('applied', false, 'total_applied', 0, 'reason', 'No advances selected');
  END IF;

  IF cardinality(p_advance_ids) <> (
    SELECT count(DISTINCT selected_id)::integer FROM unnest(p_advance_ids) AS selected_id
  ) THEN
    RAISE EXCEPTION 'Duplicate advance IDs were supplied. Select each advance only once.';
  END IF;

  SELECT * INTO v_salary
    FROM public.finance_expenses
   WHERE id = p_salary_expense_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Salary expense not found';
  END IF;
  IF v_salary.expense_category <> 'salary' OR v_salary.staff_id IS NULL THEN
    RAISE EXCEPTION 'Salary advance settlements require a Salary expense with a selected staff member';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.salary_advance_applications
     WHERE salary_expense_id = p_salary_expense_id
  ) THEN
    RAISE EXCEPTION 'This salary already has advance applications. Reverse or review the existing settlement before applying more advances.';
  END IF;

  v_currency := upper(COALESCE(v_salary.transaction_currency, v_salary.currency_code, 'IDR'));

  -- Use the canonical salary calculation for the maximum deduction, but do NOT
  -- use its auto-derived advance total: only explicitly selected IDs are eligible.
  BEGIN
    v_bpjs := COALESCE(
      (public.calculate_staff_salary(v_salary.staff_id, v_salary.expense_date, v_salary.amount, v_salary.pph_amount)->>'bpjs_amount')::numeric,
      0
    );
  EXCEPTION WHEN OTHERS THEN
    v_bpjs := 0;
  END;

  v_remaining := GREATEST(v_salary.amount - COALESCE(v_salary.pph_amount, 0) - v_bpjs, 0);

  FOR v_advance IN
    SELECT pv.id, pv.voucher_number, pv.voucher_date, pv.amount
      FROM public.payment_vouchers pv
     WHERE pv.id = ANY(p_advance_ids)
       AND pv.payment_purpose = 'salary_advance'
       AND pv.is_posted = true
       AND pv.staff_id = v_salary.staff_id
       AND pv.voucher_date <= v_salary.expense_date
     ORDER BY pv.voucher_date, pv.created_at, pv.id
     FOR UPDATE OF pv
  LOOP
    v_selected_count := v_selected_count + 1;

    IF EXISTS (
      SELECT 1
        FROM public.salary_advance_applications sa
       WHERE sa.advance_payment_voucher_id = v_advance.id
         AND sa.salary_expense_id = p_salary_expense_id
    ) THEN
      RAISE EXCEPTION 'Advance % is already applied to this salary', v_advance.voucher_number;
    END IF;

    SELECT COALESCE(SUM(sa.applied_amount), 0)
      INTO v_advance_applied
      FROM public.salary_advance_applications sa
     WHERE sa.advance_payment_voucher_id = v_advance.id;

    v_available := GREATEST(v_advance.amount - v_advance_applied, 0);
    v_take := LEAST(v_available, GREATEST(v_remaining - v_total, 0));

    IF v_take > 0 THEN
      v_total := v_total + v_take;
      v_selected_ids := array_append(v_selected_ids, v_advance.id);
      v_selected_amounts := array_append(v_selected_amounts, v_take);
    END IF;
  END LOOP;

  IF v_selected_count <> cardinality(p_advance_ids) THEN
    RAISE EXCEPTION 'One or more selected advances are not posted, do not belong to this staff member, or are dated after the salary period. Refresh and select valid advances.';
  END IF;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'total_applied', 0, 'reason', 'Selected advances have no available balance or salary has no payable balance');
  END IF;

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
      'created_by', auth.uid(),
      'document_urls', '[]'::jsonb
    ),
    p_allocations => jsonb_build_array(jsonb_build_object(
      'finance_expense_id', v_salary.id,
      'amount', v_total,
      'currency', v_currency
    )),
    p_payment_purpose => 'salary_advance_settlement'
  );

  v_settlement_id := (v_settlement->>'id')::uuid;
  PERFORM public.post_payment_voucher(v_settlement_id, auth.uid());

  FOR v_idx IN 1..COALESCE(array_length(v_selected_ids, 1), 0) LOOP
    INSERT INTO public.salary_advance_applications(
      advance_payment_voucher_id,
      salary_expense_id,
      settlement_payment_voucher_id,
      applied_amount
    )
    VALUES (
      v_selected_ids[v_idx],
      v_salary.id,
      v_settlement_id,
      v_selected_amounts[v_idx]
    );

    PERFORM public.refresh_salary_advance_status(v_selected_ids[v_idx]);
  END LOOP;

  RETURN jsonb_build_object(
    'applied', true,
    'total_applied', v_total,
    'remaining_salary', GREATEST(v_salary.amount - COALESCE(v_salary.pph_amount, 0) - v_bpjs - v_total, 0),
    'settlement_payment_voucher_id', v_settlement_id,
    'settlement_payment_voucher_number', v_settlement->>'voucher_number',
    'advance_ids_applied', to_jsonb(v_selected_ids)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_selected_salary_advances_to_expense(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_selected_salary_advances_to_expense(uuid, uuid[]) TO authenticated, service_role;

COMMIT;
