-- Migration: 20260909001000_phase4_historical_payee_backfill.sql
-- Description: Phase 4 Historical Payee Master creation, metadata-only backfill of 12 posted historical expenses,
--              correction of 5 unposted Faizah expenses to PPh 21 non-employee regime, and trigger safeguards.
--              Zero changes to historical posted debits/credits, bank reconciliations, petty cash, or loan balances.

BEGIN;

-- 1. Ensure trigger functions respect the 'app.finance_metadata_repair' bypass flag
CREATE OR REPLACE FUNCTION public.enforce_tax_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF (current_setting('app.finance_metadata_repair', true) = 'on') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF (current_setting('request.jwt.claim.role', true) = 'service_role') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    IF (COALESCE(OLD.tax_period_id, NULL) IS NOT NULL) THEN
      SELECT status INTO v_status FROM tax_periods WHERE id = OLD.tax_period_id;
      IF v_status = 'closed' THEN
        RAISE EXCEPTION 'Tax period is closed; cannot modify % on %',
          TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.tax_period_id IS NOT NULL THEN
      SELECT status INTO v_status FROM tax_periods WHERE id = NEW.tax_period_id;
      IF v_status = 'closed' THEN
        RAISE EXCEPTION 'Tax period is closed; cannot assign new rows to it'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $function$;

-- Update auto_post_expense_accounting to respect app.finance_metadata_repair
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
  -- Bypass completely during historical metadata repair
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

  IF NEW.payment_method='outstanding' THEN
    IF NEW.expense_category='salary' THEN
      SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2120' LIMIT 1;
      IF v_payment_account_id IS NULL THEN RAISE EXCEPTION 'Salaries Payable account 2120 is missing'; END IF;
    ELSE
      SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
      IF v_payment_account_id IS NULL THEN RAISE EXCEPTION 'Accounts Payable account 2110 is missing'; END IF;
    END IF;
  ELSE
    IF NEW.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'A paid expense requires bank_account_id';
    END IF;
    SELECT coa_id INTO v_payment_account_id FROM public.bank_accounts WHERE id=NEW.bank_account_id;
    IF v_payment_account_id IS NULL THEN
      RAISE EXCEPTION 'The selected bank account has no linked Chart of Accounts mapping';
    END IF;
  END IF;

  IF NEW.expense_category='pib_import' THEN
    SELECT id INTO v_bm_account_id FROM public.chart_of_accounts WHERE code='1130' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
    SELECT id INTO v_pph_account_id FROM public.chart_of_accounts WHERE code='1160' LIMIT 1;
    IF COALESCE(NEW.pib_bm_amount,0)>0 AND v_bm_account_id IS NULL THEN RAISE EXCEPTION 'BM account 1130 is missing'; END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN account 1150 is missing'; END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 AND v_pph_account_id IS NULL THEN RAISE EXCEPTION 'PPh 22 account 1160 is missing'; END IF;
    v_total:=COALESCE(NEW.pib_bm_amount,0)+COALESCE(NEW.pib_ppn_amount,0)+COALESCE(NEW.pib_pph_amount,0);
    IF v_total<>NEW.amount THEN
      RAISE EXCEPTION 'PIB components sum (%) must equal total expense amount (%)',v_total,NEW.amount;
    END IF;
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

  -- STRICT ZERO-FALLBACK RESOLUTION FOR WITHHOLDING TAX
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

  v_bank_charges:=COALESCE(NEW.bank_charges_amount,0);
  IF v_bank_charges>0 THEN
    SELECT id INTO v_bank_charge_acc_id FROM public.chart_of_accounts WHERE code='6900' LIMIT 1;
    IF v_bank_charge_acc_id IS NULL THEN RAISE EXCEPTION 'Bank charges account 6900 is missing'; END IF;
  END IF;

  v_net_payment:=(NEW.amount+COALESCE(NEW.ppn_amount,0)+COALESCE(NEW.stamp_duty_amount,0))-COALESCE(NEW.pph_amount,0);
  v_total:=NEW.amount+COALESCE(NEW.ppn_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;

  v_journal_id:=public.upsert_expense_journal_header_in_place(
    v_journal_id,NEW.id,NEW.expense_date,v_description,NEW.expense_category,v_total,NEW.created_by);

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,1,v_expense_account_id,NEW.amount,0,v_description,NEW.supplier_id,NEW.payee_id);
  v_line_num:=2;

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
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,'Biaya Transfer / Bank Charges - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF COALESCE(NEW.pph_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,'PPh Ditahan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment+v_bank_charges,v_credit_desc,NEW.supplier_id,NEW.payee_id);

  RETURN NEW;
END;
$function$;

-- Update trg_sync_expense_pph_account to respect app.finance_metadata_repair
CREATE OR REPLACE FUNCTION public.trg_sync_expense_pph_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_account_id uuid;
  v_journal_id uuid;
  v_line_number integer;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.expense_category = 'import_broker' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.pph_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_account_id := public.fn_pph_payable_account_id(NEW.pph_code_id);
  IF v_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_journal_id
    FROM public.journal_entries
   WHERE reference_id = NEW.id
     AND source_module IN ('expense', 'expenses')
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_journal_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines
     WHERE journal_entry_id = v_journal_id
       AND debit = 0
       AND description ILIKE 'PPh Ditahan%'
  ) THEN
    UPDATE public.journal_entry_lines
       SET account_id = v_account_id,
           payee_id = NEW.payee_id
     WHERE journal_entry_id = v_journal_id
       AND debit = 0
       AND description ILIKE 'PPh Ditahan%';
  ELSE
    UPDATE public.journal_entry_lines
       SET credit = credit - NEW.pph_amount
     WHERE id = (
       SELECT id FROM public.journal_entry_lines
        WHERE journal_entry_id = v_journal_id
          AND credit >= NEW.pph_amount
        ORDER BY credit DESC, line_number DESC
        LIMIT 1
     );

    SELECT COALESCE(MAX(line_number), 0) + 1 INTO v_line_number
      FROM public.journal_entry_lines
     WHERE journal_entry_id = v_journal_id;

    INSERT INTO public.journal_entry_lines
      (journal_entry_id, line_number, account_id, debit, credit, description, supplier_id, payee_id)
    VALUES
      (v_journal_id, v_line_number, v_account_id, 0, NEW.pph_amount,
       'PPh Ditahan - ' || COALESCE(NEW.description, NEW.voucher_number, 'Expense'),
       NEW.supplier_id, NEW.payee_id);
  END IF;

  UPDATE public.journal_entries
     SET total_debit = (SELECT COALESCE(SUM(debit), 0) FROM public.journal_entry_lines WHERE journal_entry_id = v_journal_id),
         total_credit = (SELECT COALESCE(SUM(credit), 0) FROM public.journal_entry_lines WHERE journal_entry_id = v_journal_id)
   WHERE id = v_journal_id;

  RETURN NEW;
END;
$function$;

-- 2. Execute Data Migration within Protected Metadata-Repair Context
DO $$
DECLARE
  v_pph21_ne_id uuid := '82c88cd1-a57e-4fa0-a94e-b0bb1863c190'::uuid;
  v_sheila_id uuid;
  v_ricardo_id uuid;
  v_rudi_id uuid;
  v_notaris_id uuid;
  v_roslina_id uuid;
  v_faizah_id uuid;
BEGIN
  -- Activate metadata-repair mode to suppress journal triggers and period lock exceptions
  PERFORM set_config('app.finance_metadata_repair', 'on', true);

  -- A. Create Payee Master Records
  -- 1. Sheila (Tax Consultant)
  INSERT INTO public.finance_payees (
    payee_code, full_name, business_role, tax_classification, default_pph_code_id, notes, is_active
  ) VALUES (
    'PAY-0001', 'Sheila', 'tax_consultant', 'tenaga_ahli', v_pph21_ne_id, 'Historical tax consultant', true
  )
  ON CONFLICT (payee_code) DO UPDATE 
    SET full_name = EXCLUDED.full_name,
        business_role = EXCLUDED.business_role,
        tax_classification = EXCLUDED.tax_classification,
        default_pph_code_id = EXCLUDED.default_pph_code_id
  RETURNING id INTO v_sheila_id;

  -- 2. Ricardo Suhendra W (Tax Consultant / Financial Statement Review)
  INSERT INTO public.finance_payees (
    payee_code, full_name, business_role, tax_classification, default_pph_code_id, notes, is_active
  ) VALUES (
    'PAY-0002', 'Ricardo Suhendra W', 'tax_consultant', 'tenaga_ahli', v_pph21_ne_id, 'Financial statements review consultant', true
  )
  ON CONFLICT (payee_code) DO UPDATE 
    SET full_name = EXCLUDED.full_name,
        business_role = EXCLUDED.business_role,
        tax_classification = EXCLUDED.tax_classification,
        default_pph_code_id = EXCLUDED.default_pph_code_id
  RETURNING id INTO v_ricardo_id;

  -- 3. Rudi Kartono (Sales Commission Recipient)
  INSERT INTO public.finance_payees (
    payee_code, full_name, business_role, tax_classification, default_pph_code_id, notes, is_active
  ) VALUES (
    'PAY-0003', 'Rudi Kartono', 'sales_commission_recipient', 'bukan_pegawai_imbalan', v_pph21_ne_id, 'Sales commission recipient', true
  )
  ON CONFLICT (payee_code) DO UPDATE 
    SET full_name = EXCLUDED.full_name,
        business_role = EXCLUDED.business_role,
        tax_classification = EXCLUDED.tax_classification,
        default_pph_code_id = EXCLUDED.default_pph_code_id
  RETURNING id INTO v_rudi_id;

  -- 4. Notaris (Notary)
  INSERT INTO public.finance_payees (
    payee_code, full_name, business_role, tax_classification, default_pph_code_id, notes, is_active
  ) VALUES (
    'PAY-0004', 'Notaris', 'notary', 'tenaga_ahli', v_pph21_ne_id, 'Notary professional legal services', true
  )
  ON CONFLICT (payee_code) DO UPDATE 
    SET full_name = EXCLUDED.full_name,
        business_role = EXCLUDED.business_role,
        tax_classification = EXCLUDED.tax_classification,
        default_pph_code_id = EXCLUDED.default_pph_code_id
  RETURNING id INTO v_notaris_id;

  -- 5. Roslina (Sales Commission Recipient)
  INSERT INTO public.finance_payees (
    payee_code, full_name, business_role, tax_classification, default_pph_code_id, notes, is_active
  ) VALUES (
    'PAY-0005', 'Roslina', 'sales_commission_recipient', 'bukan_pegawai_imbalan', v_pph21_ne_id, 'Marketing / sales commission recipient', true
  )
  ON CONFLICT (payee_code) DO UPDATE 
    SET full_name = EXCLUDED.full_name,
        business_role = EXCLUDED.business_role,
        tax_classification = EXCLUDED.tax_classification,
        default_pph_code_id = EXCLUDED.default_pph_code_id
  RETURNING id INTO v_roslina_id;

  -- 6. Faizah (Sales Commission Recipient)
  INSERT INTO public.finance_payees (
    payee_code, full_name, business_role, tax_classification, default_pph_code_id, notes, is_active
  ) VALUES (
    'PAY-0006', 'Faizah', 'sales_commission_recipient', 'bukan_pegawai_imbalan', v_pph21_ne_id, 'Sales commission recipient - PT RANIA', true
  )
  ON CONFLICT (payee_code) DO UPDATE 
    SET full_name = EXCLUDED.full_name,
        business_role = EXCLUDED.business_role,
        tax_classification = EXCLUDED.tax_classification,
        default_pph_code_id = EXCLUDED.default_pph_code_id
  RETURNING id INTO v_faizah_id;

  -- B. Backfill 12 Posted Historical Expenses (Metadata Only, Preserving Posted Accounting)
  -- 1. EXP/26/127 -> Sheila (Amount 2.700.000, DPP 1.350.000, PPh 67.500)
  UPDATE public.finance_expenses
     SET payee_id = v_sheila_id,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 1350000.00,
         pph_rate = 2.50
   WHERE voucher_number = 'EXP/26/127';

  -- 2. Ricardo Suhendra W (8 Records, Amount 2.000.000 each, DPP 1.000.000, PPh 50.000)
  UPDATE public.finance_expenses
     SET payee_id = v_ricardo_id,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 1000000.00,
         pph_rate = 2.50
   WHERE voucher_number IN (
     'EXP/26/203', 'EXP/26/204', 'EXP/26/200', 'EXP/26/199', 'EXP/26/201',
     'EXP/26-26/138', 'EXP/26/179', 'EXP/26/180'
   );

  -- 3. EXP/26/226 -> Rudi Kartono (Amount 17.880.000, DPP 8.940.000, PPh 447.000, SAPJ-26-035)
  UPDATE public.finance_expenses
     SET payee_id = v_rudi_id,
         linked_sales_invoice_id = '3e2652e2-ac33-4413-842e-37b6189736a4'::uuid,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 8940000.00,
         pph_rate = 2.50
   WHERE voucher_number = 'EXP/26/226';

  -- 4. EXP/26/224 -> Notaris (Amount 15.000.000, DPP 7.500.000, PPh 375.000)
  UPDATE public.finance_expenses
     SET payee_id = v_notaris_id,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 7500000.00,
         pph_rate = 2.50
   WHERE voucher_number = 'EXP/26/224';

  -- 5. EXP/26/223 -> Roslina (Amount 2.000.000, no tax withheld)
  UPDATE public.finance_expenses
     SET payee_id = v_roslina_id
   WHERE voucher_number = 'EXP/26/223';

  -- Attribute payee_id to journal_entry_lines for these 12 historical expenses
  -- Preserves line amounts, accounts, debits, credits, and journal checksums completely
  UPDATE public.journal_entry_lines jel
     SET payee_id = fe.payee_id
    FROM public.finance_expenses fe
    JOIN public.journal_entries je ON je.reference_id = fe.id
   WHERE jel.journal_entry_id = je.id
     AND fe.voucher_number IN (
       'EXP/26/127', 'EXP/26/203', 'EXP/26/204', 'EXP/26/200', 'EXP/26/199', 'EXP/26/201',
       'EXP/26-26/138', 'EXP/26/179', 'EXP/26/180', 'EXP/26/226', 'EXP/26/224', 'EXP/26/223'
     )
     AND jel.payee_id IS NULL;

  -- C. Correct 5 Unposted Faizah Expenses (Pending Approval, Currently Carrying PPH22)
  -- 1. EXP/26/236 (SAPJ 26-025, Amount 2.957.625, DPP 1.478.813, PPh 73.941)
  UPDATE public.finance_expenses
     SET payee_id = v_faizah_id,
         pph_code_id = v_pph21_ne_id,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 1478813.00,
         pph_rate = 2.50,
         pph_amount = 73941.00,
         is_tax_manual_override = false,
         linked_sales_invoice_id = 'bb5ed19a-66d9-4cb7-90b6-8694bc848052'::uuid,
         delivery_challan_id = '33bd7fbe-c9ec-4994-b335-7660eaaf63a8'::uuid
   WHERE voucher_number = 'EXP/26/236' AND approval_status = 'pending_approval';

  -- 2. EXP/26/237 (SAPJ 26-030, Amount 2.700.000, DPP 1.350.000, PPh 67.500)
  UPDATE public.finance_expenses
     SET payee_id = v_faizah_id,
         pph_code_id = v_pph21_ne_id,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 1350000.00,
         pph_rate = 2.50,
         pph_amount = 67500.00,
         is_tax_manual_override = false,
         linked_sales_invoice_id = '17a0aea3-5398-4733-8b52-068422a53290'::uuid,
         delivery_challan_id = '21953713-1c04-4fe4-9ff4-c6e6197044b9'::uuid
   WHERE voucher_number = 'EXP/26/237' AND approval_status = 'pending_approval';

  -- 3. EXP/26/238 (SAPJ 26-032, Amount 3.240.000, DPP 1.620.000, PPh 81.000)
  UPDATE public.finance_expenses
     SET payee_id = v_faizah_id,
         pph_code_id = v_pph21_ne_id,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 1620000.00,
         pph_rate = 2.50,
         pph_amount = 81000.00,
         is_tax_manual_override = false,
         linked_sales_invoice_id = '3300fde7-f257-4c5c-8f5e-f2780ca6600f'::uuid,
         delivery_challan_id = '4a82330e-68d8-4d0a-80b1-882ccfde7baf'::uuid
   WHERE voucher_number = 'EXP/26/238' AND approval_status = 'pending_approval';

  -- 4. EXP/26/239 (SAPJ 26-033, Amount 1.350.000, DPP 675.000, PPh 33.750)
  UPDATE public.finance_expenses
     SET payee_id = v_faizah_id,
         pph_code_id = v_pph21_ne_id,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 675000.00,
         pph_rate = 2.50,
         pph_amount = 33750.00,
         is_tax_manual_override = false,
         linked_sales_invoice_id = '1d6196ce-6e41-4ac3-8c2b-71260a77a214'::uuid,
         delivery_challan_id = '6f923dfe-1ced-4dd4-bb97-44a91808f355'::uuid
   WHERE voucher_number = 'EXP/26/239' AND approval_status = 'pending_approval';

  -- 5. EXP/26/240 (SAPJ 26-034, Amount 675.000, DPP 337.500, PPh 16.875)
  UPDATE public.finance_expenses
     SET payee_id = v_faizah_id,
         pph_code_id = v_pph21_ne_id,
         pph_calculation_regime = 'pasal17_dpp50',
         pph_dpp_ratio = 0.50,
         pph_dpp_amount = 337500.00,
         pph_rate = 2.50,
         pph_amount = 16875.00,
         is_tax_manual_override = false,
         linked_sales_invoice_id = '68017ca2-250d-494f-b9ee-cf4245cf367c'::uuid,
         delivery_challan_id = '64c2248d-b97c-43cf-8864-e1b95f3ae5d8'::uuid
   WHERE voucher_number = 'EXP/26/240' AND approval_status = 'pending_approval';

  -- Reset metadata-repair mode
  PERFORM set_config('app.finance_metadata_repair', 'off', true);
END $$;

COMMIT;
