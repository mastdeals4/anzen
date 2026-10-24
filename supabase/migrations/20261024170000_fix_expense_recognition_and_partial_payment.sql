-- Migration: 20261024170000_fix_expense_recognition_and_partial_payment.sql
-- Description: Enforce proper Expense Recognition vs Partial Payment accounting:
-- 1. All non-cash payment methods credit Accounts Payable (2110) at expense recognition.
--    No bank account is credited on expense approval.
-- 2. Payment vouchers in draft (unposted) do NOT affect paid_amount; only confirmed, posted PVs count.
-- 3. Link bank statement line detects existing posted payment voucher journals, preventing duplicate bank credits.
-- 4. Customs broker canonical posting respects AP liability when payment method is non-cash.

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

  -- Payment / Liability Account Resolution:
  -- Only immediate physical cash / petty cash credits cash box accounts directly.
  -- ALL other methods (bank_transfer, check, giro, other, outstanding, null) MUST credit Accounts Payable (2110).
  -- Bank accounts are NEVER credited at expense recognition time.
  IF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='1101' LIMIT 1;
  ELSIF NEW.payment_method = 'petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='1102' LIMIT 1;
  ELSE
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
  v_credit_desc:=COALESCE(substring(NEW.description FROM '^[^\n]+'),NEW.expense_category)||' ['||v_category_label||']';
  
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

CREATE OR REPLACE FUNCTION public.post_customs_broker_canonical()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_je uuid;
  v_expense_account uuid;
  v_ppn_account uuid;
  v_pph_account uuid;
  v_stamp_account uuid;
  v_ap_account uuid;
  v_cash_account uuid;
  v_item jsonb;
  v_supplier uuid;
  v_line_total numeric;
  v_line_ppn numeric;
  v_line_no int := 1;
  v_reimbursement numeric := 0;
  v_expense_total numeric;
  v_pph numeric := COALESCE(NEW.pph_amount,0);
  v_credit_total numeric;
  v_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method NOT IN ('cash','petty_cash');
BEGIN
  IF NEW.expense_category <> 'import_broker' THEN RETURN NEW; END IF;

  SELECT id INTO v_je
    FROM public.journal_entries
   WHERE source_module IN ('expense','expenses')
     AND (reference_id = NEW.id OR reference_number = 'EXP-'||NEW.id::text)
     AND is_posted = true
     AND NOT COALESCE(is_reversed, false)
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  IF v_je IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_je;
  END IF;

  SELECT id INTO v_expense_account FROM public.chart_of_accounts WHERE code='1130' LIMIT 1;
  SELECT id INTO v_ppn_account      FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
  SELECT id INTO v_pph_account      FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_stamp_account     FROM public.chart_of_accounts WHERE code='1130' LIMIT 1;
  SELECT id INTO v_ap_account        FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;

  IF NEW.payment_method='cash' THEN
    SELECT id INTO v_cash_account FROM public.chart_of_accounts WHERE code='1101' LIMIT 1;
  ELSIF NEW.payment_method='petty_cash' THEN
    SELECT id INTO v_cash_account FROM public.chart_of_accounts WHERE code='1102' LIMIT 1;
  ELSE
    SELECT id INTO v_cash_account FROM public.chart_of_accounts WHERE code='1101' LIMIT 1;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_reimbursement := v_reimbursement + public.broker_reimbursement_line_total(v_item);
  END LOOP;

  v_expense_total := COALESCE(NEW.amount,0) + v_reimbursement + COALESCE(NEW.stamp_duty_amount,0);
  v_credit_total := v_expense_total;

  v_je := public.upsert_expense_journal_header_in_place(
    v_je, NEW.id, NEW.expense_date,
    COALESCE(NEW.description, 'Customs Broker Invoice'),
    'import_broker', v_credit_total, NEW.created_by
  );

  v_line_total := COALESCE(NEW.amount,0) - COALESCE(NEW.ppn_amount,0);
  IF v_line_total <> 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_expense_account,'Broker service expense',v_line_total,0,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier := COALESCE(NULLIF(v_item->>'supplier_id','')::uuid, NEW.supplier_id);
    v_line_total := public.broker_reimbursement_expense_base(v_item);
    IF v_line_total <> 0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_expense_account,'Reimbursement expense',v_line_total,0,v_supplier);
      v_line_no := v_line_no + 1;
    END IF;
  END LOOP;

  IF COALESCE(NEW.ppn_amount,0) > 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_ppn_account,'Recoverable PPN - broker invoice',NEW.ppn_amount,0,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.broker_items,'[]'::jsonb)) LOOP
    v_supplier := COALESCE(NULLIF(v_item->>'supplier_id','')::uuid, NEW.supplier_id);
    v_line_ppn := COALESCE((v_item->>'ppn_amount')::numeric,0);
    IF v_line_ppn > 0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
      VALUES(v_je,v_line_no,v_ppn_account,'Recoverable PPN - reimbursement',v_line_ppn,0,v_supplier);
      v_line_no := v_line_no + 1;
    END IF;
  END LOOP;

  IF COALESCE(NEW.stamp_duty_amount,0) > 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_stamp_account,'Stamp duty',NEW.stamp_duty_amount,0,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  IF v_pph > 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,v_pph_account,'PPh23 withheld',0,v_pph,NEW.supplier_id);
    v_line_no := v_line_no + 1;
  END IF;

  v_line_total := v_expense_total - v_pph;
  IF v_line_total <> 0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line_no,
    CASE WHEN v_outstanding THEN v_ap_account ELSE v_cash_account END,
    CASE WHEN v_outstanding THEN 'Supplier payable - customs broker' ELSE 'Cash payment - customs broker' END,
    0, v_line_total, NEW.supplier_id);
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.normalize_unlinked_expense_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(current_setting('app.finance_historical_repair', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.payment_method, NEW.bank_account_id, NEW.paid_by) IS NOT DISTINCT FROM (OLD.payment_method, OLD.bank_account_id, OLD.paid_by) THEN
    RETURN NEW;
  END IF;
  IF NEW.payment_method IN ('bank_transfer', 'check', 'giro', 'other')
     AND COALESCE(current_setting('app.expense_atomic_bank_link', true), 'off') <> 'on' THEN
    NEW.payment_method := NULL;
    NEW.bank_account_id := NULL;
    NEW.paid_by := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_supplier_paid numeric := 0;
  v_pph_paid numeric := 0;
  v_payable numeric := 0;
  v_target_paid numeric;
  v_target_pph_paid numeric;
BEGIN
  IF public.historical_repair_context_active() THEN RETURN; END IF;

  -- Only count confirmed, posted payment vouchers towards paid_amount
  SELECT COALESCE(sum(va.allocated_amount),0) INTO v_supplier_paid
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id
     AND COALESCE(va.payment_kind,'supplier')='supplier'
     AND pv.is_posted = true
     AND COALESCE(pv.payment_purpose,'general') NOT IN ('salary_advance','salary_advance_settlement');

  SELECT v_supplier_paid+COALESCE(sum(allocation_amount),0) INTO v_supplier_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id
     AND COALESCE(payment_kind,'supplier')='supplier';

  SELECT v_supplier_paid+COALESCE(sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)),0) INTO v_supplier_paid
    FROM public.bank_statement_lines b
   WHERE b.matched_expense_id=p_expense_id AND b.payment_kind='supplier'
     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id);

  -- Include posted salary advance applications (advance recovery)
  SELECT v_supplier_paid+COALESCE(sum(sa.applied_amount),0) INTO v_supplier_paid
    FROM public.salary_advance_applications sa
    JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
   WHERE sa.salary_expense_id = p_expense_id AND settlement.is_posted = true;

  -- Only count confirmed, posted payment vouchers towards pph_paid_amount
  SELECT COALESCE(sum(allocated_amount),0) INTO v_pph_paid
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id AND va.payment_kind='pph23'
     AND pv.is_posted = true;

  SELECT v_pph_paid+COALESCE(sum(allocation_amount),0) INTO v_pph_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='pph23';

  v_payable := COALESCE(public.calculate_finance_expense_payable(p_expense_id),0);
  v_target_paid := LEAST(GREATEST(v_supplier_paid,0),GREATEST(v_payable,0));
  v_target_pph_paid := GREATEST(v_pph_paid,0);

  UPDATE public.finance_expenses
     SET paid_amount=v_target_paid,
         pph_paid_amount=v_target_pph_paid
   WHERE id=p_expense_id
     AND (paid_amount IS DISTINCT FROM v_target_paid OR pph_paid_amount IS DISTINCT FROM v_target_pph_paid);
END;
$function$;

CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,
  p_document_type text,
  p_document_id uuid,
  p_payment_kind text DEFAULT 'supplier'::text,
  p_allocation_amount numeric DEFAULT NULL::numeric
)
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
  v_allocate:=round(COALESCE(NULLIF(p_allocation_amount,0),LEAST(v_bank_remaining,v_doc_remaining)),2);
  IF v_allocate<=0.01 THEN RAISE EXCEPTION 'No remaining amount is available to allocate'; END IF;
  IF v_allocate>v_bank_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds remaining bank amount'; END IF;
  IF v_allocate>v_doc_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds document outstanding amount'; END IF;

  IF p_document_type='expense' THEN
    IF EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=p_bank_line_id AND a.document_type='expense' AND a.document_id=p_document_id AND a.payment_kind=COALESCE(p_payment_kind,'supplier')) THEN
      RAISE EXCEPTION 'This expense allocation already exists';
    END IF;

    -- Look for an existing valid payment journal that already credited the bank account for this expense
    -- either from a direct EXP-PAY journal or from an already-posted Payment Voucher allocated to this expense
    SELECT je.id INTO v_existing_payment_je
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
     WHERE (
       je.reference_id = p_document_id
       OR je.reference_number IN ('EXP-' || p_document_id::text, 'EXP-PAY-' || p_document_id::text, v_expense.voucher_number)
       OR je.id IN (
         SELECT pv.journal_entry_id
           FROM public.voucher_allocations va
           JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
          WHERE va.finance_expense_id = p_document_id
            AND pv.is_posted = true
       )
     )
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
