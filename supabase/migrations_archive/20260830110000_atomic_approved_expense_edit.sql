/*
 * Approved expense edit is an accounting update, not a cancellation.
 *
 * This migration contains no production-data repair. It keeps the active
 * journal header (and therefore its FK identity), atomically rebuilds its
 * lines, and revalidates/rebuilds canonical bank allocations in the same RPC.
 */

BEGIN;

CREATE OR REPLACE FUNCTION public.upsert_expense_journal_header_in_place(
  p_journal_id uuid,
  p_expense_id uuid,
  p_entry_date date,
  p_description text,
  p_transaction_category text,
  p_total numeric,
  p_created_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_journal_id uuid := p_journal_id;
  v_entry_number text;
  v_period_id uuid;
BEGIN
  SELECT id INTO v_period_id
    FROM public.accounting_periods
   WHERE start_date<=p_entry_date AND end_date>=p_entry_date
   ORDER BY start_date DESC LIMIT 1;
  IF v_journal_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('expense-je-number:' || to_char(p_entry_date,'YYMM')));
    SELECT 'JE' || to_char(p_entry_date,'YYMM') || '-' ||
           lpad((COALESCE(max(CAST(substring(entry_number FROM '-([0-9]+)$') AS integer)),0)+1)::text,4,'0')
      INTO v_entry_number
      FROM public.journal_entries
     WHERE entry_number LIKE 'JE' || to_char(p_entry_date,'YYMM') || '-%';

    INSERT INTO public.journal_entries(
      entry_number,entry_date,period_id,source_module,reference_id,reference_number,
      description,transaction_category,total_debit,total_credit,is_posted,
      posted_at,created_by
    ) VALUES (
      v_entry_number,p_entry_date,v_period_id,'expenses',p_expense_id,'EXP-'||p_expense_id::text,
      p_description,p_transaction_category,p_total,p_total,true,now(),p_created_by
    ) RETURNING id INTO v_journal_id;
  ELSE
    UPDATE public.journal_entries
       SET entry_date=p_entry_date,
           period_id=v_period_id,
           source_module='expenses',
           reference_id=p_expense_id,
           reference_number='EXP-'||p_expense_id::text,
           description=p_description,
           transaction_category=p_transaction_category,
           total_debit=p_total,
           total_credit=p_total,
           is_posted=true
     WHERE id=v_journal_id
       AND is_posted=true
       AND NOT COALESCE(is_reversed,false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Effective expense journal is no longer active';
    END IF;
  END IF;
  RETURN v_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense_account_id uuid;
  v_payment_account_id uuid;
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
BEGIN
  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;

  IF TG_OP='UPDATE' AND OLD.approval_status='approved' THEN
    IF ROW(
      OLD.amount,OLD.expense_category,OLD.expense_date,OLD.description,
      OLD.payment_method,OLD.bank_account_id,OLD.pib_bm_amount,OLD.pib_ppn_amount,
      OLD.pib_pph_amount,OLD.ppn_amount,OLD.pph_amount,OLD.stamp_duty_amount,
      OLD.fixed_asset_account_id,COALESCE(OLD.bank_charges_amount,0),
      OLD.transaction_currency,OLD.exchange_rate,OLD.supplier_id
    ) IS NOT DISTINCT FROM ROW(
      NEW.amount,NEW.expense_category,NEW.expense_date,NEW.description,
      NEW.payment_method,NEW.bank_account_id,NEW.pib_bm_amount,NEW.pib_ppn_amount,
      NEW.pib_pph_amount,NEW.ppn_amount,NEW.pph_amount,NEW.stamp_duty_amount,
      NEW.fixed_asset_account_id,COALESCE(NEW.bank_charges_amount,0),
      NEW.transaction_currency,NEW.exchange_rate,NEW.supplier_id
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
  ELSIF NEW.payment_method IS NOT NULL AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM public.bank_accounts WHERE id=NEW.bank_account_id;
  ELSIF NEW.payment_method IS NULL THEN
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
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description)
      VALUES(v_journal_id,v_line_num,v_bm_account_id,NEW.pib_bm_amount,0,'PIB - Import Duty (BM) [landed cost]');
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.pib_ppn_amount,0,'PIB - PPN Import (Input VAT)');
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description)
      VALUES(v_journal_id,v_line_num,v_pph_account_id,NEW.pib_pph_amount,0,'PIB - PPh 22 Dibayar Dimuka');
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,NEW.amount,'PIB - Payment ['||COALESCE(NEW.description,'')||']');
    RETURN NEW;
  END IF;

  IF NEW.expense_category='fixed_asset' THEN
    v_expense_account_id:=NEW.fixed_asset_account_id;
    IF v_expense_account_id IS NULL THEN RAISE EXCEPTION 'A posting Fixed Asset account is required'; END IF;
    SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
    IF COALESCE(NEW.ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Masukan account 1150 is missing'; END IF;
    v_description:=COALESCE(NEW.description,'Fixed Asset Purchase');
    v_total:=NEW.amount+COALESCE(NEW.ppn_amount,0);
    v_journal_id:=public.upsert_expense_journal_header_in_place(
      v_journal_id,NEW.id,NEW.expense_date,v_description,'fixed_asset',v_total,NEW.created_by);
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description)
    VALUES(v_journal_id,1,v_expense_account_id,NEW.amount,0,v_description);
    v_line_num:=2;
    IF COALESCE(NEW.ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_total,v_description);
    RETURN NEW;
  END IF;

  v_expense_account_id:=public.get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN RAISE EXCEPTION 'No expense account is mapped for %',NEW.expense_category; END IF;
  v_category_label:=initcap(replace(NEW.expense_category,'_',' '));
  v_description:=COALESCE(NEW.description,NEW.expense_category);
  v_credit_desc:=COALESCE(substring(NEW.description FROM '^[^\n]+'),NEW.expense_category)||' ['||v_category_label||']';
  SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
  SELECT id INTO v_pph_account_id FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_stamp_duty_account_id FROM public.chart_of_accounts WHERE code='6950' LIMIT 1;
  IF COALESCE(NEW.ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Masukan account 1150 is missing'; END IF;
  IF COALESCE(NEW.pph_amount,0)>0 AND v_pph_account_id IS NULL THEN RAISE EXCEPTION 'PPh Payable account 2132 is missing'; END IF;
  IF COALESCE(NEW.stamp_duty_amount,0)>0 AND v_stamp_duty_account_id IS NULL THEN RAISE EXCEPTION 'Stamp Duty account 6950 is missing'; END IF;
  v_bank_charges:=CASE WHEN NEW.expense_category='utilities' THEN COALESCE(NEW.bank_charges_amount,0) ELSE 0 END;
  IF v_bank_charges>0 THEN
    v_bank_charge_acc_id:=public.get_expense_account_id('bank_charges');
    IF v_bank_charge_acc_id IS NULL THEN RAISE EXCEPTION 'Bank Charges account is missing'; END IF;
  END IF;
  v_net_payment:=NEW.amount+COALESCE(NEW.ppn_amount,0)-COALESCE(NEW.pph_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;
  v_total:=NEW.amount+COALESCE(NEW.ppn_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;
  v_journal_id:=public.upsert_expense_journal_header_in_place(
    v_journal_id,NEW.id,NEW.expense_date,v_description,NEW.expense_category,v_total,NEW.created_by);
  v_line_num:=1;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
  VALUES(v_journal_id,v_line_num,v_expense_account_id,NEW.amount,0,v_credit_desc,NEW.supplier_id);
  v_line_num:=v_line_num+1;
  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
    VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description,NEW.supplier_id);
    v_line_num:=v_line_num+1;
  END IF;
  IF COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
    VALUES(v_journal_id,v_line_num,v_stamp_duty_account_id,NEW.stamp_duty_amount,0,'Bea Meterai - '||v_description,NEW.supplier_id);
    v_line_num:=v_line_num+1;
  END IF;
  IF v_bank_charges>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,'Bank charges ['||v_category_label||']',NEW.supplier_id);
    v_line_num:=v_line_num+1;
  END IF;
  IF COALESCE(NEW.pph_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,'PPh Ditahan - '||v_description,NEW.supplier_id);
    v_line_num:=v_line_num+1;
  END IF;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
  VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment,v_credit_desc,NEW.supplier_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
AFTER INSERT OR UPDATE ON public.finance_expenses
FOR EACH ROW WHEN (
  NEW.approval_status='approved'
  AND NOT public.historical_repair_context_active()
)
EXECUTE FUNCTION public.auto_post_expense_accounting();

CREATE OR REPLACE FUNCTION public.edit_approved_finance_expense_atomic(
  p_expense_id uuid,
  p_payload jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL,
  p_allocation_amount numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  v_allocation record;
  v_same_selected_count integer;
  v_selected_amount numeric;
  v_period_status text;
BEGIN
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
    bank_account_currency=COALESCE(v_bank_currency,v_currency),payment_currency=v_currency
  WHERE id=p_expense_id;

  -- The trigger must retain the header identity and rebuild only its lines.
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
     AND (v_same_selected_count=0 OR (p_allocation_amount IS NOT NULL AND abs(COALESCE(v_selected_amount,0)-p_allocation_amount)>0.01)) THEN
    FOR v_allocation IN
      SELECT id FROM public.bank_statement_allocations
       WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='supplier'
       ORDER BY id FOR UPDATE
    LOOP
      PERFORM public.unmatch_bank_statement_allocation(v_allocation.id);
    END LOOP;
    PERFORM public.link_bank_statement_line(
      p_bank_statement_line_id,'expense',p_expense_id,'supplier',p_allocation_amount);
  ELSE
    -- A no-op FK update deliberately re-runs all canonical allocation guards
    -- against the rebuilt journal/bank account. Any mismatch rolls back save.
    UPDATE public.bank_statement_allocations
       SET journal_entry_id=v_journal_id
     WHERE document_type='expense' AND document_id=p_expense_id;
  END IF;

  UPDATE public.bank_statement_allocations
     SET journal_entry_id=v_journal_id
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind<>'supplier';

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  RETURN p_expense_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_expense_journal_header_in_place(uuid,uuid,date,text,text,numeric,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_expense_journal_header_in_place(uuid,uuid,date,text,text,numeric,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric) TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
