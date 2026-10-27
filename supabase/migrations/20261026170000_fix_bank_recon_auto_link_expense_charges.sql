-- Migration: 20261026170000_fix_bank_recon_auto_link_expense_charges.sql
-- Description: Fix Bank Reconciliation auto-link allocation failure for expenses with bank charges,
--              ensure canonical expense payable includes bank charges, auto-post bank charges on all expense categories,
--              and ensure idempotent bank statement line allocation.

-- 1. Ensure originating_bank_statement_line_id column exists on finance_expenses
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'finance_expenses'
       AND column_name = 'originating_bank_statement_line_id'
  ) THEN
    ALTER TABLE public.finance_expenses
    ADD COLUMN originating_bank_statement_line_id uuid REFERENCES public.bank_statement_lines(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_finance_expenses_originating_bank_line
  ON public.finance_expenses (originating_bank_statement_line_id)
  WHERE originating_bank_statement_line_id IS NOT NULL;

-- 2. Update calculate_finance_expense_payable to canonicalize bank_charges_amount
CREATE OR REPLACE FUNCTION public.calculate_finance_expense_payable(p_expense_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN fe.expense_category = 'import_broker'
      THEN COALESCE((SELECT c.final_cash_payable FROM public.vw_customs_broker_accounting c WHERE c.expense_id=fe.id),0)
    ELSE COALESCE(fe.amount,0)
       + COALESCE(fe.ppn_amount,0)
       - COALESCE(fe.pph_amount,0)
       + COALESCE(fe.stamp_duty_amount,0)
       + COALESCE(fe.bank_charges_amount,0)
  END
  FROM public.finance_expenses fe WHERE fe.id=p_expense_id;
$$;
GRANT EXECUTE ON FUNCTION public.calculate_finance_expense_payable(uuid) TO authenticated, service_role;

-- 3. Update auto_post_expense_accounting to recognize bank_charges_amount on any expense category
CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;

  IF TG_OP='UPDATE' AND OLD.approval_status='approved' THEN
    IF ROW(
      OLD.amount,OLD.expense_category,OLD.expense_date,OLD.description,
      OLD.payment_method,OLD.bank_account_id,OLD.pib_bm_amount,OLD.pib_ppn_amount,
      OLD.pib_pph_amount,OLD.ppn_amount,OLD.pph_amount,OLD.pph_code_id,OLD.stamp_duty_amount,
      OLD.fixed_asset_account_id,COALESCE(OLD.bank_charges_amount,0),
      OLD.transaction_currency,OLD.exchange_rate,OLD.supplier_id,OLD.payee_id
    ) IS NOT DISTINCT FROM ROW(
      NEW.amount,NEW.expense_category,NEW.expense_date,NEW.description,
      NEW.payment_method,NEW.bank_account_id,NEW.pib_bm_amount,NEW.pib_ppn_amount,
      NEW.pib_pph_amount,NEW.ppn_amount,NEW.pph_amount,NEW.pph_code_id,NEW.stamp_duty_amount,
      NEW.fixed_asset_account_id,COALESCE(NEW.bank_charges_amount,0),
      NEW.transaction_currency,NEW.exchange_rate,NEW.supplier_id,NEW.payee_id
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
      VALUES(v_journal_id,v_line_num,v_bm_account_id,NEW.pib_bm_amount,0,'PIB - Import Duty (BM) [landed cost]',NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.pib_ppn_amount,0,'PIB - PPN Import (Input VAT)',NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_pph_account_id,NEW.pib_pph_amount,0,'PIB - PPh 22 Dibayar Dimuka',NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,NEW.amount,'PIB - Payment ['||COALESCE(NEW.description,'')||']',NEW.supplier_id,NEW.payee_id);
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
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,1,v_expense_account_id,NEW.amount,0,v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=2;
    IF COALESCE(NEW.ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description,NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_total,v_description,NEW.supplier_id,NEW.payee_id);
    RETURN NEW;
  END IF;

  v_expense_account_id:=CASE WHEN public.is_capitalizable_landed_cost_category(NEW.expense_category) THEN (SELECT id FROM public.chart_of_accounts WHERE code='1130' LIMIT 1) ELSE public.get_expense_account_id(NEW.expense_category) END;
  IF v_expense_account_id IS NULL THEN RAISE EXCEPTION 'No expense account is mapped for %',NEW.expense_category; END IF;
  v_category_label:=initcap(replace(NEW.expense_category,'_',' '));
  v_description:=COALESCE(NEW.description,NEW.expense_category);
  v_credit_desc:=COALESCE(substring(NEW.description FROM '^[^
]+'),NEW.expense_category)||' ['||v_category_label||']';
  
  SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
  SELECT id INTO v_stamp_duty_account_id FROM public.chart_of_accounts WHERE code='6950' LIMIT 1;
  IF COALESCE(NEW.ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Masukan account 1150 is missing'; END IF;
  IF COALESCE(NEW.stamp_duty_amount,0)>0 AND v_stamp_duty_account_id IS NULL THEN RAISE EXCEPTION 'Stamp Duty account 6950 is missing'; END IF;

  IF COALESCE(NEW.pph_amount, 0) > 0 THEN
    IF NEW.pph_code_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: Withholding tax amount % exists but pph_code_id is NULL', 
        NEW.id, NEW.pph_amount;
    END IF;

    v_pph_account_id := public.fn_pph_payable_account_id(NEW.pph_code_id);

    IF v_pph_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: Tax code % has no valid GL liability account configured', 
        NEW.id, NEW.pph_code_id;
    END IF;
  END IF;

  -- Apply bank charges whenever present regardless of category
  v_bank_charges:=COALESCE(NEW.bank_charges_amount,0);
  IF v_bank_charges>0 THEN
    v_bank_charge_acc_id:=public.get_expense_account_id('bank_charges');
    IF v_bank_charge_acc_id IS NULL THEN RAISE EXCEPTION 'Bank Charges account is missing'; END IF;
  END IF;

  v_net_payment:=NEW.amount+COALESCE(NEW.ppn_amount,0)-COALESCE(NEW.pph_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;
  v_total:=NEW.amount+COALESCE(NEW.ppn_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;

  v_journal_id:=public.upsert_expense_journal_header_in_place(
    v_journal_id,NEW.id,NEW.expense_date,v_description,NEW.expense_category,v_total,NEW.created_by);
  v_line_num:=1;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_expense_account_id,NEW.amount,0,v_credit_desc,NEW.supplier_id,NEW.payee_id);
  v_line_num:=v_line_num+1;

  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_stamp_duty_account_id,NEW.stamp_duty_amount,0,'Bea Meterai - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF v_bank_charges>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,'Bank charges ['||v_category_label||']',NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF COALESCE(NEW.pph_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,'PPh Ditahan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment,v_credit_desc,NEW.supplier_id,NEW.payee_id);

  RETURN NEW;
END;
$function$;

-- 4. Update save_finance_expense to persist originating_bank_statement_line_id
CREATE OR REPLACE FUNCTION public.save_finance_expense(p_expense_id uuid DEFAULT NULL::uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_date date := COALESCE((p_payload->>'expense_date')::date, current_date);
  v_bank_id uuid := NULLIF(p_payload->>'bank_account_id', '')::uuid;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_docs text[];
  v_orig_line_id uuid := NULLIF(p_payload->>'originating_bank_statement_line_id', '')::uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  IF COALESCE((p_payload->>'amount')::numeric, 0) <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero';
  END IF;
  IF NULLIF(p_payload->>'expense_category', '') IS NULL THEN
    RAISE EXCEPTION 'Expense category is required';
  END IF;

  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id = v_bank_id;
  v_currency := upper(COALESCE(NULLIF(p_payload->>'transaction_currency',''), v_bank_currency, 'IDR'));
  IF v_currency NOT IN ('IDR','USD') THEN RAISE EXCEPTION 'Unsupported expense currency %', v_currency; END IF;
  v_rate := COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric, 0), CASE WHEN v_currency = 'IDR' THEN 1 ELSE NULL END);
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'A positive exchange rate is required for % expenses', v_currency;
  END IF;
  IF v_bank_currency IS NOT NULL AND v_bank_currency <> v_currency THEN
    RAISE EXCEPTION 'Expense currency % does not match selected bank currency %', v_currency, v_bank_currency;
  END IF;

  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_docs
    FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls', '[]'::jsonb));

  IF p_expense_id IS NULL THEN
    INSERT INTO public.finance_expenses (
      voucher_number, expense_category, expense_type, amount, expense_date, description,
      batch_id, import_container_id, delivery_challan_id, payment_method, bank_account_id,
      payment_reference, paid_by, document_urls, supplier_id, staff_id, invoice_number,
      due_date, broker_items, pib_bm_amount, pib_ppn_amount, pib_pph_amount, ppn_amount,
      ppn_manual_override, ppn_calc_mode, dpp_amount, ppn_rate, pph_amount, pph_code_id,
      stamp_duty_amount, fixed_asset_account_id, bank_charges_amount, approval_status,
      created_by, currency_code, transaction_currency, functional_currency, exchange_rate,
      bank_account_currency, payment_currency, sales_order_allocations,
      originating_bank_statement_line_id
    ) VALUES (
      public.next_expense_voucher_number(v_date), p_payload->>'expense_category',
      COALESCE(NULLIF(p_payload->>'expense_type',''), 'admin'), (p_payload->>'amount')::numeric,
      v_date, NULLIF(p_payload->>'description',''), NULLIF(p_payload->>'batch_id','')::uuid,
      NULLIF(p_payload->>'import_container_id','')::uuid, NULLIF(p_payload->>'delivery_challan_id','')::uuid,
      NULLIF(p_payload->>'payment_method',''), v_bank_id, NULLIF(p_payload->>'payment_reference',''),
      NULLIF(p_payload->>'paid_by',''), NULLIF(v_docs, ARRAY[]::text[]),
      NULLIF(p_payload->>'supplier_id','')::uuid, NULLIF(p_payload->>'staff_id','')::uuid,
      NULLIF(p_payload->>'invoice_number',''), NULLIF(p_payload->>'due_date','')::date,
      NULLIF(p_payload->'broker_items','null'::jsonb), NULLIF(p_payload->>'pib_bm_amount','')::numeric,
      NULLIF(p_payload->>'pib_ppn_amount','')::numeric, NULLIF(p_payload->>'pib_pph_amount','')::numeric,
      COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0), COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
      COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'), NULLIF(p_payload->>'dpp_amount','')::numeric,
      COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11), COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
      NULLIF(p_payload->>'pph_code_id','')::uuid, COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
      NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
      COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
      COALESCE(NULLIF(p_payload->>'approval_status',''),'pending_approval'),
      COALESCE(NULLIF(p_payload->>'created_by','')::uuid, auth.uid()),
      v_currency, v_currency, 'IDR', v_rate, COALESCE(v_bank_currency,v_currency), v_currency,
      COALESCE(p_payload->'sales_order_allocations', '[]'::jsonb),
      v_orig_line_id
    ) RETURNING id INTO v_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.finance_expenses WHERE id=p_expense_id AND approval_status='approved') THEN
      RAISE EXCEPTION 'This expense is posted. Cancel Posting first to make changes.';
    END IF;
    UPDATE public.finance_expenses SET
      expense_category=p_payload->>'expense_category', expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),'admin'),
      amount=(p_payload->>'amount')::numeric, expense_date=v_date, description=NULLIF(p_payload->>'description',''),
      batch_id=NULLIF(p_payload->>'batch_id','')::uuid, import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
      delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
      payment_method=NULLIF(p_payload->>'payment_method',''), bank_account_id=v_bank_id,
      payment_reference=NULLIF(p_payload->>'payment_reference',''), paid_by=NULLIF(p_payload->>'paid_by',''),
      document_urls=NULLIF(v_docs,ARRAY[]::text[]), supplier_id=NULLIF(p_payload->>'supplier_id','')::uuid,
      staff_id=NULLIF(p_payload->>'staff_id','')::uuid, invoice_number=NULLIF(p_payload->>'invoice_number',''),
      due_date=NULLIF(p_payload->>'due_date','')::date, broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
      pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,
      pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
      pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,
      ppn_amount=COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0),
      ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
      ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),
      dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric, ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),
      pph_amount=COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0), pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,
      stamp_duty_amount=COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
      fixed_asset_account_id=NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
      bank_charges_amount=COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
      currency_code=v_currency, transaction_currency=v_currency, functional_currency='IDR', exchange_rate=v_rate,
      bank_account_currency=COALESCE(v_bank_currency,v_currency), payment_currency=v_currency,
      sales_order_allocations=COALESCE(p_payload->'sales_order_allocations', '[]'::jsonb),
      originating_bank_statement_line_id=COALESCE(v_orig_line_id, originating_bank_statement_line_id)
    WHERE id=p_expense_id RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$function$;

-- 5. Update link_bank_statement_line to be idempotent when an allocation already exists for this expense
CREATE OR REPLACE FUNCTION public.link_bank_statement_line(p_bank_line_id uuid, p_document_type text, p_document_id uuid, p_payment_kind text DEFAULT 'supplier'::text, p_allocation_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line public.bank_statement_lines%rowtype;
  v_expense public.finance_expenses%rowtype;
  v_je uuid;
  v_bank_coa uuid;
  v_bank_currency text;
  v_expense_currency text;
  v_bank_total numeric;
  v_bank_allocated numeric;
  v_bank_remaining numeric;
  v_doc_total numeric;
  v_doc_allocated numeric;
  v_doc_remaining numeric;
  v_allocate numeric;
  v_allocation_id uuid:=gen_random_uuid();
  v_settlement_coa uuid;
  v_rate numeric;
  v_functional_amount numeric;
  v_entry text;
  v_period_id uuid;
  v_existing_payment_je uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;
  IF p_document_type='expense' THEN
    SELECT * INTO v_expense FROM public.finance_expenses WHERE id=p_document_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    SELECT (array_agg(id ORDER BY created_at DESC,id DESC))[1] INTO v_je
      FROM public.journal_entries
     WHERE source_module IN('expense','expenses')
       AND (reference_id=p_document_id OR reference_number='EXP-'||p_document_id::text)
       AND is_posted=true AND NOT COALESCE(is_reversed,false);
  ELSIF p_document_type='receipt' THEN SELECT journal_entry_id INTO v_je FROM public.receipt_vouchers WHERE id=p_document_id;
  ELSIF p_document_type='payment' THEN SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id=p_document_id;
  ELSIF p_document_type='fund_transfer' THEN SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id=p_document_id;
  ELSIF p_document_type='petty_cash' THEN SELECT journal_entry_id INTO v_je FROM public.petty_cash_transactions WHERE id=p_document_id;
  ELSIF p_document_type='tax_payment' THEN SELECT journal_entry_id INTO v_je FROM public.tax_payments WHERE id=p_document_id;
  ELSIF p_document_type='journal' THEN SELECT id INTO v_je FROM public.journal_entries WHERE id=p_document_id AND is_posted AND NOT COALESCE(is_reversed,false);
  ELSE RAISE EXCEPTION 'Unsupported reconciliation document type %',p_document_type; END IF;
  IF v_je IS NULL THEN RAISE EXCEPTION 'Document must have an active posted journal before reconciliation'; END IF;

  SELECT coa_id,upper(currency) INTO v_bank_coa,v_bank_currency
    FROM public.bank_accounts WHERE id=v_line.bank_account_id;
  IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'Selected bank account has no General Ledger account'; END IF;

  IF p_document_type <> 'expense' THEN
    SELECT COALESCE(sum(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN COALESCE(jel.transaction_debit,jel.debit)
                            ELSE COALESCE(jel.transaction_credit,jel.credit) END),0)
      INTO v_doc_total FROM public.journal_entry_lines jel
     WHERE jel.journal_entry_id=v_je AND jel.account_id=v_bank_coa;
    IF v_doc_total<=0.01 THEN RAISE EXCEPTION 'Document journal does not contain the selected bank account on the matching side'; END IF;
  END IF;

  v_bank_total:=COALESCE(NULLIF(v_line.debit_amount,0),v_line.credit_amount,0);
  SELECT COALESCE(sum(allocation_amount),0) INTO v_bank_allocated
    FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id;

  IF p_document_type='expense' THEN
    IF COALESCE(v_line.debit_amount,0)<=0 THEN
      RAISE EXCEPTION 'Expense payment requires an outgoing bank transaction';
    END IF;
    v_expense_currency:=upper(COALESCE(v_expense.transaction_currency,v_expense.currency_code,'IDR'));
    IF COALESCE(v_bank_currency,'IDR')<>v_expense_currency THEN
      RAISE EXCEPTION 'Direct expense allocation requires matching expense and bank currencies; use Payment Voucher for cross-currency payment';
    END IF;
    IF COALESCE(p_payment_kind,'supplier')='supplier' THEN
      v_doc_total:=COALESCE(public.calculate_finance_expense_payable(p_document_id),0);
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
    ELSIF p_payment_kind='pph23' THEN
      v_doc_total:=COALESCE(v_expense.pph_amount,0);
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
    ELSE
      RAISE EXCEPTION 'Unsupported expense payment kind %',p_payment_kind;
    END IF;
    IF v_settlement_coa IS NULL THEN RAISE EXCEPTION 'Expense settlement account is not configured'; END IF;
    SELECT
      COALESCE((SELECT sum(a.allocation_amount) FROM public.bank_statement_allocations a
                 WHERE a.document_type='expense' AND a.document_id=p_document_id
                   AND a.payment_kind=COALESCE(p_payment_kind,'supplier')),0)
      + COALESCE((SELECT sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0))
                    FROM public.bank_statement_lines b
                   WHERE b.matched_expense_id=p_document_id AND b.matching_status='confirmed'
                     AND b.payment_kind=COALESCE(p_payment_kind,'supplier')
                     AND b.id <> p_bank_line_id
                     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id)),0)
      + COALESCE((SELECT sum(va.allocated_amount) FROM public.voucher_allocations va
                    JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
                   WHERE va.finance_expense_id=p_document_id
                     AND COALESCE(va.payment_kind,'supplier')=COALESCE(p_payment_kind,'supplier')
                     AND pv.is_posted=true
                     AND COALESCE(pv.payment_purpose,'general') NOT IN ('salary_advance','salary_advance_settlement')),0)
      + COALESCE((SELECT sum(sa.applied_amount)
                    FROM public.salary_advance_applications sa
                    JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
                   WHERE sa.salary_expense_id=p_document_id
                     AND COALESCE(p_payment_kind,'supplier')='supplier'
                     AND settlement.is_posted=true),0)
      INTO v_doc_allocated;
  ELSE
    SELECT COALESCE(sum(allocation_amount),0) INTO v_doc_allocated
      FROM public.bank_statement_allocations
     WHERE document_type=p_document_type AND document_id=p_document_id
       AND payment_kind=COALESCE(p_payment_kind,'supplier');
  END IF;

  v_bank_remaining:=v_bank_total-v_bank_allocated;
  v_doc_remaining:=v_doc_total-v_doc_allocated;

  -- Idempotency check: if this line is already allocated to this document and payment kind, return existing result safely
  IF p_document_type='expense' THEN
    IF EXISTS (
      SELECT 1 FROM public.bank_statement_allocations a
       WHERE a.bank_statement_line_id=p_bank_line_id
         AND a.document_type='expense'
         AND a.document_id=p_document_id
         AND a.payment_kind=COALESCE(p_payment_kind,'supplier')
    ) THEN
      SELECT a.allocation_amount, a.journal_entry_id INTO v_allocate, v_je
        FROM public.bank_statement_allocations a
       WHERE a.bank_statement_line_id=p_bank_line_id
         AND a.document_type='expense'
         AND a.document_id=p_document_id
         AND a.payment_kind=COALESCE(p_payment_kind,'supplier')
       LIMIT 1;
      PERFORM public.sync_bank_line_allocation_owner(p_bank_line_id);
      UPDATE public.bank_statement_lines SET matched_at=now(), matched_by=auth.uid(), manually_unlinked=true
       WHERE id=p_bank_line_id;
      PERFORM public.refresh_bank_statement_allocation_status(p_bank_line_id);
      PERFORM public.recalculate_expense_payment_state(p_document_id);
      RETURN jsonb_build_object('allocation_amount',v_allocate,'bank_total',v_bank_total,
        'bank_allocated',v_bank_allocated,'bank_remaining',v_bank_remaining,
        'document_total',v_doc_total,'document_allocated',v_doc_allocated,
        'document_remaining',v_doc_remaining,'journal_entry_id',v_je);
    END IF;
  END IF;

  v_allocate:=round(COALESCE(NULLIF(p_allocation_amount,0),LEAST(v_bank_remaining,v_doc_remaining)),2);
  IF v_allocate<=0.01 THEN RAISE EXCEPTION 'No remaining amount is available to allocate'; END IF;
  IF v_allocate>v_bank_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds remaining bank amount'; END IF;
  IF v_allocate>v_doc_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds document outstanding amount'; END IF;

  IF p_document_type='expense' THEN
    -- Look for an existing valid payment journal that already credited the bank account for this expense
    SELECT je.id INTO v_existing_payment_je
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
     WHERE (je.reference_id = p_document_id OR je.reference_number IN ('EXP-' || p_document_id::text, 'EXP-PAY-' || p_document_id::text, v_expense.voucher_number))
       AND je.is_posted = true
       AND NOT COALESCE(je.is_reversed, false)
       AND jel.account_id = v_bank_coa
       AND jel.credit >= v_allocate - 0.01
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_statement_allocations other_a
          WHERE other_a.journal_entry_id = je.id
            AND other_a.bank_statement_line_id <> p_bank_line_id
       )
     ORDER BY je.created_at DESC
     LIMIT 1;

    IF v_existing_payment_je IS NOT NULL THEN
      v_je := v_existing_payment_je;
    ELSE
      v_rate:=CASE WHEN v_expense_currency='IDR' THEN 1 ELSE COALESCE(v_expense.exchange_rate,0) END;
      IF v_rate<=0 THEN RAISE EXCEPTION 'Expense exchange rate is required'; END IF;
      v_functional_amount:=round(v_allocate*v_rate,2);
      v_entry:=public.next_journal_entry_number();
      SELECT id INTO v_period_id FROM public.accounting_periods
       WHERE start_date<=v_line.transaction_date AND end_date>=v_line.transaction_date
       ORDER BY start_date DESC LIMIT 1;
      IF EXISTS (SELECT 1 FROM public.accounting_periods WHERE id=v_period_id AND status<>'open') THEN
        RAISE EXCEPTION 'Cannot post expense payment in a closed accounting period';
      END IF;
      INSERT INTO public.journal_entries(entry_number,entry_date,period_id,source_module,reference_id,
        reference_number,description,total_debit,total_credit,is_posted,posted_by,posted_at,created_by,
        transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
      VALUES(v_entry,v_line.transaction_date,v_period_id,'expense_payment',p_document_id,
        'EXP-PAY-'||v_allocation_id::text,'Expense bank payment: '||COALESCE(v_expense.voucher_number,p_document_id::text),
        v_functional_amount,v_functional_amount,true,auth.uid(),now(),auth.uid(),
        v_expense_currency,'IDR',v_rate,true)
      RETURNING id INTO v_je;
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,
        transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate,supplier_id)
      VALUES
        (v_je,1,v_settlement_coa,'Expense settlement - '||COALESCE(v_expense.voucher_number,''),v_functional_amount,0,
         v_expense_currency,v_allocate,0,'IDR',v_rate,v_expense.supplier_id),
        (v_je,2,v_bank_coa,'Bank payment - '||COALESCE(v_expense.voucher_number,''),0,v_functional_amount,
         v_bank_currency,0,v_allocate,'IDR',v_rate,v_expense.supplier_id);
    END IF;
  END IF;

  INSERT INTO public.bank_statement_allocations(id,bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind,created_by)
  VALUES(v_allocation_id,p_bank_line_id,p_document_type,p_document_id,v_je,v_allocate,COALESCE(p_payment_kind,'supplier'),auth.uid());

  PERFORM public.sync_bank_line_allocation_owner(p_bank_line_id);
  UPDATE public.bank_statement_lines SET matched_at=now(),matched_by=auth.uid(),manually_unlinked=true
   WHERE id=p_bank_line_id;
  PERFORM public.refresh_bank_statement_allocation_status(p_bank_line_id);
  IF p_document_type='expense' THEN PERFORM public.recalculate_expense_payment_state(p_document_id); END IF;
  RETURN jsonb_build_object('allocation_amount',v_allocate,'bank_total',v_bank_total,
    'bank_allocated',v_bank_allocated+v_allocate,'bank_remaining',v_bank_remaining-v_allocate,
    'document_total',v_doc_total,'document_allocated',v_doc_allocated+v_allocate,
    'document_remaining',v_doc_remaining-v_allocate,'journal_entry_id',v_je);
END;
$function$;
