-- One-time, idempotent correction for Sandi Prasetyo's July and September 2026
-- salary advance application links. This preserves the July bank reconciliation and
-- retains original journals as reversed with explicit replacement journals.
CREATE OR REPLACE FUNCTION public.repair_sandi_prasetyo_salary_advance_history_2026()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_staff_id CONSTANT uuid := '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc';
  c_july_expense_id CONSTANT uuid := '50da93f7-81e6-4ae7-912b-62538d97f016';
  c_july_bank_line_id CONSTANT uuid := 'f92f9568-e361-447a-be33-a490f59e5db4';
  c_july_bank_allocation_id CONSTANT uuid := '7f1d0ede-6e78-4cf9-be30-60c461cd6fa6';
  c_september_expense_id CONSTANT uuid := '252040f4-bf49-463e-9af6-5bc9921a593c';
  c_advance_012 CONSTANT uuid := '0efd7d85-6977-4bc1-b210-004e00834d88';
  c_advance_013 CONSTANT uuid := '56acdc56-5b77-496f-a162-9f939a50aa4e';
  c_advance_019 CONSTANT uuid := '28faa8e0-fc1c-49df-aa20-01fcec0bc62c';
  c_settlement_021 CONSTANT uuid := 'df740056-054f-400c-8076-4fdefd6d28e0';
  c_app_012 CONSTANT uuid := 'd125c26c-1f73-4972-a870-cd99c0c40ade';
  c_app_013 CONSTANT uuid := '1eddf8a3-d17b-4063-b97d-f46fd9916759';
  c_app_019 CONSTANT uuid := '00bcc331-d244-4e83-b463-5ae48ab8ca67';
  c_idempotency CONSTANT text := 'sandi-prasetyo-salary-advance-jul-sep-2026-v1';

  v_existing public.finance_historical_repair_commands%ROWTYPE;
  v_command_id uuid;
  v_july public.finance_expenses%ROWTYPE;
  v_september public.finance_expenses%ROWTYPE;
  v_settlement public.payment_vouchers%ROWTYPE;
  v_july_source_je public.journal_entries%ROWTYPE;
  v_september_source_je public.journal_entries%ROWTYPE;
  v_bank_line public.bank_statement_lines%ROWTYPE;
  v_bank_allocation public.bank_statement_allocations%ROWTYPE;
  v_july_settlement_id uuid;
  v_july_settlement_je_id uuid;
  v_july_settlement_number text;
  v_july_reversal_id uuid;
  v_september_reversal_id uuid;
  v_july_replacement_je_id uuid;
  v_september_replacement_je_id uuid;
  v_salary_coa uuid;
  v_bank_coa uuid;
  v_ap_coa uuid;
  v_advance_coa uuid;
  v_period_id uuid;
  v_entry_number text;
  v_line record;
  v_line_no integer;
  v_count integer;
  v_debit numeric;
  v_credit numeric;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT EXISTS (
       SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND is_active = true AND role = 'admin'
     ) THEN
    RAISE EXCEPTION 'This historical payroll repair requires a database administrator';
  END IF;

  SELECT * INTO v_existing
    FROM public.finance_historical_repair_commands
   WHERE idempotency_key = c_idempotency
   FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'idempotent', true,
      'command_id', v_existing.id,
      'before', v_existing.before_state,
      'after', v_existing.after_state
    );
  END IF;

  SELECT * INTO v_july
    FROM public.finance_expenses
   WHERE id = c_july_expense_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_july.voucher_number <> 'EXP/26-26/122'
     OR v_july.expense_category <> 'salary'
     OR v_july.staff_id <> c_staff_id
     OR v_july.approval_status <> 'approved'
     OR abs(v_july.amount - 1850000) > 0.01
     OR abs(COALESCE(v_july.paid_amount, 0) - 1850000) > 0.01 THEN
    RAISE EXCEPTION 'July salary record no longer matches the reviewed evidence; no changes made';
  END IF;

  SELECT * INTO v_september
    FROM public.finance_expenses
   WHERE id = c_september_expense_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_september.voucher_number <> 'EXP/26/285'
     OR v_september.expense_category <> 'salary'
     OR v_september.staff_id <> c_staff_id
     OR v_september.approval_status <> 'pending_approval'
     OR abs(v_september.amount - 2000000) > 0.01
     OR abs(COALESCE(v_september.paid_amount, 0) - 1150000) > 0.01 THEN
    RAISE EXCEPTION 'September salary record no longer matches the reviewed evidence; no changes made';
  END IF;

  SELECT * INTO v_settlement
    FROM public.payment_vouchers
   WHERE id = c_settlement_021
   FOR UPDATE;
  IF NOT FOUND
     OR v_settlement.voucher_number <> 'PV/26-26/021'
     OR v_settlement.payment_purpose <> 'salary_advance_settlement'
     OR v_settlement.payment_method <> 'advance_adjustment'
     OR v_settlement.staff_id <> c_staff_id
     OR v_settlement.is_posted IS DISTINCT FROM true
     OR abs(v_settlement.amount - 1150000) > 0.01 THEN
    RAISE EXCEPTION 'September settlement voucher no longer matches reviewed evidence; no changes made';
  END IF;

  SELECT * INTO v_bank_line
    FROM public.bank_statement_lines
   WHERE id = c_july_bank_line_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_bank_line.matched_expense_id <> c_july_expense_id
     OR v_bank_line.transaction_date <> DATE '2026-07-31'
     OR abs(COALESCE(v_bank_line.debit_amount, 0) - 1850000) > 0.01
     OR v_bank_line.description NOT ILIKE '%SALARY JULI 26 SANDI PRASETYO%' THEN
    RAISE EXCEPTION 'July bank statement evidence does not match; no changes made';
  END IF;

  SELECT * INTO v_bank_allocation
    FROM public.bank_statement_allocations
   WHERE id = c_july_bank_allocation_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_bank_allocation.bank_statement_line_id <> c_july_bank_line_id
     OR v_bank_allocation.document_type <> 'expense'
     OR v_bank_allocation.document_id <> c_july_expense_id
     OR abs(v_bank_allocation.allocation_amount - 1850000) > 0.01 THEN
    RAISE EXCEPTION 'July bank allocation is missing or changed; no changes made';
  END IF;

  SELECT je.* INTO v_july_source_je
    FROM public.journal_entries je
   WHERE je.id = v_bank_allocation.journal_entry_id
     AND je.reference_id = c_july_expense_id
     AND je.entry_number = 'JE2607-0083'
     AND je.source_module IN ('expense', 'expenses')
     AND je.is_posted = true
     AND NOT COALESCE(je.is_reversed, false)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected active July salary journal JE2607-0083 is missing; no changes made';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.salary_advance_applications
   WHERE id IN (c_app_012, c_app_013, c_app_019)
     AND salary_expense_id = c_september_expense_id
     AND settlement_payment_voucher_id = c_settlement_021;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'The three expected advance application links have changed; no changes made';
  END IF;

  SELECT COALESCE(sum(applied_amount), 0) INTO v_debit
    FROM public.salary_advance_applications
   WHERE settlement_payment_voucher_id = c_settlement_021
     AND salary_expense_id = c_september_expense_id;
  IF abs(v_debit - 1150000) > 0.01 THEN
    RAISE EXCEPTION 'Expected September-linked advance applications totaling Rp1,150,000; no changes made';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.salary_advance_applications
     WHERE advance_payment_voucher_id IN (c_advance_012, c_advance_013)
       AND salary_expense_id <> c_september_expense_id
  ) THEN
    RAISE EXCEPTION 'One of the July advances is already applied elsewhere; no changes made';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.accounting_periods
     WHERE start_date <= DATE '2026-07-31' AND end_date >= DATE '2026-07-31'
       AND status <> 'open'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.accounting_periods
     WHERE start_date <= DATE '2026-07-31' AND end_date >= DATE '2026-07-31'
       AND status = 'open'
  ) OR EXISTS (
    SELECT 1 FROM public.accounting_periods
     WHERE start_date <= DATE '2026-09-30' AND end_date >= DATE '2026-09-30'
       AND status <> 'open'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.accounting_periods
     WHERE start_date <= DATE '2026-09-30' AND end_date >= DATE '2026-09-30'
       AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'July and September accounting periods must be open; no changes made';
  END IF;

  SELECT id INTO v_salary_coa FROM public.chart_of_accounts WHERE code = '6100' LIMIT 1;
  SELECT id INTO v_ap_coa FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
  SELECT id INTO v_advance_coa FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
  SELECT ba.coa_id INTO v_bank_coa
    FROM public.bank_accounts ba
   WHERE ba.id = v_bank_line.bank_account_id;
  IF v_salary_coa IS NULL OR v_ap_coa IS NULL OR v_advance_coa IS NULL OR v_bank_coa IS NULL THEN
    RAISE EXCEPTION 'Required salary, AP, advance, or bank COA is missing; no changes made';
  END IF;

  IF (SELECT count(*) FROM public.journal_entry_lines WHERE journal_entry_id = v_july_source_je.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_july_source_je.id AND account_id = v_salary_coa AND abs(debit - 1850000) < 0.01 AND abs(COALESCE(credit,0)) < 0.01)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_july_source_je.id AND account_id = v_bank_coa AND abs(credit - 1850000) < 0.01 AND abs(COALESCE(debit,0)) < 0.01) THEN
    RAISE EXCEPTION 'July salary journal is not the reviewed Dr Salary / Cr Bank entry; no changes made';
  END IF;

  SELECT je.* INTO v_september_source_je
    FROM public.journal_entries je
   WHERE je.id = v_settlement.journal_entry_id
     AND je.reference_id = c_settlement_021
     AND je.is_posted = true
     AND NOT COALESCE(je.is_reversed, false)
   FOR UPDATE;
  IF NOT FOUND
     OR (SELECT count(*) FROM public.journal_entry_lines WHERE journal_entry_id = v_september_source_je.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_september_source_je.id AND account_id = v_ap_coa AND abs(debit - 1150000) < 0.01 AND abs(COALESCE(credit,0)) < 0.01)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_september_source_je.id AND account_id = v_advance_coa AND abs(credit - 1150000) < 0.01 AND abs(COALESCE(debit,0)) < 0.01) THEN
    RAISE EXCEPTION 'September settlement journal is not the expected AP/advance entry; no changes made';
  END IF;

  IF (SELECT count(*) FROM public.voucher_allocations
       WHERE payment_voucher_id = c_settlement_021
         AND finance_expense_id = c_september_expense_id
         AND abs(allocated_amount - 1150000) < 0.01) <> 1 THEN
    RAISE EXCEPTION 'September settlement allocation is missing or changed; no changes made';
  END IF;

  v_before := jsonb_build_object(
    'july_salary', to_jsonb(v_july),
    'july_source_journal', to_jsonb(v_july_source_je),
    'july_bank_statement_line', to_jsonb(v_bank_line),
    'july_bank_allocation', to_jsonb(v_bank_allocation),
    'september_salary', to_jsonb(v_september),
    'september_settlement', to_jsonb(v_settlement),
    'september_source_journal', to_jsonb(v_september_source_je),
    'advance_applications', (
      SELECT COALESCE(jsonb_agg(to_jsonb(sa) ORDER BY sa.id), '[]'::jsonb)
        FROM public.salary_advance_applications sa
       WHERE sa.id IN (c_app_012, c_app_013, c_app_019)
    )
  );

  INSERT INTO public.finance_historical_repair_commands(
    idempotency_key, document_type, document_id, bank_statement_line_id,
    payment_kind, operation, requested_by, before_state, after_state, status
  ) VALUES (
    c_idempotency, 'expense', c_july_expense_id, c_july_bank_line_id,
    'supplier', 'restate_salary_net_of_advance', auth.uid(), v_before, '{}'::jsonb, 'committed'
  ) RETURNING id INTO v_command_id;

  PERFORM set_config('app.finance_historical_repair_command', v_command_id::text, true);
  PERFORM set_config('app.finance_historical_repair', 'on', true);
  PERFORM set_config('app.finance_metadata_repair', 'on', true);

  -- Restore the actual July gross salary while preserving the real Rp1.85m bank payout.
  -- Existing bank allocation remains Rp1.85m; the extra Rp650k is settled against advances.
  UPDATE public.finance_expenses
     SET amount = 2500000,
         paid_amount = 2500000
   WHERE id = c_july_expense_id;

  v_july_settlement_number := public.next_payment_voucher_number(DATE '2026-07-31');
  INSERT INTO public.payment_vouchers(
    voucher_number, voucher_date, supplier_id, payment_method, bank_account_id,
    reference_number, amount, pph_amount, description, document_urls,
    created_by, coa_account_id, payment_currency, exchange_rate, bank_amount,
    bank_charge, is_posted, staff_id, currency_code, transaction_currency,
    functional_currency, bank_account_currency, payment_purpose, invoice_currency,
    invoice_amount, payment_amount, bank_currency, converted_amount, actual_bank_debit,
    salary_advance_applied_amount, salary_advance_status
  ) VALUES (
    v_july_settlement_number, DATE '2026-07-31', NULL, 'advance_adjustment', NULL,
    'HIST-SALARY-EXP-26-26-122', 650000, 0,
    'Salary Advance Recovery - EXP/26-26/122 (PV/26-26/012 + PV/26-26/013)',
    ARRAY[]::text[], v_settlement.created_by, NULL, 'IDR', 1, NULL, 0, false,
    c_staff_id, 'IDR', 'IDR', 'IDR', 'IDR', 'salary_advance_settlement',
    'IDR', 650000, 650000, 'IDR', 650000, NULL, 0, 'not_applicable'
  ) RETURNING id INTO v_july_settlement_id;

  -- Reverse the old July expense journal, preserving it for audit.
  v_entry_number := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(
    entry_number, entry_date, period_id, source_module, reference_id, reference_number,
    description, transaction_category, total_debit, total_credit, is_posted, posted_at,
    posted_by, created_by, transaction_currency, functional_currency, exchange_rate,
    amounts_are_functional
  ) VALUES (
    v_entry_number, v_july_source_je.entry_date, v_july_source_je.period_id,
    'historical_repair', c_july_expense_id, 'HR-REV-JUL-' || v_command_id::text,
    'Historical reversal of July net-salary-only posting ' || v_july_source_je.entry_number,
    'salary_advance_restatement', v_july_source_je.total_credit, v_july_source_je.total_debit,
    true, now(), auth.uid(), v_july_source_je.created_by,
    'IDR', 'IDR', 1, true
  ) RETURNING id INTO v_july_reversal_id;

  v_line_no := 1;
  FOR v_line IN
    SELECT * FROM public.journal_entry_lines
     WHERE journal_entry_id = v_july_source_je.id ORDER BY line_number
  LOOP
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      supplier_id, payee_id, transaction_currency, transaction_debit,
      transaction_credit, functional_currency, exchange_rate
    ) VALUES (
      v_july_reversal_id, v_line_no, v_line.account_id,
      'Historical reversal: ' || COALESCE(v_line.description, ''),
      v_line.credit, v_line.debit, v_line.supplier_id, v_line.payee_id,
      COALESCE(v_line.transaction_currency, 'IDR'),
      COALESCE(v_line.transaction_credit, v_line.credit),
      COALESCE(v_line.transaction_debit, v_line.debit),
      'IDR', 1
    );
    v_line_no := v_line_no + 1;
  END LOOP;
  UPDATE public.journal_entries
     SET is_reversed = true, reversed_by_id = v_july_reversal_id
   WHERE id = v_july_source_je.id;

  -- Replacement July journal: gross salary Rp2.5m = bank payout Rp1.85m + AP/advance recovery Rp650k.
  v_entry_number := public.next_journal_entry_number();
  SELECT id INTO v_period_id
    FROM public.accounting_periods
   WHERE start_date <= DATE '2026-07-31' AND end_date >= DATE '2026-07-31'
   ORDER BY start_date DESC LIMIT 1;
  INSERT INTO public.journal_entries(
    entry_number, entry_date, period_id, source_module, reference_id, reference_number,
    description, transaction_category, total_debit, total_credit, is_posted, posted_at,
    posted_by, created_by, transaction_currency, functional_currency, exchange_rate,
    amounts_are_functional
  ) VALUES (
    v_entry_number, DATE '2026-07-31', v_period_id, 'expenses', c_july_expense_id,
    'EXP-' || c_july_expense_id::text,
    'Salary July 2026 - gross Rp2,500,000; bank Rp1,850,000; advances Rp650,000',
    'salary', 2500000, 2500000, true, now(), auth.uid(), v_july_source_je.created_by,
    'IDR', 'IDR', 1, true
  ) RETURNING id INTO v_july_replacement_je_id;

  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
  ) VALUES
    (v_july_replacement_je_id, 1, v_salary_coa, 'Gross July salary - Sandi Prasetyo', 2500000, 0, 'IDR', 2500000, 0, 'IDR', 1),
    (v_july_replacement_je_id, 2, v_bank_coa, 'Actual salary bank payout - statement matched', 0, 1850000, 'IDR', 0, 1850000, 'IDR', 1),
    (v_july_replacement_je_id, 3, v_ap_coa, 'July salary advance deduction clearing', 0, 650000, 'IDR', 0, 650000, 'IDR', 1);

  UPDATE public.bank_statement_allocations
     SET journal_entry_id = v_july_replacement_je_id
   WHERE id = c_july_bank_allocation_id;

  -- Post the internal July settlement journal: Dr AP, Cr Staff Advances.
  v_entry_number := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(
    entry_number, entry_date, period_id, source_module, reference_id, reference_number,
    description, transaction_category, total_debit, total_credit, is_posted, posted_at,
    posted_by, created_by, transaction_currency, functional_currency, exchange_rate,
    amounts_are_functional
  ) VALUES (
    v_entry_number, DATE '2026-07-31', v_period_id, 'payment', v_july_settlement_id,
    v_july_settlement_number,
    'Salary Advance Settlement - Sandi July advances PV/26-26/012 and PV/26-26/013',
    'salary_advance_settlement', 650000, 650000, true, now(), auth.uid(),
    v_settlement.created_by, 'IDR', 'IDR', 1, true
  ) RETURNING id INTO v_july_settlement_je_id;

  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
  ) VALUES
    (v_july_settlement_je_id, 1, v_ap_coa, 'July salary payable cleared by advance deduction', 650000, 0, 'IDR', 650000, 0, 'IDR', 1),
    (v_july_settlement_je_id, 2, v_advance_coa, 'Clear July staff advances PV/26-26/012 + PV/26-26/013', 0, 650000, 'IDR', 0, 650000, 'IDR', 1);

  UPDATE public.payment_vouchers
     SET journal_entry_id = v_july_settlement_je_id,
         is_posted = true
   WHERE id = v_july_settlement_id;

  INSERT INTO public.voucher_allocations(
    voucher_type, payment_voucher_id, finance_expense_id, allocated_amount,
    allocated_currency, payment_kind
  ) VALUES (
    'payment', v_july_settlement_id, c_july_expense_id, 650000, 'IDR', 'supplier'
  );

  -- Reverse September's incorrect Rp1.15m settlement journal.
  v_entry_number := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(
    entry_number, entry_date, period_id, source_module, reference_id, reference_number,
    description, transaction_category, total_debit, total_credit, is_posted, posted_at,
    posted_by, created_by, transaction_currency, functional_currency, exchange_rate,
    amounts_are_functional
  ) VALUES (
    v_entry_number, v_september_source_je.entry_date, v_september_source_je.period_id,
    'historical_repair', c_settlement_021, 'HR-REV-SEP-' || v_command_id::text,
    'Historical reversal of overstated salary advance settlement PV/26-26/021',
    'salary_advance_restatement', v_september_source_je.total_credit, v_september_source_je.total_debit,
    true, now(), auth.uid(), v_september_source_je.created_by,
    'IDR', 'IDR', 1, true
  ) RETURNING id INTO v_september_reversal_id;

  v_line_no := 1;
  FOR v_line IN
    SELECT * FROM public.journal_entry_lines
     WHERE journal_entry_id = v_september_source_je.id ORDER BY line_number
  LOOP
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      supplier_id, payee_id, transaction_currency, transaction_debit,
      transaction_credit, functional_currency, exchange_rate
    ) VALUES (
      v_september_reversal_id, v_line_no, v_line.account_id,
      'Historical reversal: ' || COALESCE(v_line.description, ''),
      v_line.credit, v_line.debit, v_line.supplier_id, v_line.payee_id,
      COALESCE(v_line.transaction_currency, 'IDR'),
      COALESCE(v_line.transaction_credit, v_line.credit),
      COALESCE(v_line.transaction_debit, v_line.debit),
      'IDR', 1
    );
    v_line_no := v_line_no + 1;
  END LOOP;
  UPDATE public.journal_entries
     SET is_reversed = true, reversed_by_id = v_september_reversal_id
   WHERE id = v_september_source_je.id;

  -- Corrected September settlement is Rp500k for PV/26-26/019 only.
  v_entry_number := public.next_journal_entry_number();
  SELECT id INTO v_period_id
    FROM public.accounting_periods
   WHERE start_date <= DATE '2026-09-30' AND end_date >= DATE '2026-09-30'
   ORDER BY start_date DESC LIMIT 1;
  INSERT INTO public.journal_entries(
    entry_number, entry_date, period_id, source_module, reference_id, reference_number,
    description, transaction_category, total_debit, total_credit, is_posted, posted_at,
    posted_by, created_by, transaction_currency, functional_currency, exchange_rate,
    amounts_are_functional
  ) VALUES (
    v_entry_number, DATE '2026-09-30', v_period_id, 'payment', c_settlement_021,
    'PV/26-26/021',
    'Payment Voucher PV/26-26/021 - corrected September advance settlement Rp500,000',
    'salary_advance_settlement', 500000, 500000, true, now(), auth.uid(), v_settlement.created_by,
    'IDR', 'IDR', 1, true
  ) RETURNING id INTO v_september_replacement_je_id;

  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
  ) VALUES
    (v_september_replacement_je_id, 1, v_ap_coa, 'Salary payable cleared by September advance', 500000, 0, 'IDR', 500000, 0, 'IDR', 1),
    (v_september_replacement_je_id, 2, v_advance_coa, 'Clear September staff advance PV/26-26/019', 0, 500000, 'IDR', 0, 500000, 'IDR', 1);

  -- Move the two July advance links to the July salary; keep September PV/021 linked only to PV/019.
  UPDATE public.salary_advance_applications
     SET salary_expense_id = c_july_expense_id,
         settlement_payment_voucher_id = v_july_settlement_id
   WHERE id IN (c_app_012, c_app_013)
     AND salary_expense_id = c_september_expense_id
     AND settlement_payment_voucher_id = c_settlement_021;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Expected to move exactly two July advance links; transaction rolled back';
  END IF;

  UPDATE public.payment_vouchers
     SET amount = 500000,
         invoice_amount = 500000,
         payment_amount = 500000,
         converted_amount = 500000,
         bank_amount = NULL,
         actual_bank_debit = NULL,
         journal_entry_id = v_september_replacement_je_id,
         is_posted = true
   WHERE id = c_settlement_021;

  UPDATE public.voucher_allocations
     SET allocated_amount = 500000,
         allocated_currency = 'IDR'
   WHERE payment_voucher_id = c_settlement_021
     AND finance_expense_id = c_september_expense_id
     AND abs(allocated_amount - 1150000) < 0.01;

  -- Add explicit audit rows for the reclassified application links and corrected settlement.
  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES
    ('salary_advance_applications', c_app_012, 'update',
     jsonb_build_object('salary_expense_id', c_september_expense_id, 'settlement_payment_voucher_id', c_settlement_021, 'applied_amount', 500000),
     jsonb_build_object('salary_expense_id', c_july_expense_id, 'settlement_payment_voucher_id', v_july_settlement_id, 'applied_amount', 500000),
     auth.uid()),
    ('salary_advance_applications', c_app_013, 'update',
     jsonb_build_object('salary_expense_id', c_september_expense_id, 'settlement_payment_voucher_id', c_settlement_021, 'applied_amount', 150000),
     jsonb_build_object('salary_expense_id', c_july_expense_id, 'settlement_payment_voucher_id', v_july_settlement_id, 'applied_amount', 150000),
     auth.uid()),
    ('payment_vouchers', c_settlement_021, 'update',
     jsonb_build_object('amount', 1150000, 'net_amount', 1150000, 'journal_entry_id', v_september_source_je.id, 'description', v_settlement.description),
     jsonb_build_object('amount', 500000, 'net_amount', 500000, 'journal_entry_id', v_september_replacement_je_id, 'description', v_settlement.description),
     auth.uid());

  PERFORM public.refresh_salary_advance_status(c_advance_012);
  PERFORM public.refresh_salary_advance_status(c_advance_013);
  PERFORM public.refresh_salary_advance_status(c_advance_019);

  -- Final exact balance/state values after allocation and advance links are moved.
  UPDATE public.finance_expenses SET paid_amount = 2500000 WHERE id = c_july_expense_id;
  UPDATE public.finance_expenses SET paid_amount = 500000 WHERE id = c_september_expense_id;

  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO v_debit, v_credit
    FROM public.journal_entry_lines
   WHERE journal_entry_id = v_july_replacement_je_id;
  IF abs(v_debit - 2500000) > 0.01 OR abs(v_credit - 2500000) > 0.01 THEN
    RAISE EXCEPTION 'Corrected July salary journal does not balance; transaction rolled back';
  END IF;

  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO v_debit, v_credit
    FROM public.journal_entry_lines
   WHERE journal_entry_id = v_september_replacement_je_id;
  IF abs(v_debit - 500000) > 0.01 OR abs(v_credit - 500000) > 0.01 THEN
    RAISE EXCEPTION 'Corrected September settlement journal does not balance; transaction rolled back';
  END IF;

  IF (SELECT count(*) FROM public.salary_advance_applications
       WHERE salary_expense_id = c_july_expense_id
         AND advance_payment_voucher_id IN (c_advance_012, c_advance_013)
         AND settlement_payment_voucher_id = v_july_settlement_id) <> 2
     OR (SELECT count(*) FROM public.salary_advance_applications
       WHERE salary_expense_id = c_september_expense_id
         AND advance_payment_voucher_id = c_advance_019
         AND settlement_payment_voucher_id = c_settlement_021
         AND abs(applied_amount - 500000) < 0.01) <> 1
     OR (SELECT count(*) FROM public.salary_advance_applications
       WHERE salary_expense_id = c_september_expense_id
         AND advance_payment_voucher_id IN (c_advance_012, c_advance_013)) <> 0 THEN
    RAISE EXCEPTION 'Final advance links failed verification; transaction rolled back';
  END IF;

  v_after := jsonb_build_object(
    'july_salary_voucher', 'EXP/26-26/122',
    'july_gross_salary', 2500000,
    'july_bank_payout_preserved', 1850000,
    'july_advance_deduction', 650000,
    'july_reversal_journal_id', v_july_reversal_id,
    'july_replacement_journal_id', v_july_replacement_je_id,
    'july_settlement_voucher_id', v_july_settlement_id,
    'july_settlement_voucher_number', v_july_settlement_number,
    'september_salary_voucher', 'EXP/26/285',
    'september_gross_salary', 2000000,
    'september_advance_deduction', 500000,
    'september_net_payable', 1500000,
    'september_reversal_journal_id', v_september_reversal_id,
    'september_replacement_journal_id', v_september_replacement_je_id,
    'july_bank_allocation_id_preserved', c_july_bank_allocation_id,
    'advance_applications', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'advance', av.voucher_number,
        'salary', fe.voucher_number,
        'amount', sa.applied_amount,
        'settlement', settlement.voucher_number
      ) ORDER BY av.voucher_number), '[]'::jsonb)
      FROM public.salary_advance_applications sa
      JOIN public.payment_vouchers av ON av.id = sa.advance_payment_voucher_id
      JOIN public.finance_expenses fe ON fe.id = sa.salary_expense_id
      JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
      WHERE sa.id IN (c_app_012, c_app_013, c_app_019)
    )
  );

  UPDATE public.finance_historical_repair_commands
     SET before_state = v_before,
         after_state = v_after,
         created_allocation_id = c_july_bank_allocation_id
   WHERE id = v_command_id;

  RETURN jsonb_build_object(
    'success', true,
    'command_id', v_command_id,
    'before', v_before,
    'after', v_after
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.repair_sandi_prasetyo_salary_advance_history_2026() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_sandi_prasetyo_salary_advance_history_2026() FROM anon;
REVOKE ALL ON FUNCTION public.repair_sandi_prasetyo_salary_advance_history_2026() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.repair_sandi_prasetyo_salary_advance_history_2026() TO service_role;
