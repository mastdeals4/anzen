/*
  Restore allocate_existing_cash_event on the historical-repair RPC.

  Phase 5G replaced the function with AP-only reclassification. This keeps
  that operation and restores allocation-only linking of an already-posted
  cash journal. It does not create, reverse, or rewrite journals.
*/
BEGIN;

ALTER TABLE public.finance_historical_repair_commands
  DROP CONSTRAINT IF EXISTS finance_historical_repair_commands_document_type_check;
ALTER TABLE public.finance_historical_repair_commands
  ADD CONSTRAINT finance_historical_repair_commands_document_type_check
  CHECK (document_type = ANY (ARRAY[
    'expense','payment','receipt','tax_payment','fund_transfer','petty_cash','journal'
  ]));

CREATE OR REPLACE FUNCTION public.historical_repair_context_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE(current_setting('app.finance_historical_repair','true'),'off')='on'
     AND EXISTS (
       SELECT 1 FROM public.finance_historical_repair_commands c
       WHERE c.id::text=current_setting('app.finance_historical_repair_command','true')
         AND (
           current_user IN ('postgres','supabase_admin')
           OR (auth.role()='service_role' AND c.requested_by IS NULL)
           OR c.requested_by=auth.uid()
         )
     )
     AND (
       current_user IN ('postgres','supabase_admin')
       OR auth.role()='service_role'
       OR EXISTS (
         SELECT 1 FROM public.user_profiles up
         WHERE up.id=auth.uid() AND up.is_active=true AND up.role='admin'
       )
     );
$$;

CREATE OR REPLACE FUNCTION public.sync_bank_line_from_allocation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_old_line uuid;
  v_new_line uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_line := OLD.bank_statement_line_id;
    PERFORM public.sync_bank_line_allocation_owner(v_old_line);
    PERFORM public.refresh_bank_statement_allocation_status(v_old_line);
    IF NOT public.historical_repair_context_active() THEN
      IF OLD.document_type = 'expense' AND EXISTS (
        SELECT 1 FROM public.finance_expenses WHERE id = OLD.document_id
      ) THEN
        PERFORM public.recalculate_expense_payment_state(OLD.document_id);
      ELSIF OLD.document_type = 'tax_payment' THEN
        UPDATE public.tax_payments
           SET status = 'posted'
         WHERE id = OLD.document_id
           AND NOT EXISTS (
             SELECT 1 FROM public.bank_statement_allocations
              WHERE document_type = 'tax_payment' AND document_id = OLD.document_id
           );
      END IF;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_line := NEW.bank_statement_line_id;
    IF v_new_line IS DISTINCT FROM v_old_line THEN
      PERFORM public.sync_bank_line_allocation_owner(v_new_line);
      PERFORM public.refresh_bank_statement_allocation_status(v_new_line);
    END IF;
    IF NOT public.historical_repair_context_active() THEN
      IF NEW.document_type = 'expense' AND EXISTS (
        SELECT 1 FROM public.finance_expenses WHERE id = NEW.document_id
      ) THEN
        PERFORM public.recalculate_expense_payment_state(NEW.document_id);
      ELSIF NEW.document_type = 'tax_payment' THEN
        UPDATE public.tax_payments SET status = 'reconciled' WHERE id = NEW.document_id;
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_expense_from_bank_allocation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_old_expense uuid; v_new_expense uuid; v_old_date date; v_new_date date; v_fallback date;
BEGIN
  IF public.historical_repair_context_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.document_type='expense' THEN
    v_old_expense:=OLD.document_id;
    SELECT transaction_date INTO v_old_date FROM public.bank_statement_lines WHERE id=OLD.bank_statement_line_id;
    PERFORM public.recalculate_expense_payment_state(v_old_expense);
    IF EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=v_old_expense AND (COALESCE(pph_amount,0)>0 OR COALESCE(pib_pph_amount,0)>0 OR expense_category='pph_import')) THEN
      PERFORM public.recompute_pph_periods_for_date(v_old_date);
      PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(v_old_expense));
      SELECT COALESCE(due_date,expense_date) INTO v_fallback FROM public.finance_expenses WHERE id=v_old_expense;
      PERFORM public.recompute_pph_periods_for_date(v_fallback);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.document_type='expense' THEN
    v_new_expense:=NEW.document_id;
    SELECT transaction_date INTO v_new_date FROM public.bank_statement_lines WHERE id=NEW.bank_statement_line_id;
    PERFORM public.recalculate_expense_payment_state(v_new_expense);
    IF EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=v_new_expense AND (COALESCE(pph_amount,0)>0 OR COALESCE(pib_pph_amount,0)>0 OR expense_category='pph_import')) THEN
      PERFORM public.recompute_pph_periods_for_date(v_new_date);
      PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(v_new_expense));
      SELECT COALESCE(due_date,expense_date) INTO v_fallback FROM public.finance_expenses WHERE id=v_new_expense;
      PERFORM public.recompute_pph_periods_for_date(v_fallback);
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_historical_finance_repair(
  p_idempotency_key text,
  p_document_type text,
  p_document_id uuid,
  p_bank_statement_line_id uuid,
  p_allocation_amount numeric,
  p_expected jsonb,
  p_payment_kind text DEFAULT 'supplier',
  p_operation text DEFAULT 'allocate_existing_cash_event'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_existing public.finance_historical_repair_commands%rowtype;
  v_cmd uuid;
  v_je uuid;
  v_source_je uuid;
  v_reversal_je uuid;
  v_ap_je uuid;
  v_source_amount numeric;
  v_settlement numeric;
  v_bank_amount numeric;
  v_bank_coa uuid;
  v_ap_coa uuid;
  v_cash_lines integer;
  v_cash_credit numeric;
  v_bank_gl_debit numeric;
  v_bank_gl_credit numeric;
  v_line_debit numeric;
  v_is_debit boolean;
  v_je_balanced boolean;
  v_acct_ccy text;
  v_line_ccy text;
  v_je_ccy text;
  v_before jsonb;
  v_after jsonb;
  v_je_before jsonb;
  v_alloc public.bank_statement_allocations%rowtype;
  v_entry text;
  v_line record;
  v_line_no integer;
BEGIN
  IF auth.role()<>'service_role'
     AND current_user NOT IN ('postgres','supabase_admin')
     AND NOT EXISTS (SELECT 1 FROM public.user_profiles
      WHERE id=auth.uid() AND is_active=true AND role='admin') THEN
    RAISE EXCEPTION 'Historical repair requires service_role or admin';
  END IF;
  IF NULLIF(trim(p_idempotency_key),'') IS NULL OR p_allocation_amount<=0 THEN
    RAISE EXCEPTION 'Idempotency key and positive allocation amount are required';
  END IF;
  SELECT * INTO v_existing FROM public.finance_historical_repair_commands
   WHERE idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('idempotent',true,'command_id',v_existing.id,
      'allocation_id',v_existing.created_allocation_id,'before',v_existing.before_state,
      'after',v_existing.after_state);
  END IF;
  IF p_payment_kind NOT IN ('supplier','pph23') THEN
    RAISE EXCEPTION 'Unsupported payment kind';
  END IF;

  IF p_operation='reclassify_cash_recognition_to_ap' THEN
    IF p_document_type <> 'expense' OR p_bank_statement_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'AP reclassification requires an expense and no bank evidence';
    END IF;
    INSERT INTO public.finance_historical_repair_commands(
      idempotency_key,document_type,document_id,bank_statement_line_id,payment_kind,
      operation,requested_by,before_state,after_state,status)
    VALUES(p_idempotency_key,p_document_type,p_document_id,NULL,p_payment_kind,
      p_operation,auth.uid(),'{}','{}','committed') RETURNING id INTO v_cmd;
    PERFORM set_config('app.finance_historical_repair_command',v_cmd::text,true);
    PERFORM set_config('app.finance_historical_repair','on',true);

    PERFORM 1 FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing expense source'; END IF;
    SELECT settlement_amount,paid_amount INTO v_settlement,v_source_amount
      FROM public.finance_expenses WHERE id=p_document_id;
    IF COALESCE(v_source_amount,0)<>0 THEN RAISE EXCEPTION 'Expense is not unpaid'; END IF;
    IF abs(COALESCE(v_settlement,0)-p_allocation_amount)>0.01 THEN
      RAISE EXCEPTION 'Settlement amount mismatch';
    END IF;
    IF EXISTS (SELECT 1 FROM public.payment_vouchers pv
      WHERE pv.description ILIKE '%'||(SELECT voucher_number FROM public.finance_expenses WHERE id=p_document_id)||'%'
         OR pv.reference_number ILIKE '%'||(SELECT voucher_number FROM public.finance_expenses WHERE id=p_document_id)||'%') THEN
      RAISE EXCEPTION 'Payment voucher evidence exists';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bank_statement_allocations
      WHERE document_type='expense' AND document_id=p_document_id) THEN
      RAISE EXCEPTION 'Bank allocation already exists';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bank_statement_lines
      WHERE matched_expense_id=p_document_id OR matched_payment_id IN
        (SELECT id FROM public.payment_vouchers WHERE description ILIKE '%'||(SELECT voucher_number FROM public.finance_expenses WHERE id=p_document_id)||'%')) THEN
      RAISE EXCEPTION 'Bank payment evidence exists';
    END IF;
    SELECT je.id,fe.settlement_amount INTO v_source_je,v_settlement
      FROM public.journal_entries je JOIN public.finance_expenses fe ON fe.id=je.reference_id
      WHERE fe.id=p_document_id AND je.entry_number=COALESCE(p_expected->>'entry_number',je.entry_number)
        AND je.source_module IN ('expense','expenses') AND je.is_posted
        AND NOT COALESCE(je.is_reversed,false) FOR UPDATE;
    IF v_source_je IS NULL THEN RAISE EXCEPTION 'Expected posted recognition journal is missing'; END IF;
    IF p_expected ? 'journal_id' AND p_expected->>'journal_id'<>v_source_je::text THEN
      RAISE EXCEPTION 'Unexpected source journal';
    END IF;
    PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_source_je FOR UPDATE;
    SELECT ba.coa_id INTO v_bank_coa FROM public.bank_accounts ba
      WHERE EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id=v_source_je AND l.account_id=ba.coa_id AND l.credit>0);
    SELECT count(*),COALESCE(sum(l.credit),0) INTO v_cash_lines,v_cash_credit
      FROM public.journal_entry_lines l WHERE l.journal_entry_id=v_source_je AND l.account_id=v_bank_coa AND l.credit>0;
    IF v_bank_coa IS NULL OR v_cash_lines<>1 OR abs(v_cash_credit-p_allocation_amount)>0.01 THEN
      RAISE EXCEPTION 'Source journal is not the expected cash recognition';
    END IF;
    SELECT id INTO v_ap_coa FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
    IF v_ap_coa IS NULL THEN RAISE EXCEPTION 'AP account 2110 is missing'; END IF;
    SELECT jsonb_build_object('source_journal_id',je.id,'entry_number',je.entry_number,
      'total_debit',je.total_debit,'total_credit',je.total_credit,
      'lines',(SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.line_number),'[]') FROM public.journal_entry_lines l WHERE l.journal_entry_id=je.id))
      INTO v_before FROM public.journal_entries je WHERE je.id=v_source_je;
    IF p_expected ? 'settlement_amount' AND abs((p_expected->>'settlement_amount')::numeric-v_settlement)>0.01 THEN
      RAISE EXCEPTION 'Unexpected settlement amount';
    END IF;
    v_entry:=public.generate_journal_entry_number();
    INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,
      description,total_debit,total_credit,is_posted,posted_at,posted_by,created_by)
    SELECT v_entry,je.entry_date,'historical_repair',je.reference_id,'HR-REV-'||v_cmd::text,
      'Explicit reversal of incorrect cash recognition '||je.entry_number,je.total_credit,je.total_debit,true,now(),auth.uid(),auth.uid()
      FROM public.journal_entries je WHERE je.id=v_source_je RETURNING id INTO v_reversal_je;
    v_line_no:=1;
    FOR v_line IN SELECT * FROM public.journal_entry_lines WHERE journal_entry_id=v_source_je ORDER BY line_number LOOP
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
      VALUES(v_reversal_je,v_line_no,v_line.account_id,v_line.credit,v_line.debit,'Historical reversal: '||COALESCE(v_line.description,''),v_line.supplier_id);
      v_line_no:=v_line_no+1;
    END LOOP;
    UPDATE public.journal_entries SET is_reversed=true,reversed_by_id=v_reversal_je WHERE id=v_source_je;
    v_entry:=public.generate_journal_entry_number();
    INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,
      description,total_debit,total_credit,is_posted,posted_at,posted_by,created_by)
    SELECT v_entry,je.entry_date,'historical_repair',je.reference_id,'HR-AP-'||v_cmd::text,
      'Correct AP recognition for '||fe.voucher_number,je.total_debit,je.total_debit,true,now(),auth.uid(),auth.uid()
      FROM public.journal_entries je JOIN public.finance_expenses fe ON fe.id=je.reference_id WHERE je.id=v_source_je
      RETURNING id INTO v_ap_je;
    v_line_no:=1;
    FOR v_line IN SELECT l.* FROM public.journal_entry_lines l WHERE l.journal_entry_id=v_source_je ORDER BY l.line_number LOOP
      IF v_line.account_id=v_bank_coa AND v_line.credit>0 THEN CONTINUE; END IF;
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
      VALUES(v_ap_je,v_line_no,v_line.account_id,v_line.debit,v_line.credit,'AP correction: '||COALESCE(v_line.description,''),v_line.supplier_id);
      v_line_no:=v_line_no+1;
    END LOOP;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
    VALUES(v_ap_je,v_line_no,v_ap_coa,0,p_allocation_amount,'Supplier/AP payable',
      (SELECT supplier_id FROM public.finance_expenses WHERE id=p_document_id));
    SELECT jsonb_build_object('reversal_journal_id',v_reversal_je,'replacement_journal_id',v_ap_je,
      'source_journal_id',v_source_je,'allocation_id',NULL,'paid_amount',0,
      'settlement_amount',v_settlement,'bank_allocation_count',0) INTO v_after;
    UPDATE public.finance_historical_repair_commands SET before_state=v_before,after_state=v_after WHERE id=v_cmd;
    RETURN jsonb_build_object('idempotent',false,'command_id',v_cmd,'before',v_before,'after',v_after);
  END IF;

  IF p_operation<>'allocate_existing_cash_event' THEN
    RAISE EXCEPTION 'Unsupported historical repair operation';
  END IF;
  IF p_document_type NOT IN ('expense','payment','receipt','tax_payment','fund_transfer','petty_cash','journal') THEN
    RAISE EXCEPTION 'Unsupported historical repair document';
  END IF;
  IF p_bank_statement_line_id IS NULL THEN
    RAISE EXCEPTION 'Allocation repair requires bank statement evidence';
  END IF;

  INSERT INTO public.finance_historical_repair_commands(
    idempotency_key,document_type,document_id,bank_statement_line_id,payment_kind,
    operation,requested_by,before_state,after_state,status)
  VALUES(p_idempotency_key,p_document_type,p_document_id,p_bank_statement_line_id,p_payment_kind,
    p_operation,auth.uid(),'{}','{}','committed') RETURNING id INTO v_cmd;
  PERFORM set_config('app.finance_historical_repair_command',v_cmd::text,true);
  PERFORM set_config('app.finance_historical_repair','on',true);

  PERFORM 1 FROM public.bank_statement_lines WHERE id=p_bank_statement_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing cash evidence'; END IF;
  SELECT COALESCE(NULLIF(debit_amount,0),credit_amount,0),
         COALESCE(debit_amount,0)>0,
         currency,
         (SELECT ba.currency FROM public.bank_accounts ba WHERE ba.id=bank_statement_lines.bank_account_id),
         (SELECT ba.coa_id FROM public.bank_accounts ba WHERE ba.id=bank_statement_lines.bank_account_id)
    INTO v_bank_amount, v_is_debit, v_line_ccy, v_acct_ccy, v_bank_coa
    FROM public.bank_statement_lines WHERE id=p_bank_statement_line_id;
  IF v_bank_amount IS NULL OR abs(p_allocation_amount-v_bank_amount)>0.01 THEN
    RAISE EXCEPTION 'Amount mismatch';
  END IF;
  IF p_expected ? 'bank_amount' AND abs((p_expected->>'bank_amount')::numeric-v_bank_amount)>0.01 THEN
    RAISE EXCEPTION 'Unexpected bank amount';
  END IF;
  IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'Missing bank ledger account'; END IF;
  IF COALESCE(v_line_ccy, v_acct_ccy) IS DISTINCT FROM v_acct_ccy
     AND COALESCE(v_line_ccy, v_acct_ccy) IS NOT NULL THEN
    RAISE EXCEPTION 'Currency mismatch';
  END IF;

  IF p_document_type='expense' THEN
    PERFORM 1 FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing expense source'; END IF;
    SELECT je.id INTO v_je FROM public.journal_entries je
      WHERE je.id=COALESCE((p_expected->>'journal_id')::uuid, je.id)
        AND je.source_module IN ('expense','expenses')
        AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
        AND (je.reference_id=p_document_id OR je.reference_number='EXP-'||p_document_id::text)
      FOR UPDATE;
  ELSIF p_document_type='receipt' THEN
    SELECT journal_entry_id, amount INTO v_je, v_source_amount
      FROM public.receipt_vouchers WHERE id=p_document_id AND is_posted FOR UPDATE;
  ELSIF p_document_type='payment' THEN
    SELECT journal_entry_id, amount INTO v_je, v_source_amount
      FROM public.payment_vouchers WHERE id=p_document_id AND is_posted FOR UPDATE;
  ELSIF p_document_type='tax_payment' THEN
    SELECT journal_entry_id, amount INTO v_je, v_source_amount
      FROM public.tax_payments WHERE id=p_document_id FOR UPDATE;
  ELSIF p_document_type='fund_transfer' THEN
    SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id=p_document_id FOR UPDATE;
  ELSIF p_document_type='petty_cash' THEN
    SELECT journal_entry_id INTO v_je FROM public.petty_cash_transactions WHERE id=p_document_id FOR UPDATE;
  ELSIF p_document_type='journal' THEN
    v_je := p_document_id;
    PERFORM 1 FROM public.journal_entries WHERE id=v_je FOR UPDATE;
  END IF;
  IF p_expected ? 'journal_id' THEN
    IF v_je IS NULL OR v_je::text <> p_expected->>'journal_id' THEN
      RAISE EXCEPTION 'Unexpected journal';
    END IF;
  END IF;
  IF v_je IS NULL THEN RAISE EXCEPTION 'Missing posted source journal/evidence'; END IF;
  PERFORM 1 FROM public.journal_entries
    WHERE id=v_je AND is_posted AND NOT COALESCE(is_reversed,false) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing posted source journal/evidence'; END IF;
  IF p_expected ? 'entry_number' AND (SELECT entry_number FROM public.journal_entries WHERE id=v_je)
       <> p_expected->>'entry_number' THEN
    RAISE EXCEPTION 'Unexpected journal';
  END IF;
  SELECT transaction_currency INTO v_je_ccy FROM public.journal_entries WHERE id=v_je;
  IF v_je_ccy IS NOT NULL AND v_acct_ccy IS NOT NULL AND v_je_ccy <> v_acct_ccy THEN
    RAISE EXCEPTION 'Currency mismatch';
  END IF;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_je FOR UPDATE;
  PERFORM 1 FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_statement_line_id FOR UPDATE;
  SELECT COALESCE(sum(debit),0), COALESCE(sum(credit),0)
    INTO v_bank_gl_debit, v_bank_gl_credit
    FROM public.journal_entry_lines
    WHERE journal_entry_id=v_je AND account_id=v_bank_coa;
  IF v_is_debit THEN
    IF abs(v_bank_gl_credit-v_bank_amount)>0.01 OR v_bank_gl_debit>0.01 THEN
      RAISE EXCEPTION 'Journal bank movement does not match bank statement';
    END IF;
  ELSE
    IF abs(v_bank_gl_debit-v_bank_amount)>0.01 OR v_bank_gl_credit>0.01 THEN
      RAISE EXCEPTION 'Journal bank movement does not match bank statement';
    END IF;
  END IF;
  SELECT abs(total_debit-total_credit)<0.01 INTO v_je_balanced FROM public.journal_entries WHERE id=v_je;
  IF NOT COALESCE(v_je_balanced,false) THEN RAISE EXCEPTION 'Journal is not balanced'; END IF;

  SELECT jsonb_build_object('journal_id',je.id,'entry_number',je.entry_number,
    'total_debit',je.total_debit,'total_credit',je.total_credit,
    'line_count',(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id=je.id),
    'allocations',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]')
                   FROM public.bank_statement_allocations a WHERE a.journal_entry_id=je.id))
    INTO v_before FROM public.journal_entries je WHERE je.id=v_je;
  v_je_before:=v_before;
  IF EXISTS (SELECT 1 FROM public.bank_statement_allocations
      WHERE bank_statement_line_id=p_bank_statement_line_id
        AND document_type=p_document_type AND document_id=p_document_id AND payment_kind=p_payment_kind) THEN
    RAISE EXCEPTION 'Duplicate cash event';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statement_allocations WHERE journal_entry_id=v_je) THEN
    RAISE EXCEPTION 'Duplicate cash event';
  END IF;

  INSERT INTO public.bank_statement_allocations(
    bank_statement_line_id,document_type,document_id,journal_entry_id,
    allocation_amount,payment_kind,created_by)
  VALUES(p_bank_statement_line_id,p_document_type,p_document_id,v_je,
    round(p_allocation_amount,2),p_payment_kind,auth.uid())
  RETURNING * INTO v_alloc;

  SELECT jsonb_build_object('journal_id',je.id,'entry_number',je.entry_number,
    'total_debit',je.total_debit,'total_credit',je.total_credit,
    'line_count',(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id=je.id),
    'allocation_id',v_alloc.id,'allocation_amount',v_alloc.allocation_amount)
    INTO v_after FROM public.journal_entries je WHERE je.id=v_je;
  IF v_after->>'journal_id'<>v_je_before->>'journal_id'
     OR v_after->>'total_debit'<>v_je_before->>'total_debit'
     OR v_after->>'total_credit'<>v_je_before->>'total_credit'
     OR v_after->>'line_count'<>v_je_before->>'line_count' THEN
    RAISE EXCEPTION 'Unexpected journal change';
  END IF;
  UPDATE public.finance_historical_repair_commands
    SET before_state=v_before, after_state=v_after, created_allocation_id=v_alloc.id
    WHERE id=v_cmd;
  RETURN jsonb_build_object('idempotent',false,'command_id',v_cmd,'allocation_id',v_alloc.id,
    'before',v_before,'after',v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.execute_historical_finance_repair(text,text,uuid,uuid,numeric,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.execute_historical_finance_repair(text,text,uuid,uuid,numeric,jsonb,text,text) TO authenticated,service_role;
COMMENT ON FUNCTION public.execute_historical_finance_repair IS
  'Privileged historical repair: allocate an already-posted cash journal, or explicit AP reclassification. Allocation does not rewrite journals.';

NOTIFY pgrst,'reload schema';
COMMIT;
