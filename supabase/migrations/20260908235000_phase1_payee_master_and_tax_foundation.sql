-- Migration: 20260908235000_phase1_payee_master_and_tax_foundation.sql
-- Description: Phase 1 database foundation for Payee Master and PPh 21 tax architecture.
--              Introduces public.finance_payees, canonical PPh 21 calculation regimes in tax_codes,
--              snapshot columns in finance_expenses, payee attribution on journal_entry_lines,
--              and hardens auto_post_expense_accounting() to eliminate silent fallbacks to PPh 23.
-- Zero retrospective accounting changes; preserves all closed periods and reconciliations.

BEGIN;

-- 1. Create Enums for Business Role and DJP Tax Classification
DO $$ BEGIN
    CREATE TYPE public.payee_business_role AS ENUM (
        'sales_commission_recipient',
        'tax_consultant',
        'legal_counsel',
        'notary',
        'warehouse_labor',
        'property_owner',
        'freelance_specialist'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE public.payee_tax_classification AS ENUM (
        'bukan_pegawai_imbalan',
        'tenaga_ahli',
        'pegawai_tidak_tetap',
        'pemilik_sewa_op'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. Create Table: finance_payees
CREATE TABLE IF NOT EXISTS public.finance_payees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payee_code TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    business_role public.payee_business_role NOT NULL,
    tax_classification public.payee_tax_classification NOT NULL,
    nik VARCHAR(16) NULL,
    npwp VARCHAR(20) NULL,
    ptkp_status VARCHAR(10) NOT NULL DEFAULT 'TK/0',
    default_pph_code_id UUID NULL REFERENCES public.tax_codes(id),
    bank_name TEXT NULL,
    bank_account_number TEXT NULL,
    bank_account_holder TEXT NULL,
    phone TEXT NULL,
    email TEXT NULL,
    address TEXT NULL,
    notes TEXT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_payees_role ON public.finance_payees(business_role);
CREATE INDEX IF NOT EXISTS idx_finance_payees_classification ON public.finance_payees(tax_classification);
CREATE INDEX IF NOT EXISTS idx_finance_payees_active ON public.finance_payees(is_active);

-- Enable RLS on finance_payees
ALTER TABLE public.finance_payees ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Allow authenticated read on finance_payees"
        ON public.finance_payees FOR SELECT
        TO authenticated
        USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Allow authenticated insert/update on finance_payees"
        ON public.finance_payees FOR ALL
        TO authenticated
        USING (true)
        WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 3. Insert Canonical PPh 21 Calculation Regimes into tax_codes
-- Account 2131 PPh 21 Payable is 5f1dc2bc-c988-40ce-a827-ae6bd5aa6ca2
INSERT INTO public.tax_codes (
    code, name, tax_type, rate, is_withholding, payment_account_id, is_active
) VALUES (
    'PPH21-NE',
    'PPh 21 - Bukan Pegawai & Tenaga Ahli (DPP 50% / Pasal 17)',
    'PPh21',
    0.00,
    true,
    '5f1dc2bc-c988-40ce-a827-ae6bd5aa6ca2',
    true
) ON CONFLICT (code) DO UPDATE SET
    payment_account_id = EXCLUDED.payment_account_id,
    name = EXCLUDED.name,
    tax_type = EXCLUDED.tax_type,
    is_withholding = true,
    is_active = true;

INSERT INTO public.tax_codes (
    code, name, tax_type, rate, is_withholding, payment_account_id, is_active
) VALUES (
    'PPH21-TT',
    'PPh 21 - Pegawai Tidak Tetap (TER Harian / Bebas Pajak)',
    'PPh21',
    0.00,
    true,
    '5f1dc2bc-c988-40ce-a827-ae6bd5aa6ca2',
    true
) ON CONFLICT (code) DO UPDATE SET
    payment_account_id = EXCLUDED.payment_account_id,
    name = EXCLUDED.name,
    tax_type = EXCLUDED.tax_type,
    is_withholding = true,
    is_active = true;

-- 4. Extend finance_expenses with Snapshot & Attribution Columns
ALTER TABLE public.finance_expenses
    ADD COLUMN IF NOT EXISTS payee_id UUID NULL REFERENCES public.finance_payees(id),
    ADD COLUMN IF NOT EXISTS pph_calculation_regime TEXT NULL,
    ADD COLUMN IF NOT EXISTS pph_dpp_ratio NUMERIC(5,4) NULL,
    ADD COLUMN IF NOT EXISTS pph_dpp_amount NUMERIC(15,2) NULL,
    ADD COLUMN IF NOT EXISTS pph_rate NUMERIC(5,2) NULL,
    ADD COLUMN IF NOT EXISTS is_tax_manual_override BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS linked_sales_invoice_id UUID NULL REFERENCES public.sales_invoices(id);

CREATE INDEX IF NOT EXISTS idx_finance_expenses_payee ON public.finance_expenses(payee_id);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_linked_si ON public.finance_expenses(linked_sales_invoice_id);

-- 5. Extend journal_entry_lines with payee_id
ALTER TABLE public.journal_entry_lines
    ADD COLUMN IF NOT EXISTS payee_id UUID NULL REFERENCES public.finance_payees(id);

CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_payee ON public.journal_entry_lines(payee_id);

-- 6. Harden fn_pph_payable_account_id: Strict Resolution, ZERO Silent Fallback
CREATE OR REPLACE FUNCTION public.fn_pph_payable_account_id(p_tax_code_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account_id uuid;
  v_tax_type text;
BEGIN
  IF p_tax_code_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Direct resolution from tax_codes.payment_account_id
  SELECT payment_account_id, tax_type INTO v_account_id, v_tax_type
    FROM public.tax_codes
   WHERE id = p_tax_code_id;

  IF v_account_id IS NOT NULL THEN
    RETURN v_account_id;
  END IF;

  -- 2. Fallback to tax_type mapped COA code if payment_account_id was not populated
  IF v_tax_type = 'PPh21' THEN
    SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '2131' LIMIT 1;
  ELSIF v_tax_type = 'PPh22' THEN
    SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '2137' LIMIT 1;
  ELSIF v_tax_type = 'PPh23' THEN
    SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '2132' LIMIT 1;
  ELSIF v_tax_type = 'PPh4(2)' THEN
    SELECT id INTO v_account_id FROM public.chart_of_accounts WHERE code = '2138' LIMIT 1;
  ELSE
    v_account_id := NULL; -- Strict: unknown tax type returns NULL, NO silent fallback to 2132!
  END IF;

  RETURN v_account_id;
END;
$$;

-- 7. Harden auto_post_expense_accounting: Abort on Missing/Invalid Withholding Tax Code
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

  -- 1. Debit Expense
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_expense_account_id,NEW.amount,0,v_credit_desc,NEW.supplier_id,NEW.payee_id);
  v_line_num:=v_line_num+1;

  -- 2. Debit PPN Masukan
  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 3. Debit Stamp Duty
  IF COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_stamp_duty_account_id,NEW.stamp_duty_amount,0,'Bea Meterai - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 4. Debit Bank Charges
  IF v_bank_charges>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,'Bank charges ['||v_category_label||']',NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 5. Credit PPh Ditahan
  IF COALESCE(NEW.pph_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,'PPh Ditahan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  -- 6. Credit Payment / AP Account
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment,v_credit_desc,NEW.supplier_id,NEW.payee_id);

  RETURN NEW;
END;
$function$;

-- 8. Harden trg_sync_expense_pph_account to prevent fallback and copy payee_id
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

-- 9. Update validate_non_permanent_employee_fee to support Payee Master
CREATE OR REPLACE FUNCTION public.validate_non_permanent_employee_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_pph21_code uuid;
BEGIN
  IF NEW.expense_category = 'non_permanent_employee_fee' THEN
    -- If supplier_id is provided instead of payee_id, ensure it is an individual supplier
    IF NEW.supplier_id IS NOT NULL AND NEW.payee_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.suppliers s
      WHERE s.id = NEW.supplier_id
        AND lower(COALESCE(s.supplier_type,'')) IN (
          'employee','non-permanent individual','freelancer','casual worker','honorarium recipient'
        )
    ) THEN
      RAISE EXCEPTION 'Non-Permanent Employee Fee is intended for an individual subject to PPh 21, not a company supplier';
    END IF;

    -- Default only. An explicit accountant-selected tax code is preserved.
    IF NEW.pph_code_id IS NULL THEN
      SELECT id INTO v_pph21_code FROM public.tax_codes
      WHERE tax_type = 'PPh21' AND is_withholding = true
      ORDER BY (code = 'PPH21-NE') DESC, (code = 'PPH21') DESC, code LIMIT 1;
      IF v_pph21_code IS NULL THEN
        RAISE EXCEPTION 'PPh21 tax code is not configured';
      END IF;
      NEW.pph_code_id := v_pph21_code;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;
