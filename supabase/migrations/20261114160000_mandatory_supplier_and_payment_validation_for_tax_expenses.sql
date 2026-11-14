-- ============================================================================
-- Migration: 20261114160000_mandatory_supplier_and_payment_validation_for_tax_expenses.sql
-- Description:
--   Enforces mandatory Supplier / Payee and payment detail validation for tax expenses:
--   1. Any expense with PPN > 0 or PPh > 0 (excluding statutory Kas Negara pib_import)
--      MUST have a valid supplier_id, payee_id, or staff_id from master tables.
--      Manually typed names in descriptions or notes are strictly rejected.
--   2. If an expense is marked as paid, a valid payment method and bank account
--      is mandatory.
--   3. Unpaid / outstanding tax expenses are permitted as long as a valid
--      supplier/payee is selected (PPh period remains NULL until payment).
--   4. Enforces validation across save_finance_expense, edit_approved_finance_expense_atomic,
--      approve_finance_expense, auto_post_expense_accounting, and a row-level trigger.
--   5. Fixes the regression in save_finance_expense where payee_id was dropped.
-- ============================================================================

BEGIN;

-- 1. Helper / Trigger Function: Validate tax expense linkage at database level
CREATE OR REPLACE FUNCTION public.validate_tax_expense_linkage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Service role or repair bypass
  IF current_setting('app.finance_metadata_repair', true) = 'on'
     OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Statutory Rule: Any expense with PPN or PPh liabilities requires a valid party
  IF (COALESCE(NEW.ppn_amount, 0) > 0 OR COALESCE(NEW.pph_amount, 0) > 0)
     AND COALESCE(NEW.expense_category, '') <> 'pib_import' THEN
    IF NEW.supplier_id IS NULL AND NEW.payee_id IS NULL AND NEW.staff_id IS NULL THEN
      RAISE EXCEPTION 'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.'
        USING ERRCODE = 'check_violation';
    END IF;

    -- If marked as paid, require valid payment details
    IF (NEW.payment_method IS NOT NULL AND NEW.payment_method <> 'outstanding')
       OR COALESCE(NEW.paid_amount, 0) > 0.01 THEN
      IF NEW.payment_method IS NULL OR NEW.payment_method = 'outstanding' THEN
        RAISE EXCEPTION 'Please select a valid payment method for this paid expense.'
          USING ERRCODE = 'check_violation';
      END IF;

      IF NEW.payment_method = 'bank_transfer'
         AND NEW.bank_account_id IS NULL
         AND NEW.originating_bank_statement_line_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations bsa WHERE bsa.document_id = NEW.id) THEN
        RAISE EXCEPTION 'Please select a valid payment account for this paid expense.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_tax_expense_linkage ON public.finance_expenses;
CREATE TRIGGER trg_validate_tax_expense_linkage
  BEFORE INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.validate_tax_expense_linkage();

-- 2. Upgrade save_finance_expense to persist payee_id and validate tax linkages
CREATE OR REPLACE FUNCTION public.save_finance_expense(
  p_expense_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
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
  v_ppn_amt numeric;
  v_pph_amt numeric;
  v_cat text;
  v_sup_id uuid;
  v_payee_id uuid;
  v_staff_id uuid;
  v_pay_method text;
BEGIN
  v_date := COALESCE(NULLIF(p_payload->>'expense_date', '')::date, CURRENT_DATE);
  v_rate := COALESCE(NULLIF(p_payload->>'exchange_rate', '')::numeric, 1.0);
  v_currency := COALESCE(NULLIF(p_payload->>'currency_code', ''), 'IDR');
  v_bank_id := NULLIF(p_payload->>'bank_account_id', '')::uuid;
  v_orig_line_id := NULLIF(p_payload->>'originating_bank_statement_line_id', '')::uuid;
  v_pph_treatment := COALESCE(NULLIF(p_payload->>'pph_treatment', ''), 'deduct');
  v_cat := COALESCE(p_payload->>'expense_category', '');
  v_ppn_amt := COALESCE(NULLIF(p_payload->>'ppn_amount', '')::numeric, 0);
  v_pph_amt := COALESCE(NULLIF(p_payload->>'pph_amount', '')::numeric, 0);
  v_sup_id := NULLIF(p_payload->>'supplier_id', '')::uuid;
  v_payee_id := NULLIF(p_payload->>'payee_id', '')::uuid;
  v_staff_id := NULLIF(p_payload->>'staff_id', '')::uuid;
  v_pay_method := NULLIF(p_payload->>'payment_method', '');

  IF v_pph_treatment NOT IN ('deduct', 'add') THEN
    v_pph_treatment := 'deduct';
  END IF;

  -- Mandatory validation for tax expenses
  IF (v_ppn_amt > 0 OR v_pph_amt > 0) AND v_cat <> 'pib_import' THEN
    IF v_sup_id IS NULL AND v_payee_id IS NULL AND v_staff_id IS NULL THEN
      RAISE EXCEPTION 'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.'
        USING ERRCODE = 'check_violation';
    END IF;

    -- If marked as paid, require valid payment details
    IF (v_pay_method IS NOT NULL AND v_pay_method <> 'outstanding')
       OR COALESCE(NULLIF(p_payload->>'paid_amount', '')::numeric, 0) > 0.01 THEN
      IF v_pay_method IS NULL OR v_pay_method = 'outstanding' THEN
        RAISE EXCEPTION 'Please select a valid payment method for this paid expense.'
          USING ERRCODE = 'check_violation';
      END IF;

      IF v_pay_method = 'bank_transfer'
         AND v_bank_id IS NULL
         AND v_orig_line_id IS NULL
         AND (p_expense_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations WHERE document_id = p_expense_id)) THEN
        RAISE EXCEPTION 'Please select a valid payment account for this paid expense.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
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
      payment_reference, paid_by, document_urls, supplier_id, staff_id, payee_id,
      linked_sales_invoice_id, pph_calculation_regime, pph_dpp_ratio, pph_dpp_amount,
      pph_rate, is_tax_manual_override, invoice_number, due_date, broker_items,
      pib_bm_amount, pib_ppn_amount, pib_pph_amount, ppn_amount, ppn_manual_override,
      ppn_calc_mode, dpp_amount, ppn_rate, pph_amount, pph_code_id, pph_treatment,
      stamp_duty_amount, fixed_asset_account_id, bank_charges_amount, approval_status,
      created_by, currency_code, transaction_currency, functional_currency, exchange_rate,
      bank_account_currency, payment_currency, sales_order_allocations,
      originating_bank_statement_line_id
    ) VALUES (
      public.next_expense_voucher_number(v_date), v_cat,
      COALESCE(NULLIF(p_payload->>'expense_type',''), 'admin'), (p_payload->>'amount')::numeric,
      v_date, NULLIF(p_payload->>'description',''), NULLIF(p_payload->>'batch_id','')::uuid,
      NULLIF(p_payload->>'import_container_id','')::uuid, NULLIF(p_payload->>'delivery_challan_id','')::uuid,
      v_pay_method, v_bank_id, NULLIF(p_payload->>'payment_reference',''),
      NULLIF(p_payload->>'paid_by',''), NULLIF(v_docs, ARRAY[]::text[]),
      v_sup_id, v_staff_id, v_payee_id,
      NULLIF(p_payload->>'linked_sales_invoice_id', '')::uuid,
      NULLIF(p_payload->>'pph_calculation_regime', ''),
      NULLIF(p_payload->>'pph_dpp_ratio', '')::numeric,
      NULLIF(p_payload->>'pph_dpp_amount', '')::numeric,
      NULLIF(p_payload->>'pph_rate', '')::numeric,
      COALESCE((p_payload->>'is_tax_manual_override')::boolean, false),
      NULLIF(p_payload->>'invoice_number',''), NULLIF(p_payload->>'due_date','')::date,
      NULLIF(p_payload->'broker_items','null'::jsonb), NULLIF(p_payload->>'pib_bm_amount','')::numeric,
      NULLIF(p_payload->>'pib_ppn_amount','')::numeric, NULLIF(p_payload->>'pib_pph_amount','')::numeric,
      v_ppn_amt, COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
      COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'), NULLIF(p_payload->>'dpp_amount','')::numeric,
      COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11), v_pph_amt,
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
      expense_category=v_cat, expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),'admin'),
      amount=(p_payload->>'amount')::numeric, expense_date=v_date, description=NULLIF(p_payload->>'description',''),
      batch_id=NULLIF(p_payload->>'batch_id','')::uuid, import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
      delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
      payment_method=v_pay_method, bank_account_id=v_bank_id,
      payment_reference=NULLIF(p_payload->>'payment_reference',''), paid_by=NULLIF(p_payload->>'paid_by',''),
      document_urls=NULLIF(v_docs,ARRAY[]::text[]), supplier_id=v_sup_id,
      staff_id=v_staff_id, payee_id=v_payee_id,
      linked_sales_invoice_id=NULLIF(p_payload->>'linked_sales_invoice_id', '')::uuid,
      pph_calculation_regime=NULLIF(p_payload->>'pph_calculation_regime', ''),
      pph_dpp_ratio=NULLIF(p_payload->>'pph_dpp_ratio', '')::numeric,
      pph_dpp_amount=NULLIF(p_payload->>'pph_dpp_amount', '')::numeric,
      pph_rate=NULLIF(p_payload->>'pph_rate', '')::numeric,
      is_tax_manual_override=COALESCE((p_payload->>'is_tax_manual_override')::boolean, false),
      invoice_number=NULLIF(p_payload->>'invoice_number',''),
      due_date=NULLIF(p_payload->>'due_date','')::date, broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
      pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,
      pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
      pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,
      ppn_amount=v_ppn_amt,
      ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
      ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),
      dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric, ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),
      pph_amount=v_pph_amt, pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,
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

-- 3. Upgrade approve_finance_expense to validate mandatory party linkages before approval
CREATE OR REPLACE FUNCTION public.approve_finance_expense(p_expense_id uuid, p_approved_by uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_exp public.finance_expenses%rowtype;
  v_line public.bank_statement_lines%rowtype;
  v_exp_currency text;
  v_bank_currency text;
  v_payable numeric;
  v_allocate numeric;
  v_period_status text;
  v_je_exists boolean;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  END IF;

  SELECT * INTO v_exp FROM public.finance_expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  -- Mandatory validation: Tax expenses cannot be approved without a valid party
  IF (COALESCE(v_exp.ppn_amount, 0) > 0 OR COALESCE(v_exp.pph_amount, 0) > 0)
     AND COALESCE(v_exp.expense_category, '') <> 'pib_import' THEN
    IF v_exp.supplier_id IS NULL AND v_exp.payee_id IS NULL AND v_exp.staff_id IS NULL THEN
      RAISE EXCEPTION 'Cannot approve tax expense % without selecting a valid Supplier, Payee, or Staff member.',
        COALESCE(v_exp.voucher_number, p_expense_id::text)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_exp.approval_status IS DISTINCT FROM 'approved' THEN
    UPDATE public.finance_expenses
       SET approval_status = 'approved',
           approved_by = COALESCE(p_approved_by, auth.uid()),
           approved_at = now(),
           rejection_reason = NULL
     WHERE id = p_expense_id;

    -- Refresh row state after trigger_auto_post_expense_accounting_update fires
    SELECT * INTO v_exp FROM public.finance_expenses WHERE id = p_expense_id;
  END IF;

  -- Confirm accounting journal was successfully posted for this approved expense
  SELECT EXISTS (
    SELECT 1 FROM public.journal_entries
     WHERE source_module IN ('expense', 'expenses')
       AND (reference_id = p_expense_id OR reference_number = 'EXP-' || p_expense_id::text)
       AND is_posted = true AND NOT COALESCE(is_reversed, false)
  ) INTO v_je_exists;

  -- Auto-reconcile originating or matched bank statement line if linked
  IF v_je_exists THEN
    FOR v_line IN
      SELECT *
        FROM public.bank_statement_lines
       WHERE (matched_expense_id = p_expense_id OR id = v_exp.originating_bank_statement_line_id)
         AND matching_status IN ('suggested', 'none')
         AND reconciliation_status <> 'reconciled'
       ORDER BY transaction_date ASC, created_at ASC
       FOR UPDATE
    LOOP
      IF EXISTS (
        SELECT 1 FROM public.bank_statement_allocations
         WHERE bank_statement_line_id = v_line.id
           AND document_type = 'expense'
           AND document_id = p_expense_id
      ) THEN
        PERFORM public.refresh_bank_statement_allocation_status(v_line.id);
        CONTINUE;
      END IF;

      IF COALESCE(v_line.debit_amount, 0) <= 0 THEN
        UPDATE public.bank_statement_lines
           SET notes = COALESCE(notes, '') || ' [Auto-reconciliation skipped: bank transaction is not an outgoing debit]'
         WHERE id = v_line.id;
        CONTINUE;
      END IF;

      IF v_exp.bank_account_id IS NOT NULL AND v_exp.bank_account_id <> v_line.bank_account_id THEN
        UPDATE public.bank_statement_lines
           SET notes = COALESCE(notes, '') || ' [Auto-reconciliation skipped: bank account mismatch]'
         WHERE id = v_line.id;
        CONTINUE;
      END IF;

      v_exp_currency := upper(COALESCE(v_exp.transaction_currency, v_exp.currency_code, 'IDR'));
      SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id = v_line.bank_account_id;
      IF COALESCE(v_bank_currency, 'IDR') <> v_exp_currency THEN
        UPDATE public.bank_statement_lines
           SET notes = COALESCE(notes, '') || ' [Auto-reconciliation skipped: currency mismatch]'
         WHERE id = v_line.id;
        CONTINUE;
      END IF;

      v_payable := COALESCE(public.calculate_finance_expense_payable(p_expense_id), 0);
      IF v_payable <= 0.01 THEN
        CONTINUE;
      END IF;

      v_allocate := LEAST(v_line.debit_amount, v_payable);

      SELECT ap.status INTO v_period_status
        FROM public.accounting_periods ap
       WHERE ap.start_date <= v_line.transaction_date AND ap.end_date >= v_line.transaction_date
       ORDER BY ap.start_date DESC LIMIT 1;

      IF v_period_status IS NOT NULL AND v_period_status <> 'open' THEN
        UPDATE public.bank_statement_lines
           SET notes = COALESCE(notes, '') || ' [Auto-reconciliation pending: closed accounting period]'
         WHERE id = v_line.id;
        CONTINUE;
      END IF;

      BEGIN
        PERFORM public.link_bank_statement_line(
          v_line.id,
          'expense',
          p_expense_id,
          COALESCE(v_line.payment_kind, 'supplier'),
          v_allocate
        );
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.bank_statement_lines
           SET notes = COALESCE(notes, '') || ' [Auto-reconciliation pending: ' || SQLERRM || ']'
         WHERE id = v_line.id;
      END;
    END LOOP;
  END IF;

  RETURN p_expense_id;
END;
$function$;

-- 4. Upgrade auto_post_expense_accounting to block posting if mandatory party is missing
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

  -- Mandatory validation: Block posting tax expense if party is missing
  IF (COALESCE(NEW.ppn_amount, 0) > 0 OR COALESCE(NEW.pph_amount, 0) > 0)
     AND COALESCE(NEW.expense_category, '') <> 'pib_import' THEN
    IF NEW.supplier_id IS NULL AND NEW.payee_id IS NULL AND NEW.staff_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post tax expense % without selecting a valid Supplier, Payee, or Staff member.',
        COALESCE(NEW.voucher_number, NEW.id::text)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD.approval_status='approved' THEN
    IF ROW(
      OLD.amount,OLD.expense_category,OLD.expense_date,OLD.description,
      OLD.payment_method,OLD.bank_account_id,OLD.pib_bm_amount,OLD.pib_ppn_amount,
      OLD.pib_pph_amount,OLD.ppn_amount,OLD.pph_amount,OLD.pph_code_id,
      COALESCE(OLD.pph_treatment,'deduct'),OLD.stamp_duty_amount,
      OLD.fixed_asset_account_id,COALESCE(OLD.bank_charges_amount,0),
      OLD.transaction_currency,OLD.exchange_rate,OLD.supplier_id,OLD.payee_id,OLD.staff_id
    ) IS NOT DISTINCT FROM ROW(
      NEW.amount,NEW.expense_category,NEW.expense_date,NEW.description,
      NEW.payment_method,NEW.bank_account_id,NEW.pib_bm_amount,NEW.pib_ppn_amount,
      NEW.pib_pph_amount,NEW.ppn_amount,NEW.pph_amount,NEW.pph_code_id,
      COALESCE(NEW.pph_treatment,'deduct'),NEW.stamp_duty_amount,
      NEW.fixed_asset_account_id,COALESCE(NEW.bank_charges_amount,0),
      NEW.transaction_currency,NEW.exchange_rate,NEW.supplier_id,NEW.payee_id,NEW.staff_id
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
      VALUES(v_journal_id,v_line_num,v_pph_account_id,NEW.pib_pph_amount,0,'PIB - PPh 22 Import (Prepaid Tax)',NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_total,'PIB Import - Bank/AP payment',NEW.supplier_id,NEW.payee_id);
    RETURN NEW;
  END IF;

  v_expense_account_id:=public.get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post expense %: No COA account configured for category "%"',NEW.id,NEW.expense_category;
  END IF;

  IF NEW.expense_category='fixed_asset' AND NEW.fixed_asset_account_id IS NOT NULL THEN
    v_expense_account_id:=NEW.fixed_asset_account_id;
  END IF;

  v_pph_account_id:=public.get_pph_liability_account_id(NEW.pph_code_id);
  v_ppn_account_id:=public.get_ppn_input_account_id();
  v_pph_treatment:=COALESCE(NEW.pph_treatment,'deduct');
  v_bank_charges:=COALESCE(NEW.bank_charges_amount,0);

  IF v_pph_treatment='add' THEN
    v_tax_benefit_account_id:=public.get_tax_benefit_expense_account_id();
    IF v_tax_benefit_account_id IS NULL THEN
      v_tax_benefit_account_id:=v_expense_account_id;
    END IF;
  END IF;

  IF v_pph_treatment='add' THEN
    v_net_payment:=NEW.amount+COALESCE(NEW.ppn_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;
  ELSE
    v_net_payment:=NEW.amount+COALESCE(NEW.ppn_amount,0)-COALESCE(NEW.pph_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;
  END IF;

  SELECT name INTO v_category_label FROM public.expense_categories WHERE code=NEW.expense_category;
  v_description:=COALESCE(NEW.description,v_category_label,'Expense');
  v_credit_desc:=v_description;

  v_total:=NEW.amount+COALESCE(NEW.ppn_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;
  IF v_pph_treatment='add' THEN
    v_total:=v_total+COALESCE(NEW.pph_amount,0);
  END IF;

  v_journal_id:=public.upsert_expense_journal_header_in_place(
    v_journal_id,NEW.id,NEW.expense_date,v_description,
    NEW.expense_category,v_total,NEW.created_by);

  v_line_num:=1;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_expense_account_id,NEW.amount,0,v_description,NEW.supplier_id,NEW.payee_id);

  IF v_pph_treatment='add' AND COALESCE(NEW.pph_amount,0)>0 THEN
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_tax_benefit_account_id,NEW.pph_amount,0,
      v_description||' - Tax Benefit (PPh Paid by Company)',NEW.supplier_id,NEW.payee_id);
  END IF;

  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    IF v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Input account is missing'; END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,v_description||' - PPN Input',NEW.supplier_id,NEW.payee_id);
  END IF;

  IF COALESCE(NEW.stamp_duty_account_id,NULL) IS NULL AND COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    v_stamp_duty_account_id:=public.get_expense_account_id('office_supplies');
    IF v_stamp_duty_account_id IS NULL THEN v_stamp_duty_account_id:=v_expense_account_id; END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_stamp_duty_account_id,NEW.stamp_duty_amount,0,v_description||' - Bea Meterai',NEW.supplier_id,NEW.payee_id);
  END IF;

  IF v_bank_charges>0 THEN
    v_bank_charge_acc_id:=public.get_expense_account_id('bank_charges');
    IF v_bank_charge_acc_id IS NULL THEN
      SELECT id INTO v_bank_charge_acc_id FROM public.chart_of_accounts WHERE code='6900' LIMIT 1;
    END IF;
    IF v_bank_charge_acc_id IS NULL THEN v_bank_charge_acc_id:=v_expense_account_id; END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,v_description||' - Bank Charges',NEW.supplier_id,NEW.payee_id);
  END IF;

  IF COALESCE(NEW.pph_amount,0)>0 THEN
    IF v_pph_account_id IS NULL THEN RAISE EXCEPTION 'PPh Payable account is missing'; END IF;
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,
      CASE WHEN v_pph_treatment='add' THEN v_description||' - PPh Payable (Company Covered)'
           ELSE v_description||' - PPh Withheld' END,
      NEW.supplier_id,NEW.payee_id);
  END IF;

  IF v_net_payment>0 THEN
    v_line_num:=v_line_num+1;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment,v_credit_desc,NEW.supplier_id,NEW.payee_id);
  END IF;

  RETURN NEW;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.validate_tax_expense_linkage() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_finance_expense(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_finance_expense(uuid, uuid) TO authenticated, service_role;

COMMIT;

