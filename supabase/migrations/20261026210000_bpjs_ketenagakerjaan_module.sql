-- 20261026210000_bpjs_ketenagakerjaan_module.sql
-- Production-ready BPJS Ketenagakerjaan module for PT Avira Parama Farma.
-- Extends Staff Master, Chart of Accounts, journal posting, and bank reconciliation.

-- 1. Extend finance_staff_master with BPJS configuration
ALTER TABLE public.finance_staff_master
  ADD COLUMN IF NOT EXISTS bpjs_applicable BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS bpjs_kpj_number TEXT,
  ADD COLUMN IF NOT EXISTS bpjs_enrollment_status TEXT DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS bpjs_enrollment_start_date DATE,
  ADD COLUMN IF NOT EXISTS bpjs_enrollment_end_date DATE,
  ADD COLUMN IF NOT EXISTS bpjs_wage_basis NUMERIC,
  ADD COLUMN IF NOT EXISTS bpjs_program_jht BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS bpjs_program_jkk BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS bpjs_program_jkm BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS bpjs_program_jp BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS bpjs_jht_employee_rate NUMERIC DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS bpjs_jht_employer_rate NUMERIC DEFAULT 3.7,
  ADD COLUMN IF NOT EXISTS bpjs_jkk_employer_rate NUMERIC DEFAULT 0.24,
  ADD COLUMN IF NOT EXISTS bpjs_jkm_employer_rate NUMERIC DEFAULT 0.30,
  ADD COLUMN IF NOT EXISTS bpjs_jp_employee_rate NUMERIC DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS bpjs_jp_employer_rate NUMERIC DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS bpjs_notes TEXT,
  ADD COLUMN IF NOT EXISTS bpjs_document_urls TEXT[] DEFAULT '{}';

COMMENT ON COLUMN public.finance_staff_master.bpjs_applicable IS 'Controls whether employee is enrolled in BPJS Ketenagakerjaan.';
COMMENT ON COLUMN public.finance_staff_master.bpjs_kpj_number IS 'BPJS Participant Number (Nomor Peserta / KPJ).';
COMMENT ON COLUMN public.finance_staff_master.bpjs_wage_basis IS 'Reported statutory BPJS contribution wage (can differ from monthly_salary).';

-- 2. Ensure canonical Chart of Accounts entries for BPJS
DO $$
DECLARE
  v_liab_parent uuid;
  v_exp_parent uuid;
BEGIN
  SELECT id INTO v_liab_parent FROM public.chart_of_accounts WHERE code = '2100' LIMIT 1;
  SELECT parent_id INTO v_exp_parent FROM public.chart_of_accounts WHERE code = '6100' LIMIT 1;
  IF v_exp_parent IS NULL THEN
    SELECT id INTO v_exp_parent FROM public.chart_of_accounts WHERE account_type = 'expense' AND is_header = true LIMIT 1;
  END IF;

  -- 2134 BPJS Ketenagakerjaan Payable
  IF NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE code = '2134') THEN
    INSERT INTO public.chart_of_accounts (code, name, account_type, is_active, is_header, parent_id, normal_balance)
    VALUES ('2134', 'BPJS Ketenagakerjaan Payable', 'liability', true, false, v_liab_parent, 'credit');
  END IF;

  -- 6115 BPJS Ketenagakerjaan Expense
  IF NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE code = '6115') THEN
    INSERT INTO public.chart_of_accounts (code, name, account_type, is_active, is_header, parent_id, normal_balance)
    VALUES ('6115', 'BPJS Ketenagakerjaan Expense', 'expense', true, false, v_exp_parent, 'debit');
  END IF;
END $$;

-- 3. Monthly BPJS Registers table
CREATE TABLE IF NOT EXISTS public.bpjs_monthly_registers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year INTEGER NOT NULL CHECK (period_year >= 2020),
  npp TEXT NOT NULL DEFAULT '26719331',
  company_name TEXT NOT NULL DEFAULT 'PT Avira Parama Farma',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'approved', 'posted', 'reconciled', 'cancelled')),
  total_reported_wages NUMERIC NOT NULL DEFAULT 0,
  total_employee_jht NUMERIC NOT NULL DEFAULT 0,
  total_employee_jp NUMERIC NOT NULL DEFAULT 0,
  total_employee_deductions NUMERIC NOT NULL DEFAULT 0,
  total_employer_jht NUMERIC NOT NULL DEFAULT 0,
  total_employer_jkk NUMERIC NOT NULL DEFAULT 0,
  total_employer_jkm NUMERIC NOT NULL DEFAULT 0,
  total_employer_jp NUMERIC NOT NULL DEFAULT 0,
  total_employer_expenses NUMERIC NOT NULL DEFAULT 0,
  total_contribution_payable NUMERIC NOT NULL DEFAULT 0,
  official_billed_amount NUMERIC,
  actual_paid_amount NUMERIC NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid')),
  reconciliation_status TEXT NOT NULL DEFAULT 'unreconciled' CHECK (reconciliation_status IN ('unreconciled', 'reconciled', 'variance')),
  journal_entry_id UUID REFERENCES public.journal_entries(id),
  payment_journal_entry_id UUID REFERENCES public.journal_entries(id),
  bank_statement_line_id UUID REFERENCES public.bank_statement_lines(id),
  payment_reference TEXT,
  notes TEXT,
  document_urls TEXT[] DEFAULT '{}',
  created_by UUID REFERENCES auth.users(id),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  posted_by UUID REFERENCES auth.users(id),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bpjs_monthly_registers_period UNIQUE (period_year, period_month)
);

-- 4. Monthly BPJS Register Items table
CREATE TABLE IF NOT EXISTS public.bpjs_monthly_register_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id UUID NOT NULL REFERENCES public.bpjs_monthly_registers(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES public.finance_staff_master(id),
  staff_name TEXT NOT NULL,
  employee_code TEXT,
  kpj_number TEXT,
  department TEXT,
  monthly_salary NUMERIC NOT NULL DEFAULT 0,
  wage_basis NUMERIC NOT NULL DEFAULT 0,
  is_wage_discrepant BOOLEAN NOT NULL DEFAULT false,
  program_jht BOOLEAN NOT NULL DEFAULT true,
  program_jkk BOOLEAN NOT NULL DEFAULT true,
  program_jkm BOOLEAN NOT NULL DEFAULT true,
  program_jp BOOLEAN NOT NULL DEFAULT false,
  jht_employee_rate NUMERIC NOT NULL DEFAULT 2.0,
  jht_employer_rate NUMERIC NOT NULL DEFAULT 3.7,
  jkk_employer_rate NUMERIC NOT NULL DEFAULT 0.24,
  jkm_employer_rate NUMERIC NOT NULL DEFAULT 0.30,
  jp_employee_rate NUMERIC NOT NULL DEFAULT 0.0,
  jp_employer_rate NUMERIC NOT NULL DEFAULT 0.0,
  employee_jht_amount NUMERIC NOT NULL DEFAULT 0,
  employee_jp_amount NUMERIC NOT NULL DEFAULT 0,
  total_employee_deduction NUMERIC NOT NULL DEFAULT 0,
  employer_jht_amount NUMERIC NOT NULL DEFAULT 0,
  employer_jkk_amount NUMERIC NOT NULL DEFAULT 0,
  employer_jkm_amount NUMERIC NOT NULL DEFAULT 0,
  employer_jp_amount NUMERIC NOT NULL DEFAULT 0,
  total_employer_expense NUMERIC NOT NULL DEFAULT 0,
  total_payable NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bpjs_register_items_staff UNIQUE (register_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_bpjs_items_register_id ON public.bpjs_monthly_register_items(register_id);
CREATE INDEX IF NOT EXISTS idx_bpjs_items_staff_id ON public.bpjs_monthly_register_items(staff_id);

-- Enable Row Level Security
ALTER TABLE public.bpjs_monthly_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bpjs_monthly_register_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bpjs_registers_select" ON public.bpjs_monthly_registers;
CREATE POLICY "bpjs_registers_select" ON public.bpjs_monthly_registers
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "bpjs_registers_all" ON public.bpjs_monthly_registers;
CREATE POLICY "bpjs_registers_all" ON public.bpjs_monthly_registers
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "bpjs_items_select" ON public.bpjs_monthly_register_items;
CREATE POLICY "bpjs_items_select" ON public.bpjs_monthly_register_items
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "bpjs_items_all" ON public.bpjs_monthly_register_items;
CREATE POLICY "bpjs_items_all" ON public.bpjs_monthly_register_items
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'accounts')
    )
  );

-- 5. Server-side BPJS Calculation Service
CREATE OR REPLACE FUNCTION public.calculate_staff_bpjs(
  p_staff_id uuid,
  p_wage_override numeric DEFAULT NULL,
  p_period_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_staff public.finance_staff_master%ROWTYPE;
  v_wage numeric;
  v_is_discrepant boolean := false;
  v_emp_jht numeric := 0;
  v_emp_jp numeric := 0;
  v_emp_deduction numeric := 0;
  v_er_jht numeric := 0;
  v_er_jkk numeric := 0;
  v_er_jkm numeric := 0;
  v_er_jp numeric := 0;
  v_er_expense numeric := 0;
  v_total_payable numeric := 0;
BEGIN
  SELECT * INTO v_staff FROM public.finance_staff_master WHERE id = p_staff_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff member not found';
  END IF;

  -- Eligibility checks:
  IF NOT COALESCE(v_staff.bpjs_applicable, false) THEN
    RETURN jsonb_build_object(
      'applicable', false,
      'staff_id', v_staff.id,
      'wage_basis', 0,
      'total_employee_deduction', 0,
      'total_employer_expense', 0,
      'total_payable', 0
    );
  END IF;

  -- Enrollment date checks:
  IF v_staff.bpjs_enrollment_start_date IS NOT NULL AND p_period_date < v_staff.bpjs_enrollment_start_date THEN
    RETURN jsonb_build_object(
      'applicable', false,
      'staff_id', v_staff.id,
      'reason', 'Before enrollment start date',
      'total_employee_deduction', 0,
      'total_employer_expense', 0,
      'total_payable', 0
    );
  END IF;

  IF v_staff.bpjs_enrollment_end_date IS NOT NULL AND p_period_date > v_staff.bpjs_enrollment_end_date THEN
    RETURN jsonb_build_object(
      'applicable', false,
      'staff_id', v_staff.id,
      'reason', 'After enrollment end date',
      'total_employee_deduction', 0,
      'total_employer_expense', 0,
      'total_payable', 0
    );
  END IF;

  IF v_staff.status = 'inactive' AND v_staff.last_working_date IS NOT NULL AND p_period_date > v_staff.last_working_date THEN
    RETURN jsonb_build_object(
      'applicable', false,
      'staff_id', v_staff.id,
      'reason', 'After last working date',
      'total_employee_deduction', 0,
      'total_employer_expense', 0,
      'total_payable', 0
    );
  END IF;

  -- Determine wage basis:
  v_wage := COALESCE(p_wage_override, v_staff.bpjs_wage_basis, v_staff.monthly_salary, 0);
  IF v_wage < 0 THEN
    RAISE EXCEPTION 'BPJS wage basis cannot be negative';
  END IF;

  IF v_staff.monthly_salary IS NOT NULL AND v_wage <> v_staff.monthly_salary THEN
    v_is_discrepant := true;
  END IF;

  -- Program calculations:
  -- JHT (Employee 2%, Employer 3.7%)
  IF COALESCE(v_staff.bpjs_program_jht, true) THEN
    v_emp_jht := round(v_wage * COALESCE(v_staff.bpjs_jht_employee_rate, 2.0) / 100.0, 2);
    v_er_jht := round(v_wage * COALESCE(v_staff.bpjs_jht_employer_rate, 3.7) / 100.0, 2);
  END IF;

  -- JKK (Employer 0.24%)
  IF COALESCE(v_staff.bpjs_program_jkk, true) THEN
    v_er_jkk := round(v_wage * COALESCE(v_staff.bpjs_jkk_employer_rate, 0.24) / 100.0, 2);
  END IF;

  -- JKM (Employer 0.30%)
  IF COALESCE(v_staff.bpjs_program_jkm, true) THEN
    v_er_jkm := round(v_wage * COALESCE(v_staff.bpjs_jkm_employer_rate, 0.30) / 100.0, 2);
  END IF;

  -- JP (Pension)
  IF COALESCE(v_staff.bpjs_program_jp, false) THEN
    v_emp_jp := round(v_wage * COALESCE(v_staff.bpjs_jp_employee_rate, 0.0) / 100.0, 2);
    v_er_jp := round(v_wage * COALESCE(v_staff.bpjs_jp_employer_rate, 0.0) / 100.0, 2);
  END IF;

  v_emp_deduction := v_emp_jht + v_emp_jp;
  v_er_expense := v_er_jht + v_er_jkk + v_er_jkm + v_er_jp;
  v_total_payable := v_emp_deduction + v_er_expense;

  RETURN jsonb_build_object(
    'applicable', true,
    'staff_id', v_staff.id,
    'staff_name', v_staff.full_name,
    'employee_code', v_staff.employee_code,
    'kpj_number', v_staff.bpjs_kpj_number,
    'monthly_salary', v_staff.monthly_salary,
    'wage_basis', v_wage,
    'is_wage_discrepant', v_is_discrepant,
    'program_jht', v_staff.bpjs_program_jht,
    'program_jkk', v_staff.bpjs_program_jkk,
    'program_jkm', v_staff.bpjs_program_jkm,
    'program_jp', v_staff.bpjs_program_jp,
    'jht_employee_rate', v_staff.bpjs_jht_employee_rate,
    'jht_employer_rate', v_staff.bpjs_jht_employer_rate,
    'jkk_employer_rate', v_staff.bpjs_jkk_employer_rate,
    'jkm_employer_rate', v_staff.bpjs_jkm_employer_rate,
    'jp_employee_rate', v_staff.bpjs_jp_employee_rate,
    'jp_employer_rate', v_staff.bpjs_jp_employer_rate,
    'employee_jht_amount', v_emp_jht,
    'employee_jp_amount', v_emp_jp,
    'total_employee_deduction', v_emp_deduction,
    'employer_jht_amount', v_er_jht,
    'employer_jkk_amount', v_er_jkk,
    'employer_jkm_amount', v_er_jkm,
    'employer_jp_amount', v_er_jp,
    'total_employer_expense', v_er_expense,
    'total_payable', v_total_payable
  );
END;
$function$;

-- 6. Integrate with calculate_staff_salary
CREATE OR REPLACE FUNCTION public.calculate_staff_salary(
  p_staff_id uuid,
  p_salary_date date DEFAULT CURRENT_DATE,
  p_gross_override numeric DEFAULT NULL::numeric,
  p_pph21_override numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_staff public.finance_staff_master%ROWTYPE;
  v_gross numeric;
  v_advance numeric;
  v_pph21 numeric;
  v_bpjs numeric := 0;
  v_bpjs_calc jsonb;
BEGIN
  PERFORM public._sec_check_finance_role();

  SELECT * INTO v_staff FROM public.finance_staff_master WHERE id = p_staff_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff member not found';
  END IF;

  -- If employee is inactive:
  IF v_staff.status = 'inactive' THEN
    IF v_staff.last_working_date IS NOT NULL AND COALESCE(p_salary_date, CURRENT_DATE) > v_staff.last_working_date THEN
      RAISE EXCEPTION 'Cannot generate salary for inactive employee after last working date (%)', v_staff.last_working_date;
    END IF;
  END IF;

  v_gross := COALESCE(p_gross_override, v_staff.monthly_salary, 0);
  IF v_gross < 0 THEN
    RAISE EXCEPTION 'Gross salary cannot be negative';
  END IF;

  SELECT COALESCE(sum(available_amount), 0) INTO v_advance
    FROM public.get_outstanding_salary_advances(p_staff_id, COALESCE(p_salary_date, CURRENT_DATE));

  v_pph21 := CASE
    WHEN NOT v_staff.pph21_applicable THEN 0
    WHEN v_staff.pph21_method = 'percentage' THEN round(v_gross * v_staff.pph21_percentage / 100, 2)
    ELSE COALESCE(p_pph21_override, 0)
  END;

  IF v_pph21 < 0 OR v_pph21 > v_gross THEN
    RAISE EXCEPTION 'PPh21 must be between zero and gross salary';
  END IF;

  -- Calculate employee BPJS deduction (JHT 2% etc.) using single calculation service
  IF COALESCE(v_staff.bpjs_applicable, false) THEN
    v_bpjs_calc := public.calculate_staff_bpjs(v_staff.id, NULL, COALESCE(p_salary_date, CURRENT_DATE));
    IF (v_bpjs_calc->>'applicable')::boolean THEN
      v_bpjs := COALESCE((v_bpjs_calc->>'total_employee_deduction')::numeric, 0);
    END IF;
  END IF;

  v_advance := least(v_advance, greatest(v_gross - v_pph21 - v_bpjs, 0));

  RETURN jsonb_build_object(
    'staff_id', v_staff.id,
    'monthly_salary', v_staff.monthly_salary,
    'salary_type', v_staff.salary_type,
    'gross_salary', v_gross,
    'outstanding_salary_advances', v_advance,
    'pph21_applicable', v_staff.pph21_applicable,
    'pph21_method', v_staff.pph21_method,
    'pph21_percentage', v_staff.pph21_percentage,
    'pph21_amount', v_pph21,
    'bpjs_amount', v_bpjs,
    'net_salary_payable', greatest(v_gross - v_advance - v_pph21 - v_bpjs, 0),
    'default_payment_method', v_staff.default_payment_method,
    'status', v_staff.status,
    'last_working_date', v_staff.last_working_date,
    'bpjs_applicable', v_staff.bpjs_applicable,
    'bpjs_wage_basis', v_staff.bpjs_wage_basis
  );
END;
$function$;

-- 7. Generate or Recalculate Monthly Register RPC
CREATE OR REPLACE FUNCTION public.generate_bpjs_monthly_register(
  p_year integer,
  p_month integer,
  p_official_bill numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_register_id uuid;
  v_register public.bpjs_monthly_registers%ROWTYPE;
  v_staff record;
  v_calc jsonb;
  v_period_date date;
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
BEGIN
  PERFORM public._sec_check_finance_role();

  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'Invalid month %', p_month;
  END IF;
  IF p_year < 2020 THEN
    RAISE EXCEPTION 'Invalid year %', p_year;
  END IF;

  v_period_date := make_date(p_year, p_month, 1);

  -- Check if register exists
  SELECT * INTO v_register
    FROM public.bpjs_monthly_registers
   WHERE period_year = p_year AND period_month = p_month
   FOR UPDATE;

  IF FOUND THEN
    IF v_register.status IN ('posted', 'reconciled') THEN
      RAISE EXCEPTION 'Cannot recalculate %-%: register is already %', p_year, p_month, v_register.status;
    END IF;
    v_register_id := v_register.id;
    -- Delete existing draft items for idempotent recalculation
    DELETE FROM public.bpjs_monthly_register_items WHERE register_id = v_register_id;
  ELSE
    INSERT INTO public.bpjs_monthly_registers (
      period_year, period_month, official_billed_amount, created_by
    ) VALUES (
      p_year, p_month, p_official_bill, auth.uid()
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
      );

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
         official_billed_amount = COALESCE(p_official_bill, official_billed_amount, v_total_pay),
         updated_at = now()
   WHERE id = v_register_id;

  RETURN jsonb_build_object(
    'register_id', v_register_id,
    'period_year', p_year,
    'period_month', p_month,
    'total_reported_wages', v_wages,
    'total_employee_deductions', v_emp_ded,
    'total_employer_expenses', v_er_exp,
    'total_contribution_payable', v_total_pay
  );
END;
$function$;

-- 8. Post BPJS Monthly Register Accounting Entries
CREATE OR REPLACE FUNCTION public.post_bpjs_monthly_register(
  p_register_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reg public.bpjs_monthly_registers%ROWTYPE;
  v_period_id uuid;
  v_je_id uuid;
  v_entry_num text;
  v_bpjs_payable_coa_id uuid;
  v_bpjs_expense_coa_id uuid;
  v_user uuid;
  v_posting_date date;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_user := COALESCE(p_user_id, auth.uid());

  SELECT * INTO v_reg FROM public.bpjs_monthly_registers WHERE id = p_register_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BPJS register % not found', p_register_id; END IF;
  IF v_reg.status IN ('posted', 'reconciled') THEN
    RAISE EXCEPTION 'BPJS register % is already posted', p_register_id;
  END IF;

  v_posting_date := (make_date(v_reg.period_year, v_reg.period_month, 1) + interval '1 month - 1 day')::date;

  -- Resolve period
  SELECT id INTO v_period_id FROM public.accounting_periods
   WHERE start_date <= v_posting_date AND end_date >= v_posting_date
   ORDER BY start_date DESC LIMIT 1;

  -- Resolve accounts: 2134 BPJS Payable & 6115 BPJS Expense (or fallback 6110 Employee Benefits)
  SELECT id INTO v_bpjs_payable_coa_id FROM public.chart_of_accounts WHERE code = '2134' LIMIT 1;
  SELECT id INTO v_bpjs_expense_coa_id FROM public.chart_of_accounts WHERE code = '6115' LIMIT 1;
  IF v_bpjs_expense_coa_id IS NULL THEN
    SELECT id INTO v_bpjs_expense_coa_id FROM public.chart_of_accounts WHERE code = '6110' LIMIT 1;
  END IF;

  IF v_bpjs_payable_coa_id IS NULL THEN RAISE EXCEPTION 'Account 2134 BPJS Payable not found'; END IF;
  IF v_bpjs_expense_coa_id IS NULL THEN RAISE EXCEPTION 'BPJS Expense account not found'; END IF;

  v_entry_num := public.next_journal_entry_number();

  -- Create Journal Entry for Employer Contribution portion
  -- (Employee deductions are accrued via payroll/salary expense into 2134;
  -- employer contributions are recognized as company expense 6115 -> liability 2134)
  INSERT INTO public.journal_entries (
    entry_number, entry_date, period_id, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, posted_at, created_by,
    transaction_currency, functional_currency, exchange_rate, amounts_are_functional
  ) VALUES (
    v_entry_num, v_posting_date, v_period_id, 'bpjs_register', v_reg.id,
    'BPJS-' || v_reg.period_year || '-' || lpad(v_reg.period_month::text, 2, '0'),
    'BPJS Ketenagakerjaan Employer Contribution - ' || to_char(v_posting_date, 'Mon YYYY'),
    v_reg.total_employer_expenses, v_reg.total_employer_expenses, true, v_user, now(), v_user,
    'IDR', 'IDR', 1.0, true
  ) RETURNING id INTO v_je_id;

  -- Debit: 6115 BPJS Expense
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, debit, credit, description,
    transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
  ) VALUES (
    v_je_id, 1, v_bpjs_expense_coa_id, v_reg.total_employer_expenses, 0,
    'Employer BPJS Contribution (JHT, JKK, JKM)', 'IDR', v_reg.total_employer_expenses, 0, 'IDR', 1.0
  );

  -- Credit: 2134 BPJS Payable
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, debit, credit, description,
    transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
  ) VALUES (
    v_je_id, 2, v_bpjs_payable_coa_id, 0, v_reg.total_employer_expenses,
    'BPJS Ketenagakerjaan Employer Payable', 'IDR', 0, v_reg.total_employer_expenses, 'IDR', 1.0
  );

  UPDATE public.bpjs_monthly_registers
     SET status = 'posted',
         journal_entry_id = v_je_id,
         posted_by = v_user,
         posted_at = now(),
         updated_at = now()
   WHERE id = v_reg.id;

  RETURN jsonb_build_object(
    'register_id', v_reg.id,
    'journal_entry_id', v_je_id,
    'entry_number', v_entry_num,
    'total_posted', v_reg.total_employer_expenses
  );
END;
$function$;

-- 9. Reconcile BPJS Register Payment with Bank Transaction
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
  v_bank_line public.bank_statement_lines%ROWTYPE;
  v_bank_account public.bank_accounts%ROWTYPE;
  v_period_id uuid;
  v_pay_je_id uuid;
  v_entry_num text;
  v_bpjs_payable_coa_id uuid;
  v_payment_amount numeric;
  v_diff numeric;
BEGIN
  PERFORM public._sec_check_finance_role();

  SELECT * INTO v_reg FROM public.bpjs_monthly_registers WHERE id = p_register_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BPJS register % not found', p_register_id; END IF;

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

  -- Resolve period
  SELECT id INTO v_period_id FROM public.accounting_periods
   WHERE start_date <= v_bank_line.transaction_date AND end_date >= v_bank_line.transaction_date
   ORDER BY start_date DESC LIMIT 1;

  -- Create Payment Journal Entry
  -- Debit 2134 BPJS Payable, Credit 111101 Bank BCA
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

  -- Determine payment status and reconciliation difference
  v_diff := COALESCE(v_reg.official_billed_amount, v_reg.total_contribution_payable) - v_payment_amount;

  UPDATE public.bpjs_monthly_registers
     SET bank_statement_line_id = v_bank_line.id,
         payment_journal_entry_id = v_pay_je_id,
         payment_reference = COALESCE(p_payment_reference, v_bank_line.description),
         actual_paid_amount = v_payment_amount,
         payment_status = CASE
           WHEN v_payment_amount >= COALESCE(v_reg.official_billed_amount, v_reg.total_contribution_payable) - 0.01 THEN 'paid'
           ELSE 'partially_paid'
         END,
         reconciliation_status = CASE
           WHEN abs(v_diff) <= 0.01 THEN 'reconciled'
           ELSE 'variance'
         END,
         status = 'reconciled',
         updated_at = now()
   WHERE id = v_reg.id;

  RETURN jsonb_build_object(
    'register_id', v_reg.id,
    'payment_journal_entry_id', v_pay_je_id,
    'bank_statement_line_id', v_bank_line.id,
    'actual_paid_amount', v_payment_amount,
    'difference', v_diff,
    'reconciliation_status', CASE WHEN abs(v_diff) <= 0.01 THEN 'reconciled' ELSE 'variance' END
  );
END;
$function$;

-- 10. Controlled Reversal RPC
CREATE OR REPLACE FUNCTION public.reverse_bpjs_monthly_register(
  p_register_id uuid,
  p_reason text DEFAULT 'Correction'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reg public.bpjs_monthly_registers%ROWTYPE;
BEGIN
  PERFORM public._sec_check_finance_role();

  SELECT * INTO v_reg FROM public.bpjs_monthly_registers WHERE id = p_register_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BPJS register % not found', p_register_id; END IF;

  IF v_reg.payment_journal_entry_id IS NOT NULL THEN
    UPDATE public.journal_entries
       SET is_reversed = true
     WHERE id = v_reg.payment_journal_entry_id;
  END IF;

  IF v_reg.journal_entry_id IS NOT NULL THEN
    UPDATE public.journal_entries
       SET is_reversed = true
     WHERE id = v_reg.journal_entry_id;
  END IF;

  IF v_reg.bank_statement_line_id IS NOT NULL THEN
    UPDATE public.bank_statement_lines
       SET matched_entry_id = NULL,
           reconciliation_status = 'unmatched',
           matching_status = 'none',
           matched_at = NULL,
           matched_by = NULL
     WHERE id = v_reg.bank_statement_line_id;
  END IF;

  UPDATE public.bpjs_monthly_registers
     SET status = 'cancelled',
         notes = COALESCE(notes || ' | ', '') || 'Reversed: ' || p_reason,
         payment_status = 'unpaid',
         reconciliation_status = 'unreconciled',
         updated_at = now()
   WHERE id = v_reg.id;

  RETURN jsonb_build_object('success', true, 'register_id', v_reg.id);
END;
$function$;
