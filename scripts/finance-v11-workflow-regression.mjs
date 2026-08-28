import { execFileSync } from 'node:child_process';

const sql = `
BEGIN;
SELECT set_config('request.jwt.claim.sub',(
  SELECT id::text FROM public.user_profiles
   WHERE role IN ('admin','accounts') AND is_active=true
   ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END,id LIMIT 1),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;

DO $regression$
DECLARE
  v_user uuid:=auth.uid();
  v_staff uuid;
  v_bank uuid;
  v_upload uuid;
  v_line uuid;
  v_expense uuid;
  v_payment uuid;
  v_fx_payment uuid;
  v_supplier uuid;
  v_salary uuid;
  v_draft_pph uuid;
  v_pph_period uuid;
  v_saved jsonb;
  v_calc jsonb;
  v_applied jsonb;
  v_pph21 uuid;
  v_je uuid;
  v_count bigint;
  v_broker record;
  v_debit numeric;
  v_credit numeric;
  v_expense_debit numeric;
  v_ppn_debit numeric;
  v_pph_credit numeric;
  v_bank_credit numeric;
  v_pph_before numeric;
  v_pph_after numeric;
BEGIN
  SELECT id INTO v_staff FROM public.finance_staff_master WHERE status='active' ORDER BY created_at,id LIMIT 1;
  SELECT id INTO v_pph21 FROM public.tax_codes WHERE upper(code)='PPH21' LIMIT 1;
  SELECT id INTO v_expense FROM public.finance_expenses WHERE voucher_number='EXP/26-26/113';
  SELECT bank_account_id INTO v_bank FROM public.finance_expenses WHERE id=v_expense;
  SELECT id INTO v_supplier FROM public.suppliers ORDER BY created_at,id LIMIT 1;
  IF v_user IS NULL OR v_staff IS NULL OR v_bank IS NULL OR v_pph21 IS NULL OR v_expense IS NULL OR v_supplier IS NULL THEN
    RAISE EXCEPTION 'Finance V1.1 authenticated fixtures are incomplete';
  END IF;

  SELECT * INTO v_broker
    FROM public.vw_customs_broker_accounting
   WHERE expense_id=v_expense;
  IF NOT FOUND
     OR v_broker.reimbursement_total<>9127503
     OR v_broker.expense_total<>12227503
     OR v_broker.recoverable_input_ppn<>457695
     OR v_broker.pph23_withheld<>62000
     OR v_broker.final_cash_payable<>12165503 THEN
    RAISE EXCEPTION 'Customs Broker cash formula is incorrect: %',row_to_json(v_broker);
  END IF;

  -- The fixture may already be reconciled in production. Release its existing
  -- link inside this rollback-only transaction before exercising relink.
  FOR v_line IN SELECT id FROM public.bank_statement_lines WHERE matched_expense_id=v_expense LOOP
    PERFORM public.unmatch_bank_line(v_line);
  END LOOP;

  -- Finance V1.1.1 lifecycle: cancelling, editing and re-approving must create
  -- exactly one new canonical journal. Linking payment metadata must not
  -- regenerate that journal or leave matched_entry_id stale.
  PERFORM public.cancel_expense_posting(v_expense,v_user,'Finance V1.1.1 rollback regression');
  UPDATE public.finance_expenses SET description=description WHERE id=v_expense;
  SELECT count(*) INTO v_count FROM public.journal_entries
   WHERE source_module='expenses' AND reference_id=v_expense
     AND is_posted=true AND COALESCE(is_reversed,false)=false;
  IF v_count<>0 THEN RAISE EXCEPTION 'Draft Broker Expense edit created % active journals',v_count; END IF;
  PERFORM public.approve_finance_expense(v_expense,v_user);
  SELECT id INTO v_je FROM public.journal_entries
   WHERE source_module='expenses' AND reference_id=v_expense
     AND is_posted=true AND COALESCE(is_reversed,false)=false
   ORDER BY created_at DESC LIMIT 1;

  SELECT je.total_debit,je.total_credit,
         COALESCE(sum(jel.debit) FILTER (WHERE coa.code='5300'),0),
         COALESCE(sum(jel.debit) FILTER (WHERE coa.code='1150'),0),
         COALESCE(sum(jel.credit) FILTER (WHERE coa.code='2132'),0),
         COALESCE(sum(jel.credit) FILTER (
           WHERE jel.account_id=(SELECT coa_id FROM public.bank_accounts WHERE id=v_bank)
         ),0)
    INTO v_debit,v_credit,v_expense_debit,v_ppn_debit,v_pph_credit,v_bank_credit
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE je.id=v_je
   GROUP BY je.total_debit,je.total_credit;
  IF v_debit<>12227503 OR v_credit<>12227503
     OR v_expense_debit<>11769808
     OR v_ppn_debit<>457695
     OR v_pph_credit<>62000
     OR v_bank_credit<>12165503 THEN
    RAISE EXCEPTION
      'Customs Broker journal formula failed: debit %, credit %, expense %, PPN %, PPh23 %, bank %',
      v_debit,v_credit,v_expense_debit,v_ppn_debit,v_pph_credit,v_bank_credit;
  END IF;

  INSERT INTO public.bank_statement_uploads(
    bank_account_id,statement_period,statement_start_date,statement_end_date,currency,uploaded_by,status)
  VALUES(v_bank,'Finance V1.1 rollback regression',current_date,current_date,'IDR',v_user,'completed')
  RETURNING id INTO v_upload;
  INSERT INTO public.bank_statement_lines(
    upload_id,bank_account_id,transaction_date,description,debit_amount,credit_amount,currency,created_by)
  SELECT v_upload,fe.bank_account_id,fe.expense_date,'V1.1 split broker regression',
         12165503,0,'IDR',v_user
    FROM public.finance_expenses fe
   WHERE fe.id=v_expense
  RETURNING id INTO v_line;
  PERFORM public.link_bank_statement_line(v_line,'expense',v_expense,'supplier');
  PERFORM 1 FROM public.bank_statement_lines
   WHERE id=v_line AND matched_expense_id=v_expense AND matched_entry_id=v_je
     AND reconciliation_status='matched';
  IF NOT FOUND THEN RAISE EXCEPTION 'Corrected Broker Expense bank link failed'; END IF;
  PERFORM public.unmatch_bank_line(v_line);
  PERFORM 1 FROM public.bank_statement_lines
   WHERE id=v_line AND matched_expense_id IS NULL AND matched_entry_id IS NULL
     AND reconciliation_status='unmatched' AND matching_status='none'
     AND manually_unlinked=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Broker Expense bank unlink did not persist as unmatched'; END IF;
  PERFORM public.link_bank_statement_line(v_line,'expense',v_expense,'supplier');
  SELECT count(*) INTO v_count FROM public.journal_entries
   WHERE source_module='expenses' AND reference_id=v_expense
     AND is_posted=true AND COALESCE(is_reversed,false)=false;
  IF v_count<>1 THEN RAISE EXCEPTION 'Broker Expense relink produced % active journals',v_count; END IF;

  UPDATE public.finance_staff_master SET monthly_salary=2000000,salary_type='monthly',
    pph21_applicable=true,pph21_method='percentage',pph21_percentage=5,
    default_payment_method='bank_transfer' WHERE id=v_staff;

  -- Salary Advance uses the existing Payment command and carries attachments.
  v_saved:=public.save_payment_voucher_with_purpose(NULL,jsonb_build_object(
    'voucher_date',current_date,'staff_id',v_staff,'payment_method','bank_transfer',
    'bank_account_id',v_bank,'amount',500000,'invoice_amount',500000,
    'payment_amount',500000,'payment_currency','IDR','invoice_currency','IDR',
    'exchange_rate',1,'bank_amount',500000,'actual_bank_debit',500000,
    'description','Finance V1.1 Salary Advance regression','created_by',v_user,
    'document_urls',jsonb_build_array('https://example.invalid/finance-v11-regression.pdf')),
    '[]'::jsonb,'salary_advance');
  v_payment:=(v_saved->>'id')::uuid;
  v_saved:=public.save_payment_voucher_with_purpose(v_payment,jsonb_build_object(
    'voucher_date',current_date,'staff_id',v_staff,'payment_method','bank_transfer',
    'bank_account_id',v_bank,'amount',500000,'invoice_amount',500000,
    'payment_amount',500000,'payment_currency','IDR','invoice_currency','IDR',
    'exchange_rate',1,'bank_amount',500000,'actual_bank_debit',500000,
    'description','Finance V1.1 edited Salary Advance regression','created_by',v_user,
    'document_urls',jsonb_build_array(
      'https://example.invalid/finance-v11-regression.pdf',
      'https://example.invalid/finance-v11-regression-2.pdf')),
    '[]'::jsonb,'salary_advance');
  PERFORM public.post_payment_voucher(v_payment,v_user);
  PERFORM 1 FROM public.payment_vouchers WHERE id=v_payment AND
    document_urls=ARRAY[
      'https://example.invalid/finance-v11-regression.pdf',
      'https://example.invalid/finance-v11-regression-2.pdf']::text[];
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment attachment was not persisted by the canonical command'; END IF;

  INSERT INTO public.bank_statement_lines(
    upload_id,bank_account_id,transaction_date,description,debit_amount,credit_amount,currency,created_by)
  VALUES(v_upload,v_bank,current_date,'V1.1 Payment link regression',500000,0,'IDR',v_user)
  RETURNING id INTO v_line;
  PERFORM public.link_bank_statement_line(v_line,'payment',v_payment,'supplier');
  PERFORM 1 FROM public.bank_statement_lines WHERE id=v_line AND matched_payment_id=v_payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment link did not preserve Payment document identity'; END IF;
  PERFORM public.unmatch_bank_line(v_line);
  PERFORM public.link_bank_statement_line(v_line,'payment',v_payment,'supplier');

  -- Permanent production scenario: USD 21,000 invoice paid from an IDR bank.
  v_saved:=public.save_payment_voucher_with_purpose(NULL,jsonb_build_object(
    'voucher_date',current_date,'supplier_id',v_supplier,'payment_method','bank_transfer',
    'bank_account_id',v_bank,'amount',21000,'invoice_currency','USD','invoice_amount',21000,
    'payment_amount',21000,'payment_currency','IDR','bank_currency','IDR',
    'exchange_rate',16990,'converted_amount',356790000,'bank_charge',50000,
    'actual_bank_debit',356840000,'bank_amount',356840000,
    'description','Finance V1.1 USD to IDR regression','created_by',v_user,'document_urls','[]'::jsonb),
    '[]'::jsonb,'general');
  v_fx_payment:=(v_saved->>'id')::uuid;
  PERFORM public.post_payment_voucher(v_fx_payment,v_user);
  PERFORM 1 FROM public.payment_vouchers WHERE id=v_fx_payment
    AND invoice_currency='USD' AND invoice_amount=21000
    AND payment_currency='IDR' AND bank_currency='IDR' AND exchange_rate=16990
    AND converted_amount=356790000 AND bank_charge=50000 AND actual_bank_debit=356840000;
  IF NOT FOUND THEN RAISE EXCEPTION 'USD 21,000 to IDR canonical Payment values were not preserved'; END IF;
  SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id=v_fx_payment;
  PERFORM 1 FROM public.journal_entry_lines jel JOIN public.bank_accounts ba ON ba.coa_id=jel.account_id
   WHERE jel.journal_entry_id=v_je AND ba.id=v_bank AND jel.credit=356840000;
  IF NOT FOUND THEN RAISE EXCEPTION 'USD to IDR bank journal does not equal actual cash outflow: %',
    (SELECT jsonb_agg(jsonb_build_object('code',coa.code,'debit',jel.debit,'credit',jel.credit,
      'transaction_currency',jel.transaction_currency,'transaction_debit',jel.transaction_debit,
      'transaction_credit',jel.transaction_credit,'description',jel.description))
     FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
     WHERE jel.journal_entry_id=v_je); END IF;
  INSERT INTO public.bank_statement_lines(
    upload_id,bank_account_id,transaction_date,description,debit_amount,credit_amount,currency,created_by)
  VALUES(v_upload,v_bank,current_date,'V1.1 cross-currency Payment link',356840000,0,'IDR',v_user)
  RETURNING id INTO v_line;
  PERFORM public.link_bank_statement_line(v_line,'payment',v_fx_payment,'supplier');
  PERFORM 1 FROM public.bank_statement_lines WHERE id=v_line AND matched_payment_id=v_fx_payment AND matched_entry_id=v_je;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cross-currency Payment bank link failed'; END IF;

  v_calc:=public.calculate_staff_salary(v_staff,current_date,NULL);
  IF (v_calc->>'gross_salary')::numeric<>2000000
     OR (v_calc->>'outstanding_salary_advances')::numeric<>500000
     OR (v_calc->>'pph21_amount')::numeric<>100000
     OR (v_calc->>'net_salary_payable')::numeric<>1400000 THEN
    RAISE EXCEPTION 'Canonical salary calculation failed: %',v_calc;
  END IF;

  v_salary:=public.save_finance_expense(NULL,jsonb_build_object(
    'expense_date',current_date,'expense_category','salary','expense_type','admin',
    'amount',2000000,'staff_id',v_staff,'description','Finance V1.1 Salary regression',
    'approval_status','pending_approval','transaction_currency','IDR','exchange_rate',1,
    'pph_amount',100000,'pph_code_id',v_pph21,'created_by',v_user,'document_urls','[]'::jsonb));
  PERFORM public.approve_finance_expense(v_salary,v_user);

  SELECT id INTO v_je FROM public.journal_entries WHERE reference_id=v_salary
    AND source_module IN ('expense','expenses') AND is_posted=true AND COALESCE(is_reversed,false)=false
    ORDER BY created_at DESC LIMIT 1;
  PERFORM 1 FROM public.journal_entries WHERE id=v_je AND abs(total_debit-total_credit)<=0.01;
  IF NOT FOUND THEN RAISE EXCEPTION 'Salary journal is absent or unbalanced'; END IF;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_je
    AND account_id=(SELECT id FROM public.chart_of_accounts WHERE code='2131' LIMIT 1) AND credit=100000;
  IF NOT FOUND THEN RAISE EXCEPTION 'Salary PPh21 did not post to withholding liability: %',
    (SELECT jsonb_agg(jsonb_build_object('code',coa.code,'debit',jel.debit,'credit',jel.credit,'description',jel.description))
       FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
      WHERE jel.journal_entry_id=v_je); END IF;

  SELECT id INTO v_pph_period FROM public.tax_periods
   WHERE fiscal_year=EXTRACT(YEAR FROM current_date)::int
     AND period_month=EXTRACT(MONTH FROM current_date)::int
     AND tax_type='PPh21';
  IF v_pph_period IS NULL THEN RAISE EXCEPTION 'Current PPh21 period is missing'; END IF;
  PERFORM public.compute_period_ppn(v_pph_period);
  SELECT pph_total INTO v_pph_before FROM public.tax_periods WHERE id=v_pph_period;

  -- A reversed/missing journal is an accounting warning, not authority to
  -- remove an approved withholding from the statutory Register.
  UPDATE public.journal_entries SET is_reversed=true WHERE id=v_je;
  SELECT pph_total INTO v_pph_after FROM public.tax_periods WHERE id=v_pph_period;
  IF v_pph_after IS DISTINCT FROM v_pph_before THEN
    RAISE EXCEPTION 'PPh Register changed from % to % when its source journal was reversed',v_pph_before,v_pph_after;
  END IF;
  UPDATE public.journal_entries SET is_reversed=false WHERE id=v_je;

  -- A draft with PPh never enters the Register and deleting it changes no
  -- official liability.
  v_draft_pph:=public.save_finance_expense(NULL,jsonb_build_object(
    'expense_date',current_date,'expense_category','salary','expense_type','admin',
    'amount',1000,'staff_id',v_staff,'description','Draft PPh Register regression',
    'approval_status','pending_approval','transaction_currency','IDR','exchange_rate',1,
    'pph_amount',50,'pph_code_id',v_pph21,'created_by',v_user,'document_urls','[]'::jsonb));
  SELECT pph_total INTO v_pph_after FROM public.tax_periods WHERE id=v_pph_period;
  IF v_pph_after IS DISTINCT FROM v_pph_before THEN RAISE EXCEPTION 'Draft PPh entered the Register'; END IF;
  PERFORM public.delete_expense_safe(v_draft_pph);
  SELECT pph_total INTO v_pph_after FROM public.tax_periods WHERE id=v_pph_period;
  IF v_pph_after IS DISTINCT FROM v_pph_before THEN RAISE EXCEPTION 'Deleting draft PPh changed the Register'; END IF;

  -- Cancellation removes source approval; reapproval restores the liability
  -- and recreates exactly one active journal.
  PERFORM public.cancel_expense_posting(v_salary,v_user,'PPh Register lifecycle regression');
  SELECT pph_total INTO v_pph_after FROM public.tax_periods WHERE id=v_pph_period;
  IF v_pph_after IS DISTINCT FROM v_pph_before-100000 THEN
    RAISE EXCEPTION 'Cancelling approved PPh did not remove exactly 100000 from the Register';
  END IF;
  PERFORM public.approve_finance_expense(v_salary,v_user);
  SELECT pph_total INTO v_pph_after FROM public.tax_periods WHERE id=v_pph_period;
  IF v_pph_after IS DISTINCT FROM v_pph_before THEN RAISE EXCEPTION 'Reapproving PPh did not restore the Register'; END IF;
  SELECT count(*) INTO v_count FROM public.journal_entries
   WHERE reference_id=v_salary AND source_module IN ('expense','expenses')
     AND is_posted=true AND COALESCE(is_reversed,false)=false;
  IF v_count<>1 THEN RAISE EXCEPTION 'PPh reapproval produced % active journals',v_count; END IF;

  v_applied:=public.apply_salary_advances_to_expense(v_salary,true);
  IF (v_applied->>'total_applied')::numeric<>500000 OR (v_applied->>'remaining_salary')::numeric<>1400000 THEN
    RAISE EXCEPTION 'Salary Advance settlement did not reconcile to net salary: %',v_applied;
  END IF;

  SELECT count(*) INTO v_count FROM public.journal_entries je WHERE je.is_posted=true AND
    abs(COALESCE((SELECT sum(debit) FROM public.journal_entry_lines WHERE journal_entry_id=je.id),0)-
        COALESCE((SELECT sum(credit) FROM public.journal_entry_lines WHERE journal_entry_id=je.id),0))>0.01;
  IF v_count<>0 THEN RAISE EXCEPTION '% posted journals are unbalanced',v_count; END IF;
  SELECT count(*) INTO v_count FROM public.bank_statement_lines WHERE matched_payment_id IS NOT NULL AND matched_entry_id IS NULL;
  IF v_count<>0 THEN RAISE EXCEPTION '% Payment bank links have stale journal references',v_count; END IF;

  SELECT COALESCE(sum(total_debit),0),COALESCE(sum(total_credit),0)
    INTO v_debit,v_credit
    FROM public.get_trial_balance('2000-01-01'::date,current_date,1);
  IF abs(v_debit-v_credit)>0.01 THEN RAISE EXCEPTION 'Trial Balance is out by %',v_debit-v_credit; END IF;
  PERFORM 1 FROM public.get_pnl_summary('2000-01-01'::date,current_date,1);
  IF NOT FOUND THEN RAISE EXCEPTION 'Profit and Loss RPC returned no row'; END IF;
  PERFORM 1 FROM public.get_balance_sheet(current_date,1);
  IF NOT FOUND THEN RAISE EXCEPTION 'Balance Sheet RPC returned no rows'; END IF;
  PERFORM 1 FROM public.vw_monthly_tax_summary;
  PERFORM 1 FROM public.vw_outstanding_tax;
  PERFORM 1 FROM public.vw_tax_period_status;
  PERFORM 1 FROM public.vw_input_ppn_report
   WHERE reference=(
     SELECT COALESCE(invoice_number,voucher_number)::varchar
       FROM public.finance_expenses WHERE id=v_expense
   ) AND dpp_amount=8669808 AND ppn_amount=457695;
  IF NOT FOUND THEN RAISE EXCEPTION 'Input PPN report does not preserve the corrected Broker expense/PPN split'; END IF;
  PERFORM 1 FROM public.vw_pph_by_period_type
   WHERE fiscal_year=2026 AND period_month=2 AND tax_type='PPh23' AND pph_total>=62000;
  IF NOT FOUND THEN RAISE EXCEPTION 'PPh23 report does not include the Broker withholding'; END IF;
END;
$regression$;
ROLLBACK;
`;

try {
  const stdout=execFileSync('supabase',['db','query','--linked','--output-format','json',sql],{
    cwd:process.cwd(),encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:100*1024*1024,
  });
  const response=JSON.parse(stdout.slice(stdout.indexOf('{')));
  if(response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  console.log(JSON.stringify({status:'passed',transaction:'rolled_back',checks:[
    'customs_broker_real_cash_formula_and_balanced_journal',
    'expense_split_journal_bank_link_unlink_relink','expense_cancel_edit_reapprove_stable_journal',
    'payment_create_edit_multiple_attachments',
    'payment_bank_link_unlink_relink_document_identity','staff_salary_master_calculation',
    'usd_21000_to_idr_356840000_cross_currency_payment',
    'salary_advance_fifo_settlement_after_pph21','salary_journal_and_withholding_liability',
    'pph_register_approved_source_journal_reversal_cancel_reapprove_draft_delete',
    'all_posted_journals_balanced','no_stale_payment_bank_links',
    'trial_balance_pnl_balance_sheet_and_tax_reports',
    'recoverable_ppn_and_pph23_reports',
  ]},null,2));
} catch(error) {
  if(error && typeof error==='object') {
    if('stdout' in error && error.stdout) process.stderr.write(String(error.stdout));
    if('stderr' in error && error.stderr) process.stderr.write(String(error.stderr));
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode=1;
}
