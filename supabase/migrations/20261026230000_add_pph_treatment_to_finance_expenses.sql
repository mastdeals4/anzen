-- Migration: 20261026230000_add_pph_treatment_to_finance_expenses.sql
-- Description: Add pph_treatment column to finance_expenses with default 'deduct',
--              update save_finance_expense to persist it, and update auto_post_expense_accounting
--              to account for Add (+) vs Deduct (-) PPh treatments.

-- 1. Add pph_treatment column to public.finance_expenses
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'finance_expenses'
       AND column_name = 'pph_treatment'
  ) THEN
    ALTER TABLE public.finance_expenses
      ADD COLUMN pph_treatment text DEFAULT 'deduct' CHECK (pph_treatment IN ('deduct', 'add'));
  END IF;
END $$;

-- 2. Update save_finance_expense to accept and persist pph_treatment
CREATE OR REPLACE FUNCTION public.save_finance_expense(p_expense_id uuid DEFAULT NULL::uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_date date;
  v_rate numeric;
  v_currency text;
  v_bank_id uuid;
  v_bank_currency text;
  v_docs text[];
  v_orig_line_id uuid;
  v_pph_treatment text;
BEGIN
  v_date := COALESCE(NULLIF(p_payload->>'expense_date', '')::date, CURRENT_DATE);
  v_rate := COALESCE(NULLIF(p_payload->>'exchange_rate', '')::numeric, 1.0);
  v_currency := COALESCE(NULLIF(p_payload->>'currency_code', ''), 'IDR');
  v_bank_id := NULLIF(p_payload->>'bank_account_id', '')::uuid;
  v_orig_line_id := NULLIF(p_payload->>'originating_bank_statement_line_id', '')::uuid;
  v_pph_treatment := COALESCE(NULLIF(p_payload->>'pph_treatment', ''), 'deduct');

  IF v_pph_treatment NOT IN ('deduct', 'add') THEN
    v_pph_treatment := 'deduct';
  END IF;

  IF v_bank_id IS NOT NULL THEN
    SELECT currency INTO v_bank_currency FROM public.bank_accounts WHERE id = v_bank_id;
  END IF;

  IF v_bank_currency IS NOT NULL AND v_currency <> v_bank_currency THEN
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
      pph_treatment, stamp_duty_amount, fixed_asset_account_id, bank_charges_amount, approval_status,
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
      NULLIF(p_payload->>'pph_code_id','')::uuid, v_pph_treatment,
      COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
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
      pph_treatment=v_pph_treatment,
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

-- 3. Update auto_post_expense_accounting to handle Add (+) vs Deduct (-) PPh treatments
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

  IF TG_OP='UPDATE' AND OLD.approval_status='approved' THEN
    IF ROW(
      OLD.amount,OLD.expense_category,OLD.expense_date,OLD.description,
      OLD.payment_method,OLD.bank_account_id,OLD.pib_bm_amount,OLD.pib_ppn_amount,
      OLD.pib_pph_amount,OLD.ppn_amount,OLD.pph_amount,OLD.pph_code_id,
      COALESCE(OLD.pph_treatment,'deduct'),OLD.stamp_duty_amount,
      OLD.fixed_asset_account_id,COALESCE(OLD.bank_charges_amount,0),
      OLD.transaction_currency,OLD.exchange_rate,OLD.supplier_id,OLD.payee_id
    ) IS NOT DISTINCT FROM ROW(
      NEW.amount,NEW.expense_category,NEW.expense_date,NEW.description,
      NEW.payment_method,NEW.bank_account_id,NEW.pib_bm_amount,NEW.pib_ppn_amount,
      NEW.pib_pph_amount,NEW.ppn_amount,NEW.pph_amount,NEW.pph_code_id,
      COALESCE(NEW.pph_treatment,'deduct'),NEW.stamp_duty_amount,
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
  v_credit_desc:=COALESCE(substring(NEW.description FROM '^[^\n\r]+'),NEW.expense_category)||' ['||v_category_label||']';
  
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

  v_pph_treatment := COALESCE(NEW.pph_treatment, 'deduct');

  IF v_pph_treatment = 'add' THEN
    -- In Add (+), recipient is paid without deducting PPh; PPh is added on top
    v_net_payment := NEW.amount + COALESCE(NEW.ppn_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges;
    v_total := NEW.amount + COALESCE(NEW.ppn_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges + COALESCE(NEW.pph_amount,0);
  ELSE
    -- In Deduct (-), PPh is deducted from recipient payable
    v_net_payment := NEW.amount + COALESCE(NEW.ppn_amount,0) - COALESCE(NEW.pph_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges;
    v_total := NEW.amount + COALESCE(NEW.ppn_amount,0) + COALESCE(NEW.stamp_duty_amount,0) + v_bank_charges;
  END IF;

  v_journal_id:=public.upsert_expense_journal_header_in_place(
    v_journal_id,NEW.id,NEW.expense_date,v_description,NEW.expense_category,v_total,NEW.created_by);
  v_line_num:=1;

  -- 1. Debit underlying expense (gross amount stays distinct)
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_expense_account_id,NEW.amount,0,v_credit_desc,NEW.supplier_id,NEW.payee_id);
  v_line_num:=v_line_num+1;

  -- 2. Debit PPN (if applicable)
  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 3. Debit Stamp duty (if applicable)
  IF COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_stamp_duty_account_id,NEW.stamp_duty_amount,0,'Bea Meterai - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 4. Debit Bank charges (if applicable)
  IF v_bank_charges>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,'Bank charges ['||v_category_label||']',NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 5. If PPh is Add (+), debit the PPh tax component separately
  IF v_pph_treatment = 'add' AND COALESCE(NEW.pph_amount,0)>0 THEN
    IF NEW.expense_category = 'salary' THEN
      SELECT id INTO v_tax_benefit_account_id FROM public.chart_of_accounts WHERE code='6110' LIMIT 1;
      IF v_tax_benefit_account_id IS NULL THEN
        v_tax_benefit_account_id := v_expense_account_id;
      END IF;
    ELSE
      v_tax_benefit_account_id := v_expense_account_id;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_tax_benefit_account_id,NEW.pph_amount,0,'PPh Borne (Add-on) - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 6. Credit PPh Withholding liability
  IF COALESCE(NEW.pph_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,'PPh Ditahan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 7. Credit Payment account / AP
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment,v_credit_desc,NEW.supplier_id,NEW.payee_id);

  RETURN NEW;
END;
$function$;

-- 4. Update trigger_auto_post_expense_accounting_update to react to pph_treatment changes
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting_update ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting_update AFTER UPDATE ON public.finance_expenses FOR EACH ROW WHEN (
  (new.approval_status = 'approved'::text) AND
  (new.expense_category <> 'import_broker'::text) AND
  (COALESCE(current_setting('app.finance_historical_repair'::text, true), 'off'::text) <> 'on'::text) AND (
    (old.approval_status IS DISTINCT FROM new.approval_status) OR
    (old.amount IS DISTINCT FROM new.amount) OR
    (old.expense_category IS DISTINCT FROM new.expense_category) OR
    ((old.payment_method)::text IS DISTINCT FROM (new.payment_method)::text) OR
    (old.bank_account_id IS DISTINCT FROM new.bank_account_id) OR
    (old.ppn_amount IS DISTINCT FROM new.ppn_amount) OR
    (old.pph_amount IS DISTINCT FROM new.pph_amount) OR
    (old.pph_code_id IS DISTINCT FROM new.pph_code_id) OR
    (old.pph_treatment IS DISTINCT FROM new.pph_treatment) OR
    (old.stamp_duty_amount IS DISTINCT FROM new.stamp_duty_amount) OR
    (old.bank_charges_amount IS DISTINCT FROM new.bank_charges_amount) OR
    (old.fixed_asset_account_id IS DISTINCT FROM new.fixed_asset_account_id) OR
    (old.broker_items IS DISTINCT FROM new.broker_items) OR
    (old.description IS DISTINCT FROM new.description) OR
    (old.expense_date IS DISTINCT FROM new.expense_date)
  )
) EXECUTE FUNCTION auto_post_expense_accounting();

