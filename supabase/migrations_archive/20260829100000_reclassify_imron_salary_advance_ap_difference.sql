/*
  Narrow historical repair: remove the remaining Rp500,000 AP control-only
  balance created by the legacy Imron salary-advance settlement.

  Evidence gate (the migration aborts rather than guessing): exactly one active
  EXP/26-26/110 journal must contain one supplier-less credit of Rp500,000 to
  COA 2110, with the known Imron staff identity and no existing repair.

  The source journal, expense, payment vouchers, bank statements, and bank
  allocations are immutable.  The correction is Dr AP 2110 / Cr Staff
  Advances 1160, which removes the subledger/control difference and closes the
  existing Imron advance without creating another voucher or cash event.
*/
BEGIN;

DO $$
DECLARE
  v_expense_id uuid;
  v_source_je uuid;
  v_source_entry text;
  v_source_date date;
  v_period_id uuid;
  v_staff_id uuid := 'b115a6f0-dbc2-49b1-aad4-58136704eadf';
  v_ap uuid;
  v_staff_advance uuid;
  v_repair_id uuid;
  v_repair_je uuid;
  v_existing_count integer;
  v_candidate_count integer;
  v_ap_credit numeric;
  v_supplier_before numeric;
  v_supplier_after numeric;
  v_ap_after numeric;
  v_imron_before numeric;
  v_imron_after numeric;
  v_expense_amount numeric;
BEGIN
  SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  SELECT id INTO v_staff_advance FROM public.chart_of_accounts WHERE code='1160' LIMIT 1;
  IF v_ap IS NULL OR v_staff_advance IS NULL THEN
    RAISE EXCEPTION 'Required accounts 2110 and 1160 are missing';
  END IF;

  SELECT count(*) INTO v_existing_count
  FROM public.journal_entries
  WHERE source_module='historical_salary_ap_reclassification'
    AND reference_number='EXP/26-26/110';
  IF v_existing_count > 1 THEN
    RAISE EXCEPTION 'More than one Imron AP reclassification exists';
  ELSIF v_existing_count = 1 THEN
    RAISE NOTICE 'Imron AP reclassification already exists; no-op';
    RETURN;
  END IF;

  SELECT count(*) INTO v_candidate_count
  FROM public.finance_expenses fe
  JOIN public.journal_entries je
    ON je.reference_id=fe.id AND je.source_module IN ('expense','expenses')
   AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
  JOIN public.journal_entry_lines l ON l.journal_entry_id=je.id
  WHERE fe.voucher_number='EXP/26-26/110'
    AND fe.amount=500000
    AND fe.staff_id=v_staff_id
    AND fe.supplier_id IS NULL
    AND l.account_id=v_ap AND l.debit=0 AND l.credit=500000
    AND l.supplier_id IS NULL;
  IF v_candidate_count <> 1 THEN
    -- Later canonical historical normalization may already have removed or
    -- replaced this exact source path. Never redirect a different Rp500,000
    -- payable merely because the old evidence is absent.
    RAISE NOTICE
      'Imron AP evidence is no longer the exact legacy candidate (found %); no accounting data changed',
      v_candidate_count;
    RETURN;
  END IF;

  SELECT fe.id,je.id,je.entry_number,je.entry_date,je.period_id,fe.amount
    INTO v_expense_id,v_source_je,v_source_entry,v_source_date,v_period_id,v_expense_amount
  FROM public.finance_expenses fe
  JOIN public.journal_entries je
    ON je.reference_id=fe.id AND je.source_module IN ('expense','expenses')
   AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
  JOIN public.journal_entry_lines l ON l.journal_entry_id=je.id
  WHERE fe.voucher_number='EXP/26-26/110'
    AND fe.amount=500000 AND fe.staff_id=v_staff_id AND fe.supplier_id IS NULL
    AND l.account_id=v_ap AND l.debit=0 AND l.credit=500000 AND l.supplier_id IS NULL
  FOR UPDATE OF je;

  SELECT COALESCE(sum(l.credit-l.debit),0) INTO v_ap_credit
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id=l.journal_entry_id
  WHERE l.account_id=v_ap AND je.is_posted AND NOT COALESCE(je.is_reversed,false);

  SELECT COALESCE(sum(payable_balance),0) INTO v_supplier_before
  FROM public.supplier_payables_view;
  IF abs(v_ap_credit-v_supplier_before-500000)>0.01 THEN
    RAISE EXCEPTION
      'Imron AP evidence does not explain the control/subledger difference: AP %, supplier subledger %, expected variance 500000',
      v_ap_credit,v_supplier_before;
  END IF;

  SELECT COALESCE(sum(l.debit-l.credit),0) INTO v_imron_before
  FROM public.payment_vouchers pv
  JOIN public.journal_entries je ON je.reference_id=pv.id AND je.source_module='payment'
    AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
  JOIN public.journal_entry_lines l ON l.journal_entry_id=je.id AND l.account_id=v_staff_advance
  WHERE pv.voucher_number IN ('PV/26-26/006','PV/26-26/007')
    AND pv.staff_id=v_staff_id;
  IF abs(v_imron_before-500000)>0.01 THEN
    RAISE EXCEPTION
      'Imron Staff Advances evidence changed: expected outstanding 500000 before repair, found %',
      v_imron_before;
  END IF;

  v_repair_id := public.uuid_from_text('hfr-260829:imron-ap-reclassification');
  v_repair_je := public.uuid_from_text('hfr-260829:imron-ap-reclassification-je');

  INSERT INTO public.finance_historical_repair_runs(notes)
  VALUES ('2026-08-29 Imron salary-advance AP control/subledger difference repair')
  RETURNING id INTO v_repair_id;

  INSERT INTO public.journal_entries(
    id,entry_number,entry_date,period_id,source_module,reference_id,reference_number,
    description,total_debit,total_credit,is_posted,is_reversed,posted_at
  ) VALUES (
    v_repair_je,'HFR-260829-IMRON-AP',v_source_date,v_period_id,
    'historical_salary_ap_reclassification',v_expense_id,'EXP/26-26/110',
    'Audited reclassification of legacy Imron salary-advance AP line '||v_source_entry,
    500000,500000,true,false,now()
  );

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit)
  VALUES
    (v_repair_je,1,v_ap,'Remove legacy Imron salary-advance effect from Accounts Payable',500000,0),
    (v_repair_je,2,v_staff_advance,'Close Imron salary advance against July salary settlement',0,500000);

  INSERT INTO public.finance_historical_repair_items(
    run_id,document_type,document_id,document_number,repaired_fields,
    old_metadata,new_metadata,repair_reason
  ) VALUES (
    v_repair_id,'salary_advance_ap_reclassification',v_expense_id,'EXP/26-26/110',
    ARRAY['ap_control_effect'],
    jsonb_build_object('source_journal_id',v_source_je,'source_entry',v_source_entry,
                       'ap_credit',500000,'supplier_id',NULL,'ap_control_before',v_ap_credit),
    jsonb_build_object('repair_journal_id',v_repair_je,'debit_ap',500000,
                       'credit_staff_advances',500000,'ap_control_after',v_ap_credit-500000,
                       'supplier_subledger_after',v_supplier_after,
                       'imron_staff_advance_before',v_imron_before,
                       'imron_staff_advance_after',v_imron_after,
                       'staff_id',v_staff_id),
    'Exact supplier-less historical Imron salary-advance AP credit reclassified to Staff Advances & Loans 1160'
  );

  INSERT INTO public.audit_logs(table_name,record_id,action_type,old_values,new_values)
  VALUES (
    'journal_entries',v_source_je,'update',
    jsonb_build_object('ap_control_effect',500000,'source_entry',v_source_entry,
                       'expense','EXP/26-26/110'),
    jsonb_build_object('historical_reclassification_journal_id',v_repair_je,
                       'debit_account','2110','credit_account','1160','amount',500000)
  );

  SELECT COALESCE(sum(l.credit-l.debit),0) INTO v_ap_after
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id=l.journal_entry_id
  WHERE l.account_id=v_ap AND je.is_posted AND NOT COALESCE(je.is_reversed,false);
  SELECT COALESCE(sum(payable_balance),0) INTO v_supplier_after
  FROM public.supplier_payables_view;
  SELECT v_imron_before + COALESCE(sum(l.debit-l.credit),0) INTO v_imron_after
  FROM public.journal_entry_lines l
  WHERE l.journal_entry_id=v_repair_je AND l.account_id=v_staff_advance;
  IF abs(v_ap_after-v_supplier_after)>0.01 OR abs(v_imron_after)>0.01 THEN
    RAISE EXCEPTION
      'Imron repair invariant failed: AP %, supplier subledger %, Imron advances %',
      v_ap_after,v_supplier_after,v_imron_after;
  END IF;

  UPDATE public.finance_historical_repair_runs
  SET completed_at=now(),total_records_scanned=1,records_repaired=1
  WHERE id=v_repair_id;
END $$;

COMMIT;
