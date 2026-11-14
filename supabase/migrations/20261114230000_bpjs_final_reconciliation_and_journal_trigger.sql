-- ==============================================================================
-- MIGRATION: 20261114230000_bpjs_final_reconciliation_and_journal_trigger.sql
-- Description:
--   BPJS Final Database and Payroll Reconciliation:
--   1. Update trigger_auto_post_expense_accounting_update to include bpjs_employee_deduction
--      so changes to employee BPJS deduction regenerate the approved salary journal.
--   2. Add reopen_bpjs_monthly_register RPC for explicit revision of approved registers.
--   3. Update generate_bpjs_monthly_register to:
--      - Restrict automatic recalculation to draft registers only.
--      - Protect approved and posted registers from accidental overwrite.
--      - Accurately associate primary regular salary expenses (excluding bonuses/THR).
--      - Synchronize salary expense employee deduction with calculated register items.
--      - Only populate official_billed_amount when has_official_bill is true.
--   4. Update reconcile_bpjs_register_payment to enforce strict lifecycle sequencing:
--      - Require register to have an active posted accrual journal (status = 'posted').
--      - Validate linked salary expense employee deductions match register employee deductions.
--      - Validate posted employer contribution journal matches register employer expenses.
--      - Validate total liability matches register total.
--      - Validate payment matches official bill when available, otherwise calculated contribution.
-- ==============================================================================

BEGIN;

-- 1. Fix the salary journal UPDATE trigger condition
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting_update ON public.finance_expenses;

CREATE TRIGGER trigger_auto_post_expense_accounting_update
AFTER UPDATE ON public.finance_expenses
FOR EACH ROW WHEN (
  (new.approval_status = 'approved'::text) AND
  (new.expense_category <> 'import_broker'::text) AND
  (COALESCE(current_setting('app.finance_historical_repair'::text, true), 'off'::text) <> 'on'::text) AND (
    (old.approval_status IS DISTINCT FROM new.approval_status) OR
    (old.amount IS DISTINCT FROM new.amount) OR
    (old.expense_category IS DISTINCT FROM new.expense_category) OR
    ((old.payment_method)::text IS DISTINCT FROM (new.payment_method)::text) OR
    (old.bank_account_id IS DISTINCT FROM new.bank_account_id) OR
    (old.ppn_amount IS DISTINCT FROM new.ppn_amount) OR
    (old.pph_amount IS DISTINCT FROM new.pph_amount) OR
    (old.pph_code_id IS DISTINCT FROM new.pph_code_id) OR
    (old.pph_treatment IS DISTINCT FROM new.pph_treatment) OR
    (old.stamp_duty_amount IS DISTINCT FROM new.stamp_duty_amount) OR
    (old.bank_charges_amount IS DISTINCT FROM new.bank_charges_amount) OR
    (old.fixed_asset_account_id IS DISTINCT FROM new.fixed_asset_account_id) OR
    (old.broker_items IS DISTINCT FROM new.broker_items) OR
    (old.description IS DISTINCT FROM new.description) OR
    (old.expense_date IS DISTINCT FROM new.expense_date) OR
    (old.include_in_landed_cost IS DISTINCT FROM new.include_in_landed_cost) OR
    (old.import_container_id IS DISTINCT FROM new.import_container_id) OR
    (old.bpjs_employee_deduction IS DISTINCT FROM new.bpjs_employee_deduction)
  )
) EXECUTE FUNCTION auto_post_expense_accounting();

-- 2. Add controlled reopen/revision RPC for approved registers
CREATE OR REPLACE FUNCTION public.reopen_bpjs_monthly_register(
  p_register_id uuid,
  p_reason text DEFAULT 'Revision'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reg public.bpjs_monthly_registers%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    PERFORM public._sec_check_finance_role();
  END IF;

  SELECT * INTO v_reg FROM public.bpjs_monthly_registers WHERE id = p_register_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BPJS register % not found', p_register_id; END IF;

  IF v_reg.status IN ('posted', 'reconciled') THEN
    RAISE EXCEPTION 'Cannot reopen % register: register is already % (requires formal reversal first)',
      to_char(make_date(v_reg.period_year, v_reg.period_month, 1), 'Mon YYYY'), v_reg.status;
  END IF;

  IF v_reg.status = 'draft' THEN
    RETURN jsonb_build_object('register_id', v_reg.id, 'status', 'draft', 'message', 'Already draft');
  END IF;

  UPDATE public.bpjs_monthly_registers
     SET status = 'draft',
         approved_at = NULL,
         approved_by = NULL,
         notes = COALESCE(notes || E'\n', '') || 'Reopened to draft on ' || now()::text || ': ' || COALESCE(p_reason, 'Revision'),
         updated_at = now()
   WHERE id = v_reg.id;

  RETURN jsonb_build_object('register_id', v_reg.id, 'status', 'draft');
END;
$function$;

REVOKE ALL ON FUNCTION public.reopen_bpjs_monthly_register(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_bpjs_monthly_register(uuid, text) TO authenticated, service_role;

-- 3. Update generate_bpjs_monthly_register
CREATE OR REPLACE FUNCTION public.generate_bpjs_monthly_register(
  p_year integer,
  p_month integer,
  p_official_bill numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period_date date;
  v_register_id uuid;
  v_register public.bpjs_monthly_registers%ROWTYPE;
  v_staff record;
  v_calc jsonb;
  v_item_id uuid;
  v_primary_exp_id uuid;
  v_wages numeric := 0;
  v_emp_jht numeric := 0;
  v_emp_jp numeric := 0;
  v_emp_ded numeric := 0;
  v_er_jht numeric := 0;
  v_er_jkk numeric := 0;
  v_er_jkm numeric := 0;
  v_er_jp numeric := 0;
  v_er_exp numeric := 0;
  v_total_pay numeric := 0;
  v_has_official_bill boolean;
  v_official_billed_amount numeric;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    PERFORM public._sec_check_finance_role();
  END IF;

  IF p_year < 2020 OR p_year > 2100 THEN
    RAISE EXCEPTION 'Invalid period year %', p_year;
  END IF;
  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'Invalid period month %', p_month;
  END IF;

  v_period_date := make_date(p_year, p_month, 1);

  SELECT * INTO v_register
    FROM public.bpjs_monthly_registers
   WHERE period_year = p_year AND period_month = p_month
   FOR UPDATE;

  IF FOUND THEN
    -- Protect approved, posted, and reconciled registers
    IF v_register.status <> 'draft' THEN
      RAISE EXCEPTION 'Cannot recalculate %-%: register status is % (only draft registers can be recalculated). An approved register must be explicitly reopened before recalculation.',
        p_year, p_month, v_register.status;
    END IF;

    v_register_id := v_register.id;

    -- Resolve official bill flag and amount
    v_has_official_bill := CASE
      WHEN p_official_bill IS NOT NULL AND p_official_bill > 0 THEN true
      ELSE v_register.has_official_bill
    END;
    v_official_billed_amount := CASE
      WHEN p_official_bill IS NOT NULL AND p_official_bill > 0 THEN p_official_bill
      WHEN v_register.has_official_bill THEN v_register.official_billed_amount
      ELSE NULL
    END;

    -- Clear linked register items from expenses before deleting draft items
    UPDATE public.finance_expenses
       SET bpjs_register_item_id = NULL
     WHERE bpjs_register_item_id IN (
       SELECT id FROM public.bpjs_monthly_register_items WHERE register_id = v_register_id
     );
    DELETE FROM public.bpjs_monthly_register_items WHERE register_id = v_register_id;
  ELSE
    v_has_official_bill := (p_official_bill IS NOT NULL AND p_official_bill > 0);
    v_official_billed_amount := CASE WHEN v_has_official_bill THEN p_official_bill ELSE NULL END;

    INSERT INTO public.bpjs_monthly_registers (
      period_year, period_month, official_billed_amount, has_official_bill, created_by
    ) VALUES (
      p_year, p_month, v_official_billed_amount, v_has_official_bill, auth.uid()
    ) RETURNING id INTO v_register_id;
  END IF;

  -- Iterate eligible active staff
  FOR v_staff IN
    SELECT id, full_name, employee_code, department, monthly_salary, bpjs_wage_basis,
           bpjs_enrollment_start_date, bpjs_enrollment_end_date, last_working_date, status
      FROM public.finance_staff_master
     WHERE bpjs_applicable = true
       AND (bpjs_enrollment_start_date IS NULL OR bpjs_enrollment_start_date <= (v_period_date + interval '1 month - 1 day')::date)
       AND (bpjs_enrollment_end_date IS NULL OR bpjs_enrollment_end_date >= v_period_date)
       AND (status = 'active' OR (last_working_date IS NOT NULL AND last_working_date >= v_period_date))
     ORDER BY employee_code NULLS LAST, full_name
  LOOP
    v_calc := public.calculate_staff_bpjs(v_staff.id, NULL, v_period_date);
    IF (v_calc->>'applicable')::boolean THEN
      INSERT INTO public.bpjs_monthly_register_items (
        register_id, staff_id, staff_name, employee_code, kpj_number, department,
        monthly_salary, wage_basis, is_wage_discrepant,
        program_jht, program_jkk, program_jkm, program_jp,
        jht_employee_rate, jht_employer_rate, jkk_employer_rate, jkm_employer_rate, jp_employee_rate, jp_employer_rate,
        employee_jht_amount, employee_jp_amount, total_employee_deduction,
        employer_jht_amount, employer_jkk_amount, employer_jkm_amount, employer_jp_amount,
        total_employer_expense, total_payable
      ) VALUES (
        v_register_id, v_staff.id, v_staff.full_name, v_staff.employee_code, v_calc->>'kpj_number', v_staff.department,
        v_staff.monthly_salary, (v_calc->>'wage_basis')::numeric, (v_calc->>'is_wage_discrepant')::boolean,
        (v_calc->>'program_jht')::boolean, (v_calc->>'program_jkk')::boolean, (v_calc->>'program_jkm')::boolean, (v_calc->>'program_jp')::boolean,
        (v_calc->>'jht_employee_rate')::numeric, (v_calc->>'jht_employer_rate')::numeric, (v_calc->>'jkk_employer_rate')::numeric, (v_calc->>'jkm_employer_rate')::numeric,
        (v_calc->>'jp_employee_rate')::numeric, (v_calc->>'jp_employer_rate')::numeric,
        (v_calc->>'employee_jht_amount')::numeric, (v_calc->>'employee_jp_amount')::numeric, (v_calc->>'total_employee_deduction')::numeric,
        (v_calc->>'employer_jht_amount')::numeric, (v_calc->>'employer_jkk_amount')::numeric, (v_calc->>'employer_jkm_amount')::numeric, (v_calc->>'employer_jp_amount')::numeric,
        (v_calc->>'total_employer_expense')::numeric, (v_calc->>'total_payable')::numeric
      ) RETURNING id INTO v_item_id;

      -- Controlled payroll grouping: select the primary regular salary expense for this staff member and month
      SELECT id INTO v_primary_exp_id
        FROM public.finance_expenses
       WHERE staff_id = v_staff.id
         AND expense_category = 'salary'
         AND approval_status <> 'cancelled'
         AND (
           (payroll_period_year = p_year AND payroll_period_month = p_month)
           OR (
             payroll_period_year IS NULL AND (
               description ILIKE '%' || to_char(v_period_date, 'Mon YYYY') || '%'
               OR description ILIKE '%' || to_char(v_period_date, 'Mon-YY') || '%'
               OR description ILIKE '%' || to_char(v_period_date, 'YYYY-MM') || '%'
               OR (EXTRACT(YEAR FROM expense_date) = p_year AND EXTRACT(MONTH FROM expense_date) = p_month)
             )
           )
         )
       ORDER BY
         -- Prefer regular salary over bonus/THR/overtime
         CASE WHEN description ILIKE '%bonus%' OR description ILIKE '%thr%' OR description ILIKE '%overtime%' THEN 1 ELSE 0 END ASC,
         -- Prefer salary matching or exceeding monthly base salary
         CASE WHEN amount >= v_staff.monthly_salary - 0.01 THEN 0 ELSE 1 END ASC,
         expense_date DESC,
         created_at DESC
       LIMIT 1;

      IF v_primary_exp_id IS NOT NULL THEN
        -- Synchronize employee deduction and register item on primary salary expense
        UPDATE public.finance_expenses
           SET bpjs_register_item_id = v_item_id,
               bpjs_employee_deduction = CASE
                 WHEN bpjs_employee_deduction = 0 OR bpjs_employee_deduction IS NULL THEN (v_calc->>'total_employee_deduction')::numeric
                 ELSE bpjs_employee_deduction
               END,
               payroll_period_year = p_year,
               payroll_period_month = p_month
         WHERE id = v_primary_exp_id;

        -- Unlink any secondary/bonus salary expenses from this register item to prevent duplicate deductions
        UPDATE public.finance_expenses
           SET bpjs_register_item_id = NULL
         WHERE staff_id = v_staff.id
           AND expense_category = 'salary'
           AND id <> v_primary_exp_id
           AND bpjs_register_item_id = v_item_id;
      END IF;

      v_wages := v_wages + (v_calc->>'wage_basis')::numeric;
      v_emp_jht := v_emp_jht + (v_calc->>'employee_jht_amount')::numeric;
      v_emp_jp := v_emp_jp + (v_calc->>'employee_jp_amount')::numeric;
      v_emp_ded := v_emp_ded + (v_calc->>'total_employee_deduction')::numeric;
      v_er_jht := v_er_jht + (v_calc->>'employer_jht_amount')::numeric;
      v_er_jkk := v_er_jkk + (v_calc->>'employer_jkk_amount')::numeric;
      v_er_jkm := v_er_jkm + (v_calc->>'employer_jkm_amount')::numeric;
      v_er_jp := v_er_jp + (v_calc->>'employer_jp_amount')::numeric;
      v_er_exp := v_er_exp + (v_calc->>'total_employer_expense')::numeric;
      v_total_pay := v_total_pay + (v_calc->>'total_payable')::numeric;
    END IF;
  END LOOP;

  -- Update register totals
  UPDATE public.bpjs_monthly_registers
     SET total_reported_wages = v_wages,
         total_employee_jht = v_emp_jht,
         total_employee_jp = v_emp_jp,
         total_employee_deductions = v_emp_ded,
         total_employer_jht = v_er_jht,
         total_employer_jkk = v_er_jkk,
         total_employer_jkm = v_er_jkm,
         total_employer_jp = v_er_jp,
         total_employer_expenses = v_er_exp,
         total_contribution_payable = v_total_pay,
         official_billed_amount = v_official_billed_amount,
         has_official_bill = v_has_official_bill,
         updated_at = now()
   WHERE id = v_register_id;

  RETURN jsonb_build_object(
    'register_id', v_register_id,
    'period_year', p_year,
    'period_month', p_month,
    'total_reported_wages', v_wages,
    'total_employee_deductions', v_emp_ded,
    'total_employer_expenses', v_er_exp,
    'total_contribution_payable', v_total_pay,
    'has_official_bill', v_has_official_bill,
    'official_billed_amount', v_official_billed_amount
  );
END;
$function$;

-- 4. Update reconcile_bpjs_register_payment to enforce accrual posting and validation
CREATE OR REPLACE FUNCTION public.reconcile_bpjs_register_payment(
  p_register_id uuid,
  p_bank_line_id uuid,
  p_payment_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reg public.bpjs_monthly_registers%ROWTYPE;
  v_accrual_je public.journal_entries%ROWTYPE;
  v_linked_emp_ded numeric := 0;
  v_expected_amount numeric;
  v_bank_line public.bank_statement_lines%ROWTYPE;
  v_bank_account public.bank_accounts%ROWTYPE;
  v_period_id uuid;
  v_pay_je_id uuid;
  v_entry_num text;
  v_bpjs_payable_coa_id uuid;
  v_payment_amount numeric;
  v_diff numeric;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    PERFORM public._sec_check_finance_role();
  END IF;

  SELECT * INTO v_reg FROM public.bpjs_monthly_registers WHERE id = p_register_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BPJS register % not found', p_register_id; END IF;

  -- 1. Sequential lifecycle check: Register must be posted with an active accrual journal
  IF v_reg.status IN ('draft', 'reviewed') THEN
    RAISE EXCEPTION 'Cannot reconcile payment: BPJS register %-% is in % status. It must be approved and posted to the general ledger before payment reconciliation.',
      v_reg.period_year, v_reg.period_month, v_reg.status;
  END IF;

  IF v_reg.status = 'approved' AND v_reg.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Cannot reconcile payment: BPJS register %-% is approved but its employer contribution accrual journal has not been posted yet.',
      v_reg.period_year, v_reg.period_month;
  END IF;

  IF v_reg.status NOT IN ('posted', 'reconciled') OR v_reg.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Cannot reconcile payment: BPJS register %-% must have status ''posted'' with an active accrual journal (current status: %)',
      v_reg.period_year, v_reg.period_month, v_reg.status;
  END IF;

  -- 2. Verify active posted accrual journal
  SELECT * INTO v_accrual_je
    FROM public.journal_entries
   WHERE id = v_reg.journal_entry_id
     AND is_posted = true
     AND NOT COALESCE(is_reversed, false);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BPJS register %-% accrual journal % is missing, unposted, or reversed',
      v_reg.period_year, v_reg.period_month, v_reg.journal_entry_id;
  END IF;

  -- 3. Verify employer contribution journal reconciles to register employer expenses
  IF abs(COALESCE(v_accrual_je.total_credit, 0) - COALESCE(v_reg.total_employer_expenses, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Posted employer contribution journal (Rp %) does not match register employer expenses (Rp %)',
      v_accrual_je.total_credit, v_reg.total_employer_expenses;
  END IF;

  -- 4. Verify employee BPJS deductions in linked salary expenses reconcile to register employee deductions
  SELECT COALESCE(SUM(fe.bpjs_employee_deduction), 0) INTO v_linked_emp_ded
    FROM public.finance_expenses fe
   WHERE fe.bpjs_register_item_id IN (
     SELECT id FROM public.bpjs_monthly_register_items WHERE register_id = v_reg.id
   ) AND fe.approval_status = 'approved';

  IF abs(v_linked_emp_ded - COALESCE(v_reg.total_employee_deductions, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Salary-linked employee BPJS deductions (Rp %) do not reconcile to register employee deductions (Rp %)',
      v_linked_emp_ded, v_reg.total_employee_deductions;
  END IF;

  -- 5. Verify total liability equals register total
  IF abs((COALESCE(v_reg.total_employee_deductions, 0) + COALESCE(v_reg.total_employer_expenses, 0)) - COALESCE(v_reg.total_contribution_payable, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Register total contribution payable (Rp %) does not equal employee deductions (Rp %) + employer expenses (Rp %)',
      v_reg.total_contribution_payable, v_reg.total_employee_deductions, v_reg.total_employer_expenses;
  END IF;

  -- 6. Validate bank statement line and payment amount
  SELECT * INTO v_bank_line FROM public.bank_statement_lines WHERE id = p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line % not found', p_bank_line_id; END IF;

  SELECT * INTO v_bank_account FROM public.bank_accounts WHERE id = v_bank_line.bank_account_id;
  IF NOT FOUND OR v_bank_account.coa_id IS NULL THEN
    RAISE EXCEPTION 'Bank account COA not configured for line %', p_bank_line_id;
  END IF;

  SELECT id INTO v_bpjs_payable_coa_id FROM public.chart_of_accounts WHERE code = '2134' LIMIT 1;
  IF v_bpjs_payable_coa_id IS NULL THEN RAISE EXCEPTION 'Account 2134 BPJS Payable not found'; END IF;

  v_payment_amount := COALESCE(NULLIF(v_bank_line.debit_amount, 0), v_bank_line.credit_amount, 0);
  IF v_payment_amount <= 0 THEN RAISE EXCEPTION 'Bank statement line has zero payment amount'; END IF;

  -- 7. Payment amount matches official bill when available, otherwise calculated contribution
  v_expected_amount := CASE
    WHEN v_reg.has_official_bill = true AND v_reg.official_billed_amount IS NOT NULL
      THEN v_reg.official_billed_amount
    ELSE v_reg.total_contribution_payable
  END;

  v_diff := v_expected_amount - v_payment_amount;

  IF abs(v_diff) > 0.01 THEN
    RAISE EXCEPTION 'Payment amount (Rp %) does not match expected BPJS contribution (Rp %)',
      v_payment_amount, v_expected_amount;
  END IF;

  -- Resolve accounting period
  SELECT id INTO v_period_id FROM public.accounting_periods
   WHERE start_date <= v_bank_line.transaction_date AND end_date >= v_bank_line.transaction_date
   ORDER BY start_date DESC LIMIT 1;

  -- Create Payment Journal Entry
  -- Debit 2134 BPJS Payable, Credit Bank Account COA
  v_entry_num := public.next_journal_entry_number();
  INSERT INTO public.journal_entries (
    entry_number, entry_date, period_id, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, posted_at, created_by,
    transaction_currency, functional_currency, exchange_rate, amounts_are_functional
  ) VALUES (
    v_entry_num, v_bank_line.transaction_date, v_period_id, 'bpjs_payment', v_reg.id,
    'BPJS-PAY-' || v_reg.period_year || '-' || lpad(v_reg.period_month::text, 2, '0'),
    'BPJS Ketenagakerjaan Settlement - ' || COALESCE(p_payment_reference, v_reg.npp),
    v_payment_amount, v_payment_amount, true, auth.uid(), now(), auth.uid(),
    'IDR', 'IDR', 1.0, true
  ) RETURNING id INTO v_pay_je_id;

  -- Debit: 2134 BPJS Payable
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, debit, credit, description,
    transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
  ) VALUES (
    v_pay_je_id, 1, v_bpjs_payable_coa_id, v_payment_amount, 0,
    'BPJS Payment Settlement', 'IDR', v_payment_amount, 0, 'IDR', 1.0
  );

  -- Credit: Bank Account COA
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, debit, credit, description,
    transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
  ) VALUES (
    v_pay_je_id, 2, v_bank_account.coa_id, 0, v_payment_amount,
    'Bank Payment - BPJS Ketenagakerjaan', 'IDR', 0, v_payment_amount, 'IDR', 1.0
  );

  -- Link bank statement line
  UPDATE public.bank_statement_lines
     SET matched_entry_id = v_pay_je_id,
         reconciliation_status = 'matched',
         matching_status = 'confirmed',
         matched_at = now(),
         matched_by = auth.uid()
   WHERE id = v_bank_line.id;

  -- Update register status to reconciled
  UPDATE public.bpjs_monthly_registers
     SET bank_statement_line_id = v_bank_line.id,
         payment_journal_entry_id = v_pay_je_id,
         payment_reference = COALESCE(p_payment_reference, v_bank_line.description),
         actual_paid_amount = v_payment_amount,
         payment_status = 'paid',
         reconciliation_status = 'reconciled',
         status = 'reconciled',
         updated_at = now()
   WHERE id = v_reg.id;

  RETURN jsonb_build_object(
    'register_id', v_reg.id,
    'payment_journal_entry_id', v_pay_je_id,
    'bank_statement_line_id', v_bank_line.id,
    'actual_paid_amount', v_payment_amount,
    'difference', v_diff,
    'reconciliation_status', 'reconciled'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_bpjs_register_payment(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_bpjs_register_payment(uuid, uuid, text) TO authenticated, service_role;

COMMIT;
