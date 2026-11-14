BEGIN;

DO $repair$
DECLARE
  v_nia public.finance_expenses%ROWTYPE;
  v_chintia public.finance_expenses%ROWTYPE;
  v_telekom public.finance_expenses%ROWTYPE;
  v_nia_item public.bpjs_monthly_register_items%ROWTYPE;
  v_oct_register public.bpjs_monthly_registers%ROWTYPE;
  v_pph_period public.tax_periods%ROWTYPE;
  v_pph_before numeric;
  v_pph_source_before numeric;
  v_alloc numeric;
  v_rows integer;
  v_journal_debit numeric;
  v_journal_credit numeric;
  v_payment_debit numeric;
  v_payment_credit numeric;
  v_telekom_journal_debit numeric;
  v_telekom_journal_credit numeric;
BEGIN
  -- Validate exact Nia salary evidence and current values.
  SELECT * INTO v_nia
    FROM public.finance_expenses
   WHERE voucher_number='EXP/26/363'
   FOR UPDATE;

  IF NOT FOUND
     OR v_nia.id <> '16ba0fa9-62e9-421e-9697-c4e75d40e3aa'::uuid
     OR v_nia.staff_id <> 'b0234687-5ff8-47c9-a376-01ffe7a603f4'::uuid
     OR v_nia.amount <> 8500000
     OR v_nia.pph_amount <> 170000
     OR v_nia.pph_treatment <> 'add'
     OR v_nia.bpjs_employee_deduction <> 170000
     OR v_nia.paid_amount <> 8330000
     OR v_nia.payroll_period_year <> 2026
     OR v_nia.payroll_period_month <> 11
     OR v_nia.bpjs_register_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'Nia salary record does not match reviewed state; no changes made';
  END IF;

  SELECT * INTO v_oct_register
    FROM public.bpjs_monthly_registers
   WHERE period_year=2026 AND period_month=10
   FOR SHARE;

  IF NOT FOUND OR v_oct_register.status <> 'draft'
     OR v_oct_register.payment_status <> 'unpaid'
     OR v_oct_register.total_reported_wages <> 12300000
     OR v_oct_register.total_employee_deductions <> 246000
     OR v_oct_register.total_employer_expenses <> 521520
     OR v_oct_register.total_contribution_payable <> 767520 THEN
    RAISE EXCEPTION 'October BPJS register does not match reviewed draft totals; no changes made';
  END IF;

  SELECT * INTO v_nia_item
    FROM public.bpjs_monthly_register_items
   WHERE id='81be19b2-0339-4607-b90a-da4e9f23dc97'
     AND register_id=v_oct_register.id
     AND staff_id=v_nia.staff_id
   FOR SHARE;

  IF NOT FOUND OR v_nia_item.total_employee_deduction <> 170000
     OR v_nia_item.total_employer_expense <> 360400
     OR v_nia_item.total_payable <> 530400 THEN
    RAISE EXCEPTION 'Nia October BPJS register item mismatch; no changes made';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.finance_expenses
     WHERE bpjs_register_item_id=v_nia_item.id AND id<>v_nia.id
  ) THEN
    RAISE EXCEPTION 'Nia October BPJS item is already linked to another expense';
  END IF;

  -- The original BCA evidence says Nia Salary Oct26 on 30 October.
  SELECT COALESCE(SUM(bsa.allocation_amount),0) INTO v_alloc
    FROM public.bank_statement_allocations bsa
    JOIN public.bank_statement_lines bsl ON bsl.id=bsa.bank_statement_line_id
   WHERE bsa.document_type='expense'
     AND bsa.document_id=v_nia.id
     AND bsl.transaction_date='2026-10-30'
     AND bsl.description ILIKE '%Nia Salary Oct26%';

  IF v_alloc <> 8330000 THEN
    RAISE EXCEPTION 'Nia October bank evidence mismatch: expected Rp8,330,000, found %',v_alloc;
  END IF;

  SELECT * INTO v_pph_period
    FROM public.tax_periods
   WHERE id=v_nia.pph_tax_period_id
   FOR SHARE;

  IF NOT FOUND OR v_pph_period.fiscal_year<>2026
     OR v_pph_period.period_month<>10
     OR v_pph_period.tax_type<>'PPh21'
     OR v_pph_period.filing_status NOT IN ('filed','amended') THEN
    RAISE EXCEPTION 'Nia PPh tax period is not the expected filed October 2026 period';
  END IF;

  v_pph_before := v_pph_period.pph_total;
  v_pph_source_before := public.fn_pph_authoritative_source_total(v_pph_period.id);

  -- Keep the already posted salary and payment journals untouched.
  SELECT COALESCE(SUM(debit),0),COALESCE(SUM(credit),0)
    INTO v_journal_debit,v_journal_credit
    FROM public.journal_entry_lines
   WHERE journal_entry_id=(
     SELECT id FROM public.journal_entries
      WHERE source_module='expenses' AND reference_id=v_nia.id
        AND is_posted=true AND NOT COALESCE(is_reversed,false)
   );

  SELECT COALESCE(total_debit,0),COALESCE(total_credit,0)
    INTO v_payment_debit,v_payment_credit
    FROM public.journal_entries
   WHERE source_module='expense_payment' AND reference_id=v_nia.id
     AND is_posted=true AND NOT COALESCE(is_reversed,false);

  IF v_journal_debit<>8670000 OR v_journal_credit<>8670000
     OR v_payment_debit<>8330000 OR v_payment_credit<>8330000 THEN
    RAISE EXCEPTION 'Nia posted journals do not match expected current balances';
  END IF;

  -- Narrow metadata repair: filed PPh amount, code and period stay unchanged.
  -- Suppress journal reposting while payroll-month metadata is corrected.
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.finance_metadata_repair','on',true);
  PERFORM set_config('app.finance_historical_repair','on',true);

  UPDATE public.finance_expenses
     SET payroll_period_month=10,
         payroll_period_year=2026,
         bpjs_register_item_id=v_nia_item.id,
         description=replace(description,'Nov-26','Oct-26')
   WHERE id=v_nia.id;

  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'Nia salary metadata correction did not update exactly one row'; END IF;

  -- Align descriptions on the existing salary journal lines without changing amounts.
  UPDATE public.journal_entry_lines
     SET description=replace(description,'Nov-26','Oct-26')
   WHERE journal_entry_id=(
     SELECT id FROM public.journal_entries
      WHERE source_module='expenses' AND reference_id=v_nia.id
        AND is_posted=true AND NOT COALESCE(is_reversed,false)
   )
     AND description ILIKE '%Nov-26%';

  -- Validate Telekom settlement evidence before repairing the stale paid_amount.
  SELECT * INTO v_telekom
    FROM public.finance_expenses
   WHERE voucher_number='EXP/26/314'
   FOR UPDATE;

  IF NOT FOUND
     OR v_telekom.id <> '9f5366b5-a6ca-4ff4-9a0b-2c71dd653203'::uuid
     OR v_telekom.amount <> 102938
     OR v_telekom.bank_charges_amount <> 3000
     OR v_telekom.ppn_amount <> 0
     OR v_telekom.pph_amount <> 0
     OR v_telekom.paid_amount <> 102938 THEN
    RAISE EXCEPTION 'Telekom expense does not match reviewed state; no changes made';
  END IF;

  SELECT COALESCE(SUM(allocation_amount),0) INTO v_alloc
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=v_telekom.id;

  IF v_alloc <> 105938 OR public.calculate_finance_expense_payable(v_telekom.id) <> 105938 THEN
    RAISE EXCEPTION 'Telekom bank allocation/payable mismatch: allocation %, payable %',
      v_alloc,public.calculate_finance_expense_payable(v_telekom.id);
  END IF;

  -- paid_amount follows the established convention for settled bank-charge expenses:
  -- it equals the full bank debit including bank charges. settlement_amount remains
  -- the invoice/supplier settlement amount, excluding the bank fee.
  UPDATE public.finance_expenses
     SET paid_amount=105938
   WHERE id=v_telekom.id
     AND paid_amount=102938;

  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'Telekom paid_amount was not updated exactly once'; END IF;

  -- Confirm Nia payroll period is correctly linked to October BPJS and journals remain unchanged.
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_expenses fe
    JOIN public.bpjs_monthly_register_items i ON i.id=fe.bpjs_register_item_id
    JOIN public.bpjs_monthly_registers r ON r.id=i.register_id
    WHERE fe.id=v_nia.id AND fe.payroll_period_year=2026
      AND fe.payroll_period_month=10 AND r.period_year=2026 AND r.period_month=10
      AND i.staff_id=fe.staff_id AND i.total_employee_deduction=170000
  ) THEN
    RAISE EXCEPTION 'Nia October BPJS register link validation failed';
  END IF;

  SELECT COALESCE(total_debit,0),COALESCE(total_credit,0)
    INTO v_telekom_journal_debit,v_telekom_journal_credit
    FROM public.journal_entries
   WHERE entry_number='JE2610-0154' AND reference_id=v_telekom.id
     AND is_posted=true AND NOT COALESCE(is_reversed,false);

  IF v_telekom_journal_debit<>105938 OR v_telekom_journal_credit<>105938 THEN
    RAISE EXCEPTION 'Telekom expense journal no longer balances to Rp105,938';
  END IF;

  SELECT pph_total INTO v_alloc FROM public.tax_periods WHERE id=v_pph_period.id;
  IF v_alloc IS DISTINCT FROM v_pph_before
     OR public.fn_pph_authoritative_source_total(v_pph_period.id) IS DISTINCT FROM v_pph_source_before THEN
    RAISE EXCEPTION 'Filed October PPh21 period/source total changed unexpectedly';
  END IF;
END
$repair$;

COMMIT;
