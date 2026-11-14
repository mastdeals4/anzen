BEGIN;

-- Repair missing helper dependencies referenced by auto_post_expense_accounting().
CREATE OR REPLACE FUNCTION public.get_pph_liability_account_id(p_tax_code_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(tc.collection_account_id, tc.payment_account_id)
    FROM public.tax_codes tc
   WHERE tc.id = p_tax_code_id
     AND tc.tax_type LIKE 'PPh%';
$function$;

CREATE OR REPLACE FUNCTION public.get_ppn_input_account_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT id FROM public.chart_of_accounts
   WHERE code = '1150' AND is_active = true AND NOT is_header
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_tax_benefit_expense_account_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT NULL::uuid;
$function$;

COMMENT ON FUNCTION public.get_pph_liability_account_id(uuid)
IS 'Resolves PPh liability from tax_codes.collection_account_id, falling back to payment_account_id.';
COMMENT ON FUNCTION public.get_ppn_input_account_id()
IS 'Returns active Input VAT COA 1150.';
COMMENT ON FUNCTION public.get_tax_benefit_expense_account_id()
IS 'Returns NULL when no dedicated PPh company-borne expense COA is configured, invoking source expense account fallback.';

REVOKE ALL ON FUNCTION public.get_pph_liability_account_id(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_ppn_input_account_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_tax_benefit_expense_account_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pph_liability_account_id(uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_ppn_input_account_id() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_tax_benefit_expense_account_id() TO postgres, service_role;

-- Align the main journal poster with the current expense_categories schema.
DO $patch$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.auto_post_expense_accounting()'::regprocedure)
    INTO v_def;

  v_def := replace(
    v_def,
    'FROM public.expense_categories WHERE code=NEW.expense_category',
    'FROM public.expense_categories WHERE category_key=NEW.expense_category'
  );
  v_def := replace(
    v_def,
    'COALESCE(NEW.stamp_duty_account_id,NULL) IS NULL AND ',
    ''
  );

  IF position('expense_categories WHERE code=NEW.expense_category' in v_def) > 0
     OR position('NEW.stamp_duty_account_id' in v_def) > 0 THEN
    RAISE EXCEPTION 'Stale field references remain in expense-posting function';
  END IF;

  EXECUTE v_def;
END
$patch$;

-- Prevent the secondary PPh sync trigger from adding a duplicate PPh line after
-- auto_post_expense_accounting has already created the PPh Payable (Company Covered) line.
CREATE OR REPLACE FUNCTION public.trg_sync_expense_pph_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account_id uuid;
  v_journal_id uuid;
  v_line_number integer;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.expense_category = 'import_broker' OR COALESCE(NEW.pph_amount,0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_account_id := public.fn_pph_payable_account_id(NEW.pph_code_id);
  IF v_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_journal_id
    FROM public.journal_entries
   WHERE reference_id = NEW.id
     AND source_module IN ('expense','expenses')
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_journal_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Main expense journal trigger already posted the PPh liability line.
  IF EXISTS (
    SELECT 1
      FROM public.journal_entry_lines
     WHERE journal_entry_id = v_journal_id
       AND debit = 0
       AND credit > 0
       AND (
         account_id = v_account_id
         OR description ILIKE '%PPh Payable%'
         OR description ILIKE '%PPh Withheld%'
         OR description ILIKE 'PPh Ditahan%'
       )
  ) THEN
    UPDATE public.journal_entry_lines
       SET account_id = v_account_id,
           payee_id = NEW.payee_id,
           staff_id = NEW.staff_id
     WHERE journal_entry_id = v_journal_id
       AND debit = 0
       AND credit > 0
       AND (
         account_id = v_account_id
         OR description ILIKE '%PPh Payable%'
         OR description ILIKE '%PPh Withheld%'
         OR description ILIKE 'PPh Ditahan%'
       );
  ELSE
    -- Legacy journal fallback: split PPh from the largest existing credit and add the liability line.
    UPDATE public.journal_entry_lines
       SET credit = credit - NEW.pph_amount
     WHERE id = (
       SELECT id
         FROM public.journal_entry_lines
        WHERE journal_entry_id = v_journal_id
          AND credit >= NEW.pph_amount
        ORDER BY credit DESC, line_number DESC
        LIMIT 1
     );

    SELECT COALESCE(MAX(line_number),0)+1 INTO v_line_number
      FROM public.journal_entry_lines
     WHERE journal_entry_id = v_journal_id;

    INSERT INTO public.journal_entry_lines
      (journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id,staff_id)
    VALUES
      (v_journal_id,v_line_number,v_account_id,0,NEW.pph_amount,
       'PPh Ditahan - '||COALESCE(NEW.description,NEW.voucher_number,'Expense'),
       NEW.supplier_id,NEW.payee_id,NEW.staff_id);
  END IF;

  UPDATE public.journal_entries
     SET total_debit = (
           SELECT COALESCE(SUM(debit),0)
             FROM public.journal_entry_lines
            WHERE journal_entry_id = v_journal_id
         ),
         total_credit = (
           SELECT COALESCE(SUM(credit),0)
             FROM public.journal_entry_lines
            WHERE journal_entry_id = v_journal_id
         )
   WHERE id = v_journal_id;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_sync_expense_pph_account() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_sync_expense_pph_account() TO postgres, service_role;

DO $repair$
DECLARE
  v_expense public.finance_expenses%ROWTYPE;
  v_expense_je public.journal_entries%ROWTYPE;
  v_payment_je public.journal_entries%ROWTYPE;
  v_period public.tax_periods%ROWTYPE;
  v_before_pph_total numeric;
  v_after_pph_total numeric;
  v_before_source_total numeric;
  v_after_source_total numeric;
  v_expense_journal_count integer;
  v_allocation_total numeric;
  v_ap_credit numeric;
  v_bpjs_credit numeric;
  v_pph_credit numeric;
  v_salary_debit numeric;
  v_tax_benefit_debit numeric;
  v_pph_line_count integer;
BEGIN
  SELECT * INTO v_expense
    FROM public.finance_expenses
   WHERE voucher_number = 'EXP/26/363'
   FOR UPDATE;

  IF NOT FOUND
     OR v_expense.id <> '16ba0fa9-62e9-421e-9697-c4e75d40e3aa'::uuid
     OR v_expense.expense_category <> 'salary'
     OR v_expense.staff_id <> 'b0234687-5ff8-47c9-a376-01ffe7a603f4'::uuid
     OR v_expense.amount <> 8500000
     OR v_expense.pph_amount <> 170000
     OR v_expense.bpjs_employee_deduction <> 170000
     OR v_expense.paid_amount <> 8330000
     OR v_expense.payroll_period_year <> 2026
     OR v_expense.payroll_period_month <> 11
     OR v_expense.pph_tax_period_id <> 'f2fffa5e-6a74-42b0-b30d-7403e15965b4'::uuid THEN
    RAISE EXCEPTION 'EXP/26/363 no longer matches reviewed values; no changes made';
  END IF;

  SELECT * INTO v_period
    FROM public.tax_periods
   WHERE id = v_expense.pph_tax_period_id
   FOR SHARE;

  IF NOT FOUND OR v_period.fiscal_year <> 2026 OR v_period.period_month <> 10
     OR v_period.tax_type <> 'PPh21' OR v_period.filing_status NOT IN ('filed','amended') THEN
    RAISE EXCEPTION 'Expected filed October 2026 PPh21 period; no changes made';
  END IF;

  SELECT count(*) INTO v_expense_journal_count
    FROM public.journal_entries
   WHERE source_module = 'expenses'
     AND reference_id = v_expense.id
     AND is_posted = true
     AND NOT COALESCE(is_reversed,false);

  IF v_expense_journal_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active expense journal; found %', v_expense_journal_count;
  END IF;

  SELECT * INTO v_expense_je
    FROM public.journal_entries
   WHERE source_module = 'expenses'
     AND reference_id = v_expense.id
     AND is_posted = true
     AND NOT COALESCE(is_reversed,false)
   FOR UPDATE;

  SELECT * INTO v_payment_je
    FROM public.journal_entries
   WHERE source_module = 'expense_payment'
     AND reference_id = v_expense.id
     AND is_posted = true
     AND NOT COALESCE(is_reversed,false)
   FOR UPDATE;

  IF NOT FOUND OR v_payment_je.total_debit <> 8330000 OR v_payment_je.total_credit <> 8330000 THEN
    RAISE EXCEPTION 'Expected existing Rp8,330,000 payment journal; no changes made';
  END IF;

  SELECT COALESCE(SUM(allocation_amount),0) INTO v_allocation_total
    FROM public.bank_statement_allocations
   WHERE document_type = 'expense' AND document_id = v_expense.id;

  IF v_allocation_total <> 8330000 THEN
    RAISE EXCEPTION 'Expected existing bank allocation Rp8,330,000; found %; no changes made', v_allocation_total;
  END IF;

  v_before_pph_total := v_period.pph_total;
  v_before_source_total := public.fn_pph_authoritative_source_total(v_period.id);

  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.finance_metadata_repair','off',true);
  PERFORM set_config('app.finance_historical_repair','off',true);

  UPDATE public.finance_expenses
     SET pph_treatment = 'add'
   WHERE id = v_expense.id
     AND pph_treatment IS DISTINCT FROM 'add';

  SELECT * INTO v_expense
    FROM public.finance_expenses WHERE id = v_expense.id;

  IF v_expense.pph_treatment <> 'add' THEN
    RAISE EXCEPTION 'PPh treatment was not updated to Add (+)';
  END IF;

  SELECT * INTO v_expense_je
    FROM public.journal_entries
   WHERE id = v_expense_je.id;

  SELECT
    COALESCE(SUM(jl.debit) FILTER (WHERE coa.code = '6100'),0),
    COALESCE(SUM(jl.debit) FILTER (WHERE coa.code = '6100' AND jl.description ILIKE '%Tax Benefit%'),0),
    COALESCE(SUM(jl.credit) FILTER (WHERE coa.code = '2131'),0),
    COALESCE(SUM(jl.credit) FILTER (WHERE coa.code = '2134'),0),
    COALESCE(SUM(jl.credit) FILTER (WHERE coa.code = '2110'),0),
    COUNT(*) FILTER (WHERE jl.debit=0 AND jl.credit=170000 AND coa.code='2131')
    INTO v_salary_debit, v_tax_benefit_debit, v_pph_credit, v_bpjs_credit, v_ap_credit, v_pph_line_count
    FROM public.journal_entry_lines jl
    LEFT JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
   WHERE jl.journal_entry_id = v_expense_je.id;

  IF v_expense_je.total_debit <> 8670000 OR v_expense_je.total_credit <> 8670000
     OR v_salary_debit <> 8670000
     OR v_tax_benefit_debit <> 170000
     OR v_pph_credit <> 170000
     OR v_bpjs_credit <> 170000
     OR v_ap_credit <> 8330000
     OR v_pph_line_count <> 1 THEN
    RAISE EXCEPTION 'Rebuilt salary journal invalid: journal %, debit %, credit %, salary debit %, tax benefit %, PPh %, BPJS %, AP %, PPh line count %',
      v_expense_je.entry_number, v_expense_je.total_debit, v_expense_je.total_credit,
      v_salary_debit, v_tax_benefit_debit, v_pph_credit, v_bpjs_credit, v_ap_credit, v_pph_line_count;
  END IF;

  SELECT * INTO v_payment_je
    FROM public.journal_entries
   WHERE id = v_payment_je.id;

  IF v_payment_je.total_debit <> 8330000 OR v_payment_je.total_credit <> 8330000 THEN
    RAISE EXCEPTION 'Payment journal unexpectedly changed';
  END IF;

  SELECT pph_total INTO v_after_pph_total
    FROM public.tax_periods WHERE id = v_period.id;
  v_after_source_total := public.fn_pph_authoritative_source_total(v_period.id);

  IF v_after_pph_total IS DISTINCT FROM v_before_pph_total
     OR v_after_source_total IS DISTINCT FROM v_before_source_total THEN
    RAISE EXCEPTION 'Filed October PPh21 totals changed: period % -> %, source % -> %',
      v_before_pph_total, v_after_pph_total, v_before_source_total, v_after_source_total;
  END IF;
END
$repair$;

COMMIT;
