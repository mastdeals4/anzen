-- ============================================================================
-- FINAL SECURITY AUTHORIZATION AUDIT & ROLE HARDENING
-- Migration: 20260915190000_final_security_authorization_audit.sql
-- ============================================================================

-- 1. Correct purchase_batch_cost_layers policy (remove non-existent 'manager' role)
DROP POLICY IF EXISTS purchase_batch_cost_layers_select ON public.purchase_batch_cost_layers;
CREATE POLICY purchase_batch_cost_layers_select ON public.purchase_batch_cost_layers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() 
        AND up.is_active = true 
        AND up.role = ANY (ARRAY['admin'::text, 'accounts'::text])
    )
  );


-- repair_all_posted_fund_transfers()
CREATE OR REPLACE FUNCTION public.repair_all_posted_fund_transfers()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  t record;
  eligibility text;
  result jsonb;
  scanned integer := 0;
  repaired integer := 0;
  skipped integer := 0;
  skipped_details jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();
  FOR t IN SELECT id, transfer_number FROM public.fund_transfers WHERE status='posted' ORDER BY transfer_date, transfer_number LOOP
    scanned := scanned + 1;
    eligibility := public.audit_fund_transfer_repair_eligibility(t.id);
    IF eligibility IS NOT NULL THEN
      skipped := skipped + 1;
      skipped_details := skipped_details || jsonb_build_array(jsonb_build_object(
        'fund_transfer_id', t.id, 'transfer_number', t.transfer_number, 'reason', eligibility));
      CONTINUE;
    END IF;
    SELECT public.repair_posted_fund_transfer_from_source(t.id) INTO result;
    IF COALESCE((result->>'repaired')::boolean, false) THEN
      repaired := repaired + 1;
      IF NOT EXISTS (
        SELECT 1 FROM public.audit_logs a
        WHERE a.table_name='fund_transfers' AND a.record_id=t.id
          AND a.new_values->>'validation_rerun'='true'
      ) THEN
        INSERT INTO public.audit_logs(table_name, action_type, record_id, old_values, new_values, changed_fields)
        VALUES ('fund_transfers', 'update', t.id,
          jsonb_build_object('event','batch_repair','transfer_number',t.transfer_number),
          jsonb_build_object('event','batch_repair','repair_result',result,'validation_rerun',true),
          COALESCE(ARRAY(SELECT jsonb_array_elements_text(result->'repaired_fields')), ARRAY[]::text[]));
      END IF;
    ELSE
      skipped := skipped + 1;
      skipped_details := skipped_details || jsonb_build_array(jsonb_build_object(
        'fund_transfer_id', t.id, 'transfer_number', t.transfer_number,
        'reason', COALESCE(result->>'reason', 'Repair did not pass validation')));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('total_scanned', scanned, 'automatically_repaired', repaired,
    'skipped', skipped, 'skipped_details', skipped_details);
END;
$function$
;


-- repair_historical_usd_idr_transfer_fx(p_cutoff date)
CREATE OR REPLACE FUNCTION public.repair_historical_usd_idr_transfer_fx(p_cutoff date DEFAULT '2026-08-01'::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE r record; l record; v_reversal uuid; v_corrected uuid; v_entry text; v_line int; v_run uuid; v_repaired int:=0; v_skipped int:=0; v_exception int:=0; BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM set_config('app.finance_historical_repair','on',true);
  PERFORM set_config('app.finance_historical_repair_relink','on',true);
  INSERT INTO public.finance_historical_repair_runs(notes) VALUES ('Controlled historical USD→IDR fund-transfer FX correction before cutoff '||p_cutoff::text) RETURNING id INTO v_run;
  FOR r IN
    SELECT ft.id, ft.transfer_number, ft.transfer_date, ft.from_amount, ft.to_amount, ft.exchange_rate, ft.journal_entry_id,
           je.entry_number, je.total_debit, je.total_credit,
           fba.coa_id from_coa, fba.currency from_currency, tba.coa_id to_coa, tba.currency to_currency,
           fs.id from_stmt, ts.id to_stmt, fs.debit_amount from_debit, fs.credit_amount from_credit, fs.currency from_stmt_currency,
           ts.debit_amount to_debit, ts.credit_amount to_credit, ts.currency to_stmt_currency
    FROM public.fund_transfers ft
    JOIN public.bank_accounts fba ON fba.id=ft.from_bank_account_id
    JOIN public.bank_accounts tba ON tba.id=ft.to_bank_account_id
    JOIN public.journal_entries je ON je.id=ft.journal_entry_id
    JOIN public.bank_statement_lines fs ON fs.id=ft.from_bank_statement_line_id
    JOIN public.bank_statement_lines ts ON ts.id=ft.to_bank_statement_line_id
    WHERE ft.status='posted' AND ft.transfer_date < p_cutoff AND fba.currency='USD' AND tba.currency='IDR'
      AND fs.currency='USD' AND ts.currency='IDR'
      AND abs(fs.debit_amount-ft.from_amount)<0.01 AND abs(fs.credit_amount)<0.01
      AND abs(ts.credit_amount-ft.to_amount)<0.01 AND abs(ts.debit_amount)<0.01
      AND NOT COALESCE(je.is_reversed,false)
    ORDER BY ft.transfer_date, ft.transfer_number
    FOR UPDATE OF ft,je,fs,ts
  LOOP
    IF abs(r.total_debit-r.to_amount)<0.01 AND abs(r.total_credit-r.to_amount)<0.01 THEN v_skipped:=v_skipped+1; CONTINUE; END IF;
    IF NOT (abs(r.total_debit-r.from_amount)<0.01 AND abs(r.total_credit-r.from_amount)<0.01) THEN
      v_exception:=v_exception+1;
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'fund_transfer',r.id,r.transfer_number,ARRAY['journal_amounts'],'Journal amount does not match either the USD source amount or evidenced IDR destination amount','Accountant review of the original journal and bank evidence');
      CONTINUE;
    END IF;
    v_entry:=public.generate_journal_entry_number();
    INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,posted_at,transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
    VALUES(v_entry,r.transfer_date,'historical_repair',r.id,'HR-REV-'||r.transfer_number,'Reversal of legacy USD-source functional posting '||r.entry_number,r.total_credit,r.total_debit,true,now(),'IDR','IDR',r.exchange_rate,true)
    RETURNING id INTO v_reversal;
    v_line:=1;
    FOR l IN SELECT jl.* FROM public.journal_entry_lines jl WHERE jl.journal_entry_id=r.journal_entry_id ORDER BY jl.line_number LOOP
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
      VALUES(v_reversal,v_line,l.account_id,l.credit,l.debit,'Historical FX reversal: '||COALESCE(l.description,''),l.supplier_id,l.transaction_currency,l.transaction_credit,l.transaction_debit,l.functional_currency,l.exchange_rate);
      v_line:=v_line+1;
    END LOOP;
    UPDATE public.journal_entries SET is_reversed=true,reversed_by_id=v_reversal WHERE id=r.journal_entry_id;
    v_entry:=public.generate_journal_entry_number();
    INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,posted_at,transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
    VALUES(v_entry,r.transfer_date,'historical_repair',r.id,'HR-FX-'||r.transfer_number,'Corrected USD→IDR fund transfer '||r.transfer_number,r.to_amount,r.to_amount,true,now(),'IDR','IDR',r.exchange_rate,true)
    RETURNING id INTO v_corrected;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
    VALUES(v_corrected,1,r.to_coa,r.to_amount,0,'Corrected transfer into IDR bank','IDR',r.to_amount,0,'IDR',1);
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
    VALUES(v_corrected,2,r.from_coa,0,r.to_amount,'Corrected transfer out of USD bank','USD',0,r.from_amount,'IDR',r.exchange_rate);
    UPDATE public.fund_transfers SET journal_entry_id=v_corrected WHERE id=r.id;
    UPDATE public.bank_statement_lines SET matched_entry_id=v_corrected, reconciliation_status='matched' WHERE id IN(r.from_stmt,r.to_stmt);
    INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
    VALUES(v_run,'fund_transfer',r.id,r.transfer_number,ARRAY['journal_entry','bank matched_entry_id'],jsonb_build_object('journal_entry_id',r.journal_entry_id,'entry_number',r.entry_number,'total',r.total_debit),jsonb_build_object('reversal_journal_id',v_reversal,'replacement_journal_id',v_corrected,'replacement_entry_number',v_entry,'functional_idr',r.to_amount,'transaction_usd',r.from_amount,'rate',r.exchange_rate),'Both bank statement sides prove the USD source amount, IDR destination amount, and historical FX rate');
    v_repaired:=v_repaired+1;
  END LOOP;
  UPDATE public.finance_historical_repair_runs SET completed_at=now(),total_records_scanned=v_repaired+v_skipped+v_exception,records_repaired=v_repaired,records_manual_review=v_exception,records_skipped=v_skipped WHERE id=v_run;
  RETURN jsonb_build_object('run_id',v_run,'repaired',v_repaired,'skipped_already_correct',v_skipped,'manual_review',v_exception,'cutoff',p_cutoff);
END $function$
;


-- repair_posted_fund_transfer_from_source(p_fund_transfer_id uuid)
CREATE OR REPLACE FUNCTION public.repair_posted_fund_transfer_from_source(p_fund_transfer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_transfer public.fund_transfers%ROWTYPE;
  v_journal public.journal_entries%ROWTYPE;
  v_from_coa uuid;
  v_to_coa uuid;
  v_from_currency text;
  v_to_currency text;
  v_journal_currency text;
  v_expected_rate numeric;
  v_before_lines jsonb;
  v_after_lines jsonb;
  v_repaired_fields text[] := ARRAY[]::text[];
  v_possible_bank_transactions integer;
  v_validation_failures integer;
  v_live_validation_failures integer;
  v_validation_passed boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();
  PERFORM set_config('app.finance_historical_repair', 'on', true);
  PERFORM set_config('app.finance_metadata_repair', 'on', true);

  SELECT * INTO v_transfer
  FROM public.fund_transfers
  WHERE id = p_fund_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund Transfer not found';
  END IF;
  IF v_transfer.status <> 'posted' OR v_transfer.journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer is not posted with an existing journal');
  END IF;

  SELECT * INTO v_journal
  FROM public.journal_entries
  WHERE id = v_transfer.journal_entry_id
  FOR UPDATE;

  IF NOT FOUND OR NOT COALESCE(v_journal.is_posted, false) OR COALESCE(v_journal.is_reversed, false) THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer journal is not an active posted journal');
  END IF;
  IF v_journal.source_module NOT IN ('fund_transfer', 'fund_transfers')
     OR v_journal.reference_id IS DISTINCT FROM v_transfer.id THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer and journal do not prove an authoritative relationship');
  END IF;

  IF v_transfer.from_account_type = 'bank' THEN
    SELECT coa_id, upper(currency) INTO v_from_coa, v_from_currency
    FROM public.bank_accounts WHERE id = v_transfer.from_bank_account_id AND is_active;
  ELSIF v_transfer.from_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO v_from_coa, v_from_currency FROM public.chart_of_accounts WHERE code = '1102' AND is_active LIMIT 1;
  ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN
    SELECT id, 'IDR' INTO v_from_coa, v_from_currency FROM public.chart_of_accounts WHERE code = '1101' AND is_active LIMIT 1;
  END IF;

  IF v_transfer.to_account_type = 'bank' THEN
    SELECT coa_id, upper(currency) INTO v_to_coa, v_to_currency
    FROM public.bank_accounts WHERE id = v_transfer.to_bank_account_id AND is_active;
  ELSIF v_transfer.to_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO v_to_coa, v_to_currency FROM public.chart_of_accounts WHERE code = '1102' AND is_active LIMIT 1;
  ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN
    SELECT id, 'IDR' INTO v_to_coa, v_to_currency FROM public.chart_of_accounts WHERE code = '1101' AND is_active LIMIT 1;
  END IF;

  IF v_from_coa IS NULL OR v_to_coa IS NULL OR v_from_currency IS NULL OR v_to_currency IS NULL THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer source does not contain complete active account and currency information');
  END IF;
  IF v_transfer.from_amount IS NULL OR v_transfer.to_amount IS NULL OR v_transfer.exchange_rate IS NULL THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer source is missing an amount or exchange rate');
  END IF;

  v_expected_rate := CASE
    WHEN v_from_currency = v_to_currency THEN 1
    WHEN v_from_currency = 'IDR' AND v_transfer.to_amount > 0 THEN v_transfer.from_amount / v_transfer.to_amount
    WHEN v_to_currency = 'IDR' AND v_transfer.from_amount > 0 THEN v_transfer.to_amount / v_transfer.from_amount
  END;
  IF v_expected_rate IS NULL OR abs(v_transfer.exchange_rate - v_expected_rate) > 0.000001 THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer exchange rate is not internally consistent with its stored amounts');
  END IF;
  IF (SELECT count(*) FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id AND line_number = 1 AND COALESCE(debit, 0) > 0 AND COALESCE(credit, 0) = 0)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id AND line_number = 2 AND COALESCE(credit, 0) > 0 AND COALESCE(debit, 0) = 0) THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Existing journal lines are not a safe two-line transfer journal');
  END IF;
  IF abs(COALESCE(v_journal.total_debit, 0) - COALESCE(v_transfer.from_amount, 0)) > 0.01
     OR abs(COALESCE(v_journal.total_credit, 0) - COALESCE(v_transfer.from_amount, 0)) > 0.01
     OR EXISTS (
       SELECT 1 FROM public.journal_entry_lines l
       WHERE l.journal_entry_id = v_journal.id
         AND ((l.line_number = 1 AND abs(COALESCE(l.debit, 0) - v_transfer.from_amount) > 0.01)
           OR (l.line_number = 2 AND abs(COALESCE(l.credit, 0) - v_transfer.from_amount) > 0.01))
     ) THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Existing posted journal amounts do not match the Fund Transfer source');
  END IF;

  -- No bank transaction is inferred or relinked. If the source document does
  -- not name a line, explicitly refuse to guess, especially when candidates
  -- are ambiguous. The accountant can resolve the missing source information.
  IF v_transfer.from_bank_statement_line_id IS NULL AND v_transfer.from_account_type = 'bank' THEN
    SELECT count(*) INTO v_possible_bank_transactions
    FROM public.bank_statement_lines b
    WHERE b.bank_account_id = v_transfer.from_bank_account_id
      AND abs(b.transaction_date - v_transfer.transfer_date) <= 8
      AND (COALESCE(b.debit_amount, 0) = v_transfer.from_amount OR COALESCE(b.credit_amount, 0) = v_transfer.from_amount);
    IF v_possible_bank_transactions > 1 THEN
      RETURN jsonb_build_object('repaired', false, 'reason', 'Multiple possible From Bank transactions exist; no bank link was guessed');
    END IF;
  END IF;
  IF v_transfer.to_bank_statement_line_id IS NULL AND v_transfer.to_account_type = 'bank' THEN
    SELECT count(*) INTO v_possible_bank_transactions
    FROM public.bank_statement_lines b
    WHERE b.bank_account_id = v_transfer.to_bank_account_id
      AND abs(b.transaction_date - v_transfer.transfer_date) <= 8
      AND (COALESCE(b.debit_amount, 0) = v_transfer.to_amount OR COALESCE(b.credit_amount, 0) = v_transfer.to_amount);
    IF v_possible_bank_transactions > 1 THEN
      RETURN jsonb_build_object('repaired', false, 'reason', 'Multiple possible To Bank transactions exist; no bank link was guessed');
    END IF;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'debit', debit, 'credit', credit) ORDER BY id)
  INTO v_before_lines FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id;

  v_journal_currency := CASE WHEN v_from_currency = v_to_currency THEN v_from_currency ELSE 'IDR' END;
  UPDATE public.journal_entries
  SET source_module = 'fund_transfers', reference_id = v_transfer.id,
      reference_number = v_transfer.transfer_number, transaction_currency = v_journal_currency,
      functional_currency = 'IDR', exchange_rate = v_transfer.exchange_rate,
      amounts_are_functional = true
  WHERE id = v_journal.id
    AND (source_module IS DISTINCT FROM 'fund_transfers' OR reference_id IS DISTINCT FROM v_transfer.id
      OR reference_number IS DISTINCT FROM v_transfer.transfer_number OR transaction_currency IS DISTINCT FROM v_journal_currency
      OR functional_currency IS DISTINCT FROM 'IDR' OR exchange_rate IS DISTINCT FROM v_transfer.exchange_rate
      OR amounts_are_functional IS DISTINCT FROM true);
  IF FOUND THEN v_repaired_fields := array_append(v_repaired_fields, 'journal_metadata'); END IF;

  UPDATE public.journal_entry_lines
  SET account_id = v_to_coa, transaction_currency = v_to_currency,
      functional_currency = 'IDR', exchange_rate = CASE WHEN v_to_currency = 'USD' THEN v_transfer.exchange_rate ELSE 1 END
  WHERE journal_entry_id = v_journal.id AND line_number = 1
    AND (account_id IS DISTINCT FROM v_to_coa OR transaction_currency IS DISTINCT FROM v_to_currency
      OR functional_currency IS DISTINCT FROM 'IDR' OR exchange_rate IS DISTINCT FROM CASE WHEN v_to_currency = 'USD' THEN v_transfer.exchange_rate ELSE 1 END);
  IF FOUND THEN v_repaired_fields := array_append(v_repaired_fields, 'journal_debit_line_metadata'); END IF;

  UPDATE public.journal_entry_lines
  SET account_id = v_from_coa, transaction_currency = v_from_currency,
      functional_currency = 'IDR', exchange_rate = CASE WHEN v_from_currency = 'USD' THEN v_transfer.exchange_rate ELSE 1 END
  WHERE journal_entry_id = v_journal.id AND line_number = 2
    AND (account_id IS DISTINCT FROM v_from_coa OR transaction_currency IS DISTINCT FROM v_from_currency
      OR functional_currency IS DISTINCT FROM 'IDR' OR exchange_rate IS DISTINCT FROM CASE WHEN v_from_currency = 'USD' THEN v_transfer.exchange_rate ELSE 1 END);
  IF FOUND THEN v_repaired_fields := array_append(v_repaired_fields, 'journal_credit_line_metadata'); END IF;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'debit', debit, 'credit', credit) ORDER BY id)
  INTO v_after_lines FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id;
  IF v_before_lines IS DISTINCT FROM v_after_lines THEN
    RAISE EXCEPTION 'Fund Transfer repair cancelled because a debit or credit value changed';
  END IF;

  -- The existing validation projections are live views. Read them after the
  -- metadata updates; resolve the false-positive only when they are clean.
  SELECT count(*) INTO v_validation_failures
  FROM public.finance_historical_repair_verification_failures f
  WHERE f.document_type = 'fund_transfer' AND f.database_id = v_transfer.id;
  SELECT count(*) INTO v_live_validation_failures
  FROM public.finance_live_verification_failures f
  WHERE f.document_type = 'fund_transfer' AND f.document_id = v_transfer.id;
  v_validation_failures := v_validation_failures + v_live_validation_failures;
  v_validation_passed := v_validation_failures = 0;
  IF v_validation_passed THEN
    UPDATE public.finance_historical_repair_exceptions
    SET status = 'resolved'
    WHERE status = 'manual_review' AND document_type = 'fund_transfer' AND document_id = v_transfer.id;
  END IF;

  -- A no-op retry produces no second audit mutation. The first successful
  -- call records the exact derived fields changed and immutable line values.
  IF COALESCE(array_length(v_repaired_fields, 1), 0) > 0 THEN
    INSERT INTO public.audit_logs(table_name, action_type, record_id, old_values, new_values, changed_fields)
    VALUES ('fund_transfers', 'update', v_transfer.id,
      jsonb_build_object('journal_entry_id', v_journal.id, 'journal_lines', v_before_lines),
      jsonb_build_object('journal_entry_id', v_journal.id, 'journal_lines', v_after_lines,
        'validation_rerun', true, 'validation_passed', v_validation_passed),
      v_repaired_fields);
  END IF;

  IF NOT v_validation_passed THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Derived data still fails the existing Finance validation', 'validation_failures', v_validation_failures);
  END IF;

  RETURN jsonb_build_object('repaired', true, 'repaired_fields', v_repaired_fields,
    'validation_rerun', true, 'journal_entry_id', v_journal.id);
END;
$function$
;


-- delete_fund_transfer(p_id uuid)
CREATE OR REPLACE FUNCTION public.delete_fund_transfer(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_transfer             public.fund_transfers%ROWTYPE;
  v_je_ids               uuid[];
  v_period               record;
  v_dependency           record;
  v_orphan_count         integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Fund transfer id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT *
    INTO v_transfer
    FROM public.fund_transfers
   WHERE id = p_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund transfer % not found', p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_transfer.status = 'posted' THEN
    RAISE EXCEPTION
      'Posted fund transfer % cannot be deleted. Reverse it first, then delete it while the accounting period is open.',
      v_transfer.transfer_number
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT ap.fiscal_year, ap.period_month, ap.status
    INTO v_period
    FROM public.accounting_periods ap
   WHERE ap.start_date <= v_transfer.transfer_date
     AND ap.end_date >= v_transfer.transfer_date
   ORDER BY ap.start_date DESC
   LIMIT 1;

  IF FOUND AND v_period.status <> 'open' THEN
    RAISE EXCEPTION
      'Cannot delete fund transfer %: accounting period %-% is %.',
      v_transfer.transfer_number,
      v_period.fiscal_year,
      lpad(v_period.period_month::text, 2, '0'),
      v_period.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT je.id), ARRAY[]::uuid[])
    INTO v_je_ids
    FROM public.journal_entries je
   WHERE je.source_module = 'fund_transfers'
     AND (
       je.reference_id = p_id
       OR je.reference_number IN (
         v_transfer.transfer_number,
         'REV-' || v_transfer.transfer_number
       )
     );

  FOR v_period IN
    SELECT DISTINCT
           ap.fiscal_year,
           ap.period_month,
           ap.status,
           je.entry_date
      FROM public.journal_entries je
      JOIN public.accounting_periods ap
        ON ap.start_date <= je.entry_date
       AND ap.end_date >= je.entry_date
     WHERE je.id = ANY(v_je_ids)
       AND ap.status <> 'open'
  LOOP
    RAISE EXCEPTION
      'Cannot delete fund transfer %: journal accounting period %-% for % is %.',
      v_transfer.transfer_number,
      v_period.fiscal_year,
      lpad(v_period.period_month::text, 2, '0'),
      v_period.entry_date,
      v_period.status
      USING ERRCODE = 'check_violation';
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.reversed_by_id = ANY(v_je_ids)
       AND NOT (je.id = ANY(v_je_ids))
  ) THEN
    RAISE EXCEPTION
      'Cannot delete fund transfer %: an unrelated journal entry depends on its reversal journal.',
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Refuse to let an unexpected ON DELETE action modify another document.
  -- Expected Contra, ledger, and reconciliation owners are cleaned below.
  FOR v_dependency IN
    SELECT c.conrelid::regclass AS relation_name,
           a.attname AS column_name
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.journal_entries'::regclass
       AND array_length(c.conkey, 1) = 1
       AND NOT (
         (c.conrelid = 'public.journal_entry_lines'::regclass
          AND a.attname = 'journal_entry_id')
         OR (c.conrelid = 'public.fund_transfers'::regclass
             AND a.attname = 'journal_entry_id')
         OR (c.conrelid = 'public.bank_statement_lines'::regclass
             AND a.attname = 'matched_entry_id')
         OR (c.conrelid = 'public.bank_reconciliation_items'::regclass
             AND a.attname = 'journal_entry_id')
         OR (c.conrelid = 'public.journal_entries'::regclass
             AND a.attname = 'reversed_by_id')
       )
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s WHERE %I = ANY($1)',
      v_dependency.relation_name,
      v_dependency.column_name
    )
    INTO v_orphan_count
    USING v_je_ids;

    IF v_orphan_count <> 0 THEN
      RAISE EXCEPTION
        'Cannot delete fund transfer %: % dependent record(s) in % still reference its journal entry.',
        v_transfer.transfer_number,
        v_orphan_count,
        v_dependency.relation_name
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;

  -- Break the Fund Transfer -> Journal Entry FK cycle before deleting journals.
  UPDATE public.fund_transfers
     SET journal_entry_id = NULL
   WHERE id = p_id;

  -- Release only links owned by this Contra or one of its collected journals.
  UPDATE public.bank_statement_lines
     SET matched_fund_transfer_id = NULL,
         matched_entry_id = NULL,
         reconciliation_status = 'unmatched',
         matched_at = NULL,
         matched_by = NULL,
         notes = NULL
   WHERE matched_fund_transfer_id = p_id
      OR matched_entry_id = ANY(v_je_ids);

  UPDATE public.bank_reconciliation_items
     SET journal_entry_id = NULL,
         is_matched = false,
         matched_at = NULL
   WHERE journal_entry_id = ANY(v_je_ids);

  -- Petty Cash displays current Fund Transfers directly. This cleanup is only
  -- for legacy projection rows and cannot create or alter accounting.
  DELETE FROM public.petty_cash_transactions
   WHERE fund_transfer_id = p_id;

  UPDATE public.journal_entries
     SET is_reversed = false,
         reversed_by_id = NULL
   WHERE id = ANY(v_je_ids)
     AND reversed_by_id = ANY(v_je_ids);

  DELETE FROM public.journal_entry_lines
   WHERE journal_entry_id = ANY(v_je_ids);

  DELETE FROM public.journal_entries
   WHERE id = ANY(v_je_ids);

  DELETE FROM public.fund_transfers
   WHERE id = p_id;

  -- Every check runs before commit. Any failure rolls the entire deletion back.
  SELECT count(*)
    INTO v_orphan_count
    FROM public.fund_transfers
   WHERE id = p_id;
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: fund transfer % still exists. No changes were committed.',
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.journal_entries
   WHERE id = ANY(v_je_ids)
      OR (
        source_module = 'fund_transfers'
        AND (
          reference_id = p_id
          OR reference_number IN (
            v_transfer.transfer_number,
            'REV-' || v_transfer.transfer_number
          )
        )
      );
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % related journal entries remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.journal_entry_lines
   WHERE journal_entry_id = ANY(v_je_ids);
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % related ledger postings remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.petty_cash_transactions
   WHERE fund_transfer_id = p_id;
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % related Petty Cash rows remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.bank_statement_lines
   WHERE matched_fund_transfer_id = p_id
      OR matched_entry_id = ANY(v_je_ids);
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % Bank Reconciliation links remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.bank_reconciliation_items
   WHERE journal_entry_id = ANY(v_je_ids);
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % Bank Reconciliation items remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$function$
;


-- delete_payment_voucher_with_allocations(p_voucher_id uuid)
CREATE OR REPLACE FUNCTION public.delete_payment_voucher_with_allocations(p_voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
v_invoice_id uuid;
v_affected_invoice_ids uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

SELECT COALESCE(array_agg(DISTINCT purchase_invoice_id), ARRAY[]::uuid[])
INTO v_affected_invoice_ids
FROM public.voucher_allocations
WHERE payment_voucher_id = p_voucher_id
AND purchase_invoice_id IS NOT NULL;

DELETE FROM public.voucher_allocations
WHERE payment_voucher_id = p_voucher_id;

DELETE FROM public.payment_vouchers
WHERE id = p_voucher_id;

IF NOT FOUND THEN
RAISE EXCEPTION 'Payment voucher % not found', p_voucher_id;
END IF;

FOR v_invoice_id IN SELECT DISTINCT unnest(v_affected_invoice_ids) LOOP
PERFORM public.recalculate_purchase_invoice_payment_state(v_invoice_id);
END LOOP;
END;
$function$
;


-- delete_expense_safe(p_expense_id uuid)
CREATE OR REPLACE FUNCTION public.delete_expense_safe(p_expense_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_expense public.finance_expenses%ROWTYPE;
  v_allocation_count integer;
  v_legacy_count integer;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot delete expenses', v_role;
  END IF;

  SELECT * INTO v_expense
    FROM public.finance_expenses
   WHERE id = p_expense_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  SELECT count(*) INTO v_allocation_count
    FROM public.bank_statement_allocations
   WHERE document_type = 'expense'
     AND document_id = p_expense_id;

  -- Separate statement: allocation triggers may safely recalculate the still
  -- existing expense, then the source row and its journals are deleted.
  DELETE FROM public.bank_statement_allocations
   WHERE document_type = 'expense'
     AND document_id = p_expense_id;

  -- Release pre-allocation legacy links to this expense. Allocation-owned
  -- lines have already been rebuilt by sync_bank_line_from_allocation().
  WITH released AS (
    UPDATE public.bank_statement_lines b SET
      matched_expense_id = NULL,
      matched_entry_id = NULL,
      reconciliation_status = 'unmatched',
      matching_status = 'none',
      matched_at = NULL,
      matched_by = NULL,
      manually_unlinked = true
    WHERE b.matched_expense_id = p_expense_id
      AND NOT EXISTS (
        SELECT 1 FROM public.bank_statement_allocations a
         WHERE a.bank_statement_line_id = b.id
      )
    RETURNING 1
  ) SELECT count(*) INTO v_legacy_count FROM released;

  DELETE FROM public.finance_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
     WHERE document_type = 'expense' AND document_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Expense delete left orphan bank allocations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bank_statement_lines WHERE matched_expense_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Expense delete left orphan bank references';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'released_allocations', v_allocation_count,
    'released_legacy_lines', v_legacy_count
  );
END;
$function$
;


-- delete_purchase_invoice(p_id uuid)
CREATE OR REPLACE FUNCTION public.delete_purchase_invoice(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_invoice           purchase_invoices%ROWTYPE;
  v_je_ids            UUID[];
  v_affected_pvs      UUID[];
  v_original_je_id    UUID;
  v_orphan_pv_je_ids  UUID[];

  -- integrity-check counters
  v_orphan_pi         INT;
  v_orphan_items      INT;
  v_orphan_allocs     INT;
  v_orphan_jes        INT;
  v_orphan_je_lines   INT;
  v_orphan_bsl_pi     INT;
  v_orphan_bsl_pv     INT;
  v_orphan_batches    INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Purchase invoice id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- (a) Lock the invoice row.
  SELECT * INTO v_invoice
    FROM public.purchase_invoices
   WHERE id = p_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  v_original_je_id := v_invoice.journal_entry_id;

  -- Collect every JE created by this invoice.
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_je_ids
    FROM public.journal_entries
   WHERE source_module = 'purchase_invoice'
     AND reference_id  = p_id;

  IF v_original_je_id IS NOT NULL
     AND NOT v_original_je_id = ANY (v_je_ids) THEN
    v_je_ids := array_append(v_je_ids, v_original_je_id);
  END IF;

  -- Payment vouchers that were paying THIS invoice.
  SELECT COALESCE(array_agg(DISTINCT payment_voucher_id), ARRAY[]::UUID[])
    INTO v_affected_pvs
    FROM public.voucher_allocations
   WHERE purchase_invoice_id = p_id
     AND payment_voucher_id IS NOT NULL;

  -- Drop the allocations pointing at this invoice.
  DELETE FROM public.voucher_allocations
   WHERE purchase_invoice_id = p_id;

  -- Identify PVs whose allocations are now empty and release their bank matches.
  IF array_length(v_affected_pvs, 1) IS NOT NULL THEN
    SELECT COALESCE(array_agg(pv.journal_entry_id), ARRAY[]::UUID[])
      INTO v_orphan_pv_je_ids
      FROM public.payment_vouchers pv
     WHERE pv.id = ANY (v_affected_pvs)
       AND pv.journal_entry_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1
               FROM public.voucher_allocations va
              WHERE va.payment_voucher_id = pv.id
           );

    IF array_length(v_orphan_pv_je_ids, 1) IS NOT NULL THEN
      UPDATE public.bank_statement_lines
         SET matched_entry_id        = NULL,
             matched_expense_id      = NULL,
             matched_receipt_id      = NULL,
             matched_petty_cash_id   = NULL,
             matched_fund_transfer_id= NULL,
             reconciliation_status   = 'unmatched',
             matched_at              = NULL,
             matched_by              = NULL
       WHERE matched_entry_id = ANY (v_orphan_pv_je_ids);
    END IF;
  END IF;

  -- Bank recon cleanup for the PI's OWN JEs (all typed FKs).
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    UPDATE public.bank_statement_lines
       SET matched_entry_id        = NULL,
           matched_expense_id      = NULL,
           matched_receipt_id      = NULL,
           matched_petty_cash_id   = NULL,
           matched_fund_transfer_id= NULL,
           reconciliation_status   = 'unmatched',
           matched_at              = NULL,
           matched_by              = NULL
     WHERE matched_entry_id = ANY (v_je_ids);
  END IF;

  -- Break invoice → JE FK before deleting the JE.
  IF v_original_je_id IS NOT NULL THEN
    UPDATE public.purchase_invoices
       SET journal_entry_id = NULL
     WHERE id = p_id;
  END IF;

  -- Delete JE lines then JE headers.
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines
     WHERE journal_entry_id = ANY (v_je_ids);

    DELETE FROM public.journal_entries
     WHERE id = ANY (v_je_ids);
  END IF;

  -- Detach batches.
  UPDATE public.batches
     SET purchase_invoice_id = NULL
   WHERE purchase_invoice_id = p_id;

  -- Belt-and-braces items delete.
  DELETE FROM public.purchase_invoice_items
   WHERE purchase_invoice_id = p_id;

  -- Delete the invoice row.
  DELETE FROM public.purchase_invoices
   WHERE id = p_id;

  -- ═════════════════════════════════════════════════════════════════════
  -- INTEGRITY CHECKS
  --
  -- Every RAISE EXCEPTION below rolls back this transaction — the invoice
  -- stays, the JE stays, allocations stay. Better a visible failure than
  -- silent orphan state on the bank reconciliation screen.
  -- ═════════════════════════════════════════════════════════════════════

  SELECT COUNT(*) INTO v_orphan_pi
    FROM public.purchase_invoices
   WHERE id = p_id;
  IF v_orphan_pi <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — purchase_invoices row still present (count=%). Rolling back.',
      p_id, v_orphan_pi
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_orphan_items
    FROM public.purchase_invoice_items
   WHERE purchase_invoice_id = p_id;
  IF v_orphan_items <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — % orphan purchase_invoice_items remain. Rolling back.',
      p_id, v_orphan_items
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_orphan_allocs
    FROM public.voucher_allocations
   WHERE purchase_invoice_id = p_id;
  IF v_orphan_allocs <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — % orphan voucher_allocations remain. Rolling back.',
      p_id, v_orphan_allocs
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_orphan_jes
    FROM public.journal_entries
   WHERE source_module = 'purchase_invoice'
     AND reference_id  = p_id;
  IF v_orphan_jes <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — % orphan journal_entries (source_module=purchase_invoice) remain. Rolling back.',
      p_id, v_orphan_jes
      USING ERRCODE = 'raise_exception';
  END IF;

  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    SELECT COUNT(*) INTO v_orphan_je_lines
      FROM public.journal_entry_lines
     WHERE journal_entry_id = ANY (v_je_ids);
    IF v_orphan_je_lines <> 0 THEN
      RAISE EXCEPTION
        'delete_purchase_invoice(%): integrity check failed — % orphan journal_entry_lines remain against deleted JEs. Rolling back.',
        p_id, v_orphan_je_lines
        USING ERRCODE = 'raise_exception';
    END IF;

    SELECT COUNT(*) INTO v_orphan_bsl_pi
      FROM public.bank_statement_lines
     WHERE matched_entry_id = ANY (v_je_ids);
    IF v_orphan_bsl_pi <> 0 THEN
      RAISE EXCEPTION
        'delete_purchase_invoice(%): integrity check failed — % bank_statement_lines still matched to deleted PI JEs. Rolling back.',
        p_id, v_orphan_bsl_pi
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF array_length(v_orphan_pv_je_ids, 1) IS NOT NULL THEN
    SELECT COUNT(*) INTO v_orphan_bsl_pv
      FROM public.bank_statement_lines
     WHERE matched_entry_id = ANY (v_orphan_pv_je_ids);
    IF v_orphan_bsl_pv <> 0 THEN
      RAISE EXCEPTION
        'delete_purchase_invoice(%): integrity check failed — % bank_statement_lines still matched to orphan PV JEs. Rolling back.',
        p_id, v_orphan_bsl_pv
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_orphan_batches
    FROM public.batches
   WHERE purchase_invoice_id = p_id;
  IF v_orphan_batches <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — % batches still tagged to deleted invoice. Rolling back.',
      p_id, v_orphan_batches
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════
  -- Audit trail — only reached when every check above passed.
  -- ═════════════════════════════════════════════════════════════════════
  BEGIN
    INSERT INTO public.audit_logs (
      table_name, record_id, action_type, old_values, new_values, user_id
    ) VALUES (
      'purchase_invoices',
      p_id,
      'delete',
      jsonb_build_object(
        'invoice_number',           v_invoice.invoice_number,
        'supplier_id',              v_invoice.supplier_id,
        'invoice_date',             v_invoice.invoice_date,
        'total_amount',             v_invoice.total_amount,
        'paid_amount',              v_invoice.paid_amount,
        'status',                   v_invoice.status,
        'journal_entry_ids',        to_jsonb(v_je_ids),
        'payment_voucher_ids',      to_jsonb(v_affected_pvs),
        'orphan_pv_je_ids_released',to_jsonb(v_orphan_pv_je_ids),
        'integrity_checks',         'passed'
      ),
      jsonb_build_object(
        '_action',      'DELETE_PURCHASE_INVOICE',
        'deleted_at',   NOW(),
        'deleted_by',   auth.uid()
      ),
      auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$function$
;


-- delete_tax_payment(p_id uuid)
CREATE OR REPLACE FUNCTION public.delete_tax_payment(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_payment        tax_payments%ROWTYPE;
  v_period_status  text;
  v_je_ids         uuid[];
  v_file_urls      text[];

  v_orphan_pay     int;
  v_orphan_je      int;
  v_orphan_je_lines int;
  v_orphan_bsl     int;
  v_orphan_bri     int;
  v_orphan_files   int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Tax payment id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock the row
  SELECT * INTO v_payment
    FROM public.tax_payments
   WHERE id = p_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax payment % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Refuse if the period is closed (unless service_role)
  IF current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    SELECT status INTO v_period_status FROM tax_periods WHERE id = v_payment.tax_period_id;
    IF v_period_status = 'closed' THEN
      RAISE EXCEPTION 'Tax period is closed; cannot delete tax payment. Reopen the period first.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Collect JEs owned by this tax payment
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_je_ids
    FROM public.journal_entries
   WHERE source_module = 'tax_payment'
     AND reference_id  = p_id;

  IF v_payment.journal_entry_id IS NOT NULL
     AND NOT v_payment.journal_entry_id = ANY (v_je_ids) THEN
    v_je_ids := array_append(v_je_ids, v_payment.journal_entry_id);
  END IF;

  -- Release bank_statement_lines matched to this payment.
  -- NOTE: bank_statement_lines has no updated_at column — do not write it.
  UPDATE public.bank_statement_lines
     SET matched_entry_id       = NULL,
         matched_tax_payment_id = NULL,
         reconciliation_status  = 'unmatched'
   WHERE (matched_tax_payment_id = p_id)
      OR (array_length(v_je_ids, 1) IS NOT NULL AND matched_entry_id = ANY (v_je_ids));

  -- Release bank_reconciliation_items entries
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    UPDATE public.bank_reconciliation_items
       SET is_matched = false,
           matched_at = NULL
     WHERE journal_entry_id = ANY (v_je_ids);
  END IF;

  -- Snapshot attachment paths BEFORE cascade-deleting the rows
  SELECT COALESCE(array_agg(file_url), ARRAY[]::text[])
    INTO v_file_urls
    FROM public.tax_payment_files
   WHERE tax_payment_id = p_id;

  DELETE FROM public.tax_payment_files WHERE tax_payment_id = p_id;

  -- Break FK from tax_payments → JE before deleting JE
  UPDATE public.tax_payments
     SET journal_entry_id = NULL
   WHERE id = p_id;

  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = ANY (v_je_ids);
    DELETE FROM public.journal_entries     WHERE id = ANY (v_je_ids);
  END IF;

  DELETE FROM public.tax_payments WHERE id = p_id;

  -- ═══ INTEGRITY CHECKS ═════════════════════════════════════════════════
  SELECT COUNT(*) INTO v_orphan_pay FROM public.tax_payments WHERE id = p_id;
  IF v_orphan_pay <> 0 THEN
    RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — tax_payments row still present. Rolling back.', p_id
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_orphan_je
    FROM public.journal_entries
   WHERE source_module = 'tax_payment' AND reference_id = p_id;
  IF v_orphan_je <> 0 THEN
    RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % orphan journal_entries (source=tax_payment) remain. Rolling back.', p_id, v_orphan_je
      USING ERRCODE = 'raise_exception';
  END IF;

  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    SELECT COUNT(*) INTO v_orphan_je_lines
      FROM public.journal_entry_lines WHERE journal_entry_id = ANY (v_je_ids);
    IF v_orphan_je_lines <> 0 THEN
      RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % orphan journal_entry_lines remain. Rolling back.', p_id, v_orphan_je_lines
        USING ERRCODE = 'raise_exception';
    END IF;

    SELECT COUNT(*) INTO v_orphan_bsl
      FROM public.bank_statement_lines
     WHERE matched_entry_id = ANY (v_je_ids);
    IF v_orphan_bsl <> 0 THEN
      RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % bank_statement_lines still matched to deleted JE. Rolling back.', p_id, v_orphan_bsl
        USING ERRCODE = 'raise_exception';
    END IF;

    SELECT COUNT(*) INTO v_orphan_bri
      FROM public.bank_reconciliation_items
     WHERE journal_entry_id = ANY (v_je_ids) AND is_matched = true;
    IF v_orphan_bri <> 0 THEN
      RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % bank_reconciliation_items still matched to deleted JE. Rolling back.', p_id, v_orphan_bri
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_orphan_files FROM public.tax_payment_files WHERE tax_payment_id = p_id;
  IF v_orphan_files <> 0 THEN
    RAISE EXCEPTION 'delete_tax_payment(%): integrity check failed — % orphan tax_payment_files remain. Rolling back.', p_id, v_orphan_files
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Audit trail (best-effort — do not let audit failure abort the delete)
  BEGIN
    INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
    VALUES (
      'tax_payments', p_id, 'delete',
      jsonb_build_object(
        'tax_period_id',   v_payment.tax_period_id,
        'tax_type',        v_payment.tax_type,
        'amount',          v_payment.amount,
        'payment_date',    v_payment.payment_date,
        'status',          v_payment.status,
        'file_urls',       v_file_urls
      ),
      NULL,
      auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- audit failure must not abort the delete
  END;
END $function$
;


-- reopen_tax_period(p_period_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.reopen_tax_period(p_period_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reopen reason is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_profiles
                 WHERE id = auth.uid() AND role = 'admin' AND is_active = true) THEN
    RAISE EXCEPTION 'Only admins may reopen a closed tax period';
  END IF;

  UPDATE tax_periods SET
    status         = 'reopened',
    reopen_reason  = p_reason,
    reopened_at    = now(),
    reopened_by    = auth.uid(),
    updated_at     = now()
  WHERE id = p_period_id AND status = 'closed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Period % is not in closed state', p_period_id;
  END IF;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_periods', 'update', p_period_id,
          jsonb_build_object('action','reopen','reason',p_reason));
END $function$
;


-- close_tax_period(p_period_id uuid)
CREATE OR REPLACE FUNCTION public.close_tax_period(p_period_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period                  tax_periods%ROWTYPE;
  v_missing_faktur          int;
  v_draft_sales             int;
  v_draft_purchase          int;
  v_unposted_je             int;
  v_unreconciled_payments   int;
  v_outstanding             numeric(18,2);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_profiles
                 WHERE id = auth.uid() AND role IN ('admin') AND is_active = true) THEN
    RAISE EXCEPTION 'Only admins/managers may close a tax period';
  END IF;

  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;
  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'Tax period already closed';
  END IF;

  -- Recompute snapshot before validating
  PERFORM compute_period_ppn(p_period_id);
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;

  -- 1. Missing Faktur Pajak (PPN only)
  IF v_period.tax_type = 'PPN' THEN
    SELECT COUNT(*) INTO v_missing_faktur
      FROM sales_invoices
     WHERE tax_period_id = p_period_id
       AND tax_amount > 0
       AND (faktur_pajak_number IS NULL OR faktur_pajak_number = '');
    IF v_missing_faktur > 0 THEN
      RAISE EXCEPTION 'Cannot close period: % sales invoice(s) missing Faktur Pajak number', v_missing_faktur;
    END IF;
  END IF;

  -- 2. No draft sales invoices attributed to this period
  BEGIN
    SELECT COUNT(*) INTO v_draft_sales
      FROM sales_invoices
     WHERE tax_period_id = p_period_id
       AND status = 'draft';
    IF v_draft_sales > 0 THEN
      RAISE EXCEPTION 'Cannot close period: % draft sales invoice(s) remain', v_draft_sales;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    NULL;  -- sales_invoices.status may not be present in every branch
  END;

  -- 3. No draft purchase invoices attributed to this period
  BEGIN
    SELECT COUNT(*) INTO v_draft_purchase
      FROM purchase_invoices
     WHERE tax_period_id = p_period_id
       AND status = 'draft';
    IF v_draft_purchase > 0 THEN
      RAISE EXCEPTION 'Cannot close period: % draft purchase invoice(s) remain', v_draft_purchase;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;

  -- 4. No unposted journal_entries referencing this period's source docs
  --    (any tax_payment JE where is_posted = false is a blocker)
  SELECT COUNT(*) INTO v_unposted_je
    FROM journal_entries je
    JOIN tax_payments txp ON txp.id = je.reference_id
   WHERE je.source_module = 'tax_payment'
     AND txp.tax_period_id = p_period_id
     AND je.is_posted = false;
  IF v_unposted_je > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unposted journal entries for tax payments', v_unposted_je;
  END IF;

  -- 5. No unreconciled tax_payments (must all be in status='reconciled')
  SELECT COUNT(*) INTO v_unreconciled_payments
    FROM tax_payments
   WHERE tax_period_id = p_period_id
     AND status IN ('draft','posted');
  IF v_unreconciled_payments > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unreconciled tax payment(s) remain (status draft or posted)', v_unreconciled_payments;
  END IF;

  -- 6. Zero outstanding payable
  SELECT outstanding_amount INTO v_outstanding
    FROM vw_outstanding_tax
   WHERE tax_period_id = p_period_id;
  IF COALESCE(v_outstanding, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot close period: Rp % still outstanding. Record additional tax payments first.', v_outstanding;
  END IF;

  -- Flip status
  UPDATE tax_periods SET
    status    = 'closed',
    closed_at = now(),
    closed_by = auth.uid(),
    updated_at = now()
  WHERE id = p_period_id;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_periods', 'update', p_period_id,
          jsonb_build_object(
            'action', 'close',
            'status', 'closed',
            'input_ppn_total',  v_period.input_ppn_total,
            'output_ppn_total', v_period.output_ppn_total,
            'net_ppn',          v_period.net_ppn,
            'pph_total',        v_period.pph_total
          ));
END $function$
;


-- record_tax_payment(p_tax_period_id uuid, p_tax_type text, p_payment_date date, p_amount numeric, p_bank_account_id uuid, p_billing_code text, p_ntpn text, p_government_reference text, p_notes text)
CREATE OR REPLACE FUNCTION public.record_tax_payment(p_tax_period_id uuid, p_tax_type text, p_payment_date date, p_amount numeric, p_bank_account_id uuid, p_billing_code text DEFAULT NULL::text, p_ntpn text DEFAULT NULL::text, p_government_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tp_id            uuid;
  v_je_id            uuid;
  v_je_number        text;
  v_period           tax_periods%ROWTYPE;
  v_payable_code     text;
  v_payable_acct_id  uuid;
  v_bank_acct_coa_id uuid;
  v_ref_number       text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Tax payment amount must be > 0';
  END IF;

  SELECT * INTO v_period FROM tax_periods WHERE id = p_tax_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_tax_period_id;
  END IF;
  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot record tax payment on a closed period';
  END IF;
  IF v_period.tax_type <> p_tax_type THEN
    RAISE EXCEPTION 'Tax type mismatch: period is %, payment is %',
      v_period.tax_type, p_tax_type;
  END IF;

  -- Map tax type → payable account code
  v_payable_code := CASE p_tax_type
    WHEN 'PPN'      THEN '2130'
    WHEN 'PPh21'    THEN '2131'
    WHEN 'PPh22'    THEN '2137'
    WHEN 'PPh23'    THEN '2132'
    WHEN 'PPh4(2)'  THEN '2138'
    WHEN 'PPh_Unifikasi' THEN '2131'  -- treated as PPh 21 payable by default
    ELSE NULL
  END;

  IF v_payable_code IS NULL THEN
    RAISE EXCEPTION 'Unknown tax_type: %', p_tax_type;
  END IF;

  SELECT id INTO v_payable_acct_id FROM chart_of_accounts WHERE code = v_payable_code;
  IF v_payable_acct_id IS NULL THEN
    RAISE EXCEPTION 'Payable account % missing from Chart of Accounts', v_payable_code;
  END IF;

  -- Bank account → CoA account
  IF p_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account is required for a tax payment';
  END IF;
  SELECT coa_id INTO v_bank_acct_coa_id FROM bank_accounts WHERE id = p_bank_account_id;
  IF v_bank_acct_coa_id IS NULL THEN
    -- Fallback to generic Bank BCA (1111) when bank_accounts.coa_id not wired
    SELECT id INTO v_bank_acct_coa_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_acct_coa_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve bank CoA account for tax payment';
  END IF;

  -- 1) Create tax_payments row (draft)
  INSERT INTO tax_payments
    (tax_period_id, tax_type, payment_date, amount,
     bank_account_id, billing_code, ntpn, government_reference, notes,
     status, created_by)
  VALUES
    (p_tax_period_id, p_tax_type, p_payment_date, p_amount,
     p_bank_account_id, p_billing_code, p_ntpn, p_government_reference, p_notes,
     'draft', auth.uid())
  RETURNING id INTO v_tp_id;

  v_ref_number := COALESCE(NULLIF(p_ntpn,''), NULLIF(p_billing_code,''),
                           'TAX-' || to_char(p_payment_date, 'YYMM') || '-' || substr(v_tp_id::text, 1, 8));

  -- 2) Post journal entry: Dr Tax Payable / Cr Bank
  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by)
  VALUES
    (v_je_number, p_payment_date, 'tax_payment', v_tp_id, v_ref_number,
     'Tax Payment ' || p_tax_type || ' — ' || v_ref_number,
     p_amount, p_amount, true, auth.uid())
  RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES
    (v_je_id, 1, v_payable_acct_id,
     p_tax_type || ' payment — ' || v_ref_number,
     p_amount, 0),
    (v_je_id, 2, v_bank_acct_coa_id,
     'Bank ' || p_tax_type || ' payment — ' || v_ref_number,
     0, p_amount);

  -- 3) Link back and mark posted
  UPDATE tax_payments SET
    journal_entry_id = v_je_id,
    status           = 'posted',
    updated_at       = now()
  WHERE id = v_tp_id;

  -- 4) Nudge the period status if it was open
  UPDATE tax_periods SET
    status = CASE WHEN status = 'open' THEN 'payment_pending' ELSE status END,
    updated_at = now()
  WHERE id = p_tax_period_id;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_payments', 'insert', v_tp_id,
          jsonb_build_object(
            'tax_period_id', p_tax_period_id,
            'tax_type',      p_tax_type,
            'amount',        p_amount,
            'journal_entry_id', v_je_id
          ));

  RETURN v_tp_id;
END $function$
;


-- record_tax_payment(p_tax_period_id uuid, p_tax_type text, p_payment_date date, p_amount numeric, p_bank_account_id uuid, p_billing_code text, p_ntpn text, p_government_reference text, p_notes text, p_payment_reference text)
CREATE OR REPLACE FUNCTION public.record_tax_payment(p_tax_period_id uuid, p_tax_type text, p_payment_date date, p_amount numeric, p_bank_account_id uuid, p_billing_code text DEFAULT NULL::text, p_ntpn text DEFAULT NULL::text, p_government_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_payment_reference text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tp_id            uuid;
  v_je_id            uuid;
  v_je_number        text;
  v_period           tax_periods%ROWTYPE;
  v_payable_code     text;
  v_payable_acct_id  uuid;
  v_bank_acct_coa_id uuid;
  v_ref_number       text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Tax payment amount must be > 0';
  END IF;

  SELECT * INTO v_period FROM tax_periods WHERE id = p_tax_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_tax_period_id;
  END IF;
  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot record tax payment on a closed period';
  END IF;
  IF v_period.tax_type <> p_tax_type THEN
    RAISE EXCEPTION 'Tax type mismatch: period is %, payment is %',
      v_period.tax_type, p_tax_type;
  END IF;

  v_payable_code := CASE p_tax_type
    WHEN 'PPN'      THEN '2130'
    WHEN 'PPh21'    THEN '2131'
    WHEN 'PPh22'    THEN '2137'
    WHEN 'PPh23'    THEN '2132'
    WHEN 'PPh4(2)'  THEN '2138'
    WHEN 'PPh_Unifikasi' THEN '2131'
    ELSE NULL
  END;

  IF v_payable_code IS NULL THEN
    RAISE EXCEPTION 'Unknown tax_type: %', p_tax_type;
  END IF;

  SELECT id INTO v_payable_acct_id FROM chart_of_accounts WHERE code = v_payable_code;
  IF v_payable_acct_id IS NULL THEN
    RAISE EXCEPTION 'Payable account % missing from Chart of Accounts', v_payable_code;
  END IF;

  IF p_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account is required for a tax payment';
  END IF;
  SELECT coa_id INTO v_bank_acct_coa_id FROM bank_accounts WHERE id = p_bank_account_id;
  IF v_bank_acct_coa_id IS NULL THEN
    SELECT id INTO v_bank_acct_coa_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_acct_coa_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve bank CoA account for tax payment';
  END IF;

  INSERT INTO tax_payments
    (tax_period_id, tax_type, payment_date, amount,
     bank_account_id, billing_code, ntpn, government_reference,
     payment_reference, notes,
     status, created_by)
  VALUES
    (p_tax_period_id, p_tax_type, p_payment_date, p_amount,
     p_bank_account_id, p_billing_code, p_ntpn, p_government_reference,
     p_payment_reference, p_notes,
     'draft', auth.uid())
  RETURNING id INTO v_tp_id;

  v_ref_number := COALESCE(
    NULLIF(p_ntpn, ''),
    NULLIF(p_billing_code, ''),
    NULLIF(p_payment_reference, ''),
    'TAX-' || to_char(p_payment_date, 'YYMM') || '-' || substr(v_tp_id::text, 1, 8)
  );

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by)
  VALUES
    (v_je_number, p_payment_date, 'tax_payment', v_tp_id, v_ref_number,
     'Tax Payment ' || p_tax_type || ' — ' || v_ref_number,
     p_amount, p_amount, true, auth.uid())
  RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES
    (v_je_id, 1, v_payable_acct_id,
     p_tax_type || ' payment — ' || v_ref_number, p_amount, 0),
    (v_je_id, 2, v_bank_acct_coa_id,
     'Bank ' || p_tax_type || ' payment — ' || v_ref_number, 0, p_amount);

  UPDATE tax_payments SET
    journal_entry_id = v_je_id,
    status = 'posted',
    updated_at = now()
  WHERE id = v_tp_id;

  UPDATE tax_periods SET
    status = CASE WHEN status = 'open' THEN 'payment_pending' ELSE status END,
    updated_at = now()
  WHERE id = p_tax_period_id;

  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, new_values)
  VALUES (auth.uid(), 'tax_payments', 'insert', v_tp_id,
          jsonb_build_object(
            'tax_period_id',     p_tax_period_id,
            'tax_type',          p_tax_type,
            'amount',            p_amount,
            'journal_entry_id',  v_je_id,
            'payment_reference', p_payment_reference,
            'billing_code',      p_billing_code,
            'ntpn',              p_ntpn
          ));

  RETURN v_tp_id;
END $function$
;


-- update_tax_payment(p_id uuid, p_payment_date date, p_amount numeric, p_bank_account_id uuid, p_billing_code text, p_ntpn text, p_government_reference text, p_notes text, p_payment_reference text)
CREATE OR REPLACE FUNCTION public.update_tax_payment(p_id uuid, p_payment_date date, p_amount numeric, p_bank_account_id uuid, p_billing_code text DEFAULT NULL::text, p_ntpn text DEFAULT NULL::text, p_government_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_payment_reference text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_old              tax_payments%ROWTYPE;
  v_period           tax_periods%ROWTYPE;
  v_je_number        text;
  v_je_id            uuid;
  v_old_je_ids       uuid[];
  v_payable_code     text;
  v_payable_acct_id  uuid;
  v_bank_acct_coa_id uuid;
  v_ref_number       text;
  v_is_admin         boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Tax payment amount must be > 0';
  END IF;
  IF p_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account is required';
  END IF;

  SELECT * INTO v_old FROM tax_payments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax payment % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_period FROM tax_periods WHERE id = v_old.tax_period_id;
  IF v_period.status = 'closed' AND current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'Tax period is closed; cannot edit tax payment. Reopen the period first.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reconciled payments can only be edited by admin (edit implies breaking
  -- the current bank reconciliation match). Non-admins must first unmatch
  -- via the Bank Reconciliation screen.
  IF v_old.status = 'reconciled' THEN
    SELECT (up.role = 'admin' AND up.is_active) INTO v_is_admin
      FROM user_profiles up WHERE up.id = auth.uid();
    IF NOT COALESCE(v_is_admin, false) THEN
      RAISE EXCEPTION 'Tax payment is reconciled; only an admin may edit it. Unmatch it in Bank Reconciliation first.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Resolve accounts (same logic as record_tax_payment)
  v_payable_code := CASE v_old.tax_type
    WHEN 'PPN'      THEN '2130'
    WHEN 'PPh21'    THEN '2131'
    WHEN 'PPh22'    THEN '2137'
    WHEN 'PPh23'    THEN '2132'
    WHEN 'PPh4(2)'  THEN '2138'
    WHEN 'PPh_Unifikasi' THEN '2131'
    ELSE NULL
  END;
  IF v_payable_code IS NULL THEN
    RAISE EXCEPTION 'Unknown tax_type: %', v_old.tax_type;
  END IF;

  SELECT id INTO v_payable_acct_id FROM chart_of_accounts WHERE code = v_payable_code;
  IF v_payable_acct_id IS NULL THEN
    RAISE EXCEPTION 'Payable account % missing from Chart of Accounts', v_payable_code;
  END IF;

  SELECT coa_id INTO v_bank_acct_coa_id FROM bank_accounts WHERE id = p_bank_account_id;
  IF v_bank_acct_coa_id IS NULL THEN
    SELECT id INTO v_bank_acct_coa_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_acct_coa_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve bank CoA account';
  END IF;

  -- Reverse old JE(s)
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_old_je_ids
    FROM journal_entries
   WHERE source_module = 'tax_payment' AND reference_id = p_id;
  IF v_old.journal_entry_id IS NOT NULL AND NOT v_old.journal_entry_id = ANY (v_old_je_ids) THEN
    v_old_je_ids := array_append(v_old_je_ids, v_old.journal_entry_id);
  END IF;

  -- Release bank recon matches before deleting the JEs.
  -- NOTE: bank_statement_lines has no updated_at column — do not write it.
  UPDATE bank_statement_lines
     SET matched_entry_id       = NULL,
         matched_tax_payment_id = NULL,
         reconciliation_status  = 'unmatched'
   WHERE matched_tax_payment_id = p_id
      OR (array_length(v_old_je_ids, 1) IS NOT NULL AND matched_entry_id = ANY (v_old_je_ids));

  IF array_length(v_old_je_ids, 1) IS NOT NULL THEN
    UPDATE bank_reconciliation_items
       SET is_matched = false, matched_at = NULL
     WHERE journal_entry_id = ANY (v_old_je_ids);
    DELETE FROM journal_entry_lines WHERE journal_entry_id = ANY (v_old_je_ids);
    DELETE FROM journal_entries     WHERE id = ANY (v_old_je_ids);
  END IF;

  -- Update the payment row (period + type unchanged; use delete+create for that)
  UPDATE tax_payments SET
    payment_date         = p_payment_date,
    amount               = p_amount,
    bank_account_id      = p_bank_account_id,
    billing_code         = p_billing_code,
    ntpn                 = p_ntpn,
    government_reference = p_government_reference,
    notes                = p_notes,
    payment_reference    = p_payment_reference,
    journal_entry_id     = NULL,
    status               = 'draft',
    updated_at           = now()
  WHERE id = p_id;

  -- Post fresh JE
  v_ref_number := COALESCE(
    NULLIF(p_ntpn, ''), NULLIF(p_billing_code, ''), NULLIF(p_payment_reference, ''),
    'TAX-' || to_char(p_payment_date, 'YYMM') || '-' || substr(p_id::text, 1, 8)
  );
  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by)
  VALUES
    (v_je_number, p_payment_date, 'tax_payment', p_id, v_ref_number,
     'Tax Payment ' || v_old.tax_type || ' — ' || v_ref_number,
     p_amount, p_amount, true, auth.uid())
  RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES
    (v_je_id, 1, v_payable_acct_id,
     v_old.tax_type || ' payment — ' || v_ref_number, p_amount, 0),
    (v_je_id, 2, v_bank_acct_coa_id,
     'Bank ' || v_old.tax_type || ' payment — ' || v_ref_number, 0, p_amount);

  UPDATE tax_payments SET journal_entry_id = v_je_id, status = 'posted', updated_at = now()
   WHERE id = p_id;

  -- Refresh period snapshot (belt-and-braces; the AFTER trigger also fires)
  PERFORM compute_period_ppn(v_old.tax_period_id);

  -- Audit log — captures full before/after
  INSERT INTO audit_logs (user_id, table_name, action_type, record_id, old_values, new_values)
  VALUES (
    auth.uid(), 'tax_payments', 'update', p_id,
    jsonb_build_object(
      'payment_date',      v_old.payment_date,
      'amount',            v_old.amount,
      'bank_account_id',   v_old.bank_account_id,
      'ntpn',              v_old.ntpn,
      'billing_code',      v_old.billing_code,
      'payment_reference', v_old.payment_reference,
      'notes',             v_old.notes,
      'status',            v_old.status,
      'old_je_ids',        to_jsonb(v_old_je_ids)
    ),
    jsonb_build_object(
      'payment_date',      p_payment_date,
      'amount',            p_amount,
      'bank_account_id',   p_bank_account_id,
      'ntpn',              p_ntpn,
      'billing_code',      p_billing_code,
      'payment_reference', p_payment_reference,
      'notes',             p_notes,
      'new_je_id',         v_je_id,
      'edited_at',         now()
    )
  );

  RETURN p_id;
END $function$
;


-- reassign_tax_document_period(p_source text, p_document_id uuid, p_tax_period_id uuid)
CREATE OR REPLACE FUNCTION public.reassign_tax_document_period(p_source text, p_document_id uuid, p_tax_period_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_target public.tax_periods%ROWTYPE;
  v_old_period_id uuid;
  v_tax_type text;
  v_tax_code_id uuid;
  v_doc_date date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_target
    FROM public.tax_periods
   WHERE id = p_tax_period_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found', p_tax_period_id; END IF;
  IF v_target.status IN ('closed', 'filed') OR v_target.filing_status = 'filed' THEN
    RAISE EXCEPTION 'Tax period % is filed or closed and cannot be selected', p_tax_period_id;
  END IF;

  CASE p_source
    WHEN 'purchase_invoice' THEN
      SELECT tax_period_id, invoice_date INTO v_old_period_id, v_doc_date FROM public.purchase_invoices WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Purchase invoices require a PPN tax period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = 'PPN' AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'sales_invoice' THEN
      SELECT tax_period_id, invoice_date INTO v_old_period_id, v_doc_date FROM public.sales_invoices WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Sales invoice % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Sales invoices require a PPN tax period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = 'PPN' AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'credit_note' THEN
      SELECT tax_period_id, issue_date INTO v_old_period_id, v_doc_date FROM public.credit_notes WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Credit note % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Credit notes require a PPN tax period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = 'PPN' AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'finance_expense_ppn' THEN
      SELECT tax_period_id, expense_date INTO v_old_period_id, v_doc_date FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_document_id; END IF;
      IF v_target.tax_type <> 'PPN' THEN RAISE EXCEPTION 'Expenses require a PPN tax period for PPN reporting'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = 'PPN' AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'finance_expense_pph' THEN
      SELECT pph_tax_period_id, pph_code_id, expense_date INTO v_old_period_id, v_tax_code_id, v_doc_date
        FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_document_id; END IF;
      SELECT tax_type INTO v_tax_type FROM public.tax_codes WHERE id=v_tax_code_id;
      IF v_tax_type IS NULL OR v_target.tax_type <> v_tax_type THEN RAISE EXCEPTION 'Expense PPh tax type must match the selected period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = v_tax_type AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    WHEN 'payment_voucher' THEN
      SELECT tax_period_id, pph_code_id, voucher_date INTO v_old_period_id, v_tax_code_id, v_doc_date
        FROM public.payment_vouchers WHERE id=p_document_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_document_id; END IF;
      SELECT tax_type INTO v_tax_type FROM public.tax_codes WHERE id=v_tax_code_id;
      IF v_tax_type IS NULL OR v_target.tax_type <> v_tax_type THEN RAISE EXCEPTION 'Payment voucher PPh tax type must match the selected period'; END IF;
      IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL THEN
        SELECT id INTO v_old_period_id FROM public.tax_periods WHERE tax_type = v_tax_type AND v_doc_date BETWEEN period_start AND period_end;
      END IF;

    ELSE
      RAISE EXCEPTION 'Unsupported tax document source %', p_source;
  END CASE;

  IF v_old_period_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tax_periods
     WHERE id=v_old_period_id AND (status IN ('closed', 'filed') OR filing_status='filed')
  ) THEN
    RAISE EXCEPTION 'The current tax period is filed or closed; reopen it before changing this document';
  END IF;

  CASE p_source
    WHEN 'purchase_invoice' THEN UPDATE public.purchase_invoices SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
    WHEN 'sales_invoice' THEN
      UPDATE public.sales_invoices SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
      UPDATE public.faktur_pajak SET tax_period_id=p_tax_period_id WHERE sales_invoice_id=p_document_id;
    WHEN 'credit_note' THEN UPDATE public.credit_notes SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
    WHEN 'finance_expense_ppn' THEN UPDATE public.finance_expenses SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
    WHEN 'finance_expense_pph' THEN UPDATE public.finance_expenses SET pph_tax_period_id=p_tax_period_id WHERE id=p_document_id;
    WHEN 'payment_voucher' THEN UPDATE public.payment_vouchers SET tax_period_id=p_tax_period_id WHERE id=p_document_id;
  END CASE;

  IF v_old_period_id IS NOT NULL AND v_old_period_id <> p_tax_period_id THEN
    PERFORM public.compute_period_ppn(v_old_period_id);
  END IF;
  PERFORM public.compute_period_ppn(p_tax_period_id);
END;
$function$
;


-- save_finance_exception_corrections_v2(p_corrections jsonb)
CREATE OR REPLACE FUNCTION public.save_finance_exception_corrections_v2(p_corrections jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  c jsonb;
  v_type text;
  v_id uuid;
  v_exception bigint;
  v_journal uuid;
  v_line uuid;
  v_supplier uuid;
  v_customer uuid;
  v_from_bank uuid;
  v_to_bank uuid;
  v_from_old uuid;
  v_to_old uuid;
  v_from_old_coa uuid;
  v_to_old_coa uuid;
  v_from_new_coa uuid;
  v_to_new_coa uuid;
  v_from_alias text;
  v_to_alias text;
  v_from_currency text;
  v_to_currency text;
  v_link_type text;
  v_link_id uuid;
  v_result jsonb;
  v_resolved_ids jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();
  IF jsonb_typeof(p_corrections)<>'array' OR jsonb_array_length(p_corrections)=0 THEN
    RAISE EXCEPTION 'Select at least one correction before saving';
  END IF;
  PERFORM set_config('app.finance_historical_repair','on',true);
  PERFORM set_config('app.finance_metadata_repair','on',true);

  FOR c IN SELECT value FROM jsonb_array_elements(p_corrections) LOOP
    v_type:=c->>'document_type';
    v_id:=(c->>'document_id')::uuid;
    v_exception:=NULLIF(c->>'exception_id','')::bigint;
    v_journal:=NULLIF(c->>'journal_entry_id','')::uuid;
    v_line:=NULLIF(c->>'journal_line_id','')::uuid;
    v_supplier:=NULLIF(c->>'supplier_id','')::uuid;
    v_customer:=NULLIF(c->>'customer_id','')::uuid;
    v_from_bank:=NULLIF(c->>'from_bank_account_id','')::uuid;
    v_to_bank:=NULLIF(c->>'to_bank_account_id','')::uuid;
    v_link_type:=NULLIF(c->>'linked_document_type','');
    v_link_id:=NULLIF(c->>'linked_document_id','')::uuid;

    IF NOT EXISTS (SELECT 1 FROM public.finance_exception_correction_dashboard x WHERE x.document_type=v_type AND x.document_id=v_id) THEN
      RAISE EXCEPTION 'This exception is no longer open';
    END IF;
    IF v_supplier IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id=v_supplier AND COALESCE(is_active,true)) THEN
      RAISE EXCEPTION 'Selected supplier is not active';
    END IF;
    IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id=v_customer) THEN
      RAISE EXCEPTION 'Selected customer does not exist';
    END IF;

    IF v_type='expense' THEN
      UPDATE public.finance_expenses SET
        expense_type=COALESCE(NULLIF(c->>'expense_subcategory',''),expense_type),
        supplier_id=COALESCE(v_supplier,supplier_id),
        payment_reference=COALESCE(NULLIF(c->>'reference',''),payment_reference)
      WHERE id=v_id;
    ELSIF v_type='receipt' THEN
      UPDATE public.receipt_vouchers SET customer_id=COALESCE(v_customer,customer_id),
        reference_number=COALESCE(NULLIF(c->>'reference',''),reference_number) WHERE id=v_id;
    ELSIF v_type='payment' THEN
      UPDATE public.payment_vouchers SET supplier_id=COALESCE(v_supplier,supplier_id),
        reference_number=COALESCE(NULLIF(c->>'reference',''),reference_number) WHERE id=v_id;
    ELSIF v_type='loan' THEN
      UPDATE public.loans SET loan_type=COALESCE(NULLIF(c->>'finance_classification',''),loan_type) WHERE id=v_id;
    ELSIF v_type='capital_contribution' THEN
      UPDATE public.capital_contributions SET contribution_type=COALESCE(NULLIF(c->>'finance_classification',''),contribution_type) WHERE id=v_id;
    END IF;

    IF v_line IS NOT NULL THEN
      UPDATE public.journal_entry_lines SET
        supplier_id=COALESCE(v_supplier,supplier_id),customer_id=COALESCE(v_customer,customer_id)
      WHERE id=v_line AND journal_entry_id=v_journal;
    END IF;

    IF v_type='fund_transfer' AND (v_from_bank IS NOT NULL OR v_to_bank IS NOT NULL) THEN
      SELECT from_bank_account_id,to_bank_account_id,journal_entry_id INTO v_from_old,v_to_old,v_journal
      FROM public.fund_transfers WHERE id=v_id FOR UPDATE;
      v_from_bank:=COALESCE(v_from_bank,v_from_old);
      v_to_bank:=COALESCE(v_to_bank,v_to_old);
      IF v_from_bank=v_to_bank THEN RAISE EXCEPTION 'From Bank and To Bank must be different'; END IF;
      SELECT coa_id,COALESCE(alias,account_name,bank_name),upper(currency) INTO v_from_new_coa,v_from_alias,v_from_currency
        FROM public.bank_accounts WHERE id=v_from_bank AND is_active;
      SELECT coa_id,COALESCE(alias,account_name,bank_name),upper(currency) INTO v_to_new_coa,v_to_alias,v_to_currency
        FROM public.bank_accounts WHERE id=v_to_bank AND is_active;
      SELECT coa_id INTO v_from_old_coa FROM public.bank_accounts WHERE id=v_from_old;
      SELECT coa_id INTO v_to_old_coa FROM public.bank_accounts WHERE id=v_to_old;
      IF v_from_new_coa IS NULL OR v_to_new_coa IS NULL THEN RAISE EXCEPTION 'Both transfer banks need active Bank Master posting accounts'; END IF;
      UPDATE public.journal_entry_lines SET account_id=v_from_new_coa
        WHERE journal_entry_id=v_journal AND account_id=v_from_old_coa AND COALESCE(credit,0)>0;
      UPDATE public.journal_entry_lines SET account_id=v_to_new_coa
        WHERE journal_entry_id=v_journal AND account_id=v_to_old_coa AND COALESCE(debit,0)>0;
      UPDATE public.fund_transfers SET from_bank_account_id=v_from_bank,to_bank_account_id=v_to_bank WHERE id=v_id;
    END IF;

    IF v_type='bank_reconciliation' AND v_link_id IS NOT NULL THEN
      IF v_link_type IS NULL THEN RAISE EXCEPTION 'Select the linked document type'; END IF;
      PERFORM public.link_bank_statement_line(v_id,v_link_type,v_link_id,COALESCE(NULLIF(c->>'payment_type',''),'supplier'));
    END IF;
  END LOOP;

  -- Existing RPC owns GL classification, bank master mapping, tax/currency
  -- metadata, balance protection, audit logging and reason-specific verification.
  v_result:=public.save_finance_exception_corrections(p_corrections);

  FOR c IN SELECT value FROM jsonb_array_elements(p_corrections) LOOP
    v_exception:=NULLIF(c->>'exception_id','')::bigint;
    IF v_exception IS NOT NULL AND COALESCE((c->>'confirm_resolved')::boolean,false)
       AND EXISTS (
         SELECT 1 FROM jsonb_each_text(c) x
         WHERE x.key IN ('expense_category','expense_subcategory','account_id','bank_account_id','from_bank_account_id',
           'to_bank_account_id','loan_account_id','capital_account_id','tax_code_id','payment_type','document_classification',
           'exchange_rate','faktur_pajak_number','supplier_id','customer_id','reference','finance_classification','linked_document_id')
           AND NULLIF(x.value,'') IS NOT NULL
       ) THEN
      UPDATE public.finance_historical_repair_exceptions SET status='resolved'
      WHERE id=v_exception AND status='manual_review';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.finance_exception_correction_dashboard x
      WHERE x.document_type=c->>'document_type' AND x.document_id=(c->>'document_id')::uuid
    ) THEN v_resolved_ids:=v_resolved_ids || jsonb_build_array(c->>'row_id'); END IF;
  END LOOP;

  RETURN v_result || jsonb_build_object('resolved_row_ids',v_resolved_ids,'verification_refreshed',true);
END;
$function$
;


-- save_finance_exception_corrections(p_corrections jsonb)
CREATE OR REPLACE FUNCTION public.save_finance_exception_corrections(p_corrections jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  c jsonb;
  v_document_type text;
  v_document_id uuid;
  v_exception_id bigint;
  v_reason text;
  v_journal_id uuid;
  v_line_id uuid;
  v_account_id uuid;
  v_bank_id uuid;
  v_bank_coa_id uuid;
  v_bank_currency text;
  v_tax_code_id uuid;
  v_tax_type text;
  v_exchange_rate numeric;
  v_before_lines jsonb;
  v_after_lines jsonb;
  v_resolved boolean := false;
  v_saved integer := 0;
  v_resolved_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();
  IF jsonb_typeof(p_corrections) <> 'array' OR jsonb_array_length(p_corrections)=0 THEN
    RAISE EXCEPTION 'Select at least one correction before saving';
  END IF;

  -- Existing source triggers read these flags. Metadata corrections must never
  -- regenerate journals or recalculate historical debit/credit values.
  PERFORM set_config('app.finance_historical_repair','on',true);
  PERFORM set_config('app.finance_metadata_repair','on',true);

  FOR c IN SELECT value FROM jsonb_array_elements(p_corrections)
  LOOP
    v_document_type := c->>'document_type';
    v_document_id := (c->>'document_id')::uuid;
    v_exception_id := NULLIF(c->>'exception_id','')::bigint;
    v_line_id := NULLIF(c->>'journal_line_id','')::uuid;
    v_bank_id := NULLIF(c->>'bank_account_id','')::uuid;
    v_tax_code_id := NULLIF(c->>'tax_code_id','')::uuid;
    v_exchange_rate := NULLIF(c->>'exchange_rate','')::numeric;
    v_resolved := false;

    IF v_exception_id IS NOT NULL THEN
      SELECT reason INTO v_reason
      FROM public.finance_historical_repair_exceptions
      WHERE id=v_exception_id AND document_type=v_document_type
        AND document_id=v_document_id AND status='manual_review'
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'This exception is no longer open'; END IF;
    ELSE
      v_reason := 'Live Finance verification failure';
      IF NOT EXISTS (
        SELECT 1 FROM public.finance_exception_correction_dashboard d
        WHERE d.document_type=v_document_type AND d.document_id=v_document_id
          AND d.status='Verification failed'
      ) THEN RAISE EXCEPTION 'This verification failure is no longer open'; END IF;
    END IF;

    SELECT CASE v_document_type
      WHEN 'journal' THEN v_document_id
      WHEN 'receipt' THEN (SELECT journal_entry_id FROM public.receipt_vouchers WHERE id=v_document_id)
      WHEN 'payment' THEN (SELECT journal_entry_id FROM public.payment_vouchers WHERE id=v_document_id)
      WHEN 'fund_transfer' THEN (SELECT journal_entry_id FROM public.fund_transfers WHERE id=v_document_id)
      WHEN 'loan' THEN (SELECT journal_entry_id FROM public.loans WHERE id=v_document_id)
      WHEN 'loan_transaction' THEN (SELECT journal_entry_id FROM public.loan_transactions WHERE id=v_document_id)
      WHEN 'loan_repayment' THEN (SELECT journal_entry_id FROM public.loan_transactions WHERE id=v_document_id)
      WHEN 'capital_contribution' THEN (SELECT journal_entry_id FROM public.capital_contributions WHERE id=v_document_id)
      WHEN 'tax_payment' THEN (SELECT journal_entry_id FROM public.tax_payments WHERE id=v_document_id)
      WHEN 'sales_invoice' THEN (SELECT journal_entry_id FROM public.sales_invoices WHERE id=v_document_id)
      WHEN 'purchase_invoice' THEN (SELECT journal_entry_id FROM public.purchase_invoices WHERE id=v_document_id)
      WHEN 'bank_reconciliation' THEN (SELECT matched_entry_id FROM public.bank_statement_lines WHERE id=v_document_id)
      WHEN 'expense' THEN (SELECT id FROM public.journal_entries j WHERE j.source_module IN('expense','expenses')
        AND (j.reference_id=v_document_id OR j.reference_number='EXP-'||v_document_id::text)
        AND COALESCE(j.is_reversed,false)=false ORDER BY j.is_posted DESC,j.created_at DESC LIMIT 1)
      WHEN 'petty_cash' THEN (SELECT id FROM public.journal_entries j WHERE j.source_module='petty_cash'
        AND j.reference_id=v_document_id AND COALESCE(j.is_reversed,false)=false ORDER BY j.is_posted DESC,j.created_at DESC LIMIT 1)
    END INTO v_journal_id;

    IF v_journal_id IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('id',id,'debit',debit,'credit',credit) ORDER BY id)
      INTO v_before_lines FROM public.journal_entry_lines WHERE journal_entry_id=v_journal_id;
    END IF;

    IF v_bank_id IS NOT NULL THEN
      SELECT ba.coa_id,upper(ba.currency) INTO v_bank_coa_id,v_bank_currency
      FROM public.bank_accounts ba JOIN public.chart_of_accounts coa ON coa.id=ba.coa_id
      WHERE ba.id=v_bank_id AND ba.is_active=true AND coa.is_active=true AND COALESCE(coa.is_header,false)=false;
      IF v_bank_coa_id IS NULL THEN RAISE EXCEPTION 'Selected bank has no active posting account'; END IF;
    END IF;

    v_account_id := COALESCE(NULLIF(c->>'account_id','')::uuid,
      NULLIF(c->>'loan_account_id','')::uuid,
      NULLIF(c->>'capital_account_id','')::uuid,
      CASE WHEN v_bank_id IS NOT NULL THEN v_bank_coa_id END);
    IF v_account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts WHERE id=v_account_id AND is_active=true AND COALESCE(is_header,false)=false
    ) THEN RAISE EXCEPTION 'Selected account is not an active posting account'; END IF;

    IF v_tax_code_id IS NOT NULL THEN
      SELECT tax_type INTO v_tax_type FROM public.tax_codes WHERE id=v_tax_code_id AND is_active=true;
      IF v_tax_type IS NULL THEN RAISE EXCEPTION 'Selected tax category is not active'; END IF;
    END IF;

    -- Source metadata. Every assignment is to an existing row; no insert,
    -- delete, posting, numbering, date, narration, or amount field is allowed.
    IF v_document_type='expense' THEN
      UPDATE public.finance_expenses SET
        expense_category=COALESCE(NULLIF(c->>'expense_category',''),expense_category),
        payment_method=COALESCE(NULLIF(c->>'payment_type',''),payment_method),
        bank_account_id=COALESCE(v_bank_id,bank_account_id),
        pph_code_id=COALESCE(v_tax_code_id,pph_code_id),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),
        currency_code=COALESCE(v_bank_currency,currency_code),
        payment_currency=COALESCE(v_bank_currency,payment_currency),
        bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR')
      WHERE id=v_document_id;
    ELSIF v_document_type='receipt' THEN
      UPDATE public.receipt_vouchers SET payment_method=COALESCE(NULLIF(c->>'payment_type',''),payment_method),
        bank_account_id=COALESCE(v_bank_id,bank_account_id),exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),currency_code=COALESCE(v_bank_currency,currency_code),
        payment_currency=COALESCE(v_bank_currency,payment_currency),bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR') WHERE id=v_document_id;
    ELSIF v_document_type='payment' THEN
      UPDATE public.payment_vouchers SET payment_method=COALESCE(NULLIF(c->>'payment_type',''),payment_method),
        bank_account_id=COALESCE(v_bank_id,bank_account_id),pph_code_id=COALESCE(v_tax_code_id,pph_code_id),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),currency_code=COALESCE(v_bank_currency,currency_code),
        payment_currency=COALESCE(v_bank_currency,payment_currency),bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR') WHERE id=v_document_id;
    ELSIF v_document_type='loan' THEN
      UPDATE public.loans SET bank_account_id=COALESCE(v_bank_id,bank_account_id),
        coa_id=COALESCE(NULLIF(c->>'loan_account_id','')::uuid,coa_id),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),currency=COALESCE(v_bank_currency,currency),
        bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),functional_currency=COALESCE(functional_currency,'IDR')
      WHERE id=v_document_id;
    ELSIF v_document_type IN ('loan_transaction','loan_repayment') THEN
      UPDATE public.loan_transactions SET bank_account_id=COALESCE(v_bank_id,bank_account_id),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR') WHERE id=v_document_id;
    ELSIF v_document_type='capital_contribution' THEN
      UPDATE public.capital_contributions SET bank_account_id=COALESCE(v_bank_id,bank_account_id),
        contribution_type=COALESCE(NULLIF(c->>'expense_category',''),contribution_type),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR') WHERE id=v_document_id;
    ELSIF v_document_type='petty_cash' THEN
      UPDATE public.petty_cash_transactions SET expense_category=COALESCE(NULLIF(c->>'expense_category',''),expense_category),
        bank_account_id=COALESCE(v_bank_id,bank_account_id) WHERE id=v_document_id;
    ELSIF v_document_type='tax_payment' THEN
      UPDATE public.tax_payments SET bank_account_id=COALESCE(v_bank_id,bank_account_id),
        tax_type=COALESCE(v_tax_type,tax_type) WHERE id=v_document_id;
    ELSIF v_document_type='sales_invoice' AND NULLIF(c->>'faktur_pajak_number','') IS NOT NULL THEN
      UPDATE public.sales_invoices SET faktur_pajak_number=c->>'faktur_pajak_number' WHERE id=v_document_id;
    ELSIF v_document_type='purchase_invoice' AND NULLIF(c->>'faktur_pajak_number','') IS NOT NULL THEN
      UPDATE public.purchase_invoices SET faktur_pajak_number=c->>'faktur_pajak_number' WHERE id=v_document_id;
    ELSIF v_document_type='bank_reconciliation' AND NULLIF(c->>'payment_type','') IS NOT NULL THEN
      UPDATE public.bank_statement_lines SET payment_kind=c->>'payment_type' WHERE id=v_document_id;
    END IF;

    IF v_journal_id IS NOT NULL THEN
      UPDATE public.journal_entries SET
        source_module=COALESCE(NULLIF(c->>'document_classification',''),source_module),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),
        functional_currency=COALESCE(functional_currency,'IDR'),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        amounts_are_functional=COALESCE(amounts_are_functional,true)
      WHERE id=v_journal_id;
    END IF;

    IF v_account_id IS NOT NULL THEN
      IF v_line_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines WHERE id=v_line_id AND journal_entry_id=v_journal_id
      ) THEN RAISE EXCEPTION 'The account line can no longer be identified safely'; END IF;
      UPDATE public.journal_entry_lines SET account_id=v_account_id WHERE id=v_line_id;
    END IF;

    IF v_journal_id IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('id',id,'debit',debit,'credit',credit) ORDER BY id)
      INTO v_after_lines FROM public.journal_entry_lines WHERE journal_entry_id=v_journal_id;
      IF v_before_lines IS DISTINCT FROM v_after_lines THEN
        RAISE EXCEPTION 'Correction cancelled because a debit or credit value changed';
      END IF;
    END IF;

    -- Resolve only when the specific historical problem is now disproved.
    IF v_reason ILIKE '%missing Faktur Pajak%' THEN
      v_resolved := EXISTS(SELECT 1 FROM public.sales_invoices WHERE id=v_document_id AND NULLIF(btrim(faktur_pajak_number),'') IS NOT NULL)
        OR EXISTS(SELECT 1 FROM public.purchase_invoices WHERE id=v_document_id AND NULLIF(btrim(faktur_pajak_number),'') IS NOT NULL);
    ELSIF v_reason ILIKE '%no historical transaction-date rate%' OR v_reason ILIKE '%no authoritative historical rate%' THEN
      v_resolved := v_exchange_rate IS NOT NULL AND v_exchange_rate>0;
    ELSIF v_reason ILIKE '%does not use the Expense bank account%' OR v_reason ILIKE '%does not post to this bank account%' THEN
      v_resolved := EXISTS(SELECT 1 FROM public.journal_entry_lines jl JOIN public.bank_accounts ba ON ba.coa_id=jl.account_id
        WHERE jl.journal_entry_id=v_journal_id AND ba.id=COALESCE(v_bank_id,(SELECT bank_account_id FROM public.bank_statement_lines WHERE id=v_document_id)));
    ELSIF v_reason ILIKE 'No unique authoritative relationship%' THEN
      IF v_document_type='expense' THEN v_resolved := EXISTS(SELECT 1 FROM public.finance_expenses x WHERE x.id=v_document_id
        AND x.transaction_currency IS NOT NULL AND x.functional_currency IS NOT NULL AND x.currency_code IS NOT NULL
        AND x.exchange_rate IS NOT NULL AND x.payment_method IS NOT NULL AND (x.payment_method<>'bank_transfer' OR x.bank_account_id IS NOT NULL));
      ELSIF v_document_type='receipt' THEN v_resolved := EXISTS(SELECT 1 FROM public.receipt_vouchers x WHERE x.id=v_document_id
        AND x.transaction_currency IS NOT NULL AND x.functional_currency IS NOT NULL AND x.currency_code IS NOT NULL
        AND x.exchange_rate IS NOT NULL AND x.payment_method IS NOT NULL AND (x.payment_method<>'bank_transfer' OR x.bank_account_id IS NOT NULL));
      ELSIF v_document_type='payment' THEN v_resolved := EXISTS(SELECT 1 FROM public.payment_vouchers x WHERE x.id=v_document_id
        AND x.transaction_currency IS NOT NULL AND x.functional_currency IS NOT NULL AND x.currency_code IS NOT NULL
        AND x.exchange_rate IS NOT NULL AND x.payment_method IS NOT NULL AND (x.payment_method<>'bank_transfer' OR x.bank_account_id IS NOT NULL)); END IF;
    ELSIF v_reason ILIKE '%metadata conflicts%' THEN
      v_resolved := v_bank_id IS NOT NULL;
    ELSIF v_reason ILIKE '%Journal metadata cannot be derived%' THEN
      v_resolved := EXISTS(SELECT 1 FROM public.journal_entries WHERE id=v_journal_id AND source_module IS NOT NULL
        AND transaction_currency IS NOT NULL AND functional_currency IS NOT NULL
        AND (transaction_currency='IDR' OR exchange_rate IS NOT NULL));
    END IF;

    IF v_exception_id IS NOT NULL AND v_resolved THEN
      UPDATE public.finance_historical_repair_exceptions SET status='resolved' WHERE id=v_exception_id;
      v_resolved_count := v_resolved_count + 1;
    END IF;

    INSERT INTO public.audit_logs(table_name,action_type,record_id,old_values,new_values,changed_fields)
    VALUES('finance_exception_correction_dashboard','update',v_document_id,
      jsonb_build_object('exception_id',v_exception_id,'journal_lines',v_before_lines),
      jsonb_build_object('correction',c,'journal_lines',v_after_lines,'resolved',v_resolved),
      ARRAY['finance_metadata','account_classification','exception_status']);
    v_saved := v_saved + 1;
  END LOOP;

  RETURN jsonb_build_object('saved',v_saved,'resolved',v_resolved_count,'refresh_required',true);
END;
$function$
;


-- save_bank_linked_finance_journal(p_bank_line_id uuid, p_description text, p_counter_account_code text, p_bank_side text, p_transaction_currency text, p_exchange_rate numeric)
CREATE OR REPLACE FUNCTION public.save_bank_linked_finance_journal(p_bank_line_id uuid, p_description text, p_counter_account_code text, p_bank_side text, p_transaction_currency text, p_exchange_rate numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_line public.bank_statement_lines%ROWTYPE; v_bank_coa uuid; v_counter_coa uuid;
  v_amount numeric; v_journal uuid; v_lines jsonb; v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND OR v_line.matched_entry_id IS NOT NULL THEN RAISE EXCEPTION 'Bank statement line is missing or already linked'; END IF;
  SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id=v_line.bank_account_id AND is_active=true AND upper(currency)=upper(p_transaction_currency);
  SELECT id INTO v_counter_coa FROM public.chart_of_accounts WHERE code=p_counter_account_code AND is_active=true AND COALESCE(is_header,false)=false;
  IF v_bank_coa IS NULL OR v_counter_coa IS NULL THEN RAISE EXCEPTION 'Bank or counter account is not configured'; END IF;
  IF p_bank_side='debit' THEN v_amount:=COALESCE(v_line.credit_amount,0);
  ELSIF p_bank_side='credit' THEN v_amount:=COALESCE(v_line.debit_amount,0);
  ELSE RAISE EXCEPTION 'Bank side must be debit or credit'; END IF;
  IF v_amount<=0 THEN RAISE EXCEPTION 'Bank statement direction does not match this journal action'; END IF;
  v_lines:=CASE WHEN p_bank_side='debit' THEN jsonb_build_array(
      jsonb_build_object('account_id',v_bank_coa,'description',p_description,'debit',v_amount,'credit',0),
      jsonb_build_object('account_id',v_counter_coa,'description',p_description,'debit',0,'credit',v_amount))
    ELSE jsonb_build_array(
      jsonb_build_object('account_id',v_counter_coa,'description',p_description,'debit',v_amount,'credit',0),
      jsonb_build_object('account_id',v_bank_coa,'description',p_description,'debit',0,'credit',v_amount)) END;
  v_journal:=public.save_finance_journal(NULL,v_line.transaction_date,p_description,v_lines,upper(p_transaction_currency),p_exchange_rate);
  v_result:=public.link_bank_statement_line(p_bank_line_id,'journal',v_journal,'supplier');
  RETURN jsonb_build_object('document_id',v_journal,'journal_entry_id',v_journal,'link',v_result);
END $function$
;


-- undo_reverse_fund_transfer(p_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.undo_reverse_fund_transfer(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_message  text;
  v_conflict jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  BEGIN
    RETURN public.undo_reverse_fund_transfer_core(p_id, p_reason);
  EXCEPTION WHEN integrity_constraint_violation THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;

    IF v_message LIKE
       'Cannot undo reversal: the % bank statement line is now linked to another transaction' THEN
      v_conflict := public.describe_undo_reverse_bank_conflict(p_id);
      IF v_conflict IS NOT NULL THEN
        RAISE EXCEPTION '%', v_message
          USING
            ERRCODE = 'integrity_constraint_violation',
            DETAIL = v_conflict::text;
      END IF;
    END IF;

    RAISE;
  END;
END;
$function$
;


-- post_fund_transfer_journal(p_transfer_id uuid, p_user_id uuid)
CREATE OR REPLACE FUNCTION public.post_fund_transfer_journal(p_transfer_id uuid, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public, pg_temp'
AS $function$
DECLARE
v_transfer        RECORD;
v_journal_id      UUID;
v_from_account_id UUID;
v_to_account_id   UUID;
v_description     TEXT;
v_role            text;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin','accounts') THEN
RAISE EXCEPTION 'Permission denied: role % cannot post fund transfer journals', v_role;
END IF;

SELECT * INTO v_transfer FROM fund_transfers WHERE id = p_transfer_id;
IF NOT FOUND THEN RAISE EXCEPTION 'Fund transfer not found'; END IF;
IF v_transfer.journal_entry_id IS NOT NULL THEN RETURN v_transfer.journal_entry_id; END IF;

SELECT id INTO v_journal_id FROM journal_entries
WHERE reference_number = v_transfer.transfer_number AND source_module = 'fund_transfers'
ORDER BY created_at DESC LIMIT 1;
IF v_journal_id IS NOT NULL THEN
UPDATE fund_transfers SET journal_entry_id = v_journal_id WHERE id = p_transfer_id;
RETURN v_journal_id;
END IF;

IF    v_transfer.from_account_type = 'petty_cash'   THEN SELECT id INTO v_from_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN SELECT id INTO v_from_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
ELSIF v_transfer.from_account_type = 'bank'         THEN SELECT coa_id INTO v_from_account_id FROM bank_accounts WHERE id = v_transfer.from_bank_account_id;
END IF;

IF    v_transfer.to_account_type = 'petty_cash'   THEN SELECT id INTO v_to_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN SELECT id INTO v_to_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
ELSIF v_transfer.to_account_type = 'bank'         THEN SELECT coa_id INTO v_to_account_id FROM bank_accounts WHERE id = v_transfer.to_bank_account_id;
END IF;

IF v_from_account_id IS NULL OR v_to_account_id IS NULL THEN
RAISE EXCEPTION 'Cannot determine chart of accounts for transfer';
END IF;

v_description := 'Fund Transfer ' || v_transfer.transfer_number;
IF v_transfer.description IS NOT NULL THEN
v_description := v_description || ' - ' || v_transfer.description;
END IF;

INSERT INTO journal_entries (
entry_date, source_module, reference_id, reference_number,
description, total_debit, total_credit, is_posted, created_by
) VALUES (
v_transfer.transfer_date, 'fund_transfers', v_transfer.id, v_transfer.transfer_number,
v_description, 0, 0, true, p_user_id
) RETURNING id INTO v_journal_id;

INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
VALUES
(v_journal_id, v_to_account_id,   v_transfer.amount, 0,                  'Transfer In'),
(v_journal_id, v_from_account_id, 0,                  v_transfer.amount, 'Transfer Out');

UPDATE fund_transfers SET journal_entry_id = v_journal_id WHERE id = p_transfer_id;
RETURN v_journal_id;
END;
$function$
;


-- post_payment_voucher(p_pv_id uuid, p_posted_by uuid)
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv record; v_je uuid; v_ap uuid; v_bank uuid; v_charge uuid; v_pph uuid; v_fx uuid;
  v_invoice_currency text; v_bank_currency text; v_rate numeric; v_gross numeric;
  v_payment numeric; v_converted numeric; v_pph_bank numeric; v_actual numeric; v_charge_amt numeric;
  v_expected numeric; v_fx_delta numeric; v_ap_debit numeric; v_total numeric; v_line int := 1; v_entry text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id=p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found',p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted',v_pv.voucher_number; END IF;

  v_invoice_currency := upper(COALESCE(v_pv.invoice_currency,v_pv.transaction_currency,v_pv.payment_currency,'IDR'));
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id=v_pv.bank_account_id;
  v_bank_currency := COALESCE(v_bank_currency,v_pv.bank_currency,v_pv.payment_currency,'IDR');
  v_rate := CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE COALESCE(v_pv.exchange_rate,0) END;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'Missing exchange rate for %',v_pv.voucher_number; END IF;

  v_gross := COALESCE(v_pv.invoice_amount,v_pv.amount,0);
  v_payment := COALESCE(v_pv.payment_amount,v_gross-COALESCE(v_pv.pph_amount,0));
  v_converted := COALESCE(v_pv.converted_amount,v_payment*v_rate);
  v_pph_bank := COALESCE(v_pv.pph_amount,0)*v_rate;
  v_charge_amt := COALESCE(v_pv.bank_charge,0);
  v_actual := COALESCE(v_pv.actual_bank_debit,v_pv.bank_amount,v_converted+v_charge_amt);
  v_expected := v_converted+v_charge_amt;
  v_fx_delta := v_actual-v_expected;
  v_ap_debit := v_gross*v_rate;

  IF v_pv.coa_account_id IS NOT NULL THEN
    v_ap := v_pv.coa_account_id;
  ELSE
    SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  END IF;
  IF v_pv.payment_method = 'advance_adjustment' OR v_pv.payment_purpose = 'salary_advance' THEN
    SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code='1160' LIMIT 1;
  ELSE
    SELECT coa_id INTO v_bank FROM public.bank_accounts WHERE id=v_pv.bank_account_id;
    IF v_bank IS NULL THEN SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code='1101' LIMIT 1; END IF;
  END IF;
  SELECT id INTO v_charge FROM public.chart_of_accounts WHERE code='7100' LIMIT 1;
  SELECT id INTO v_pph FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_fx FROM public.chart_of_accounts WHERE code='7300' LIMIT 1;
  IF v_ap IS NULL OR v_bank IS NULL THEN RAISE EXCEPTION 'Required payment accounts are missing'; END IF;
  IF v_pph_bank > 0 AND v_pph IS NULL THEN RAISE EXCEPTION 'PPh payable account is missing'; END IF;

  v_total := v_ap_debit + v_charge_amt + GREATEST(v_fx_delta,0);
  v_entry := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,posted_by)
  VALUES(v_entry,v_pv.voucher_date,'payment',v_pv.id,v_pv.voucher_number,'Payment Voucher: '||v_pv.voucher_number,v_total,v_total,true,p_posted_by)
  RETURNING id INTO v_je;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_ap,'Payment - '||v_pv.voucher_number,v_ap_debit,0,v_invoice_currency,v_gross,0,v_rate,v_pv.supplier_id); v_line:=v_line+1;
  IF v_charge_amt>0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_charge,'Bank Charge - '||v_pv.voucher_number,v_charge_amt,0,v_bank_currency,v_charge_amt,0,1,v_pv.supplier_id); v_line:=v_line+1;
  END IF;
  IF v_pph_bank>0 AND v_pph IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_pph,'PPh Withholding - '||v_pv.voucher_number,0,v_pph_bank,v_bank_currency,0,v_pv.pph_amount,v_rate,v_pv.supplier_id); v_line:=v_line+1;
  END IF;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_bank,CASE WHEN v_pv.payment_method='advance_adjustment' THEN 'Advance Adjustment - ' ELSE 'Bank Payment - ' END||v_pv.voucher_number,0,v_actual,v_bank_currency,0,v_actual,1,v_pv.supplier_id); v_line:=v_line+1;
  IF v_fx_delta>0 AND v_fx IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line,v_fx,'FX loss - '||v_pv.voucher_number,v_fx_delta,0,v_pv.supplier_id);
  ELSIF v_fx_delta<0 AND v_fx IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line,v_fx,'FX gain - '||v_pv.voucher_number,0,abs(v_fx_delta),v_pv.supplier_id);
  END IF;
  UPDATE public.payment_vouchers SET is_posted=true,journal_entry_id=v_je WHERE id=p_pv_id;
  INSERT INTO public.audit_logs(table_name,record_id,action_type,old_values,new_values,user_id)
  VALUES('payment_vouchers',p_pv_id,'update',jsonb_build_object('is_posted',false),jsonb_build_object('is_posted',true,'journal_entry_id',v_je),p_posted_by);
END; $function$
;


-- post_receipt_voucher(p_rv_id uuid, p_posted_by uuid)
CREATE OR REPLACE FUNCTION public.post_receipt_voucher(p_rv_id uuid, p_posted_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_rv                 RECORD;
v_je_id              UUID;
v_je_number          TEXT;
v_debit_account_id   UUID;
v_credit_account_id  UUID;
BEGIN
IF auth.uid() IS NULL THEN
RAISE EXCEPTION 'Not authenticated';
END IF;

SELECT * INTO v_rv FROM receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
IF v_rv.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number; END IF;

IF v_rv.bank_account_id IS NOT NULL THEN
SELECT coa_id INTO v_debit_account_id FROM bank_accounts WHERE id = v_rv.bank_account_id;
ELSIF v_rv.payment_method = 'cash' THEN
SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
END IF;
IF v_debit_account_id IS NULL THEN
SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
END IF;

IF v_rv.coa_account_id IS NOT NULL THEN
v_credit_account_id := v_rv.coa_account_id;
ELSE
SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
END IF;

IF v_debit_account_id IS NULL OR v_credit_account_id IS NULL THEN
RAISE EXCEPTION 'Cannot post: required chart of accounts entries missing';
END IF;

v_je_number := next_journal_entry_number();

INSERT INTO journal_entries (
entry_number, entry_date, source_module, reference_id, reference_number,
description, total_debit, total_credit, is_posted, posted_by
) VALUES (
v_je_number, v_rv.voucher_date, 'receipt', v_rv.id, v_rv.voucher_number,
'Receipt Voucher: ' || v_rv.voucher_number,
v_rv.amount, v_rv.amount, TRUE, p_posted_by
) RETURNING id INTO v_je_id;

INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
VALUES (v_je_id, 1, v_debit_account_id, 'Cash Receipt - ' || v_rv.voucher_number, v_rv.amount, 0, v_rv.customer_id);
INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
VALUES (v_je_id, 2, v_credit_account_id, 'Receipt - ' || v_rv.voucher_number, 0, v_rv.amount, v_rv.customer_id);

UPDATE receipt_vouchers
SET is_posted = TRUE, journal_entry_id = v_je_id
WHERE id = p_rv_id;

INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
VALUES (
'receipt_vouchers', p_rv_id, 'update',
jsonb_build_object('is_posted', FALSE),
jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', p_posted_by),
p_posted_by
);
END;
$function$
;


-- create_fund_transfer_with_posting(p_transfer_date date, p_from_amount numeric, p_to_amount numeric, p_from_account_type text, p_to_account_type text, p_description text, p_from_bank_account_id uuid, p_to_bank_account_id uuid, p_from_bank_statement_line_id uuid, p_to_bank_statement_line_id uuid, p_exchange_rate numeric, p_created_by uuid)
CREATE OR REPLACE FUNCTION public.create_fund_transfer_with_posting(p_transfer_date date, p_from_amount numeric, p_to_amount numeric, p_from_account_type text, p_to_account_type text, p_description text DEFAULT NULL::text, p_from_bank_account_id uuid DEFAULT NULL::uuid, p_to_bank_account_id uuid DEFAULT NULL::uuid, p_from_bank_statement_line_id uuid DEFAULT NULL::uuid, p_to_bank_statement_line_id uuid DEFAULT NULL::uuid, p_exchange_rate numeric DEFAULT NULL::numeric, p_created_by uuid DEFAULT NULL::uuid)
 RETURNS fund_transfers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
  v_transfer_number text;
  v_transfer public.fund_transfers;
  v_source_account_name text;
BEGIN
  v_user_id := COALESCE(p_created_by, auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_transfer_number := public.generate_fund_transfer_number();

  INSERT INTO public.fund_transfers (
    transfer_number,
    transfer_date,
    amount,
    from_amount,
    to_amount,
    exchange_rate,
    from_account_type,
    to_account_type,
    from_bank_account_id,
    to_bank_account_id,
    from_bank_statement_line_id,
    to_bank_statement_line_id,
    description,
    created_by
  ) VALUES (
    v_transfer_number,
    p_transfer_date,
    p_from_amount,
    p_from_amount,
    p_to_amount,
    p_exchange_rate,
    p_from_account_type,
    p_to_account_type,
    CASE WHEN p_from_account_type = 'bank' THEN p_from_bank_account_id ELSE NULL END,
    CASE WHEN p_to_account_type = 'bank' THEN p_to_bank_account_id ELSE NULL END,
    p_from_bank_statement_line_id,
    p_to_bank_statement_line_id,
    NULLIF(p_description, ''),
    v_user_id
  )
  RETURNING * INTO v_transfer;

  IF v_transfer.to_account_type = 'petty_cash' THEN
    IF v_transfer.from_account_type = 'bank' THEN
      SELECT COALESCE(ba.alias, ba.bank_name, 'Bank')
        INTO v_source_account_name
      FROM public.bank_accounts ba
      WHERE ba.id = v_transfer.from_bank_account_id;
    ELSE
      v_source_account_name := 'Cash on Hand';
    END IF;

    INSERT INTO public.petty_cash_transactions (
      transaction_date,
      transaction_type,
      amount,
      description,
      bank_account_id,
      bank_statement_line_id,
      source,
      fund_transfer_id,
      approval_status,
      created_by
    ) VALUES (
      v_transfer.transfer_date,
      'withdraw',
      v_transfer.to_amount,
      COALESCE(v_transfer.description, 'Fund transfer from ' || COALESCE(v_source_account_name, 'Bank')),
      v_transfer.from_bank_account_id,
      v_transfer.from_bank_statement_line_id,
      'Fund Transfer ' || v_transfer.transfer_number,
      v_transfer.id,
      'approved',
      v_user_id
    )
    ON CONFLICT (fund_transfer_id) WHERE fund_transfer_id IS NOT NULL DO NOTHING;
  END IF;

  RETURN v_transfer;
END;
$function$
;


-- save_payment_voucher_with_allocations(p_voucher_id uuid, p_voucher_number text, p_voucher_date date, p_supplier_id uuid, p_payment_method text, p_bank_account_id uuid, p_reference_number text, p_amount numeric, p_pph_amount numeric, p_pph_code_id uuid, p_description text, p_payment_currency text, p_exchange_rate numeric, p_bank_amount numeric, p_bank_charge numeric, p_created_by uuid, p_allocations jsonb, p_staff_id uuid)
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_allocations(p_voucher_id uuid DEFAULT NULL::uuid, p_voucher_number text DEFAULT NULL::text, p_voucher_date date DEFAULT NULL::date, p_supplier_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT NULL::text, p_bank_account_id uuid DEFAULT NULL::uuid, p_reference_number text DEFAULT NULL::text, p_amount numeric DEFAULT 0, p_pph_amount numeric DEFAULT 0, p_pph_code_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_payment_currency text DEFAULT 'IDR'::text, p_exchange_rate numeric DEFAULT 1, p_bank_amount numeric DEFAULT NULL::numeric, p_bank_charge numeric DEFAULT 0, p_created_by uuid DEFAULT NULL::uuid, p_allocations jsonb DEFAULT '[]'::jsonb, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_voucher_id    UUID;
  v_alloc         JSONB;
  v_invoice_id    UUID;
  v_expense_id    UUID;
  v_alloc_amount  NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_supplier_id IS NULL AND p_staff_id IS NULL THEN
    RAISE EXCEPTION 'Payment voucher needs a payee: supplier or staff';
  END IF;

  -- ── Create or update the voucher header ──
  IF p_voucher_id IS NULL THEN
    INSERT INTO payment_vouchers (
      voucher_number, voucher_date, supplier_id, staff_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate,
      bank_amount, bank_charge, created_by
    ) VALUES (
      p_voucher_number, p_voucher_date, p_supplier_id, p_staff_id, p_payment_method,
      p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
      p_description, p_payment_currency, p_exchange_rate,
      p_bank_amount, p_bank_charge, p_created_by
    ) RETURNING id INTO v_voucher_id;
  ELSE
    v_voucher_id := p_voucher_id;

    IF EXISTS (SELECT 1 FROM payment_vouchers WHERE id = v_voucher_id AND is_posted = TRUE) THEN
      RAISE EXCEPTION 'Cannot edit: % is posted. Cancel Posting first to make changes.', p_voucher_number;
    END IF;

    UPDATE payment_vouchers SET
      voucher_date      = p_voucher_date,
      supplier_id       = p_supplier_id,
      staff_id          = p_staff_id,
      payment_method    = p_payment_method,
      bank_account_id   = p_bank_account_id,
      reference_number  = p_reference_number,
      amount            = p_amount,
      pph_amount        = p_pph_amount,
      pph_code_id       = p_pph_code_id,
      description       = p_description,
      payment_currency  = p_payment_currency,
      exchange_rate     = p_exchange_rate,
      bank_amount       = p_bank_amount,
      bank_charge       = p_bank_charge,
      updated_at        = NOW()
    WHERE id = v_voucher_id;
  END IF;

  -- ── Replace all allocations ──
  DELETE FROM voucher_allocations WHERE payment_voucher_id = v_voucher_id;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) AS value
  LOOP
    v_alloc_amount := COALESCE((v_alloc->>'amount')::NUMERIC, 0);
    IF v_alloc_amount <= 0 THEN
      CONTINUE;
    END IF;

    v_invoice_id := NULLIF(v_alloc->>'invoice_id', '')::UUID;
    v_expense_id := NULLIF(v_alloc->>'finance_expense_id', '')::UUID;

    IF v_invoice_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, purchase_invoice_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id, v_invoice_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
      );
    ELSIF v_expense_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, finance_expense_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id, v_expense_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
      );
      -- paid_amount on finance_expenses updated by trg_sync_expense_payment_state
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$function$
;


-- save_payment_voucher(p_voucher_date date, p_supplier_id uuid, p_payment_method text, p_bank_account_id uuid, p_reference_number text, p_amount numeric, p_pph_amount numeric, p_pph_code_id uuid, p_description text, p_created_by uuid, p_allocations jsonb)
CREATE OR REPLACE FUNCTION public.save_payment_voucher(p_voucher_date date, p_supplier_id uuid, p_payment_method text, p_bank_account_id uuid, p_reference_number text, p_amount numeric, p_pph_amount numeric, p_pph_code_id uuid, p_description text, p_created_by uuid, p_allocations jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
v_voucher_number text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

v_voucher_number := public.generate_voucher_number('PV');

RETURN public.save_payment_voucher_with_allocations(
NULL,
v_voucher_number,
p_voucher_date,
p_supplier_id,
p_payment_method,
p_bank_account_id,
p_reference_number,
p_amount,
p_pph_amount,
p_pph_code_id,
p_description,
'IDR',
1,
NULL,
0,
p_created_by,
p_allocations
);
END;
$function$
;


-- save_payment_voucher_with_purpose(p_voucher_id uuid, p_payload jsonb, p_allocations jsonb, p_payment_purpose text)
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_purpose(p_voucher_id uuid DEFAULT NULL::uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_allocations jsonb DEFAULT '[]'::jsonb, p_payment_purpose text DEFAULT 'general'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();

  IF p_payment_purpose NOT IN (
    'general',
    'salary_advance',
    'salary_advance_settlement'
  ) THEN
    RAISE EXCEPTION 'Unsupported payment purpose %', p_payment_purpose;
  END IF;

  v_result := public.save_payment_voucher_command(
    p_voucher_id,
    p_payload,
    p_allocations
  );
  v_id := (v_result->>'id')::uuid;

  UPDATE public.payment_vouchers
     SET payment_purpose = p_payment_purpose,
         salary_advance_status = CASE p_payment_purpose
           WHEN 'salary_advance' THEN 'outstanding'
           ELSE 'not_applicable'
         END
   WHERE id = v_id;

  RETURN v_result;
END;
$function$
;


-- approve_finance_expense(p_expense_id uuid, p_approved_by uuid)
CREATE OR REPLACE FUNCTION public.approve_finance_expense(p_expense_id uuid, p_approved_by uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
BEGIN
  PERFORM public._sec_check_finance_role();
  UPDATE public.finance_expenses SET approval_status='approved',approved_by=COALESCE(p_approved_by,auth.uid()),approved_at=now(),rejection_reason=NULL
  WHERE id=p_expense_id AND approval_status IS DISTINCT FROM 'approved';
  IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=p_expense_id AND approval_status='approved') THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  RETURN p_expense_id;
END $function$
;


-- edit_approved_finance_expense_atomic(p_expense_id uuid, p_payload jsonb, p_bank_statement_line_id uuid, p_allocation_amount numeric)
CREATE OR REPLACE FUNCTION public.edit_approved_finance_expense_atomic(p_expense_id uuid, p_payload jsonb, p_bank_statement_line_id uuid DEFAULT NULL::uuid, p_allocation_amount numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
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
  v_same_selected_count integer;
  v_selected_amount numeric;
  v_period_status text;
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
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id=v_bank_id;
  v_currency:=upper(COALESCE(NULLIF(p_payload->>'transaction_currency',''),v_bank_currency,'IDR'));
  v_rate:=COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric,0),CASE WHEN v_currency='IDR' THEN 1 END);
  IF v_currency NOT IN('IDR','USD') OR v_rate IS NULL OR v_rate<=0 THEN RAISE EXCEPTION 'Valid expense currency/rate is required'; END IF;
  IF v_bank_currency IS NOT NULL AND v_bank_currency<>v_currency THEN RAISE EXCEPTION 'Expense currency does not match selected bank currency'; END IF;
  IF NULLIF(p_payload->>'payment_method','') IS NOT NULL
     AND NULLIF(p_payload->>'payment_method','') NOT IN('cash','petty_cash')
     AND v_bank_id IS NULL THEN RAISE EXCEPTION 'Bank-paid expense requires a bank account'; END IF;
  IF NULLIF(p_payload->>'payment_method','') IN('cash','petty_cash')
     AND p_bank_statement_line_id IS NOT NULL THEN RAISE EXCEPTION 'Cash/petty-cash expense cannot create a bank allocation'; END IF;
  IF NULLIF(p_payload->>'payment_method','') IS NULL AND p_bank_statement_line_id IS NOT NULL THEN RAISE EXCEPTION 'Accrued expense cannot create a bank allocation'; END IF;
  SELECT ap.status INTO v_period_status
    FROM public.accounting_periods ap
   WHERE ap.start_date<=v_date AND ap.end_date>=v_date
   ORDER BY ap.start_date DESC LIMIT 1;
  IF v_period_status IS NOT NULL AND v_period_status<>'open' THEN
    RAISE EXCEPTION 'Cannot move approved expense into a closed accounting period';
  END IF;
  SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO v_docs
    FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls','[]'::jsonb));

  PERFORM set_config('app.expense_atomic_bank_link','on',true);

  UPDATE public.finance_expenses SET
    expense_category=p_payload->>'expense_category',expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),'admin'),
    amount=(p_payload->>'amount')::numeric,expense_date=v_date,description=NULLIF(p_payload->>'description',''),
    batch_id=NULLIF(p_payload->>'batch_id','')::uuid,import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
    delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
    payment_method=NULLIF(p_payload->>'payment_method',''),bank_account_id=v_bank_id,
    payment_reference=NULLIF(p_payload->>'payment_reference',''),paid_by=NULLIF(p_payload->>'paid_by',''),
    document_urls=NULLIF(v_docs,ARRAY[]::text[]),supplier_id=NULLIF(p_payload->>'supplier_id','')::uuid,
    staff_id=NULLIF(p_payload->>'staff_id','')::uuid,invoice_number=NULLIF(p_payload->>'invoice_number',''),
    due_date=NULLIF(p_payload->>'due_date','')::date,broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
    pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
    pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,ppn_amount=COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0),
    ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
    ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric,
    ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),pph_amount=COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,stamp_duty_amount=COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
    fixed_asset_account_id=NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
    bank_charges_amount=COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
    currency_code=v_currency,transaction_currency=v_currency,functional_currency='IDR',exchange_rate=v_rate,
    bank_account_currency=COALESCE(v_bank_currency,v_currency),payment_currency=v_currency,
    payee_id=NULLIF(p_payload->>'payee_id','')::uuid,
    linked_sales_invoice_id=NULLIF(p_payload->>'linked_sales_invoice_id','')::uuid,
    pph_calculation_regime=NULLIF(p_payload->>'pph_calculation_regime',''),
    pph_dpp_ratio=NULLIF(p_payload->>'pph_dpp_ratio','')::numeric,
    pph_dpp_amount=NULLIF(p_payload->>'pph_dpp_amount','')::numeric,
    pph_rate=NULLIF(p_payload->>'pph_rate','')::numeric,
    is_tax_manual_override=COALESCE((p_payload->>'is_tax_manual_override')::boolean, false)
  WHERE id=p_expense_id;

  IF NOT EXISTS(
    SELECT 1 FROM public.journal_entries
     WHERE id=v_journal_id
       AND source_module IN('expense','expenses')
       AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
       AND is_posted AND NOT COALESCE(is_reversed,false)
  ) THEN RAISE EXCEPTION 'Expense journal identity changed during edit'; END IF;
  IF (SELECT count(*) FROM public.journal_entries
       WHERE source_module IN('expense','expenses')
         AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
         AND is_posted AND NOT COALESCE(is_reversed,false))<>1 THEN
    RAISE EXCEPTION 'Expense edit did not preserve exactly one active journal';
  END IF;

  SELECT count(*),max(allocation_amount)
    INTO v_same_selected_count,v_selected_amount
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='supplier'
     AND bank_statement_line_id=p_bank_statement_line_id;

  IF p_bank_statement_line_id IS NOT NULL
     AND v_same_selected_count=0 THEN
    PERFORM public.link_bank_statement_line(
      p_bank_statement_line_id,'expense',p_expense_id,'supplier',p_allocation_amount);
  ELSIF p_bank_statement_line_id IS NOT NULL
     AND p_allocation_amount IS NOT NULL
     AND abs(COALESCE(v_selected_amount,0)-p_allocation_amount)>0.01 THEN
    RAISE EXCEPTION 'Change an existing bank allocation through unlink/relink so other payments remain intact';
  END IF;

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  RETURN p_expense_id;
END;
$function$
;


-- adjust_batch_stock_atomic(p_batch_id uuid, p_quantity_change numeric, p_transaction_type text, p_reference_id uuid, p_notes text, p_created_by uuid, p_operation_id uuid)
CREATE OR REPLACE FUNCTION public.adjust_batch_stock_atomic(p_batch_id uuid, p_quantity_change numeric, p_transaction_type text, p_reference_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_created_by uuid DEFAULT NULL::uuid, p_operation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(new_stock numeric, transaction_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_transaction_id uuid;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for stock adjustment';
  END IF;
  IF p_transaction_type IS DISTINCT FROM 'adjustment' THEN
    RAISE EXCEPTION 'Manual inventory entry supports Stock Adjustment only';
  END IF;
  IF COALESCE(p_quantity_change, 0) = 0 THEN
    RAISE EXCEPTION 'Stock adjustment cannot be zero';
  END IF;

  SELECT *
  INTO v_batch
  FROM public.batches
  WHERE id = p_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;

  v_transaction_id := public.post_inventory_movement(
    p_operation_id,
    v_batch.product_id,
    v_batch.id,
    'adjustment',
    p_quantity_change,
    CURRENT_DATE,
    NULL,
    'stock_adjustment',
    p_reference_id,
    p_notes,
    COALESCE(p_created_by, auth.uid()),
    NULL,
    NULL
  );

  SELECT current_stock
  INTO new_stock
  FROM public.batches
  WHERE id = p_batch_id;

  transaction_id := v_transaction_id;
  RETURN NEXT;
END;
$function$
;


-- save_batch_inventory_v1(p_batch_id uuid, p_payload jsonb, p_operation_id uuid)
CREATE OR REPLACE FUNCTION public.save_batch_inventory_v1(p_batch_id uuid, p_payload jsonb, p_operation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_existing_batch_id uuid;
  v_actor uuid := auth.uid();
  v_delta numeric;
  v_previous_context text;
  v_unit_price numeric;
  v_is_local boolean;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse']) THEN
    RAISE EXCEPTION 'Permission denied for canonical batch save';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'operation_id is required';
  END IF;
  IF p_batch_id IS NULL AND NULLIF(p_payload->>'make_id', '') IS NULL THEN
    RAISE EXCEPTION 'Make / Manufacturer is required for new inventory batches';
  END IF;
  IF NULLIF(p_payload->>'make_id', '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.product_sources
        WHERE id = (p_payload->>'make_id')::uuid
          AND product_id = (p_payload->>'product_id')::uuid
     ) THEN
    RAISE EXCEPTION 'Selected Make / Manufacturer does not belong to the selected product';
  END IF;

  v_unit_price := COALESCE((p_payload->>'import_price')::numeric, 0);
  v_is_local := NULLIF(p_payload->>'import_container_id', '') IS NULL;

  IF p_batch_id IS NULL THEN
    SELECT batch_id INTO v_existing_batch_id
      FROM public.inventory_transactions
     WHERE operation_id = p_operation_id AND transaction_type = 'purchase';
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'batch_id', v_existing_batch_id, 'idempotent_retry', true);
    END IF;

    v_previous_context := current_setting('app.canonical_stock_engine', true);
    PERFORM set_config('app.canonical_stock_engine', 'on', true);
    INSERT INTO public.batches (
      batch_number, product_id, make_id, import_container_id, import_date,
      import_quantity, current_stock, packaging_details, import_price,
      import_price_usd, exchange_rate_usd_to_idr, duty_percent, duty_charges,
      duty_charge_type, freight_charges, freight_charge_type, other_charges,
      other_charge_type, expiry_date, is_active, created_by,
      cost_per_unit, landed_cost_per_unit, final_landed_cost, import_price_per_unit
    ) VALUES (
      p_payload->>'batch_number', (p_payload->>'product_id')::uuid,
      NULLIF(p_payload->>'make_id', '')::uuid,
      NULLIF(p_payload->>'import_container_id', '')::uuid,
      (p_payload->>'import_date')::date, (p_payload->>'import_quantity')::numeric,
      0, NULLIF(p_payload->>'packaging_details', ''),
      v_unit_price,
      NULLIF(p_payload->>'import_price_usd', '')::numeric,
      NULLIF(p_payload->>'exchange_rate_usd_to_idr', '')::numeric,
      COALESCE(NULLIF(p_payload->>'duty_percent', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'duty_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'duty_charge_type', ''), 'fixed'),
      COALESCE(NULLIF(p_payload->>'freight_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'freight_charge_type', ''), 'fixed'),
      COALESCE(NULLIF(p_payload->>'other_charges', '')::numeric, 0),
      COALESCE(NULLIF(p_payload->>'other_charge_type', ''), 'fixed'),
      NULLIF(p_payload->>'expiry_date', '')::date, true, v_actor,
      v_unit_price,
      CASE WHEN v_is_local THEN v_unit_price ELSE 0 END,
      CASE WHEN v_is_local THEN v_unit_price * (p_payload->>'import_quantity')::numeric ELSE 0 END,
      v_unit_price
    ) RETURNING * INTO v_batch;
    PERFORM set_config('app.canonical_stock_engine', COALESCE(v_previous_context, ''), true);
    PERFORM public.post_inventory_movement(
      p_operation_id, v_batch.product_id, v_batch.id, 'purchase',
      v_batch.import_quantity, v_batch.import_date, v_batch.batch_number,
      'batch_creation', v_batch.id, 'Canonical Batch Creation: ' || v_batch.batch_number,
      v_actor, 0, v_batch.import_quantity
    );
    RETURN jsonb_build_object('success', true, 'batch_id', v_batch.id);
  END IF;

  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF (p_payload->>'product_id')::uuid IS DISTINCT FROM v_batch.product_id
     AND EXISTS (SELECT 1 FROM public.inventory_transactions WHERE batch_id = p_batch_id AND transaction_type <> 'purchase') THEN
    RAISE EXCEPTION 'Cannot change product after batch stock movement exists';
  END IF;

  v_delta := (p_payload->>'import_quantity')::numeric - v_batch.import_quantity;
  UPDATE public.batches SET
    batch_number = p_payload->>'batch_number', product_id = (p_payload->>'product_id')::uuid,
    make_id = NULLIF(p_payload->>'make_id', '')::uuid,
    import_container_id = NULLIF(p_payload->>'import_container_id', '')::uuid,
    import_date = (p_payload->>'import_date')::date, import_quantity = (p_payload->>'import_quantity')::numeric,
    packaging_details = NULLIF(p_payload->>'packaging_details', ''),
    import_price = COALESCE((p_payload->>'import_price')::numeric, import_price),
    import_price_usd = NULLIF(p_payload->>'import_price_usd', '')::numeric,
    exchange_rate_usd_to_idr = NULLIF(p_payload->>'exchange_rate_usd_to_idr', '')::numeric,
    duty_percent = COALESCE(NULLIF(p_payload->>'duty_percent', '')::numeric, 0),
    duty_charges = COALESCE(NULLIF(p_payload->>'duty_charges', '')::numeric, 0),
    duty_charge_type = COALESCE(NULLIF(p_payload->>'duty_charge_type', ''), duty_charge_type),
    freight_charges = COALESCE(NULLIF(p_payload->>'freight_charges', '')::numeric, 0),
    freight_charge_type = COALESCE(NULLIF(p_payload->>'freight_charge_type', ''), freight_charge_type),
    other_charges = COALESCE(NULLIF(p_payload->>'other_charges', '')::numeric, 0),
    other_charge_type = COALESCE(NULLIF(p_payload->>'other_charge_type', ''), other_charge_type),
    expiry_date = NULLIF(p_payload->>'expiry_date', '')::date,
    cost_per_unit = CASE
      WHEN NULLIF(p_payload->>'import_container_id', '') IS NULL
        THEN COALESCE((p_payload->>'import_price')::numeric, import_price)
      ELSE cost_per_unit
    END,
    landed_cost_per_unit = CASE
      WHEN NULLIF(p_payload->>'import_container_id', '') IS NULL
        THEN COALESCE((p_payload->>'import_price')::numeric, import_price)
      ELSE landed_cost_per_unit
    END,
    final_landed_cost = CASE
      WHEN NULLIF(p_payload->>'import_container_id', '') IS NULL
        THEN COALESCE((p_payload->>'import_price')::numeric, import_price) * (p_payload->>'import_quantity')::numeric
      ELSE final_landed_cost
    END,
    import_price_per_unit = COALESCE((p_payload->>'import_price')::numeric, import_price),
    updated_at = now()
  WHERE id = p_batch_id;

  IF v_delta <> 0 THEN
    PERFORM public.post_inventory_movement(
      p_operation_id, (p_payload->>'product_id')::uuid, p_batch_id, 'adjustment',
      v_delta, CURRENT_DATE, p_payload->>'batch_number', 'batch_edit', p_batch_id,
      format('Canonical Batch Edit quantity correction: %s to %s', v_batch.import_quantity, (p_payload->>'import_quantity')::numeric),
      v_actor, v_batch.current_stock, v_batch.current_stock + v_delta
    );
  END IF;
  RETURN jsonb_build_object('success', true, 'batch_id', p_batch_id);
END;
$function$
;


-- archive_batch_inventory_v1(p_batch_id uuid)
CREATE OR REPLACE FUNCTION public.archive_batch_inventory_v1(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_batch public.batches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for batch archive';
  END IF;

  SELECT *
  INTO v_batch
  FROM public.batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'archived', false,
      'reason', 'Batch not found'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stock_reservations
    WHERE batch_id = p_batch_id
      AND status = 'active'
  ) THEN
    RETURN jsonb_build_object(
      'archived', false,
      'reason', format(
        'Batch %s has active reservations and cannot be archived',
        v_batch.batch_number
      )
    );
  END IF;

  IF v_batch.current_stock <> 0 THEN
    RETURN jsonb_build_object(
      'archived', false,
      'reason', format(
        'Batch %s still has stock %s. Post a canonical adjustment to zero before archiving',
        v_batch.batch_number,
        v_batch.current_stock
      )
    );
  END IF;

  UPDATE public.batches
  SET is_active = false,
      updated_at = now()
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'archived', true,
    'batch_id', p_batch_id,
    'batch_number', v_batch.batch_number
  );
END;
$function$
;


-- delete_batch_safe(p_batch_id uuid)
CREATE OR REPLACE FUNCTION public.delete_batch_safe(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_result := public.archive_batch_inventory_v1(p_batch_id);
  RETURN jsonb_build_object(
    'deleted', false,
    'archived', COALESCE((v_result->>'archived')::boolean, false),
    'batch_id', v_result->>'batch_id',
    'batch_number', v_result->>'batch_number',
    'reason', COALESCE(
      v_result->>'reason',
      'Inventory V1 preserves batch and movement history; the batch was archived'
    )
  );
END;
$function$
;


-- approve_purchase_invoice_for_receiving(p_purchase_invoice_id uuid)
CREATE OR REPLACE FUNCTION public.approve_purchase_invoice_for_receiving(p_purchase_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE v_status text;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts']) THEN RAISE EXCEPTION 'Permission denied'; END IF;
  SELECT receiving_approval_status INTO v_status FROM public.purchase_invoices WHERE id=p_purchase_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase Invoice not found'; END IF;
  IF v_status <> 'pending_approval' THEN RAISE EXCEPTION 'Purchase Invoice must be pending approval'; END IF;
  UPDATE public.purchase_invoices SET receiving_approval_status='approved', receiving_approved_at=now(), receiving_approved_by=auth.uid(), updated_at=now() WHERE id=p_purchase_invoice_id;
  RETURN jsonb_build_object('success',true,'status','approved');
END; $function$
;


-- reject_purchase_invoice_inward(p_purchase_invoice_id uuid, p_purchase_invoice_item_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.reject_purchase_invoice_inward(p_purchase_invoice_id uuid, p_purchase_invoice_item_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE v_status text;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','warehouse']) THEN RAISE EXCEPTION 'Permission denied'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason))=0 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  SELECT receiving_approval_status INTO v_status FROM public.purchase_invoices WHERE id=p_purchase_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase Invoice not found'; END IF;
  IF v_status <> 'approved' THEN RAISE EXCEPTION 'Only approved Purchase Invoices can be rejected at inward'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_invoice_items WHERE id=p_purchase_invoice_item_id AND purchase_invoice_id=p_purchase_invoice_id AND item_type='inventory') THEN
    RAISE EXCEPTION 'Purchase Invoice item does not belong to this invoice';
  END IF;
  INSERT INTO public.purchase_invoice_inward_rejections(purchase_invoice_id,purchase_invoice_item_id,reason,rejected_by) VALUES (p_purchase_invoice_id,p_purchase_invoice_item_id,trim(p_reason),auth.uid());
  UPDATE public.purchase_invoices SET receiving_approval_status='rejected', receiving_rejection_reason=trim(p_reason), updated_at=now() WHERE id=p_purchase_invoice_id;
  RETURN jsonb_build_object('success',true,'status','rejected');
END; $function$
;


-- submit_purchase_invoice_for_receiving(p_purchase_invoice_id uuid)
CREATE OR REPLACE FUNCTION public.submit_purchase_invoice_for_receiving(p_purchase_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE v_invoice public.purchase_invoices%ROWTYPE;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts']) THEN RAISE EXCEPTION 'Permission denied'; END IF;
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id = p_purchase_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase Invoice not found'; END IF;
  IF v_invoice.status = 'cancelled' THEN RAISE EXCEPTION 'Cancelled Purchase Invoice cannot be submitted'; END IF;
  UPDATE public.purchase_invoices SET receiving_approval_status='pending_approval', receiving_submitted_at=now(), receiving_submitted_by=auth.uid(), receiving_rejection_reason=NULL, updated_at=now() WHERE id=p_purchase_invoice_id;
  RETURN jsonb_build_object('success',true,'status','pending_approval');
END; $function$
;


-- receive_purchase_invoice_item(p_purchase_invoice_item_id uuid, p_payload jsonb, p_received_quantity numeric, p_operation_id uuid)
CREATE OR REPLACE FUNCTION public.receive_purchase_invoice_item(p_purchase_invoice_item_id uuid, p_payload jsonb, p_received_quantity numeric, p_operation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_item public.purchase_invoice_items%ROWTYPE;
  v_invoice public.purchase_invoices%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_batch_id uuid;
  v_existing numeric;
  v_allocation_id uuid;
  v_make_id uuid;
  v_container_id uuid;
  v_currency text;
  v_rate numeric;
  v_tx_unit numeric;
  v_func_unit numeric;
  v_existing_batch boolean := false;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','warehouse']) THEN
    RAISE EXCEPTION 'Permission denied for inventory receiving';
  END IF;
  IF p_operation_id IS NULL OR p_received_quantity IS NULL OR p_received_quantity <= 0 THEN
    RAISE EXCEPTION 'A positive quantity and operation_id are required';
  END IF;
  SELECT * INTO v_item FROM public.purchase_invoice_items WHERE id=p_purchase_invoice_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice item not found'; END IF;
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id=v_item.purchase_invoice_id;
  IF v_item.item_type <> 'inventory' OR v_item.product_id IS NULL
     OR NULLIF(p_payload->>'product_id','')::uuid IS DISTINCT FROM v_item.product_id THEN
    RAISE EXCEPTION 'Receiving requires the invoice inventory product';
  END IF;
  SELECT batch_id,id INTO v_batch_id,v_allocation_id
    FROM public.purchase_invoice_receiving_allocations WHERE operation_id=p_operation_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,
      'allocation_id',v_allocation_id,'idempotent_retry',true);
  END IF;
  SELECT COALESCE(sum(received_quantity),0) INTO v_existing
    FROM public.purchase_invoice_receiving_allocations
   WHERE purchase_invoice_item_id=v_item.id AND status='received';
  IF v_existing+p_received_quantity > v_item.quantity THEN
    RAISE EXCEPTION 'Received quantity exceeds invoice line quantity';
  END IF;
  v_make_id := NULLIF(p_payload->>'make_id','')::uuid;
  v_container_id := NULLIF(p_payload->>'import_container_id','')::uuid;
  IF v_make_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM public.product_sources WHERE id=v_make_id AND product_id=v_item.product_id) THEN
    RAISE EXCEPTION 'Selected Make / Manufacturer does not belong to the invoice product';
  END IF;
  IF NULLIF(p_payload->>'batch_id','') IS NOT NULL THEN
    SELECT * INTO v_batch FROM public.batches WHERE id=(p_payload->>'batch_id')::uuid FOR UPDATE;
  ELSE
    SELECT * INTO v_batch FROM public.batches
     WHERE product_id=v_item.product_id AND batch_number=p_payload->>'batch_number'
       AND (make_id=v_make_id OR make_id IS NULL) AND coalesce(is_active,true)
     ORDER BY (make_id IS NULL),created_at LIMIT 1 FOR UPDATE;
  END IF;
  IF FOUND THEN
    v_existing_batch := true;
    IF v_batch.product_id IS DISTINCT FROM v_item.product_id THEN
      RAISE EXCEPTION 'Product does not match selected batch';
    END IF;
    IF v_batch.make_id IS NOT NULL AND v_batch.make_id IS DISTINCT FROM v_make_id THEN
      RAISE EXCEPTION 'Make does not match selected batch';
    END IF;
    IF NULLIF(p_payload->>'expiry_date','')::date IS NOT NULL
       AND v_batch.expiry_date IS NOT NULL
       AND NULLIF(p_payload->>'expiry_date','')::date IS DISTINCT FROM v_batch.expiry_date THEN
      RAISE EXCEPTION 'Expiry date conflicts with existing physical batch';
    END IF;
    PERFORM public.post_inventory_movement(p_operation_id,v_batch.product_id,v_batch.id,
      'adjustment',p_received_quantity,v_invoice.invoice_date,v_invoice.invoice_number,
      'purchase_invoice_receiving',v_invoice.id,
      'Purchase Invoice receiving into existing batch '||v_batch.batch_number,
      auth.uid(),v_batch.current_stock,v_batch.current_stock+p_received_quantity);
    UPDATE public.batches SET import_quantity=import_quantity+p_received_quantity,updated_at=now()
      WHERE id=v_batch.id;
    v_batch_id := v_batch.id;
  ELSE
    p_payload := jsonb_set(p_payload,'{import_quantity}',to_jsonb(p_received_quantity),true);
    p_payload := jsonb_set(p_payload,'{purchase_invoice_id}',to_jsonb(v_item.purchase_invoice_id),true);
    p_payload := jsonb_set(p_payload,'{supplier_id}',to_jsonb(v_invoice.supplier_id),true);
    SELECT (public.save_batch_inventory_v1(NULL,p_payload,p_operation_id)->>'batch_id')::uuid INTO v_batch_id;
  END IF;
  v_currency := upper(coalesce(v_invoice.currency,'IDR'));
  v_rate := CASE WHEN v_currency='IDR' THEN 1 ELSE coalesce(v_invoice.exchange_rate,0) END;
  IF v_rate<=0 THEN RAISE EXCEPTION 'Purchase invoice exchange rate is required'; END IF;
  v_tx_unit := coalesce(v_item.unit_price,0);
  v_func_unit := round(v_tx_unit*v_rate,2);
  INSERT INTO public.purchase_invoice_receiving_allocations(
    purchase_invoice_id,purchase_invoice_item_id,batch_id,received_quantity,
    operation_id,received_by,currency,exchange_rate,functional_unit_cost,
    functional_total_cost,import_container_id)
  VALUES(v_item.purchase_invoice_id,v_item.id,v_batch_id,p_received_quantity,
    p_operation_id,auth.uid(),v_currency,v_rate,v_func_unit,
    round(v_func_unit*p_received_quantity,2),v_container_id)
  RETURNING id INTO v_allocation_id;
  INSERT INTO public.purchase_batch_cost_layers(
    receiving_allocation_id,purchase_invoice_id,purchase_invoice_item_id,batch_id,
    import_container_id,quantity,currency,exchange_rate,transaction_unit_cost,
    functional_unit_cost,functional_total_cost,final_functional_unit_cost)
  VALUES(v_allocation_id,v_item.purchase_invoice_id,v_item.id,v_batch_id,v_container_id,
    p_received_quantity,v_currency,v_rate,v_tx_unit,v_func_unit,
    round(v_func_unit*p_received_quantity,2),v_func_unit);
  IF v_existing_batch THEN
    PERFORM public.apply_batch_receipt_weighted_average(v_batch_id,p_received_quantity,v_func_unit);
  END IF;
  RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,'allocation_id',v_allocation_id);
END; $function$
;


-- approve_sales_order_product_reservation_v2(p_so_id uuid, p_approved_by uuid)
CREATE OR REPLACE FUNCTION public.approve_sales_order_product_reservation_v2(p_so_id uuid, p_approved_by uuid)
 RETURNS TABLE(success boolean, message text, shortage_items jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_delivered numeric;
  v_item_required numeric;
  v_reserved numeric;
  v_shortage_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse'])
     AND current_setting('app.canonical_reservation_engine', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Permission denied for SO product reservation approval';
  END IF;

  PERFORM 1 FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  PERFORM set_config('app.canonical_reservation_engine', 'on', true);

  UPDATE public.sales_orders
  SET approved_by = COALESCE(p_approved_by, auth.uid()),
      approved_at = COALESCE(approved_at, now())
  WHERE id = p_so_id;

  FOR r IN
    SELECT id, product_id, quantity
    FROM public.sales_order_items
    WHERE sales_order_id = p_so_id
    ORDER BY product_id, id
  LOOP
    v_reserved := public.reconcile_so_product_reservation_v2(r.id, 'SO approval/re-approval');

    SELECT COALESCE(sum(dci.quantity), 0) INTO v_delivered
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.sales_order_item_id = r.id
      AND dc.approval_status = 'approved';

    v_item_required := GREATEST(r.quantity - v_delivered, 0);

    IF v_item_required > v_reserved THEN
      v_has_shortage := true;
      v_shortage_qty := v_item_required - v_reserved;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', r.product_id,
        'required_qty', r.quantity,
        'shortage_qty', v_shortage_qty
      );
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE public.sales_orders
    SET status = 'shortage',
        updated_at = now()
    WHERE id = p_so_id;

    PERFORM public.fn_create_import_requirements(p_so_id, v_shortage_list);

    RETURN QUERY
    SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE public.sales_orders
    SET status = 'stock_reserved',
        updated_at = now()
    WHERE id = p_so_id;

    -- Cancel any pending import requirements for this SO
    UPDATE public.import_requirements
    SET status = 'cancelled',
        notes = COALESCE(notes || ' | ', '') ||
          'Auto-cancelled: shortage resolved by stock reservation ' ||
          to_char(now(), 'YYYY-MM-DD'),
        updated_at = now()
    WHERE sales_order_id = p_so_id
      AND status = 'pending';

    RETURN QUERY
    SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$function$
;


-- approve_sales_order_inventory_v1(p_so_id uuid, p_approved_by uuid)
CREATE OR REPLACE FUNCTION public.approve_sales_order_inventory_v1(p_so_id uuid, p_approved_by uuid)
 RETURNS TABLE(success boolean, message text, shortage_items jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_previous_context text;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for Sales Order approval';
  END IF;

  v_previous_context := current_setting('app.canonical_reservation_engine', true);
  PERFORM set_config('app.canonical_reservation_engine', 'on', true);

  UPDATE public.sales_orders
  SET status = 'approved',
      approved_by = COALESCE(p_approved_by, auth.uid()),
      approved_at = now(),
      updated_at = now()
  WHERE id = p_so_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.fn_reserve_stock_for_so_v2(p_so_id);

  PERFORM set_config(
    'app.canonical_reservation_engine',
    COALESCE(v_previous_context, ''),
    true
  );
END;
$function$
;


-- release_so_product_reservations_v2(p_so_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.release_so_product_reservations_v2(p_so_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE r public.so_product_reservations%ROWTYPE;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse','sales'])
     AND current_setting('app.canonical_reservation_engine',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Permission denied for reservation release';
  END IF;
  FOR r IN SELECT * FROM public.so_product_reservations WHERE sales_order_id=p_so_id AND status='active' ORDER BY id FOR UPDATE LOOP
    UPDATE public.so_product_reservations SET reserved_quantity=0,status='released',closed_at=now(),updated_at=now(),close_reason=p_reason WHERE id=r.id;
    INSERT INTO public.so_product_reservation_events(reservation_id,sales_order_id,sales_order_item_id,event_type,quantity_delta,quantity_after,reason,actor_id)
    VALUES(r.id,r.sales_order_id,r.sales_order_item_id,'released',-r.reserved_quantity,0,p_reason,auth.uid());
  END LOOP;
END; $function$
;


-- edit_delivery_challan(p_challan_id uuid, p_new_items jsonb)
CREATE OR REPLACE FUNCTION public.edit_delivery_challan(p_challan_id uuid, p_new_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role       text;
  v_challan    record;
  v_item       jsonb;
  v_count      integer;
  v_product_id uuid;
  v_batch_id   uuid;
  v_new_qty    numeric;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot edit delivery challans', v_role;
  END IF;

  SELECT * INTO v_challan FROM delivery_challans WHERE id = p_challan_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;

  IF v_challan.approved_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot edit approved delivery challan');
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
  END IF;

  -- Suppress the INSERT trigger on delivery_challan_items (safety: DC is pending anyway,
  -- trigger now also guards against non-approved DCs, but be explicit)
  PERFORM set_config('app.skip_dc_item_trigger', 'true', true);

  -- Remove all existing items for this DC
  DELETE FROM delivery_challan_items WHERE challan_id = p_challan_id;

  -- Insert the new item list
  -- No reserved_stock manipulation needed: reservations are in stock_reservations
  -- linked to the SO, not the DC. trg_sync_batch_reserved_stock handles accuracy.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id   := (v_item->>'batch_id')::uuid;
    v_new_qty    := (v_item->>'quantity')::numeric;

    INSERT INTO delivery_challan_items (
      challan_id, product_id, batch_id, quantity,
      pack_size, pack_type, number_of_packs
    ) VALUES (
      p_challan_id, v_product_id, v_batch_id, v_new_qty,
      NULLIF(v_item->>'pack_size', '')::numeric,
      NULLIF(v_item->>'pack_type', ''),
      NULLIF(v_item->>'number_of_packs', '')::integer
    );
  END LOOP;

  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);

  RETURN jsonb_build_object('success', true, 'message', 'Delivery challan updated successfully');

EXCEPTION
  WHEN foreign_key_violation THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', 'Invalid product or batch selection');
  WHEN OTHERS THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$
;


-- fn_cancel_delivery_challan(p_dc_id uuid, p_user uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.fn_cancel_delivery_challan(p_dc_id uuid, p_user uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = COALESCE(auth.uid(), p_user);
  IF v_role IS NULL OR v_role NOT IN ('admin','accounts','warehouse') THEN
    RAISE EXCEPTION 'Not authorized to cancel delivery challans';
  END IF;

  UPDATE delivery_challans
     SET approval_status   = 'cancelled',
         rejection_reason  = COALESCE(p_reason, rejection_reason),
         rejected_by       = COALESCE(p_user, auth.uid()),
         rejected_at       = now(),
         updated_at        = now()
   WHERE id = p_dc_id;
END;
$function$
;


-- fn_reject_delivery_challan(p_dc_id uuid, p_rejector_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.fn_reject_delivery_challan(p_dc_id uuid, p_rejector_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin','accounts','warehouse') THEN
RAISE EXCEPTION 'Permission denied: role % cannot reject delivery challans', v_role;
END IF;

UPDATE delivery_challans
SET approval_status = 'rejected', rejection_reason = p_reason
WHERE id = p_dc_id;
RETURN true;
END;
$function$
;


-- fn_cancel_sales_order(p_so_id uuid, p_canceller_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.fn_cancel_sales_order(p_so_id uuid, p_canceller_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_status text;
BEGIN
  SELECT role INTO v_role
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF v_role NOT IN ('admin', 'accounts', 'sales') THEN
    RAISE EXCEPTION
      'Permission denied: role % cannot cancel sales orders', v_role;
  END IF;

  SELECT status::text INTO v_status
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Order not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.delivery_challans dc
    WHERE dc.sales_order_id = p_so_id
      AND dc.approval_status = 'approved'
  ) THEN
    RAISE EXCEPTION
      'Sales Order has an approved Delivery Challan; reverse/cancel the Delivery Challan before cancelling the order';
  END IF;

  DELETE FROM public.import_requirements
  WHERE sales_order_id = p_so_id;

  PERFORM public.fn_release_stock_reservations(
    p_so_id,
    'SO cancelled: ' || p_reason,
    p_canceller_id
  );

  UPDATE public.sales_orders
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = p_so_id;

  RETURN true;
END;
$function$
;


-- fn_reject_sales_order(p_so_id uuid, p_rejector_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.fn_reject_sales_order(p_so_id uuid, p_rejector_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts') THEN
RAISE EXCEPTION 'Permission denied: role % cannot reject sales orders', v_role;
END IF;

PERFORM fn_release_stock_reservations(p_so_id, 'SO rejected: ' || p_reason);
UPDATE sales_orders
SET status = 'rejected', rejected_by = p_rejector_id, rejected_at = now(),
rejection_reason = p_reason, updated_at = now()
WHERE id = p_so_id;
RETURN true;
END;
$function$
;


-- create_sales_invoice_atomic(p_invoice jsonb, p_items jsonb)
CREATE OR REPLACE FUNCTION public.create_sales_invoice_atomic(p_invoice jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_invoice_id uuid;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_discount numeric := COALESCE((p_invoice->>'discount_amount')::numeric, 0);
  v_stamp numeric := COALESCE((p_invoice->>'stamp_duty_amount')::numeric, 0);
  v_total numeric;
  v_count integer := 0;
  v_item jsonb;
  v_product uuid;
  v_batch uuid;
  v_dc_item uuid;
  v_qty numeric;
  v_price numeric;
  v_rate numeric;
  v_dc record;
  v_linked_challans uuid[];
  v_invoice_so_id uuid := NULLIF(p_invoice->>'sales_order_id','')::uuid;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'sales','warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create sales invoices', v_role;
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sales invoice requires at least one product line';
  END IF;
  IF NULLIF(p_invoice->>'invoice_number','') IS NULL OR NULLIF(p_invoice->>'customer_id','') IS NULL THEN
    RAISE EXCEPTION 'Invoice number and customer are required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_invoices WHERE invoice_number=p_invoice->>'invoice_number') THEN
    RAISE EXCEPTION 'Invoice number already exists';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_product := NULLIF(v_item->>'product_id','')::uuid;
    v_batch := NULLIF(v_item->>'batch_id','')::uuid;
    v_dc_item := NULLIF(v_item->>'delivery_challan_item_id','')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_rate := COALESCE((v_item->>'tax_rate')::numeric, 0);
    IF v_product IS NULL OR v_dc_item IS NULL OR COALESCE(v_qty,0) <= 0 OR COALESCE(v_price,0) < 0 THEN
      RAISE EXCEPTION 'Every invoice line must have a source Delivery Challan item, product, quantity, and price';
    END IF;
    SELECT dci.product_id,dci.batch_id,dci.quantity,dc.customer_id,dc.approval_status,dc.sales_order_id
      INTO v_dc
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id=dci.challan_id
    WHERE dci.id=v_dc_item
    FOR SHARE;
    IF NOT FOUND OR v_dc.product_id IS DISTINCT FROM v_product OR v_dc.batch_id IS DISTINCT FROM v_batch
       OR v_dc.customer_id IS DISTINCT FROM (p_invoice->>'customer_id')::uuid
       OR v_dc.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'Invoice line source Delivery Challan is invalid or not approved';
    END IF;
    IF v_invoice_so_id IS NOT NULL AND v_dc.sales_order_id IS DISTINCT FROM v_invoice_so_id THEN
      RAISE EXCEPTION 'Invoice Sales Order does not match its Delivery Challan source';
    END IF;
    IF v_qty > v_dc.quantity - COALESCE((SELECT sum(sii.quantity) FROM public.sales_invoice_items sii
      WHERE sii.delivery_challan_item_id=v_dc_item),0) THEN
      RAISE EXCEPTION 'Invoice quantity exceeds remaining Delivery Challan quantity';
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
    v_tax := v_tax + (v_qty * v_price * v_rate / 100);
    v_count := v_count + 1;
  END LOOP;
  v_total := v_subtotal + v_tax - v_discount + v_stamp;
  SELECT array_agg(DISTINCT dc.id) INTO v_linked_challans
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id=dci.challan_id
  WHERE dci.id IN (SELECT (value->>'delivery_challan_item_id')::uuid FROM jsonb_array_elements(p_items));
  IF p_invoice ? 'subtotal' AND abs(v_subtotal - (p_invoice->>'subtotal')::numeric) > 0.01
     OR p_invoice ? 'tax_amount' AND abs(v_tax - (p_invoice->>'tax_amount')::numeric) > 0.01
     OR p_invoice ? 'total_amount' AND abs(v_total - (p_invoice->>'total_amount')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'Invoice totals do not match persisted product lines';
  END IF;

  INSERT INTO public.sales_invoices (
    invoice_number,customer_id,sales_order_id,invoice_date,due_date,discount_amount,
    delivery_challan_number,po_number,payment_terms_days,notes,subtotal,tax_amount,
    stamp_duty_amount,total_amount,payment_status,created_by,linked_challan_ids
  ) VALUES (
    p_invoice->>'invoice_number',(p_invoice->>'customer_id')::uuid,v_invoice_so_id,
    COALESCE((p_invoice->>'invoice_date')::date,CURRENT_DATE),(p_invoice->>'due_date')::date,v_discount,
    NULL,p_invoice->>'po_number',(p_invoice->>'payment_terms_days')::integer,p_invoice->>'notes',
    v_subtotal,v_tax,v_stamp,v_total,'pending',COALESCE(NULLIF(p_invoice->>'created_by','')::uuid,auth.uid()),
    COALESCE(v_linked_challans, CASE WHEN jsonb_typeof(p_invoice->'linked_challan_ids')='array' THEN
      ARRAY(SELECT jsonb_array_elements_text(p_invoice->'linked_challan_ids')::uuid) ELSE NULL END)
  ) RETURNING id INTO v_invoice_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.sales_invoice_items
      (invoice_id,product_id,batch_id,quantity,unit_price,tax_rate,delivery_challan_item_id)
    VALUES (v_invoice_id,(v_item->>'product_id')::uuid,NULLIF(v_item->>'batch_id','')::uuid,
      (v_item->>'quantity')::numeric,(v_item->>'unit_price')::numeric,
      COALESCE((v_item->>'tax_rate')::numeric,0),(v_item->>'delivery_challan_item_id')::uuid);
  END LOOP;

  IF (SELECT count(*) FROM public.sales_invoice_items WHERE invoice_id=v_invoice_id) <> v_count THEN
    RAISE EXCEPTION 'Invoice line count verification failed';
  END IF;
  RETURN v_invoice_id;
END;
$function$
;


-- update_sales_invoice_atomic(p_invoice_id uuid, p_invoice_updates jsonb, p_new_items jsonb[])
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(p_invoice_id uuid, p_invoice_updates jsonb, p_new_items jsonb[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_old_je_id uuid;
  v_result uuid;
  v_dc_item_ids uuid[];
  v_linked_challan_ids text[];
  v_sales_order_ids uuid[];
  v_customer_ids uuid[];
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  SELECT array_agg(DISTINCT NULLIF(item->>'delivery_challan_item_id', '')::uuid)
  INTO v_dc_item_ids
  FROM unnest(p_new_items) AS item;

  IF v_dc_item_ids IS NULL OR cardinality(v_dc_item_ids) = 0 THEN
    RAISE EXCEPTION 'Sales Invoice must contain Delivery Challan-linked items';
  END IF;

  IF array_length(v_dc_item_ids, 1) <> (
    SELECT count(*) FROM public.delivery_challan_items WHERE id = ANY(v_dc_item_ids)
  ) THEN
    RAISE EXCEPTION 'Sales Invoice contains a missing Delivery Challan item';
  END IF;

  SELECT
    array_agg(DISTINCT dc.id::text ORDER BY dc.id::text),
    array_agg(DISTINCT dc.sales_order_id),
    array_agg(DISTINCT dc.customer_id)
  INTO v_linked_challan_ids, v_sales_order_ids, v_customer_ids
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.id = ANY(v_dc_item_ids);

  IF cardinality(v_customer_ids) <> 1
     OR (p_invoice_updates ? 'customer_id'
         AND (p_invoice_updates->>'customer_id')::uuid IS DISTINCT FROM v_customer_ids[1]) THEN
    RAISE EXCEPTION 'Invoice customer must match all linked Delivery Challans';
  END IF;

  SELECT journal_entry_id INTO v_old_je_id
  FROM public.sales_invoices
  WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Invoice % not found', p_invoice_id;
  END IF;

  -- Remove old revenue journal entry
  IF v_old_je_id IS NOT NULL THEN
    UPDATE public.sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM public.journal_entries WHERE id = v_old_je_id;
  END IF;

  -- Remove old COGS journal entry so COGS is cleanly regenerated for updated items
  DELETE FROM public.journal_entry_lines
   WHERE journal_entry_id IN (
     SELECT id FROM public.journal_entries
      WHERE source_module = 'sales_invoice_cogs' AND reference_id = p_invoice_id
   );
  DELETE FROM public.journal_entries
   WHERE source_module = 'sales_invoice_cogs' AND reference_id = p_invoice_id;

  -- Delete old sales invoice items
  DELETE FROM public.sales_invoice_items WHERE invoice_id = p_invoice_id;
  PERFORM set_config('app.sales_invoice_rebuild', 'true', true);

  UPDATE public.sales_invoices
  SET
    invoice_date       = COALESCE((p_invoice_updates->>'invoice_date')::date, invoice_date),
    due_date           = COALESCE((p_invoice_updates->>'due_date')::date, due_date),
    customer_id        = v_customer_ids[1],
    sales_order_id     = CASE WHEN cardinality(v_sales_order_ids) = 1 THEN v_sales_order_ids[1] ELSE NULL END,
    subtotal           = COALESCE((p_invoice_updates->>'subtotal')::numeric, subtotal),
    tax_amount         = COALESCE((p_invoice_updates->>'tax_amount')::numeric, tax_amount),
    total_amount       = COALESCE((p_invoice_updates->>'total_amount')::numeric, total_amount),
    discount_amount    = COALESCE((p_invoice_updates->>'discount_amount')::numeric, discount_amount),
    stamp_duty_amount  = COALESCE((p_invoice_updates->>'stamp_duty_amount')::numeric, stamp_duty_amount),
    po_number          = COALESCE(p_invoice_updates->>'po_number', po_number),
    payment_terms_days = COALESCE((p_invoice_updates->>'payment_terms_days')::integer, payment_terms_days),
    notes              = COALESCE(p_invoice_updates->>'notes', notes),
    linked_challan_ids = v_linked_challan_ids,
    updated_at         = now()
  WHERE id = p_invoice_id
  RETURNING id INTO v_result;

  INSERT INTO public.sales_invoice_items (
    invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id
  )
  SELECT
    p_invoice_id,
    (item->>'product_id')::uuid,
    NULLIF(item->>'batch_id', '')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'tax_rate')::numeric,
    NULLIF(item->>'delivery_challan_item_id', '')::uuid
  FROM unnest(p_new_items) AS item;

  PERFORM set_config('app.sales_invoice_rebuild', 'false', true);
  UPDATE public.sales_invoices SET updated_at = now()
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  RETURN v_result;
END;
$function$
;


-- update_sales_invoice_atomic(p_invoice_id uuid, p_invoice_updates jsonb, p_items jsonb, p_user_id uuid)
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(p_invoice_id uuid, p_invoice_updates jsonb, p_items jsonb, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_result uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_result := public.update_sales_invoice_atomic(
    p_invoice_id,
    p_invoice_updates,
    ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
      )
    )::jsonb[]
  );

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'journal_entry_id', (SELECT journal_entry_id FROM sales_invoices WHERE id = p_invoice_id),
    'result_id', v_result,
    'user_id', p_user_id
  );
END;
$function$
;


-- accept_document_extraction_atomic(p_document_id uuid, p_actor_id uuid, p_apply_to_request_id uuid)
CREATE OR REPLACE FUNCTION public.accept_document_extraction_atomic(p_document_id uuid, p_actor_id uuid, p_apply_to_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc public.crm_product_documents%ROWTYPE;
  v_extraction JSONB;
  v_status TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Lock the document row
  SELECT * INTO v_doc
  FROM public.crm_product_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND: Document % not found', p_document_id;
  END IF;

  v_extraction := v_doc.ai_extraction;
  IF v_extraction IS NULL THEN
    RAISE EXCEPTION 'NO_EXTRACTION: No AI extraction exists for document %', p_document_id;
  END IF;

  v_status := v_extraction->>'status';
  IF v_status IN ('accepted', 'dismissed') THEN
    RAISE EXCEPTION 'DOCUMENT_ALREADY_PROCESSED: Extraction for document % has already been reviewed (status: %)', p_document_id, v_status;
  END IF;

  -- If request linking is requested, associate document with the request if not already linked
  IF p_apply_to_request_id IS NOT NULL THEN
    UPDATE public.crm_product_documents
    SET enquiry_request_id = p_apply_to_request_id
    WHERE id = p_document_id AND enquiry_request_id IS NULL;
  END IF;

  -- Update extraction status to accepted, recording human reviewer and timestamp
  UPDATE public.crm_product_documents
  SET ai_extraction = jsonb_set(
    jsonb_set(
      jsonb_set(
        v_extraction,
        '{status}',
        '"accepted"'::jsonb
      ),
      '{reviewed_by}',
      to_jsonb(p_actor_id::text)
    ),
    '{reviewed_at}',
    to_jsonb(v_now::text)
  )
  WHERE id = p_document_id;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'status', 'accepted',
    'reviewed_at', v_now
  );
END;
$function$
;


-- dismiss_document_extraction_atomic(p_document_id uuid, p_actor_id uuid)
CREATE OR REPLACE FUNCTION public.dismiss_document_extraction_atomic(p_document_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc public.crm_product_documents%ROWTYPE;
  v_extraction JSONB;
  v_status TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Lock the document row
  SELECT * INTO v_doc
  FROM public.crm_product_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND: Document % not found', p_document_id;
  END IF;

  v_extraction := v_doc.ai_extraction;
  IF v_extraction IS NULL THEN
    RAISE EXCEPTION 'NO_EXTRACTION: No AI extraction exists for document %', p_document_id;
  END IF;

  v_status := v_extraction->>'status';
  IF v_status IN ('accepted', 'dismissed') THEN
    RAISE EXCEPTION 'DOCUMENT_ALREADY_PROCESSED: Extraction for document % has already been reviewed (status: %)', p_document_id, v_status;
  END IF;

  UPDATE public.crm_product_documents
  SET ai_extraction = jsonb_set(
    jsonb_set(
      jsonb_set(
        v_extraction,
        '{status}',
        '"dismissed"'::jsonb
      ),
      '{dismissed_by}',
      to_jsonb(p_actor_id::text)
    ),
    '{dismissed_at}',
    to_jsonb(v_now::text)
  )
  WHERE id = p_document_id;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'status', 'dismissed',
    'dismissed_at', v_now
  );
END;
$function$
;


-- edit_document_extraction_atomic(p_document_id uuid, p_actor_id uuid, p_edited_values jsonb)
CREATE OR REPLACE FUNCTION public.edit_document_extraction_atomic(p_document_id uuid, p_actor_id uuid, p_edited_values jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc public.crm_product_documents%ROWTYPE;
  v_extraction JSONB;
  v_status TEXT;
  v_original JSONB;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Lock the document row
  SELECT * INTO v_doc
  FROM public.crm_product_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND: Document % not found', p_document_id;
  END IF;

  v_extraction := v_doc.ai_extraction;
  IF v_extraction IS NULL THEN
    RAISE EXCEPTION 'NO_EXTRACTION: No AI extraction exists for document %', p_document_id;
  END IF;

  v_status := v_extraction->>'status';
  IF v_status IN ('accepted', 'dismissed') THEN
    RAISE EXCEPTION 'DOCUMENT_ALREADY_PROCESSED: Extraction for document % has already been reviewed (status: %)', p_document_id, v_status;
  END IF;

  -- Preserve original extraction if not already preserved
  v_original := COALESCE(v_extraction->'original_extraction', v_extraction);

  -- Update with human edits
  UPDATE public.crm_product_documents
  SET ai_extraction = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            v_extraction,
            '{status}',
            '"edited"'::jsonb
          ),
          '{reviewed_by}',
          to_jsonb(p_actor_id::text)
        ),
        '{reviewed_at}',
        to_jsonb(v_now::text)
      ),
      '{edited_values}',
      p_edited_values
    ),
    '{original_extraction}',
    v_original
  )
  WHERE id = p_document_id;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'status', 'edited',
    'reviewed_at', v_now
  );
END;
$function$
;


-- create_system_task(p_title text, p_description text, p_deadline timestamp with time zone, p_origin text, p_reference_type text, p_reference_id uuid, p_assigned_role text, p_priority text, p_customer_id uuid, p_product_id uuid)
CREATE OR REPLACE FUNCTION public.create_system_task(p_title text, p_description text, p_deadline timestamp with time zone, p_origin text, p_reference_type text, p_reference_id uuid, p_assigned_role text, p_priority text DEFAULT NULL::text, p_customer_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
v_task_id uuid;
v_assigned_users uuid[];
v_auto_priority text;
v_creator_id uuid;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts') THEN
RAISE EXCEPTION 'Permission denied: role % cannot create system tasks', v_role;
END IF;

v_assigned_users := get_users_by_role(p_assigned_role);
v_auto_priority  := COALESCE(p_priority, calculate_task_priority(p_deadline));

SELECT id INTO v_creator_id FROM user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;
IF v_creator_id IS NULL THEN
SELECT id INTO v_creator_id FROM user_profiles WHERE is_active = true LIMIT 1;
END IF;

INSERT INTO tasks (
title, description, deadline, priority, auto_priority, status,
task_type, task_mode, task_origin, reference_type, reference_id,
auto_assigned_role, assigned_users, customer_id, product_id, created_by, proof_required
) VALUES (
p_title, p_description, p_deadline, v_auto_priority::task_priority, v_auto_priority, 'to_do'::task_status,
'system', 'advisory', p_origin, p_reference_type, p_reference_id,
p_assigned_role, v_assigned_users, p_customer_id, p_product_id, v_creator_id, false
)
RETURNING id INTO v_task_id;

IF array_length(v_assigned_users, 1) > 0 THEN
INSERT INTO task_assignments (task_id, assigned_user_id, assigned_by)
SELECT v_task_id, unnest(v_assigned_users), v_creator_id;
END IF;

RETURN v_task_id;
END;
$function$
;


-- create_system_task(p_title text, p_description text, p_deadline timestamp with time zone, p_priority task_priority, p_assigned_users uuid[], p_task_origin task_origin_enum, p_sales_order_id uuid, p_customer_id uuid, p_product_id uuid, p_tags text[], p_metadata jsonb)
CREATE OR REPLACE FUNCTION public.create_system_task(p_title text, p_description text, p_deadline timestamp with time zone, p_priority task_priority, p_assigned_users uuid[], p_task_origin task_origin_enum, p_sales_order_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_tags text[] DEFAULT ARRAY[]::text[], p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
v_task_id uuid;
v_system_user uuid;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts') THEN
RAISE EXCEPTION 'Permission denied: role % cannot create system tasks', v_role;
END IF;

SELECT id INTO v_system_user FROM user_profiles WHERE role = 'admin' LIMIT 1;
IF v_system_user IS NULL THEN
v_system_user := auth.uid();
END IF;

INSERT INTO tasks (
title, description, deadline, priority, status, created_by, assigned_users,
task_type, task_mode, task_origin, sales_order_id, customer_id, product_id,
tags, auto_priority, system_metadata
) VALUES (
p_title, p_description, p_deadline, p_priority, 'to_do', v_system_user, p_assigned_users,
'system', 'advisory', p_task_origin, p_sales_order_id, p_customer_id, p_product_id,
array_append(p_tags, 'system-generated'), true, p_metadata
)
RETURNING id INTO v_task_id;

RETURN v_task_id;
END;
$function$
;


-- dismiss_system_task(p_task_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.dismiss_system_task(p_task_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts') THEN
RAISE EXCEPTION 'Permission denied: role % cannot dismiss system tasks', v_role;
END IF;

UPDATE tasks
SET dismissed_at = now(), dismissed_by = auth.uid(), dismissal_reason = p_reason,
status = 'completed'::task_status
WHERE id = p_task_id AND task_type = 'system' AND task_mode = 'advisory';
RETURN FOUND;
END;
$function$
;


-- get_next_product_code()
CREATE OR REPLACE FUNCTION public.get_next_product_code()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_max_code text;
  v_next_num integer;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot generate product codes', v_role;
  END IF;

  SELECT MAX(product_code) INTO v_max_code
  FROM products
  WHERE product_code ~ '^[A-Z]{2,4}-[0-9]+$';

  IF v_max_code IS NULL THEN RETURN 'PRD-001'; END IF;
  v_next_num := (regexp_match(v_max_code, '[0-9]+$'))[1]::integer + 1;
  RETURN regexp_replace(v_max_code, '[0-9]+$', LPAD(v_next_num::text, 3, '0'));
END;
$function$
;


-- check_inquiry_requirements_fulfilled(inquiry_id uuid)
CREATE OR REPLACE FUNCTION public.check_inquiry_requirements_fulfilled(inquiry_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
inquiry_record RECORD;
all_fulfilled boolean;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts', 'sales') THEN
RAISE EXCEPTION 'Permission denied: role % cannot check inquiry requirements', v_role;
END IF;

SELECT * INTO inquiry_record FROM crm_inquiries WHERE id = inquiry_id;

IF NOT FOUND THEN
RETURN false;
END IF;

all_fulfilled := (
(NOT inquiry_record.price_required OR inquiry_record.price_sent_at IS NOT NULL) AND
(NOT inquiry_record.coa_required OR inquiry_record.coa_sent_at IS NOT NULL) AND
(NOT inquiry_record.sample_required OR inquiry_record.sample_sent_at IS NOT NULL) AND
(NOT inquiry_record.agency_letter_required OR inquiry_record.agency_letter_sent_at IS NOT NULL)
);

RETURN all_fulfilled;
END;
$function$
;


-- calculate_rejection_financial_loss(p_rejection_id uuid)
CREATE OR REPLACE FUNCTION public.calculate_rejection_financial_loss(p_rejection_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
v_loss decimal;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts', 'warehouse') THEN
RAISE EXCEPTION 'Permission denied: role % cannot calculate rejection financial loss', v_role;
END IF;

SELECT sr.quantity * b.purchase_price INTO v_loss
FROM stock_rejections sr
JOIN batches b ON b.id = sr.batch_id
WHERE sr.id = p_rejection_id;

RETURN COALESCE(v_loss, 0);
END;
$function$
;


-- calculate_return_financial_impact(p_return_id uuid)
CREATE OR REPLACE FUNCTION public.calculate_return_financial_impact(p_return_id uuid)
 RETURNS TABLE(total_value numeric, total_quantity numeric, product_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts', 'warehouse') THEN
RAISE EXCEPTION 'Permission denied: role % cannot calculate return financial impact', v_role;
END IF;

RETURN QUERY
SELECT
SUM(mri.quantity_returned * mri.unit_price) AS total_value,
SUM(mri.quantity_returned) AS total_quantity,
COUNT(DISTINCT mri.product_id)::integer AS product_count
FROM material_return_items mri
WHERE mri.return_id = p_return_id;
END;
$function$
;


-- generate_tax_notifications()
CREATE OR REPLACE FUNCTION public.generate_tax_notifications()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user record;
  v_row record;
  v_count int := 0;
  v_today date := CURRENT_DATE;
  v_upcoming_cutoff date := CURRENT_DATE + 7;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  FOR v_user IN
    SELECT id FROM user_profiles
    WHERE is_active = true AND role IN ('admin','accounts')
  LOOP
    -- Overdue tax payments
    FOR v_row IN
      SELECT tax_period_id, tax_type, payment_due_date, outstanding_amount
      FROM vw_outstanding_tax
      WHERE payment_due_date < v_today AND outstanding_amount > 0
    LOOP
      -- Insert directly: we're SECURITY DEFINER so RLS is bypassed. This
      -- also side-steps upsert_notification's "only admins may notify other
      -- users" rule which would fire when a manager triggers this RPC.
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      SELECT v_user.id, 'tax_overdue',
             v_row.tax_type || ' payment overdue',
             format('Rp %s outstanding, due %s',
               to_char(v_row.outstanding_amount, 'FM999G999G999G999D00'),
               to_char(v_row.payment_due_date, 'DD Mon YYYY')),
             v_row.tax_period_id, 'tax_period', false
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = v_user.id
          AND type = 'tax_overdue'
          AND reference_id = v_row.tax_period_id
          AND is_read = false
      );
      v_count := v_count + 1;
    END LOOP;

    -- Upcoming tax payments (next 7 days)
    FOR v_row IN
      SELECT tax_period_id, tax_type, payment_due_date, outstanding_amount
      FROM vw_outstanding_tax
      WHERE payment_due_date BETWEEN v_today AND v_upcoming_cutoff
        AND outstanding_amount > 0
    LOOP
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      SELECT v_user.id, 'tax_due_soon',
             v_row.tax_type || ' payment due',
             format('Rp %s due on %s',
               to_char(v_row.outstanding_amount, 'FM999G999G999G999D00'),
               to_char(v_row.payment_due_date, 'DD Mon YYYY')),
             v_row.tax_period_id, 'tax_period', false
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = v_user.id
          AND type = 'tax_due_soon'
          AND reference_id = v_row.tax_period_id
          AND is_read = false
      );
      v_count := v_count + 1;
    END LOOP;

    -- Missing Faktur Pajak on open PPN periods
    FOR v_row IN
      SELECT id AS tax_period_id, fiscal_year, period_month, missing_faktur_count
      FROM vw_tax_period_status
      WHERE tax_type = 'PPN' AND status <> 'closed' AND missing_faktur_count > 0
    LOOP
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
      SELECT v_user.id, 'faktur_missing',
             'Waiting for Faktur',
             format('%s sales invoice(s) in %s-%s need a Faktur Pajak number',
               v_row.missing_faktur_count,
               v_row.fiscal_year,
               lpad(v_row.period_month::text, 2, '0')),
             v_row.tax_period_id, 'tax_period', false
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = v_user.id
          AND type = 'faktur_missing'
          AND reference_id = v_row.tax_period_id
          AND is_read = false
      );
      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  RETURN v_count;
END $function$
;


-- log_timeline_event(p_inquiry_id uuid, p_event_type text, p_event_title text, p_event_description text, p_old_value text, p_new_value text, p_performed_by uuid)
CREATE OR REPLACE FUNCTION public.log_timeline_event(p_inquiry_id uuid, p_event_type text, p_event_title text, p_event_description text DEFAULT NULL::text, p_old_value text DEFAULT NULL::text, p_new_value text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_role text;
new_timeline_id uuid;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts', 'sales') THEN
RAISE EXCEPTION 'Permission denied: role % cannot log timeline events', v_role;
END IF;

INSERT INTO crm_inquiry_timeline (
inquiry_id, event_type, event_title, event_description,
old_value, new_value, performed_by
) VALUES (
p_inquiry_id, p_event_type, p_event_title, p_event_description,
p_old_value, p_new_value,
COALESCE(p_performed_by, auth.uid())
) RETURNING id INTO new_timeline_id;

RETURN new_timeline_id;
END;
$function$
;


-- fn_safe_autolink_dc_to_so()
CREATE OR REPLACE FUNCTION public.fn_safe_autolink_dc_to_so()
 RETURNS TABLE(dc_id uuid, linked_so_id uuid, action text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
dc_rec          RECORD;
candidate_so_id uuid;
match_count     int;
v_role          text;
BEGIN
SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
IF v_role NOT IN ('admin', 'accounts') THEN
RAISE EXCEPTION 'Permission denied: role % cannot auto-link challans', v_role;
END IF;

FOR dc_rec IN
SELECT dc.id, dc.customer_id FROM delivery_challans dc
WHERE dc.sales_order_id IS NULL
AND (dc.review_status IS NULL OR dc.review_status != 'needs_review')
LOOP
SELECT COUNT(DISTINCT so.id) INTO match_count
FROM sales_orders so
WHERE so.customer_id = dc_rec.customer_id AND so.is_archived = false
AND so.status NOT IN ('draft','cancelled','rejected')
AND NOT EXISTS (
SELECT 1 FROM delivery_challan_items dci
WHERE dci.challan_id = dc_rec.id
AND NOT EXISTS (
SELECT 1 FROM sales_order_items soi
WHERE soi.sales_order_id = so.id AND soi.product_id = dci.product_id
AND soi.quantity >= dci.quantity
)
)
AND EXISTS (SELECT 1 FROM delivery_challan_items dci2 WHERE dci2.challan_id = dc_rec.id);

IF match_count = 1 THEN
SELECT so.id INTO candidate_so_id
FROM sales_orders so
WHERE so.customer_id = dc_rec.customer_id AND so.is_archived = false
AND so.status NOT IN ('draft','cancelled','rejected')
AND NOT EXISTS (
SELECT 1 FROM delivery_challan_items dci
WHERE dci.challan_id = dc_rec.id
AND NOT EXISTS (
SELECT 1 FROM sales_order_items soi
WHERE soi.sales_order_id = so.id AND soi.product_id = dci.product_id
AND soi.quantity >= dci.quantity
)
)
AND EXISTS (SELECT 1 FROM delivery_challan_items dci2 WHERE dci2.challan_id = dc_rec.id)
LIMIT 1;

UPDATE delivery_challans SET sales_order_id = candidate_so_id, updated_at = now()
WHERE id = dc_rec.id;
dc_id := dc_rec.id; linked_so_id := candidate_so_id; action := 'linked';
RETURN NEXT;
ELSE
UPDATE delivery_challans SET review_status = 'needs_review', updated_at = now()
WHERE id = dc_rec.id AND sales_order_id IS NULL;
dc_id := dc_rec.id; linked_so_id := NULL; action := 'needs_review';
RETURN NEXT;
END IF;
END LOOP;
END;
$function$
;

-- ============================================================================
-- 7. Clean remaining manager references in CRM, Sourcing & Reservation functions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_release_reservation_by_so_id(p_so_id uuid, p_released_by uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for reservation release';
  END IF;

  UPDATE public.stock_reservations
  SET status = 'released',
      is_released = true,
      released_at = now(),
      released_by = COALESCE(p_released_by, auth.uid()),
      release_reason = COALESCE(
        release_reason,
        'Canonical Sales Order reservation release'
      )
  WHERE sales_order_id = p_so_id
    AND status = 'active';

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_create_appointment_followup()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role NOT IN ('admin', 'accounts', 'sales') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create appointment follow-ups', v_role;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_create_followup(p_inquiry_id uuid, p_action_type text, p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  rule_record RECORD;
  new_reminder_id uuid;
  due_date timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role NOT IN ('admin', 'accounts', 'sales') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create follow-ups', v_role;
  END IF;

  SELECT * INTO rule_record
  FROM crm_automation_rules
  WHERE is_active = true
    AND trigger_on = 'action_performed'
    AND trigger_action = p_action_type
    AND auto_create_followup = true
  ORDER BY priority DESC
  LIMIT 1;

  IF rule_record IS NOT NULL THEN
    due_date := now() + (rule_record.followup_days_offset || ' days')::interval;

    INSERT INTO crm_reminders (
      inquiry_id, reminder_type, title, due_date, assigned_to, created_by
    ) VALUES (
      p_inquiry_id, rule_record.followup_type, rule_record.followup_title,
      due_date, COALESCE(p_user_id, auth.uid()), auth.uid()
    ) RETURNING id INTO new_reminder_id;

    RETURN new_reminder_id;
  END IF;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_final_quote_write_restriction()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role
  FROM user_profiles
  WHERE id = auth.uid()
    AND is_active = true;

  IF caller_role NOT IN ('admin') THEN
    IF (
      NEW.final_quote_price      IS DISTINCT FROM OLD.final_quote_price      OR
      NEW.final_quote_currency   IS DISTINCT FROM OLD.final_quote_currency   OR
      NEW.final_entered_by       IS DISTINCT FROM OLD.final_entered_by       OR
      NEW.final_entered_at       IS DISTINCT FROM OLD.final_entered_at
    ) THEN
      RAISE EXCEPTION
        'Permission denied: only admin may update final quote fields. '
        'Your role (%) cannot change final_quote_price, final_quote_currency, '
        'final_entered_by, or final_entered_at.',
        COALESCE(caller_role, 'unknown');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_release_partial_reservation(p_so_id uuid, p_product_id uuid, p_qty numeric, p_released_by uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reservation record;
  v_remaining_qty numeric := p_qty;
  v_release_qty numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.inventory_v1_actor_allowed(
    ARRAY['admin', 'accounts', 'warehouse']
  ) THEN
    RAISE EXCEPTION 'Permission denied for partial reservation release';
  END IF;
  IF COALESCE(p_qty, 0) <= 0 THEN
    RAISE EXCEPTION 'Reservation release quantity must be positive';
  END IF;

  FOR v_reservation IN
    SELECT id, reserved_quantity
    FROM public.stock_reservations
    WHERE sales_order_id = p_so_id
      AND product_id = p_product_id
      AND status = 'active'
    ORDER BY reserved_at, id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_qty <= 0;
    v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);

    IF v_release_qty = v_reservation.reserved_quantity THEN
      UPDATE public.stock_reservations
      SET status = 'released',
          is_released = true,
          released_at = now(),
          released_by = COALESCE(p_released_by, auth.uid()),
          release_reason = 'Canonical partial reservation release'
      WHERE id = v_reservation.id;
    ELSE
      UPDATE public.stock_reservations
      SET reserved_quantity = reserved_quantity - v_release_qty
      WHERE id = v_reservation.id;
    END IF;

    v_remaining_qty := v_remaining_qty - v_release_qty;
  END LOOP;

  IF v_remaining_qty > 0 THEN
    RAISE EXCEPTION 'Reservation release exceeds active reserved quantity by %',
      v_remaining_qty;
  END IF;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_price_request_counts(p_pr_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_total    integer;
  v_src_recv integer;
  v_src_pend integer;
  v_fq_ready integer;
  v_fq_pend  integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role NOT IN ('admin', 'sales', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot recompute price request counts', v_role;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE price_status = 'received'),
    COUNT(*) FILTER (WHERE price_status IN ('pending', 'requested')),
    COUNT(*) FILTER (WHERE final_quote_price IS NOT NULL),
    COUNT(*) FILTER (WHERE price_status = 'received' AND final_quote_price IS NULL)
  INTO v_total, v_src_recv, v_src_pend, v_fq_ready, v_fq_pend
  FROM price_request_items
  WHERE price_request_id = p_pr_id;

  UPDATE price_requests
  SET
    total_products        = v_total,
    source_price_received = v_src_recv,
    source_price_pending  = v_src_pend,
    final_quote_ready     = v_fq_ready,
    final_quote_pending   = v_fq_pend,
    updated_at            = now()
  WHERE id = p_pr_id;
END;
$function$;
