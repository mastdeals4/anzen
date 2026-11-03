-- ==============================================================================
-- MIGRATION: 20261103000000_pib_subledger_reclassification_and_customs_payment_clearing.sql
-- Description: 
--   1. Historical PIB Reclassification: Forward-only reclassification of Rp 155,537,718.00
--      statutory customs AP out of Anzen Exports subledger into supplier_id = NULL.
--   2. Jul26 Mix Customs Payment Clearing: Record missing payment journal Dr AP 142,196,037.98,
--      Dr Rounding 0.02, Cr BCA Bank 142,196,038.00 (BSL 00ecc051-1118-471d-b58c-b57ed5525ac7).
--   3. Pregabalin Customs Payment Clearing: Record missing payment journal Dr AP 13,930,405.00,
--      Cr BCA Bank 13,930,405.00 (BSL 46d73481-2756-4ed2-8036-0f299822decd).
--   4. Future PIB Posting Engine Guard: Update auto_post_expense_accounting() so pib_import
--      expenses strictly post supplier_id = NULL to prevent trade AP contamination,
--      preserving 100% of existing function logic across all other categories.
-- Safeguards:
--   - Strict idempotency (IF NOT EXISTS guards).
--   - Deterministic admin user identity.
--   - Zero modification of historical posted journals.
--   - Comprehensive balance assertions at completion.
-- ==============================================================================

-- Part 1: Update auto_post_expense_accounting() to guarantee supplier_id = NULL for pib_import
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

  -- ── PIB IMPORT: Statutory Customs Obligations (Strictly supplier_id = NULL) ──
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
    -- Statutory duties and import taxes are liabilities to Kas Negara, NEVER trade vendor AP
    IF COALESCE(NEW.pib_bm_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_bm_account_id,NEW.pib_bm_amount,0,'PIB - Import Duty (BM) [landed cost]',NULL,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.pib_ppn_amount,0,'PIB - PPN Import (Input VAT)',NULL,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_pph_account_id,NEW.pib_pph_amount,0,'PIB - PPh 22 Dibayar Dimuka',NULL,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,NEW.amount,'PIB - Payment ['||COALESCE(NEW.description,'')||']',NULL,NEW.payee_id);
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

-- Part 2: Main Accounting Corrections Execution Block
DO $$
DECLARE
  v_admin_id uuid;
  v_ap_id uuid;
  v_bank_id uuid;
  v_duty_id uuid;
  v_period_aug uuid;
  v_period_nov uuid;
  v_anzen_id uuid := '8df2e209-0dc3-4ce4-8359-e619dace1d5f'::uuid;
  v_jul_voucher_id uuid := 'c0682356-2f3c-478b-be86-0c07e07c9c5b'::uuid;
  v_preg_voucher_id uuid := 'ad2b26be-4252-4eab-b151-bbada6e9403d'::uuid;
  v_bsl_jul_id uuid := '00ecc051-1118-471d-b58c-b57ed5525ac7'::uuid;
  v_bsl_preg_id uuid := '46d73481-2756-4ed2-8036-0f299822decd'::uuid;
  v_reclass_je_id uuid;
  v_jul_pay_je_id uuid;
  v_preg_pay_je_id uuid;
  v_active_gl2110 numeric;
  v_active_gl111101 numeric;
  v_active_gl1150 numeric;
  v_active_gl1155 numeric;
  v_active_anzen_ap numeric;
  v_active_unassigned_ap numeric;
  v_statutory_customs_ap numeric;
BEGIN
  -- 0. Deterministic Admin User Profile
  SELECT id INTO v_admin_id 
  FROM public.user_profiles 
  WHERE role = 'admin' AND is_active = true 
  ORDER BY email ASC 
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Fatal: No active admin user profile found for posting identity';
  END IF;

  -- 1. Resolve Account IDs
  SELECT id INTO v_ap_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
  SELECT id INTO v_bank_id FROM public.chart_of_accounts WHERE code = '111101' LIMIT 1;
  SELECT id INTO v_duty_id FROM public.chart_of_accounts WHERE code = '5200' LIMIT 1;

  IF v_ap_id IS NULL OR v_bank_id IS NULL OR v_duty_id IS NULL THEN
    RAISE EXCEPTION 'Fatal: Missing required COA account (2110, 111101, or 5200)';
  END IF;

  -- 2. Resolve Accounting Periods
  SELECT id INTO v_period_aug 
  FROM public.accounting_periods 
  WHERE fiscal_year = 2026 AND period_month = 8 
  LIMIT 1;

  SELECT id INTO v_period_nov 
  FROM public.accounting_periods 
  WHERE fiscal_year = 2026 AND period_month = 11 
  LIMIT 1;

  -- ============================================================================
  -- CORRECTION A: Forward-Only PIB Subledger Reclassification
  -- ============================================================================
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-RECLASS-PIB-SUBLEDGER') THEN
    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_number,
      description, total_debit, total_credit, is_posted, created_by, posted_by, posted_at,
      transaction_category, transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      'JE2611-RECLASS-PIB-SUBLEDGER', '2026-11-03', v_period_nov, 'journal', 'RECLASS-PIB-EXP25-234-EXP26-141-EXP26-221',
      'Reclassify open statutory customs liabilities out of Anzen Exports subledger', 155537718.00, 155537718.00,
      true, v_admin_id, v_admin_id, now(), 'adjustment', 'IDR', 'IDR', 1.0, true
    ) RETURNING id INTO v_reclass_je_id;

    INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description, supplier_id)
    VALUES 
      (v_reclass_je_id, 1, v_ap_id, 155537718.00, 0.00, 'Reclassify open statutory customs liabilities out of Anzen Exports subledger (EXP/25/234, EXP/26-26/141, EXP/26/221)', v_anzen_id),
      (v_reclass_je_id, 2, v_ap_id, 0.00, 155537718.00, 'Statutory customs AP liability reclassified from Anzen Exports (Billing codes 640251103497462, 640260805760329, 640260805810981)', NULL);

    RAISE NOTICE 'Applied JE2611-RECLASS-PIB-SUBLEDGER: Dr 2110 [Anzen] / Cr 2110 [NULL] Rp 155,537,718.00';
  ELSE
    RAISE NOTICE 'Skipping JE2611-RECLASS-PIB-SUBLEDGER: already exists';
  END IF;

  -- ============================================================================
  -- CORRECTION B: Jul26 Mix Customs Payment Clearing
  -- ============================================================================
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-PAY-JUL26-DUTY') THEN
    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_number, reference_id,
      description, total_debit, total_credit, is_posted, created_by, posted_by, posted_at,
      transaction_category, transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      'JE2611-PAY-JUL26-DUTY', '2026-08-06', v_period_aug, 'expense_payment', 'EXP-PAY-00ecc051-JUL26-MIX', v_jul_voucher_id,
      'Bank payment for PIB Jul26 Mix billing code 640260805810981', 142196038.00, 142196038.00,
      true, v_admin_id, v_admin_id, now(), 'payment', 'IDR', 'IDR', 1.0, true
    ) RETURNING id INTO v_jul_pay_je_id;

    INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description, supplier_id)
    VALUES 
      (v_jul_pay_je_id, 1, v_ap_id, 142196037.98, 0.00, 'Settlement of Jul26 Mix customs liability (Billing code 640260805810981)', NULL),
      (v_jul_pay_je_id, 2, v_duty_id, 0.02, 0.00, 'Billing code rounding adjustment: 640260805810981', NULL),
      (v_jul_pay_je_id, 3, v_bank_id, 0.00, 142196038.00, 'Bank payment for PIB Jul26 Mix billing code 640260805810981 (BSL 00ecc051-1118-471d-b58c-b57ed5525ac7)', NULL);

    UPDATE public.bank_statement_lines
    SET matched_entry_id = v_jul_pay_je_id
    WHERE id = v_bsl_jul_id;

    RAISE NOTICE 'Applied JE2611-PAY-JUL26-DUTY: Dr 2110 [NULL] Rp 142,196,037.98, Dr 5200 Rp 0.02, Cr 111101 Rp 142,196,038.00';
  ELSE
    RAISE NOTICE 'Skipping JE2611-PAY-JUL26-DUTY: already exists';
  END IF;

  -- ============================================================================
  -- CORRECTION C: Pregabalin Customs Payment Clearing
  -- ============================================================================
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-PAY-PREGABALIN-DUTY') THEN
    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_number, reference_id,
      description, total_debit, total_credit, is_posted, created_by, posted_by, posted_at,
      transaction_category, transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      'JE2611-PAY-PREGABALIN-DUTY', '2026-08-03', v_period_aug, 'expense_payment', 'EXP-PAY-46d73481-PREGABALIN', v_preg_voucher_id,
      'Bank payment for PIB Pregabalin billing code 640260805760329', 13930405.00, 13930405.00,
      true, v_admin_id, v_admin_id, now(), 'payment', 'IDR', 'IDR', 1.0, true
    ) RETURNING id INTO v_preg_pay_je_id;

    INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description, supplier_id)
    VALUES 
      (v_preg_pay_je_id, 1, v_ap_id, 13930405.00, 0.00, 'Settlement of Pregabalin customs liability (Billing code 640260805760329)', NULL),
      (v_preg_pay_je_id, 2, v_bank_id, 0.00, 13930405.00, 'Bank payment for PIB Pregabalin billing code 640260805760329 (BSL 46d73481-2756-4ed2-8036-0f299822decd)', NULL);

    UPDATE public.bank_statement_lines
    SET matched_entry_id = v_preg_pay_je_id
    WHERE id = v_bsl_preg_id;

    RAISE NOTICE 'Applied JE2611-PAY-PREGABALIN-DUTY: Dr 2110 [NULL] Rp 13,930,405.00, Cr 111101 Rp 13,930,405.00';
  ELSE
    RAISE NOTICE 'Skipping JE2611-PAY-PREGABALIN-DUTY: already exists';
  END IF;

  -- ============================================================================
  -- POST-CORRECTION AUDIT ASSERTIONS (AUTHORITATIVE ACTIVE TRIAL BALANCE)
  -- ============================================================================
  SELECT sum(credit - debit) INTO v_active_gl2110
  FROM public.journal_entry_lines jel 
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id 
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE coa.code = '2110' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);

  SELECT sum(debit - credit) INTO v_active_gl111101
  FROM public.journal_entry_lines jel 
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id 
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE coa.code = '111101' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);

  SELECT sum(debit - credit) INTO v_active_gl1150
  FROM public.journal_entry_lines jel 
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id 
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE coa.code = '1150' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);

  SELECT sum(debit - credit) INTO v_active_gl1155
  FROM public.journal_entry_lines jel 
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id 
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE coa.code = '1155' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);

  SELECT sum(credit - debit) INTO v_active_anzen_ap
  FROM public.journal_entry_lines jel 
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id 
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE coa.code = '2110' AND jel.supplier_id = v_anzen_id AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);

  SELECT sum(credit - debit) INTO v_active_unassigned_ap
  FROM public.journal_entry_lines jel 
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id 
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE coa.code = '2110' AND jel.supplier_id IS NULL AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);

  v_statutory_customs_ap := v_active_unassigned_ap - 23966441.00;

  IF v_active_gl2110 <> 5861389183.00 THEN
    RAISE EXCEPTION 'Assertion Failed: Active GL 2110 balance (%) does not match expected 5861389183.00', v_active_gl2110;
  END IF;

  IF v_active_gl111101 <> 1080961657.11 THEN
    RAISE EXCEPTION 'Assertion Failed: Active GL 111101 balance (%) does not match expected 1080961657.11', v_active_gl111101;
  END IF;

  IF v_active_gl1150 <> 874746899.50 THEN
    RAISE EXCEPTION 'Assertion Failed: Active GL 1150 balance (%) does not match expected 874746899.50', v_active_gl1150;
  END IF;

  IF v_active_gl1155 <> 194669147.00 THEN
    RAISE EXCEPTION 'Assertion Failed: Active GL 1155 balance (%) does not match expected 194669147.00', v_active_gl1155;
  END IF;

  IF v_active_anzen_ap <> 5749719842.00 THEN
    RAISE EXCEPTION 'Assertion Failed: Anzen Exports AP balance (%) does not match expected 5749719842.00', v_active_anzen_ap;
  END IF;

  IF v_active_unassigned_ap <> 24010141.00 THEN
    RAISE EXCEPTION 'Assertion Failed: Total active unassigned GL 2110 balance (%) does not match expected 24010141.00', v_active_unassigned_ap;
  END IF;

  IF v_statutory_customs_ap <> 43700.00 THEN
    RAISE EXCEPTION 'Assertion Failed: Remaining Statutory Customs AP on NULL (%) does not match expected 43700.00', v_statutory_customs_ap;
  END IF;

  RAISE NOTICE 'SUCCESS: All active post-correction control balances verified to exact cent.';
END $$;
