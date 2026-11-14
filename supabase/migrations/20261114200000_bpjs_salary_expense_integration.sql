-- ==============================================================================
-- MIGRATION: 20261114200000_bpjs_salary_expense_integration.sql
-- Description:
--   Permanent BPJS and Salary Expense Integration Fix:
--   1. Schema: Add persisted BPJS deduction and payroll period columns to finance_expenses:
--      - bpjs_employee_deduction NUMERIC(18,2) NOT NULL DEFAULT 0
--      - bpjs_register_item_id UUID REFERENCES bpjs_monthly_register_items(id) ON DELETE SET NULL
--      - payroll_period_month INTEGER
--      - payroll_period_year INTEGER
--   2. Schema: Add has_official_bill to bpjs_monthly_registers
--   3. Trigger & Function: Update auto_post_expense_accounting() to post Employee BPJS
--      deductions to 2134 BPJS Ketenagakerjaan Payable and deduct from employee net AP.
--   4. Function: Update calculate_finance_expense_payable() to account for employee BPJS deduction.
--   5. Function: Update save_finance_expense and edit_approved_finance_expense_atomic to persist
--      bpjs_employee_deduction, bpjs_register_item_id, payroll_period_month, payroll_period_year.
--   6. Function: Update generate_bpjs_monthly_register() to link salary expenses idempotently
--      and distinguish calculated contribution vs official bill.
--   7. Historical Reconciliation:
--      - Chintia (EXP/26/366): Oct-26 payroll, BPJS Rp 76,000, Net Rp 3,724,000, linked to Oct register item.
--        Update expense journal JE2610-0250 lines to credit BPJS 2134 Rp 76k & AP 2110 Rp 3.724m.
--      - Nia (EXP/26/363): Nov-26 payroll, BPJS Rp 170,000, preserve historical payment & bank allocation.
--      - Oct 2026 BPJS Register figures preserved exactly (wages Rp 12.3m, total payable Rp 767,520).
-- ==============================================================================

BEGIN;

-- 1. Schema Extensions
ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS bpjs_employee_deduction NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bpjs_register_item_id UUID REFERENCES public.bpjs_monthly_register_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payroll_period_month INTEGER,
  ADD COLUMN IF NOT EXISTS payroll_period_year INTEGER;

ALTER TABLE public.bpjs_monthly_registers
  ADD COLUMN IF NOT EXISTS has_official_bill BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_finance_expenses_bpjs_item
  ON public.finance_expenses(bpjs_register_item_id)
  WHERE bpjs_register_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_expenses_payroll_period
  ON public.finance_expenses(staff_id, payroll_period_year, payroll_period_month)
  WHERE expense_category = 'salary';

-- 2. Update calculate_finance_expense_payable
CREATE OR REPLACE FUNCTION public.calculate_finance_expense_payable(p_expense_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT GREATEST(
    COALESCE(fe.amount, 0)
    + COALESCE(fe.ppn_amount, 0)
    - CASE WHEN COALESCE(fe.pph_treatment, 'deduct') = 'add' THEN 0 ELSE COALESCE(fe.pph_amount, 0) END
    + COALESCE(fe.stamp_duty_amount, 0)
    + COALESCE(fe.bank_charges_amount, 0)
    - COALESCE(fe.bpjs_employee_deduction, 0),
    0
  )
  FROM public.finance_expenses fe WHERE fe.id = p_expense_id;
$$;

-- 3. Update auto_post_expense_accounting
CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expense_account_id uuid;
  v_tax_benefit_account_id uuid;
  v_payment_account_id uuid;
  v_bpjs_payable_acc_id uuid;
  v_journal_id uuid;
  v_active_count integer;
  v_description text;
  v_credit_desc text;
  v_category_label text;
  v_bm_account_id uuid;
  v_ppn_account_id uuid;
  v_pph_account_id uuid;
  v_stamp_duty_account_id uuid;
  v_bank_charge_acc_id uuid;
  v_line_num integer;
  v_net_payment numeric(18,2);
  v_total numeric(18,2);
  v_bank_charges numeric(18,2);
  v_pph_treatment text;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;

  -- Mandatory validation: Block posting tax expense if party is missing
  IF (COALESCE(NEW.ppn_amount, 0) > 0 OR COALESCE(NEW.pph_amount, 0) > 0)
     AND COALESCE(NEW.expense_category, '') <> 'pib_import' THEN
    IF NEW.supplier_id IS NULL AND NEW.payee_id IS NULL AND NEW.staff_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post tax expense % without selecting a valid Supplier, Payee, or Staff member.',
        COALESCE(NEW.voucher_number, NEW.id::text)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD.approval_status='approved' THEN
    IF ROW(
      OLD.amount,OLD.expense_category,OLD.expense_date,OLD.description,
      OLD.payment_method,OLD.bank_account_id,OLD.pib_bm_amount,OLD.pib_ppn_amount,
      OLD.pib_pph_amount,OLD.ppn_amount,OLD.pph_amount,OLD.pph_code_id,
      COALESCE(OLD.pph_treatment,'deduct'),OLD.stamp_duty_amount,
      OLD.fixed_asset_account_id,COALESCE(OLD.bank_charges_amount,0),
      OLD.transaction_currency,OLD.exchange_rate,OLD.supplier_id,OLD.payee_id,OLD.staff_id,
      COALESCE(OLD.bpjs_employee_deduction, 0)
    ) IS NOT DISTINCT FROM ROW(
      NEW.amount,NEW.expense_category,NEW.expense_date,NEW.description,
      NEW.payment_method,NEW.bank_account_id,NEW.pib_bm_amount,NEW.pib_ppn_amount,
      NEW.pib_pph_amount,NEW.ppn_amount,NEW.pph_amount,NEW.pph_code_id,
      COALESCE(NEW.pph_treatment,'deduct'),NEW.stamp_duty_amount,
      NEW.fixed_asset_account_id,COALESCE(NEW.bank_charges_amount,0),
      NEW.transaction_currency,NEW.exchange_rate,NEW.supplier_id,NEW.payee_id,NEW.staff_id,
      COALESCE(NEW.bpjs_employee_deduction, 0)
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT count(*), (array_agg(id ORDER BY created_at DESC,id DESC))[1]
    INTO v_active_count,v_journal_id
    FROM public.journal_entries
   WHERE source_module IN('expense','expenses')
     AND (reference_id=NEW.id OR reference_number='EXP-'||NEW.id::text)
     AND is_posted=true AND NOT COALESCE(is_reversed,false);

  IF v_active_count>1 THEN
    RAISE EXCEPTION 'Expense % has multiple active journals; edit is blocked',NEW.id;
  END IF;
  IF TG_OP='UPDATE' AND OLD.approval_status='approved' AND v_active_count<>1 THEN
    RAISE EXCEPTION 'Approved expense % must have exactly one active journal before edit',NEW.id;
  END IF;
  IF v_journal_id IS NOT NULL THEN
    PERFORM 1 FROM public.journal_entries WHERE id=v_journal_id FOR UPDATE;
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id=v_journal_id;
  END IF;

  IF NEW.payment_method='cash' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='1101' LIMIT 1;
  ELSIF NEW.payment_method='petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  ELSIF NEW.payment_method IS NOT NULL AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM public.bank_accounts WHERE id=NEW.bank_account_id;
  ELSIF NEW.payment_method IS NULL OR NEW.payment_method = 'outstanding' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  END IF;
  IF v_payment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post expense %: the selected payment/AP account is not configured',NEW.id;
  END IF;

  IF NEW.expense_category='pib_import' THEN
    v_bm_account_id:=public.get_expense_account_id('duty_customs');
    v_ppn_account_id:=public.get_expense_account_id('ppn_import');
    v_pph_account_id:=public.get_expense_account_id('pph_import');
    IF COALESCE(NEW.pib_bm_amount,0)>0 AND v_bm_account_id IS NULL THEN RAISE EXCEPTION 'Import Duty account is missing'; END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Import account is missing'; END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 AND v_pph_account_id IS NULL THEN RAISE EXCEPTION 'PPh Import account is missing'; END IF;
    v_total:=NEW.amount;
    v_journal_id:=public.upsert_expense_journal_header_in_place(
      v_journal_id,NEW.id,NEW.expense_date,COALESCE(NEW.description,'PIB Import Payment'),
      'pib_import',v_total,NEW.created_by);
    v_line_num:=1;
    IF COALESCE(NEW.pib_bm_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_bm_account_id,NEW.pib_bm_amount,0,'PIB - Import Duty (BM) [landed cost]',NULL,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.pib_ppn_amount,0,'PIB - PPN Import (Input VAT)',NULL,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_pph_account_id,NEW.pib_pph_amount,0,'PIB - PPh 22 Dibayar Dimuka',NULL,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,NEW.amount,'PIB - Payment ['||COALESCE(NEW.description,'')||']',NULL,NEW.payee_id);
    RETURN NEW;
  END IF;

  v_expense_account_id:=public.get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post expense %: No COA account configured for category "%"',NEW.id,NEW.expense_category;
  END IF;

  IF NEW.expense_category='fixed_asset' AND NEW.fixed_asset_account_id IS NOT NULL THEN
    v_expense_account_id:=NEW.fixed_asset_account_id;
  END IF;

  v_pph_account_id:=public.get_pph_liability_account_id(NEW.pph_code_id);
  v_ppn_account_id:=public.get_ppn_input_account_id();
  v_pph_treatment:=COALESCE(NEW.pph_treatment,'deduct');
  v_bank_charges:=COALESCE(NEW.bank_charges_amount,0);

  IF v_pph_treatment='add' THEN
    v_tax_benefit_account_id:=public.get_tax_benefit_expense_account_id();
    IF v_tax_benefit_account_id IS NULL THEN
      v_tax_benefit_account_id:=v_expense_account_id;
    END IF;
  END IF;

  -- Employee net payment calculation (deducts PPh if 'deduct', and deducts BPJS employee deduction)
  IF v_pph_treatment='add' THEN
    v_net_payment := NEW.amount + COALESCE(NEW.ppn_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges - COALESCE(NEW.bpjs_employee_deduction, 0);
  ELSE
    v_net_payment := NEW.amount + COALESCE(NEW.ppn_amount,0) - COALESCE(NEW.pph_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges - COALESCE(NEW.bpjs_employee_deduction, 0);
  END IF;

  SELECT name INTO v_category_label FROM public.expense_categories WHERE code=NEW.expense_category;
  v_description:=COALESCE(NEW.description,v_category_label,'Expense');
  v_credit_desc:=v_description;

  v_total:=NEW.amount+COALESCE(NEW.ppn_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;
  IF v_pph_treatment='add' THEN
    v_total:=v_total+COALESCE(NEW.pph_amount,0);
  END IF;

  v_journal_id:=public.upsert_expense_journal_header_in_place(
    v_journal_id,NEW.id,NEW.expense_date,v_description,
    NEW.expense_category,v_total,NEW.created_by);

  -- 1. Debit expense (Gross salary or expense amount)
  v_line_num:=1;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
  VALUES(v_journal_id,v_line_num,v_expense_account_id,NEW.amount,0,v_description,NEW.supplier_id,NEW.payee_id,NEW.staff_id);

  -- 2. Debit Tax benefit (if PPh is add-on)
  IF v_pph_treatment='add' AND COALESCE(NEW.pph_amount,0)>0 THEN
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
    VALUES(v_journal_id,v_line_num,v_tax_benefit_account_id,NEW.pph_amount,0,
      v_description||' - Tax Benefit (PPh Paid by Company)',NEW.supplier_id,NEW.payee_id,NEW.staff_id);
  END IF;

  -- 3. Debit PPN Input (if applicable)
  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    IF v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Input account is missing'; END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
    VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,v_description||' - PPN Input',NEW.supplier_id,NEW.payee_id,NEW.staff_id);
  END IF;

  -- 4. Debit Stamp Duty (if applicable)
  IF COALESCE(NEW.stamp_duty_account_id,NULL) IS NULL AND COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    v_stamp_duty_account_id:=public.get_expense_account_id('office_supplies');
    IF v_stamp_duty_account_id IS NULL THEN v_stamp_duty_account_id:=v_expense_account_id; END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
    VALUES(v_journal_id,v_line_num,v_stamp_duty_account_id,NEW.stamp_duty_amount,0,v_description||' - Bea Meterai',NEW.supplier_id,NEW.payee_id,NEW.staff_id);
  END IF;

  -- 5. Debit Bank Charges (if applicable)
  IF v_bank_charges>0 THEN
    v_bank_charge_acc_id:=public.get_expense_account_id('bank_charges');
    IF v_bank_charge_acc_id IS NULL THEN
      SELECT id INTO v_bank_charge_acc_id FROM public.chart_of_accounts WHERE code='6900' LIMIT 1;
    END IF;
    IF v_bank_charge_acc_id IS NULL THEN v_bank_charge_acc_id:=v_expense_account_id; END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,v_description||' - Bank Charges',NEW.supplier_id,NEW.payee_id,NEW.staff_id);
  END IF;

  -- 6. Credit PPh Liability (if applicable)
  IF COALESCE(NEW.pph_amount,0)>0 THEN
    IF v_pph_account_id IS NULL THEN RAISE EXCEPTION 'PPh Payable account is missing'; END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,
      CASE WHEN v_pph_treatment='add' THEN v_description||' - PPh Payable (Company Covered)'
           ELSE v_description||' - PPh Withheld' END,
      NEW.supplier_id,NEW.payee_id,NEW.staff_id);
  END IF;

  -- 7. Credit BPJS Ketenagakerjaan Liability for Employee Deduction (if applicable)
  IF COALESCE(NEW.bpjs_employee_deduction, 0) > 0 THEN
    SELECT id INTO v_bpjs_payable_acc_id FROM public.chart_of_accounts WHERE code = '2134' LIMIT 1;
    IF v_bpjs_payable_acc_id IS NULL THEN
      SELECT id INTO v_bpjs_payable_acc_id FROM public.chart_of_accounts WHERE code = '2135' LIMIT 1;
    END IF;
    IF v_bpjs_payable_acc_id IS NULL THEN
      RAISE EXCEPTION 'BPJS Payable account (2134) is missing';
    END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
    VALUES(v_journal_id,v_line_num,v_bpjs_payable_acc_id,0,NEW.bpjs_employee_deduction,
      v_description||' - BPJS Ketenagakerjaan Withheld',NEW.supplier_id,NEW.payee_id,NEW.staff_id);
  END IF;

  -- 8. Credit Net AP / Payment Account
  IF v_net_payment>0 THEN
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment,v_credit_desc,NEW.supplier_id,NEW.payee_id,NEW.staff_id);
  END IF;

  RETURN NEW;
END;
$function$;

-- 4. Update save_finance_expense
CREATE OR REPLACE FUNCTION public.save_finance_expense(
  p_expense_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_id uuid;
  v_orig_line_id uuid;
  v_date date;
  v_cat text;
  v_pay_method text;
  v_bank_id uuid;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_docs text[];
  v_sup_id uuid;
  v_staff_id uuid;
  v_payee_id uuid;
  v_ppn_amt numeric;
  v_pph_amt numeric;
  v_pph_treatment text;
  v_bpjs_ded numeric;
  v_bpjs_item_id uuid;
  v_p_month integer;
  v_p_year integer;
  v_desc text;
  v_month_match text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF COALESCE((p_payload->>'amount')::numeric, 0) <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero';
  END IF;

  v_cat := p_payload->>'expense_category';
  IF v_cat IS NULL OR v_cat = '' THEN
    RAISE EXCEPTION 'Expense category is required';
  END IF;

  v_date := COALESCE((p_payload->>'expense_date')::date, CURRENT_DATE);
  v_pay_method := NULLIF(p_payload->>'payment_method', '');
  v_bank_id := NULLIF(p_payload->>'bank_account_id', '')::uuid;

  IF v_bank_id IS NOT NULL THEN
    SELECT currency INTO v_bank_currency FROM public.bank_accounts WHERE id = v_bank_id;
    IF v_bank_currency IS NULL THEN
      RAISE EXCEPTION 'Selected bank account does not exist';
    END IF;
  END IF;

  v_currency := COALESCE(NULLIF(p_payload->>'transaction_currency', ''), v_bank_currency, 'IDR');
  IF v_currency = 'USD' THEN
    v_rate := COALESCE((p_payload->>'exchange_rate')::numeric, 1);
    IF v_rate <= 1 THEN
      RAISE EXCEPTION 'A valid USD rate greater than 1 is required';
    END IF;
  ELSE
    v_currency := 'IDR';
    v_rate := 1;
  END IF;

  IF p_payload ? 'document_urls' THEN
    SELECT COALESCE(array_agg(elem::text), ARRAY[]::text[])
      INTO v_docs
      FROM jsonb_array_elements_text(p_payload->'document_urls') AS elem;
  ELSE
    v_docs := ARRAY[]::text[];
  END IF;

  v_sup_id := NULLIF(p_payload->>'supplier_id', '')::uuid;
  v_staff_id := NULLIF(p_payload->>'staff_id', '')::uuid;
  v_payee_id := NULLIF(p_payload->>'payee_id', '')::uuid;

  v_ppn_amt := COALESCE(NULLIF(p_payload->>'ppn_amount', '')::numeric, 0);
  v_pph_amt := COALESCE(NULLIF(p_payload->>'pph_amount', '')::numeric, 0);
  v_pph_treatment := COALESCE(NULLIF(p_payload->>'pph_treatment', ''), 'deduct');

  -- Salary and BPJS period handling
  v_bpjs_ded := COALESCE(NULLIF(p_payload->>'bpjs_employee_deduction', '')::numeric, 0);
  v_bpjs_item_id := NULLIF(p_payload->>'bpjs_register_item_id', '')::uuid;
  v_p_month := NULLIF(p_payload->>'payroll_period_month', '')::integer;
  v_p_year := NULLIF(p_payload->>'payroll_period_year', '')::integer;
  v_desc := NULLIF(p_payload->>'description', '');

  IF v_cat = 'salary' THEN
    -- Parse payroll period if missing
    IF v_p_month IS NULL OR v_p_year IS NULL THEN
      IF v_desc ~ '·\s*([A-Za-z]{3})-(\d{2})' THEN
        v_month_match := regexp_matches(v_desc, '·\s*([A-Za-z]{3})-(\d{2})');
        v_p_year := 2000 + v_month_match[2]::integer;
        v_p_month := CASE lower(v_month_match[1])
          WHEN 'jan' THEN 1 WHEN 'feb' THEN 2 WHEN 'mar' THEN 3 WHEN 'apr' THEN 4
          WHEN 'may' THEN 5 WHEN 'jun' THEN 6 WHEN 'jul' THEN 7 WHEN 'aug' THEN 8
          WHEN 'sep' THEN 9 WHEN 'oct' THEN 10 WHEN 'nov' THEN 11 WHEN 'dec' THEN 12
          ELSE EXTRACT(MONTH FROM v_date)::integer
        END;
      ELSE
        v_p_year := EXTRACT(YEAR FROM v_date)::integer;
        v_p_month := EXTRACT(MONTH FROM v_date)::integer;
      END IF;
    END IF;

    -- Derive BPJS deduction from Staff Master if not provided
    IF v_bpjs_ded = 0 AND v_staff_id IS NOT NULL THEN
      DECLARE
        v_sal_calc jsonb;
      BEGIN
        v_sal_calc := public.calculate_staff_salary(v_staff_id, v_date, (p_payload->>'amount')::numeric);
        v_bpjs_ded := COALESCE((v_sal_calc->>'bpjs_amount')::numeric, 0);
      EXCEPTION WHEN OTHERS THEN
        v_bpjs_ded := 0;
      END;
    END IF;

    -- Link BPJS register item if not explicitly passed
    IF v_bpjs_item_id IS NULL AND v_staff_id IS NOT NULL AND v_p_year IS NOT NULL AND v_p_month IS NOT NULL THEN
      SELECT ri.id INTO v_bpjs_item_id
        FROM public.bpjs_monthly_register_items ri
        JOIN public.bpjs_monthly_registers r ON r.id = ri.register_id
       WHERE ri.staff_id = v_staff_id
         AND r.period_year = v_p_year
         AND r.period_month = v_p_month
       LIMIT 1;
    END IF;
  END IF;

  v_orig_line_id := NULLIF(p_payload->>'originating_bank_statement_line_id', '')::uuid;

  IF p_expense_id IS NULL THEN
    INSERT INTO public.finance_expenses (
      expense_category, expense_type, amount, expense_date, description, batch_id,
      import_container_id, delivery_challan_id,
      payment_method, bank_account_id, payment_reference,
      paid_by, document_urls,
      supplier_id, staff_id, payee_id,
      linked_sales_invoice_id,
      pph_calculation_regime,
      pph_dpp_ratio,
      pph_dpp_amount,
      pph_rate,
      is_tax_manual_override,
      invoice_number, due_date,
      broker_items, pib_bm_amount,
      pib_ppn_amount, pib_pph_amount,
      ppn_amount, ppn_manual_override,
      ppn_calc_mode, dpp_amount,
      ppn_rate, pph_amount,
      pph_code_id, pph_treatment,
      stamp_duty_amount,
      fixed_asset_account_id,
      bank_charges_amount,
      approval_status,
      created_by,
      currency_code, transaction_currency, functional_currency, exchange_rate, bank_account_currency, payment_currency,
      sales_order_allocations,
      originating_bank_statement_line_id,
      bpjs_employee_deduction,
      bpjs_register_item_id,
      payroll_period_month,
      payroll_period_year
    ) VALUES (
      v_cat, COALESCE(NULLIF(p_payload->>'expense_type',''),'admin'),
      (p_payload->>'amount')::numeric, v_date, v_desc, NULLIF(p_payload->>'batch_id','')::uuid,
      NULLIF(p_payload->>'import_container_id','')::uuid, NULLIF(p_payload->>'delivery_challan_id','')::uuid,
      v_pay_method, v_bank_id, NULLIF(p_payload->>'payment_reference',''),
      NULLIF(p_payload->>'paid_by',''), NULLIF(v_docs, ARRAY[]::text[]),
      v_sup_id, v_staff_id, v_payee_id,
      NULLIF(p_payload->>'linked_sales_invoice_id', '')::uuid,
      NULLIF(p_payload->>'pph_calculation_regime', ''),
      NULLIF(p_payload->>'pph_dpp_ratio', '')::numeric,
      NULLIF(p_payload->>'pph_dpp_amount', '')::numeric,
      NULLIF(p_payload->>'pph_rate', '')::numeric,
      COALESCE((p_payload->>'is_tax_manual_override')::boolean, false),
      NULLIF(p_payload->>'invoice_number',''), NULLIF(p_payload->>'due_date','')::date,
      NULLIF(p_payload->'broker_items','null'::jsonb), NULLIF(p_payload->>'pib_bm_amount','')::numeric,
      NULLIF(p_payload->>'pib_ppn_amount','')::numeric, NULLIF(p_payload->>'pib_pph_amount','')::numeric,
      v_ppn_amt, COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
      COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'), NULLIF(p_payload->>'dpp_amount','')::numeric,
      COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11), v_pph_amt,
      NULLIF(p_payload->>'pph_code_id','')::uuid, v_pph_treatment,
      COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
      NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
      COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
      COALESCE(NULLIF(p_payload->>'approval_status',''),'pending_approval'),
      COALESCE(NULLIF(p_payload->>'created_by','')::uuid, auth.uid()),
      v_currency, v_currency, 'IDR', v_rate, COALESCE(v_bank_currency,v_currency), v_currency,
      COALESCE(p_payload->'sales_order_allocations', '[]'::jsonb),
      v_orig_line_id,
      v_bpjs_ded,
      v_bpjs_item_id,
      v_p_month,
      v_p_year
    ) RETURNING id INTO v_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.finance_expenses WHERE id=p_expense_id AND approval_status='approved') THEN
      RAISE EXCEPTION 'This expense is posted. Cancel Posting first to make changes.';
    END IF;
    UPDATE public.finance_expenses SET
      expense_category=v_cat, expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),'admin'),
      amount=(p_payload->>'amount')::numeric, expense_date=v_date, description=v_desc,
      batch_id=NULLIF(p_payload->>'batch_id','')::uuid, import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
      delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
      payment_method=v_pay_method, bank_account_id=v_bank_id,
      payment_reference=NULLIF(p_payload->>'payment_reference',''), paid_by=NULLIF(p_payload->>'paid_by',''),
      document_urls=NULLIF(v_docs,ARRAY[]::text[]), supplier_id=v_sup_id,
      staff_id=v_staff_id, payee_id=v_payee_id,
      linked_sales_invoice_id=NULLIF(p_payload->>'linked_sales_invoice_id', '')::uuid,
      pph_calculation_regime=NULLIF(p_payload->>'pph_calculation_regime', ''),
      pph_dpp_ratio=NULLIF(p_payload->>'pph_dpp_ratio', '')::numeric,
      pph_dpp_amount=NULLIF(p_payload->>'pph_dpp_amount', '')::numeric,
      pph_rate=NULLIF(p_payload->>'pph_rate', '')::numeric,
      is_tax_manual_override=COALESCE((p_payload->>'is_tax_manual_override')::boolean, false),
      invoice_number=NULLIF(p_payload->>'invoice_number',''),
      due_date=NULLIF(p_payload->>'due_date','')::date, broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
      pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,
      pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
      pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,
      ppn_amount=v_ppn_amt,
      ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
      ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),
      dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric, ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),
      pph_amount=v_pph_amt, pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,
      pph_treatment=v_pph_treatment,
      stamp_duty_amount=COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
      fixed_asset_account_id=NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
      bank_charges_amount=COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
      currency_code=v_currency, transaction_currency=v_currency, functional_currency='IDR', exchange_rate=v_rate,
      bank_account_currency=COALESCE(v_bank_currency,v_currency), payment_currency=v_currency,
      sales_order_allocations=COALESCE(p_payload->'sales_order_allocations', '[]'::jsonb),
      originating_bank_statement_line_id=COALESCE(v_orig_line_id, originating_bank_statement_line_id),
      bpjs_employee_deduction=v_bpjs_ded,
      bpjs_register_item_id=v_bpjs_item_id,
      payroll_period_month=v_p_month,
      payroll_period_year=v_p_year
    WHERE id=p_expense_id RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$function$;

-- 5. Update edit_approved_finance_expense_atomic
CREATE OR REPLACE FUNCTION public.edit_approved_finance_expense_atomic(
  p_expense_id uuid,
  p_payload jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL::uuid,
  p_allocation_amount numeric DEFAULT NULL::numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_exp public.finance_expenses%rowtype;
  v_journal_id uuid;
  v_journal_count integer;
  v_date date;
  v_bank_id uuid;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_docs text[];
  v_period_status text;
  v_effective_allocation numeric;
  v_bpjs_ded numeric;
  v_bpjs_item_id uuid;
  v_p_month integer;
  v_p_year integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_exp FROM public.finance_expenses WHERE id=p_expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_exp.approval_status<>'approved' THEN RAISE EXCEPTION 'Approved expense edit requires an approved expense'; END IF;

  SELECT count(*),(array_agg(id ORDER BY created_at DESC,id DESC))[1]
    INTO v_journal_count,v_journal_id
    FROM public.journal_entries
   WHERE source_module IN('expense','expenses')
     AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
     AND is_posted=true AND NOT COALESCE(is_reversed,false);
  IF v_journal_count<>1 THEN RAISE EXCEPTION 'Approved expense must have exactly one active effective journal'; END IF;
  PERFORM 1 FROM public.journal_entries WHERE id=v_journal_id FOR UPDATE;

  SELECT ap.status INTO v_period_status
    FROM public.journal_entries je
    LEFT JOIN public.accounting_periods ap
      ON ap.start_date<=je.entry_date AND ap.end_date>=je.entry_date
   WHERE je.id=v_journal_id
   ORDER BY ap.start_date DESC LIMIT 1;
  IF v_period_status IS NOT NULL AND v_period_status<>'open' THEN
    RAISE EXCEPTION 'Cannot edit approved expense in a closed accounting period';
  END IF;

  IF COALESCE((p_payload->>'amount')::numeric,0)<=0 THEN RAISE EXCEPTION 'Expense amount must be greater than zero'; END IF;
  IF NULLIF(p_payload->>'expense_category','') IS NULL THEN RAISE EXCEPTION 'Expense category is required'; END IF;
  v_date:=COALESCE((p_payload->>'expense_date')::date,current_date);
  v_bank_id:=NULLIF(p_payload->>'bank_account_id','')::uuid;

  IF v_bank_id IS NOT NULL THEN
    SELECT currency INTO v_bank_currency FROM public.bank_accounts WHERE id=v_bank_id;
    IF v_bank_currency IS NULL THEN RAISE EXCEPTION 'Selected bank account does not exist'; END IF;
  END IF;

  v_currency:=COALESCE(NULLIF(p_payload->>'transaction_currency',''),v_bank_currency,v_exp.transaction_currency,'IDR');
  IF v_currency='USD' THEN
    v_rate:=COALESCE((p_payload->>'exchange_rate')::numeric,v_exp.exchange_rate,1);
    IF v_rate<=1 THEN RAISE EXCEPTION 'A valid USD rate greater than 1 is required'; END IF;
  ELSE
    v_currency:='IDR';
    v_rate:=1;
  END IF;

  IF p_payload ? 'document_urls' THEN
    SELECT COALESCE(array_agg(elem::text),ARRAY[]::text[])
      INTO v_docs
      FROM jsonb_array_elements_text(p_payload->'document_urls') AS elem;
  ELSE
    v_docs:=v_exp.document_urls;
  END IF;

  v_bpjs_ded := COALESCE(NULLIF(p_payload->>'bpjs_employee_deduction','')::numeric, v_exp.bpjs_employee_deduction, 0);
  v_bpjs_item_id := COALESCE(NULLIF(p_payload->>'bpjs_register_item_id','')::uuid, v_exp.bpjs_register_item_id);
  v_p_month := COALESCE(NULLIF(p_payload->>'payroll_period_month','')::integer, v_exp.payroll_period_month);
  v_p_year := COALESCE(NULLIF(p_payload->>'payroll_period_year','')::integer, v_exp.payroll_period_year);

  UPDATE public.finance_expenses SET
    expense_category=p_payload->>'expense_category',
    expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),v_exp.expense_type,'general'),
    amount=(p_payload->>'amount')::numeric,
    expense_date=v_date,
    description=NULLIF(p_payload->>'description',''),
    batch_id=NULLIF(p_payload->>'batch_id','')::uuid,
    import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
    delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
    payment_method=NULLIF(p_payload->>'payment_method',''),
    bank_account_id=v_bank_id,
    payment_reference=NULLIF(p_payload->>'payment_reference',''),
    paid_by=CASE WHEN NULLIF(p_payload->>'payment_method','') IN('cash','petty_cash') THEN 'cash' WHEN v_bank_id IS NOT NULL THEN 'bank' ELSE NULL END,
    document_urls=v_docs,
    supplier_id=NULLIF(p_payload->>'supplier_id','')::uuid,
    staff_id=NULLIF(p_payload->>'staff_id','')::uuid,
    payee_id=NULLIF(p_payload->>'payee_id','')::uuid,
    invoice_number=NULLIF(p_payload->>'invoice_number',''),
    due_date=NULLIF(p_payload->>'due_date','')::date,
    broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
    pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,
    pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
    pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,
    ppn_amount=COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0),
    ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
    ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),
    dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric,
    ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),
    pph_amount=COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,
    pph_treatment=COALESCE(NULLIF(p_payload->>'pph_treatment',''),'deduct'),
    stamp_duty_amount=COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
    fixed_asset_account_id=NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
    bank_charges_amount=COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
    currency_code=v_currency,
    transaction_currency=v_currency,
    functional_currency='IDR',
    exchange_rate=v_rate,
    bank_account_currency=COALESCE(v_bank_currency,v_currency),
    payment_currency=v_currency,
    sales_order_allocations=COALESCE(p_payload->'sales_order_allocations','[]'::jsonb),
    bpjs_employee_deduction=v_bpjs_ded,
    bpjs_register_item_id=v_bpjs_item_id,
    payroll_period_month=v_p_month,
    payroll_period_year=v_p_year
  WHERE id=p_expense_id;

  RETURN p_expense_id;
END;
$function$;

-- 6. Update generate_bpjs_monthly_register to link salary expenses
CREATE OR REPLACE FUNCTION public.generate_bpjs_monthly_register(
  p_year integer,
  p_month integer,
  p_official_bill numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_period_date date;
  v_register_id uuid;
  v_register public.bpjs_monthly_registers%ROWTYPE;
  v_staff record;
  v_calc jsonb;
  v_item_id uuid;
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
    IF v_register.status IN ('posted', 'reconciled') THEN
      RAISE EXCEPTION 'Cannot recalculate %-%: register is already %', p_year, p_month, v_register.status;
    END IF;
    v_register_id := v_register.id;
    -- Clear linked register items from expenses before deleting draft items
    UPDATE public.finance_expenses
       SET bpjs_register_item_id = NULL
     WHERE bpjs_register_item_id IN (
       SELECT id FROM public.bpjs_monthly_register_items WHERE register_id = v_register_id
     );
    DELETE FROM public.bpjs_monthly_register_items WHERE register_id = v_register_id;
  ELSE
    INSERT INTO public.bpjs_monthly_registers (
      period_year, period_month, official_billed_amount, has_official_bill, created_by
    ) VALUES (
      p_year, p_month, p_official_bill, (p_official_bill IS NOT NULL), auth.uid()
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

      -- Link corresponding salary expense for this staff member and payroll period
      UPDATE public.finance_expenses
         SET bpjs_register_item_id = v_item_id
       WHERE staff_id = v_staff.id
         AND expense_category = 'salary'
         AND (
           (payroll_period_year = p_year AND payroll_period_month = p_month)
           OR (payroll_period_year IS NULL AND description ILIKE '%' || to_char(v_period_date, 'Mon-YY') || '%')
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
         has_official_bill = CASE WHEN p_official_bill IS NOT NULL THEN true ELSE has_official_bill END,
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

-- 7. Historical Data Reconciliation
DO $$
BEGIN
  PERFORM set_config('app.finance_metadata_repair', 'on', true);
END $$;

-- Chintia Benazir Widjaya (EXP/26/366):
-- Gross Rp 3,800,000, Employee BPJS Rp 76,000, Net Rp 3,724,000, Paid Rp 3,724,000.
-- Oct 2026 payroll. Payment matches net payable exactly.
UPDATE public.finance_expenses
   SET bpjs_employee_deduction = 76000.00,
       payroll_period_month = 10,
       payroll_period_year = 2026,
       bpjs_register_item_id = 'f8bffe29-55bb-445b-8626-260726705a04'::uuid
 WHERE voucher_number = 'EXP/26/366';

-- Update Chintia's expense journal JE2610-0250 lines:
-- Debit 6100 Salaries & Wages: Rp 3,800,000.00
-- Credit 2134 BPJS Ketenagakerjaan Payable: Rp 76,000.00
-- Credit 2110 Accounts Payable: Rp 3,724,000.00
DO $$
DECLARE
  v_je_id uuid := '228da849-df20-4fc7-8615-91ea6e5094a5'::uuid;
  v_bpjs_coa uuid;
  v_ap_coa uuid;
BEGIN
  SELECT id INTO v_bpjs_coa FROM public.chart_of_accounts WHERE code = '2134' LIMIT 1;
  SELECT id INTO v_ap_coa FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;

  -- Update AP line to net payable (3,724,000)
  UPDATE public.journal_entry_lines
     SET credit = 3724000.00,
         transaction_credit = 3724000.00
   WHERE journal_entry_id = v_je_id AND account_id = v_ap_coa;

  -- Add or update BPJS Payable line for 76,000
  IF EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id AND account_id = v_bpjs_coa) THEN
    UPDATE public.journal_entry_lines
       SET credit = 76000.00,
           transaction_credit = 76000.00
     WHERE journal_entry_id = v_je_id AND account_id = v_bpjs_coa;
  ELSE
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description,
      transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate, staff_id
    ) VALUES (
      v_je_id, 3, v_bpjs_coa, 0, 76000.00, '[Chintia Benazir Widjaya · Oct-26] [BPJS Withheld]',
      'IDR', 0, 76000.00, 'IDR', 1.0, 'a584900a-0155-4444-b906-f080b3826f88'::uuid
    );
  END IF;
END $$;

-- Nia Delisma Nasution (EXP/26/363):
-- Gross Rp 8,500,000, PPh21 Rp 170,000, Employee BPJS Rp 170,000.
-- Nov 2026 payroll. Paid Rp 8,330,000 (historical payment preserved, not linked to Oct register).
UPDATE public.finance_expenses
   SET bpjs_employee_deduction = 170000.00,
       payroll_period_month = 11,
       payroll_period_year = 2026,
       bpjs_register_item_id = NULL
 WHERE voucher_number = 'EXP/26/363';

-- Backfill payroll_period_month and payroll_period_year for other existing salary expenses based on description/expense_date
UPDATE public.finance_expenses
   SET payroll_period_year = COALESCE(payroll_period_year, EXTRACT(YEAR FROM expense_date)::integer),
       payroll_period_month = COALESCE(
         payroll_period_month,
         CASE
           WHEN description ~* '·\s*Jan' OR description ~* 'Jan\s*202' OR description ~* 'Jan-2' THEN 1
           WHEN description ~* '·\s*Feb' OR description ~* 'Feb\s*202' OR description ~* 'Feb-2' THEN 2
           WHEN description ~* '·\s*Mar' OR description ~* 'Mar\s*202' OR description ~* 'Mar-2' THEN 3
           WHEN description ~* '·\s*Apr' OR description ~* 'Apr\s*202' OR description ~* 'Apr-2' THEN 4
           WHEN description ~* '·\s*May' OR description ~* 'May\s*202' OR description ~* 'May-2' THEN 5
           WHEN description ~* '·\s*Jun' OR description ~* 'Jun\s*202' OR description ~* 'Jun-2' THEN 6
           WHEN description ~* '·\s*Jul' OR description ~* 'Jul\s*202' OR description ~* 'Jul-2' THEN 7
           WHEN description ~* '·\s*Aug' OR description ~* 'Aug\s*202' OR description ~* 'Aug-2' THEN 8
           WHEN description ~* '·\s*Sep' OR description ~* 'Sep\s*202' OR description ~* 'Sep-2' THEN 9
           WHEN description ~* '·\s*Oct' OR description ~* 'Oct\s*202' OR description ~* 'Oct-2' THEN 10
           WHEN description ~* '·\s*Nov' OR description ~* 'Nov\s*202' OR description ~* 'Nov-2' THEN 11
           WHEN description ~* '·\s*Dec' OR description ~* 'Dec\s*202' OR description ~* 'Dec-2' THEN 12
           ELSE EXTRACT(MONTH FROM expense_date)::integer
         END
       )
 WHERE expense_category = 'salary'
   AND (payroll_period_month IS NULL OR payroll_period_year IS NULL);

COMMIT;
