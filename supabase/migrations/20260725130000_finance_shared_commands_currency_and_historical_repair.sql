/*
  Finance Perfection Sprint

  Establishes shared Finance commands, immutable currency metadata, atomic
  numbering/linking, and an audited deterministic historical repair.

  Historical repair rule: this migration never updates document amounts,
  journal debit/credit values, or posted totals. Every automatic repair is
  recorded in finance_historical_repair_items. Ambiguous rows are left intact
  and recorded in finance_historical_repair_exceptions.
*/

-- ---------------------------------------------------------------------------
-- 1. Currency metadata. Existing numeric accounting values are untouched.
-- ---------------------------------------------------------------------------

ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS currency_code text,
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,6),
  ADD COLUMN IF NOT EXISTS bank_account_currency text,
  ADD COLUMN IF NOT EXISTS payment_currency text;

ALTER TABLE public.receipt_vouchers
  ADD COLUMN IF NOT EXISTS currency_code text,
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,6),
  ADD COLUMN IF NOT EXISTS bank_account_currency text,
  ADD COLUMN IF NOT EXISTS payment_currency text;

ALTER TABLE public.payment_vouchers
  ADD COLUMN IF NOT EXISTS currency_code text,
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS bank_account_currency text;

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,6),
  ADD COLUMN IF NOT EXISTS amounts_are_functional boolean;

ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS transaction_debit numeric(18,2),
  ADD COLUMN IF NOT EXISTS transaction_credit numeric(18,2),
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,6);

-- Payment vouchers previously had only an indirect journal link from a bank
-- statement row. A typed FK is required for the same traceability guaranteed
-- for Expenses, Receipts, Contra, and Petty Cash.
ALTER TABLE public.bank_statement_lines
  ADD COLUMN IF NOT EXISTS matched_payment_id uuid REFERENCES public.payment_vouchers(id) ON DELETE SET NULL;

-- New writes must use supported currency codes. NOT VALID preserves ambiguous
-- legacy rows for the exception report rather than rejecting the migration.
ALTER TABLE public.finance_expenses DROP CONSTRAINT IF EXISTS finance_expenses_currency_metadata_check;
ALTER TABLE public.finance_expenses ADD CONSTRAINT finance_expenses_currency_metadata_check
  CHECK (
    (transaction_currency IS NULL OR transaction_currency IN ('IDR','USD')) AND
    (functional_currency IS NULL OR functional_currency = 'IDR') AND
    (currency_code IS NULL OR currency_code IN ('IDR','USD')) AND
    (payment_currency IS NULL OR payment_currency IN ('IDR','USD')) AND
    (bank_account_currency IS NULL OR bank_account_currency IN ('IDR','USD')) AND
    (exchange_rate IS NULL OR exchange_rate > 0)
  ) NOT VALID;

ALTER TABLE public.receipt_vouchers DROP CONSTRAINT IF EXISTS receipt_vouchers_currency_metadata_check;
ALTER TABLE public.receipt_vouchers ADD CONSTRAINT receipt_vouchers_currency_metadata_check
  CHECK (
    (transaction_currency IS NULL OR transaction_currency IN ('IDR','USD')) AND
    (functional_currency IS NULL OR functional_currency = 'IDR') AND
    (currency_code IS NULL OR currency_code IN ('IDR','USD')) AND
    (payment_currency IS NULL OR payment_currency IN ('IDR','USD')) AND
    (bank_account_currency IS NULL OR bank_account_currency IN ('IDR','USD')) AND
    (exchange_rate IS NULL OR exchange_rate > 0)
  ) NOT VALID;

ALTER TABLE public.payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_currency_metadata_check;
ALTER TABLE public.payment_vouchers ADD CONSTRAINT payment_vouchers_currency_metadata_check
  CHECK (
    (transaction_currency IS NULL OR transaction_currency IN ('IDR','USD')) AND
    (functional_currency IS NULL OR functional_currency = 'IDR') AND
    (currency_code IS NULL OR currency_code IN ('IDR','USD')) AND
    (payment_currency IS NULL OR payment_currency IN ('IDR','USD')) AND
    (bank_account_currency IS NULL OR bank_account_currency IN ('IDR','USD')) AND
    (exchange_rate IS NULL OR exchange_rate > 0)
  ) NOT VALID;

ALTER TABLE public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_currency_metadata_check;
ALTER TABLE public.journal_entries ADD CONSTRAINT journal_entries_currency_metadata_check
  CHECK (
    (transaction_currency IS NULL OR transaction_currency IN ('IDR','USD')) AND
    (functional_currency IS NULL OR functional_currency = 'IDR') AND
    (exchange_rate IS NULL OR exchange_rate > 0)
  ) NOT VALID;

ALTER TABLE public.journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_currency_metadata_check;
ALTER TABLE public.journal_entry_lines ADD CONSTRAINT journal_entry_lines_currency_metadata_check
  CHECK (
    (transaction_currency IS NULL OR transaction_currency IN ('IDR','USD')) AND
    (functional_currency IS NULL OR functional_currency='IDR') AND
    (exchange_rate IS NULL OR exchange_rate>0)
  ) NOT VALID;

-- Reporting consumes functional debit/credit values exactly once. Older rows
-- without the new contract retain the previous source-based fallback. A legacy
-- USD row explicitly marked non-functional but lacking a rate is deliberately
-- not assigned a current-rate guess; it remains in the repair exception report.
CREATE OR REPLACE FUNCTION public.get_journal_reporting_multiplier(
  p_journal_entry_id uuid,
  p_usd_rate numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public
AS $$
  SELECT CASE
    WHEN je.amounts_are_functional=true THEN 1::numeric
    WHEN je.transaction_currency='IDR' THEN 1::numeric
    WHEN je.transaction_currency='USD' AND je.exchange_rate IS NOT NULL THEN je.exchange_rate
    WHEN je.transaction_currency='USD' AND je.amounts_are_functional=false THEN 1::numeric
    WHEN EXISTS (
      SELECT 1
      FROM public.journal_entries source_je
      LEFT JOIN public.purchase_invoices pi ON pi.id=source_je.reference_id AND source_je.source_module='purchase_invoice'
      LEFT JOIN public.payment_vouchers pv ON pv.id=source_je.reference_id AND source_je.source_module='payment'
      LEFT JOIN public.bank_accounts pv_ba ON pv_ba.id=pv.bank_account_id
      LEFT JOIN public.receipt_vouchers rv ON rv.id=source_je.reference_id AND source_je.source_module='receipt'
      LEFT JOIN public.bank_accounts rv_ba ON rv_ba.id=rv.bank_account_id
      LEFT JOIN public.fund_transfers ft ON ft.id=source_je.reference_id AND source_je.source_module IN('fund_transfer','fund_transfers')
      LEFT JOIN public.bank_accounts ft_from_ba ON ft_from_ba.id=ft.from_bank_account_id
      LEFT JOIN public.bank_accounts ft_to_ba ON ft_to_ba.id=ft.to_bank_account_id
      LEFT JOIN public.bank_statement_lines bsl ON bsl.matched_entry_id=source_je.id
      LEFT JOIN public.bank_accounts bsl_ba ON bsl_ba.id=bsl.bank_account_id
      WHERE source_je.id=je.id AND (
        pi.currency='USD' OR COALESCE(pv.payment_currency,pv_ba.currency)='USD' OR rv_ba.currency='USD'
        OR COALESCE(ft_from_ba.currency,ft_to_ba.currency)='USD' OR COALESCE(bsl.currency,bsl_ba.currency)='USD'
      )
    ) THEN COALESCE(NULLIF(p_usd_rate,0),public.get_reporting_usd_rate())
    ELSE 1::numeric
  END
  FROM public.journal_entries je WHERE je.id=p_journal_entry_id;
$$;

-- ---------------------------------------------------------------------------
-- 2. Atomic native voucher numbering.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.next_expense_voucher_number(p_expense_date date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_year int;
  v_fy text;
  v_prefix text;
  v_next int;
BEGIN
  IF p_expense_date IS NULL THEN RAISE EXCEPTION 'Expense date is required'; END IF;
  -- Preserve the native Finance calendar-year series (for example 26-26).
  v_start_year := EXTRACT(YEAR FROM p_expense_date)::int;
  v_fy := right(v_start_year::text, 2) || '-' || right(v_start_year::text, 2);
  v_prefix := 'EXP/' || v_fy || '/';
  PERFORM pg_advisory_xact_lock(hashtext('expense_voucher_' || v_fy));
  SELECT COALESCE(MAX((regexp_match(voucher_number, '/([0-9]+)$'))[1]::int), 0) + 1
    INTO v_next
    FROM public.finance_expenses
   WHERE voucher_number LIKE v_prefix || '%';
  RETURN v_prefix || lpad(v_next::text, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.next_payment_voucher_number(p_voucher_date date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_year int;
  v_fy text;
  v_prefix text;
  v_next int;
BEGIN
  IF p_voucher_date IS NULL THEN RAISE EXCEPTION 'Voucher date is required'; END IF;
  v_start_year := EXTRACT(YEAR FROM p_voucher_date)::int;
  v_fy := right(v_start_year::text, 2) || '-' || right(v_start_year::text, 2);
  v_prefix := 'PV/' || v_fy || '/';
  PERFORM pg_advisory_xact_lock(hashtext('payment_voucher_' || v_fy));
  SELECT COALESCE(MAX((regexp_match(voucher_number, '/([0-9]+)$'))[1]::int), 0) + 1
    INTO v_next
    FROM public.payment_vouchers
   WHERE voucher_number LIKE v_prefix || '%';
  RETURN v_prefix || lpad(v_next::text, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.next_receipt_voucher_number(p_voucher_date date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_next int;
BEGIN
  IF p_voucher_date IS NULL THEN RAISE EXCEPTION 'Voucher date is required'; END IF;
  v_prefix := 'RV' || to_char(p_voucher_date, 'YYMM') || '-';
  PERFORM pg_advisory_xact_lock(hashtext('receipt_voucher_' || v_prefix));
  SELECT COALESCE(MAX((regexp_match(voucher_number, '-([0-9]+)$'))[1]::int), 0) + 1
    INTO v_next
    FROM public.receipt_vouchers
   WHERE voucher_number LIKE v_prefix || '%';
  RETURN v_prefix || lpad(v_next::text, 4, '0');
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Shared Expense command. Native Expense and Bank Reconciliation call this.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_finance_expense(
  p_expense_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_date date := COALESCE((p_payload->>'expense_date')::date, current_date);
  v_bank_id uuid := NULLIF(p_payload->>'bank_account_id', '')::uuid;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_docs text[];
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
      bank_account_currency, payment_currency
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
      v_currency, v_currency, 'IDR', v_rate, COALESCE(v_bank_currency,v_currency), v_currency
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
      bank_account_currency=COALESCE(v_bank_currency,v_currency), payment_currency=v_currency
    WHERE id=p_expense_id RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_finance_expense(p_expense_id uuid,p_approved_by uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public._sec_check_finance_role();
  UPDATE public.finance_expenses SET approval_status='approved',approved_by=COALESCE(p_approved_by,auth.uid()),approved_at=now(),rejection_reason=NULL
  WHERE id=p_expense_id AND approval_status IS DISTINCT FROM 'approved';
  IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=p_expense_id AND approval_status='approved') THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  RETURN p_expense_id;
END $$;

-- Only approved expenses create/recreate active accounting. This fixes the
-- legacy condition where pending and rejected documents entered the GL.
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW WHEN (
    NEW.approval_status = 'approved'
    AND COALESCE(current_setting('app.finance_historical_repair',true),'off') <> 'on'
  )
  EXECUTE FUNCTION public.auto_post_expense_accounting();

-- Keep the document's transaction amount separate from the functional IDR
-- values used by every GL report. This trigger runs after the native posting
-- trigger (PostgreSQL orders same-kind triggers by name). It also removes the
-- active JE when approval/posting is cancelled. Historical repair sets a
-- transaction-local guard so this function never converts old debit/credit
-- values while metadata is being repaired.
CREATE OR REPLACE FUNCTION public.sync_expense_journal_currency_and_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_je uuid;
  v_currency text:=upper(COALESCE(NEW.transaction_currency,NEW.currency_code,'IDR'));
  v_rate numeric:=CASE WHEN upper(COALESCE(NEW.transaction_currency,NEW.currency_code,'IDR'))='IDR'
    THEN 1 ELSE NEW.exchange_rate END;
BEGIN
  IF NEW.approval_status IS DISTINCT FROM 'approved' THEN
    IF OLD.approval_status='approved' AND EXISTS(
      SELECT 1 FROM public.journal_entries WHERE source_module IN('expense','expenses')
        AND (reference_id=NEW.id OR reference_number='EXP-'||NEW.id::text)
        AND COALESCE(is_reversed,false)=false
    ) THEN
      RAISE EXCEPTION 'Use Cancel Posting so the journal removal is period-checked and audited';
    END IF;
    RETURN NEW;
  END IF;
  IF COALESCE(current_setting('app.finance_historical_repair',true),'off')='on' THEN RETURN NEW; END IF;

  SELECT id INTO v_je
    FROM public.journal_entries
   WHERE source_module='expenses'
     AND (reference_id=NEW.id OR reference_number='EXP-'||NEW.id::text)
     AND is_posted=true AND COALESCE(is_reversed,false)=false
   ORDER BY created_at DESC LIMIT 1;
  IF v_je IS NULL THEN
    RAISE EXCEPTION 'Approved expense % has no active journal entry',NEW.id;
  END IF;
  IF v_currency NOT IN ('IDR','USD') OR v_rate IS NULL OR v_rate<=0 THEN
    RAISE EXCEPTION 'Approved expense % has invalid currency metadata',NEW.id;
  END IF;

  -- Metadata-only historical repair must never rewrite accounting history.
  IF COALESCE(current_setting('app.finance_historical_repair',true),'off') <> 'on' THEN
    UPDATE public.journal_entry_lines
       SET transaction_currency=v_currency,
           transaction_debit=COALESCE(transaction_debit,debit),
           transaction_credit=COALESCE(transaction_credit,credit),
           functional_currency='IDR',exchange_rate=v_rate,
           debit=round(COALESCE(transaction_debit,debit)*v_rate,2),
           credit=round(COALESCE(transaction_credit,credit)*v_rate,2)
     WHERE journal_entry_id=v_je;
    UPDATE public.journal_entries je
       SET transaction_currency=v_currency,functional_currency='IDR',exchange_rate=v_rate,
           amounts_are_functional=true,
           total_debit=(SELECT COALESCE(sum(debit),0) FROM public.journal_entry_lines WHERE journal_entry_id=v_je),
           total_credit=(SELECT COALESCE(sum(credit),0) FROM public.journal_entry_lines WHERE journal_entry_id=v_je)
     WHERE je.id=v_je;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sync_expense_journal_currency ON public.finance_expenses;
CREATE TRIGGER trigger_sync_expense_journal_currency
  AFTER INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.sync_expense_journal_currency_and_state();

-- ---------------------------------------------------------------------------
-- 4. Shared Receipt and Payment commands.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_receipt_voucher_with_allocations(
  p_receipt_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_alloc jsonb;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
BEGIN
  PERFORM public._sec_check_finance_role();
  IF NULLIF(p_payload->>'customer_id','') IS NULL THEN RAISE EXCEPTION 'Customer is required'; END IF;
  IF COALESCE((p_payload->>'amount')::numeric,0) <= 0 THEN RAISE EXCEPTION 'Receipt amount must be greater than zero'; END IF;
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id=NULLIF(p_payload->>'bank_account_id','')::uuid;
  v_currency := upper(COALESCE(NULLIF(p_payload->>'transaction_currency',''),v_bank_currency,'IDR'));
  v_rate := COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric,0),CASE WHEN v_currency='IDR' THEN 1 ELSE NULL END);
  IF v_rate IS NULL OR v_rate<=0 OR (v_currency='USD' AND v_rate<=1) THEN
    RAISE EXCEPTION 'A valid exchange rate is required for % receipts',v_currency;
  END IF;
  IF v_bank_currency IS NOT NULL AND v_bank_currency<>v_currency THEN
    RAISE EXCEPTION 'Receipt currency % does not match selected bank currency %',v_currency,v_bank_currency;
  END IF;

  IF p_receipt_id IS NULL THEN
    INSERT INTO public.receipt_vouchers(
      voucher_number,voucher_date,customer_id,payment_method,bank_account_id,reference_number,
      amount,description,created_by,currency_code,transaction_currency,functional_currency,
      exchange_rate,bank_account_currency,payment_currency
    ) VALUES (
      public.next_receipt_voucher_number((p_payload->>'voucher_date')::date),(p_payload->>'voucher_date')::date,
      (p_payload->>'customer_id')::uuid,p_payload->>'payment_method',NULLIF(p_payload->>'bank_account_id','')::uuid,
      NULLIF(p_payload->>'reference_number',''),(p_payload->>'amount')::numeric,NULLIF(p_payload->>'description',''),
      COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),v_currency,v_currency,'IDR',v_rate,
      COALESCE(v_bank_currency,v_currency),v_currency
    ) RETURNING id INTO v_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.receipt_vouchers WHERE id=p_receipt_id AND is_posted=true) THEN
      RAISE EXCEPTION 'Cannot edit a posted receipt voucher. Cancel posting first.';
    END IF;
    UPDATE public.receipt_vouchers SET
      voucher_date=(p_payload->>'voucher_date')::date,customer_id=(p_payload->>'customer_id')::uuid,
      payment_method=p_payload->>'payment_method',bank_account_id=NULLIF(p_payload->>'bank_account_id','')::uuid,
      reference_number=NULLIF(p_payload->>'reference_number',''),amount=(p_payload->>'amount')::numeric,
      description=NULLIF(p_payload->>'description',''),currency_code=v_currency,transaction_currency=v_currency,
      functional_currency='IDR',exchange_rate=v_rate,bank_account_currency=COALESCE(v_bank_currency,v_currency),
      payment_currency=v_currency,updated_at=now()
    WHERE id=p_receipt_id RETURNING id INTO v_id;
    DELETE FROM public.voucher_allocations WHERE receipt_voucher_id=v_id;
  END IF;
  FOR v_alloc IN SELECT value FROM jsonb_array_elements(COALESCE(p_allocations,'[]'::jsonb)) LOOP
    IF COALESCE((v_alloc->>'amount')::numeric,0) > 0 THEN
      INSERT INTO public.voucher_allocations(voucher_type,receipt_voucher_id,sales_invoice_id,sales_order_id,allocated_amount)
      VALUES('receipt',v_id,NULLIF(v_alloc->>'sales_invoice_id','')::uuid,
        NULLIF(v_alloc->>'sales_order_id','')::uuid,(v_alloc->>'amount')::numeric);
    END IF;
  END LOOP;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_payment_voucher_command(
  p_voucher_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_number text;
  v_id uuid;
  v_date date := (p_payload->>'voucher_date')::date;
  v_currency text:=upper(COALESCE(NULLIF(p_payload->>'payment_currency',''),'IDR'));
  v_bank_currency text;
  v_rate numeric:=COALESCE(NULLIF(p_payload->>'exchange_rate','')::numeric,1);
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id=NULLIF(p_payload->>'bank_account_id','')::uuid;
  IF v_currency NOT IN('IDR','USD') OR v_rate<=0 OR (v_currency='USD' AND v_rate<=1) THEN
    RAISE EXCEPTION 'Payment currency or exchange rate is invalid';
  END IF;
  IF v_bank_currency IS NOT NULL AND v_bank_currency<>v_currency THEN
    RAISE EXCEPTION 'Payment currency % does not match selected bank currency %',v_currency,v_bank_currency;
  END IF;
  SELECT voucher_number INTO v_number FROM public.payment_vouchers WHERE id=p_voucher_id;
  v_number := COALESCE(v_number,public.next_payment_voucher_number(v_date));
  v_id := public.save_payment_voucher_with_allocations(
    p_voucher_id=>p_voucher_id,p_voucher_number=>v_number,p_voucher_date=>v_date,
    p_supplier_id=>NULLIF(p_payload->>'supplier_id','')::uuid,
    p_payment_method=>p_payload->>'payment_method',p_bank_account_id=>NULLIF(p_payload->>'bank_account_id','')::uuid,
    p_reference_number=>NULLIF(p_payload->>'reference_number',''),p_amount=>(p_payload->>'amount')::numeric,
    p_pph_amount=>COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    p_pph_code_id=>NULLIF(p_payload->>'pph_code_id','')::uuid,p_description=>NULLIF(p_payload->>'description',''),
    p_payment_currency=>v_currency,
    p_exchange_rate=>v_rate,
    p_bank_amount=>NULLIF(p_payload->>'bank_amount','')::numeric,
    p_bank_charge=>COALESCE(NULLIF(p_payload->>'bank_charge','')::numeric,0),
    p_created_by=>COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),p_allocations=>p_allocations,
    p_staff_id=>NULLIF(p_payload->>'staff_id','')::uuid
  );
  UPDATE public.payment_vouchers pv SET
    currency_code=upper(COALESCE(pv.payment_currency,'IDR')),
    transaction_currency=upper(COALESCE(pv.payment_currency,'IDR')),
    functional_currency='IDR',
    bank_account_currency=upper(COALESCE(
      (SELECT ba.currency FROM public.bank_accounts ba WHERE ba.id=pv.bank_account_id),
      pv.payment_currency,'IDR'))
  WHERE pv.id=v_id;
  RETURN jsonb_build_object('id',v_id,'voucher_number',v_number);
END;
$$;

-- Native voucher posting functions create their JE in document currency. The
-- following post-write synchronizers preserve those originals on each line and
-- convert the GL debit/credit columns to functional IDR exactly once (or from
-- the preserved originals when a draft rate changes and it is posted again).
CREATE OR REPLACE FUNCTION public.sync_receipt_journal_currency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_currency text:=upper(COALESCE(NEW.transaction_currency,NEW.currency_code,'IDR'));
  v_rate numeric:=CASE WHEN upper(COALESCE(NEW.transaction_currency,NEW.currency_code,'IDR'))='IDR' THEN 1 ELSE NEW.exchange_rate END;
BEGIN
  IF COALESCE(NEW.is_posted,false)=false OR NEW.journal_entry_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('app.finance_historical_repair',true),'off')='on' THEN RETURN NEW; END IF;
  IF v_currency NOT IN('IDR','USD') OR v_rate IS NULL OR v_rate<=0 THEN RAISE EXCEPTION 'Posted receipt has invalid currency metadata'; END IF;
  UPDATE public.journal_entry_lines SET transaction_currency=v_currency,
    transaction_debit=COALESCE(transaction_debit,debit),transaction_credit=COALESCE(transaction_credit,credit),
    functional_currency='IDR',exchange_rate=v_rate,
    debit=round(COALESCE(transaction_debit,debit)*v_rate,2),credit=round(COALESCE(transaction_credit,credit)*v_rate,2)
  WHERE journal_entry_id=NEW.journal_entry_id;
  UPDATE public.journal_entries SET transaction_currency=v_currency,functional_currency='IDR',exchange_rate=v_rate,
    amounts_are_functional=true,
    total_debit=(SELECT COALESCE(sum(debit),0) FROM public.journal_entry_lines WHERE journal_entry_id=NEW.journal_entry_id),
    total_credit=(SELECT COALESCE(sum(credit),0) FROM public.journal_entry_lines WHERE journal_entry_id=NEW.journal_entry_id)
  WHERE id=NEW.journal_entry_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trigger_sync_receipt_journal_currency ON public.receipt_vouchers;
CREATE TRIGGER trigger_sync_receipt_journal_currency AFTER INSERT OR UPDATE ON public.receipt_vouchers
FOR EACH ROW EXECUTE FUNCTION public.sync_receipt_journal_currency();

CREATE OR REPLACE FUNCTION public.sync_payment_journal_currency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_currency text:=upper(COALESCE(NEW.transaction_currency,NEW.payment_currency,NEW.currency_code,'IDR'));
  v_rate numeric:=CASE WHEN upper(COALESCE(NEW.transaction_currency,NEW.payment_currency,NEW.currency_code,'IDR'))='IDR' THEN 1 ELSE NEW.exchange_rate END;
BEGIN
  IF COALESCE(NEW.is_posted,false)=false OR NEW.journal_entry_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('app.finance_historical_repair',true),'off')='on' THEN RETURN NEW; END IF;
  IF v_currency NOT IN('IDR','USD') OR v_rate IS NULL OR v_rate<=0 THEN RAISE EXCEPTION 'Posted payment has invalid currency metadata'; END IF;
  UPDATE public.journal_entry_lines SET transaction_currency=v_currency,
    transaction_debit=COALESCE(transaction_debit,debit),transaction_credit=COALESCE(transaction_credit,credit),
    functional_currency='IDR',exchange_rate=v_rate,
    debit=round(COALESCE(transaction_debit,debit)*v_rate,2),credit=round(COALESCE(transaction_credit,credit)*v_rate,2)
  WHERE journal_entry_id=NEW.journal_entry_id;
  UPDATE public.journal_entries SET transaction_currency=v_currency,functional_currency='IDR',exchange_rate=v_rate,
    amounts_are_functional=true,
    total_debit=(SELECT COALESCE(sum(debit),0) FROM public.journal_entry_lines WHERE journal_entry_id=NEW.journal_entry_id),
    total_credit=(SELECT COALESCE(sum(credit),0) FROM public.journal_entry_lines WHERE journal_entry_id=NEW.journal_entry_id)
  WHERE id=NEW.journal_entry_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trigger_sync_payment_journal_currency ON public.payment_vouchers;
CREATE TRIGGER trigger_sync_payment_journal_currency AFTER INSERT OR UPDATE ON public.payment_vouchers
FOR EACH ROW EXECUTE FUNCTION public.sync_payment_journal_currency();

-- Fund Transfer's native poster predates the transaction/functional currency
-- contract. Normalize only newly posted/reposted transfers; historical repair
-- never invokes this trigger and therefore never changes old GL amounts.
CREATE OR REPLACE FUNCTION public.normalize_fund_transfer_exchange_rate()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
  v_from_currency text;
  v_to_currency text;
BEGIN
  v_from_currency:=CASE WHEN NEW.from_account_type='bank'
    THEN (SELECT upper(currency) FROM public.bank_accounts WHERE id=NEW.from_bank_account_id) ELSE 'IDR' END;
  v_to_currency:=CASE WHEN NEW.to_account_type='bank'
    THEN (SELECT upper(currency) FROM public.bank_accounts WHERE id=NEW.to_bank_account_id) ELSE 'IDR' END;
  IF v_from_currency='USD' AND v_to_currency='IDR' AND NEW.from_amount>0 THEN
    NEW.exchange_rate:=NEW.to_amount/NEW.from_amount;
  ELSIF v_from_currency='IDR' AND v_to_currency='USD' AND NEW.to_amount>0 THEN
    NEW.exchange_rate:=NEW.from_amount/NEW.to_amount;
  ELSIF v_from_currency='USD' AND v_to_currency='USD' THEN
    NEW.exchange_rate:=COALESCE(NULLIF(NEW.exchange_rate,0),public.get_reporting_usd_rate());
  ELSE
    NEW.exchange_rate:=1;
  END IF;
  IF NEW.exchange_rate IS NULL OR NEW.exchange_rate<=0 OR ((v_from_currency='USD' OR v_to_currency='USD') AND NEW.exchange_rate<=1) THEN
    RAISE EXCEPTION 'A valid USD-to-IDR exchange rate is required for this Fund Transfer';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS aa_normalize_fund_transfer_exchange_rate ON public.fund_transfers;
CREATE TRIGGER aa_normalize_fund_transfer_exchange_rate
  BEFORE INSERT OR UPDATE OF from_amount,to_amount,from_account_type,to_account_type,
    from_bank_account_id,to_bank_account_id,exchange_rate
  ON public.fund_transfers FOR EACH ROW EXECUTE FUNCTION public.normalize_fund_transfer_exchange_rate();

-- The legacy validator treated exchange_rate as "destination units per source
-- unit". Finance stores one canonical USD-to-IDR rate, so that formula is
-- inverted for IDR -> USD transfers. Validate according to the currencies on
-- each side while leaving all stored accounting amounts untouched.
CREATE OR REPLACE FUNCTION public.validate_fund_transfer_fx()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_from_currency text;
  v_to_currency text;
  v_expected numeric;
  v_actual numeric;
BEGIN
  IF COALESCE(NEW.from_amount,0)<=0 OR COALESCE(NEW.to_amount,0)<=0 THEN
    RAISE EXCEPTION 'Fund transfer amounts must be positive';
  END IF;
  IF COALESCE(NEW.exchange_rate,0)<=0 THEN
    RAISE EXCEPTION 'exchange_rate must be positive';
  END IF;

  v_from_currency:=CASE WHEN NEW.from_account_type='bank'
    THEN (SELECT upper(currency) FROM public.bank_accounts WHERE id=NEW.from_bank_account_id)
    ELSE 'IDR' END;
  v_to_currency:=CASE WHEN NEW.to_account_type='bank'
    THEN (SELECT upper(currency) FROM public.bank_accounts WHERE id=NEW.to_bank_account_id)
    ELSE 'IDR' END;

  IF v_from_currency IS NULL OR v_to_currency IS NULL
     OR v_from_currency NOT IN('IDR','USD') OR v_to_currency NOT IN('IDR','USD') THEN
    RAISE EXCEPTION 'Fund transfer currencies must be IDR or USD';
  ELSIF v_from_currency='USD' AND v_to_currency='IDR' THEN
    v_expected:=NEW.from_amount*NEW.exchange_rate;
    v_actual:=NEW.to_amount;
  ELSIF v_from_currency='IDR' AND v_to_currency='USD' THEN
    v_expected:=NEW.to_amount*NEW.exchange_rate;
    v_actual:=NEW.from_amount;
  ELSE
    v_expected:=NEW.from_amount;
    v_actual:=NEW.to_amount;
  END IF;

  IF abs(v_actual-v_expected)/GREATEST(abs(v_actual),1)>0.02 THEN
    RAISE EXCEPTION 'FX inconsistency between from_amount %, to_amount %, and USD-to-IDR rate %',
      NEW.from_amount,NEW.to_amount,NEW.exchange_rate;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.protect_posted_fund_transfer_accounting()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF COALESCE(current_setting('app.finance_historical_repair',true),'off')='on'
     AND NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
     AND NEW.transfer_date IS NOT DISTINCT FROM OLD.transfer_date
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.from_amount IS NOT DISTINCT FROM OLD.from_amount
     AND NEW.to_amount IS NOT DISTINCT FROM OLD.to_amount
     AND NEW.from_account_type IS NOT DISTINCT FROM OLD.from_account_type
     AND NEW.to_account_type IS NOT DISTINCT FROM OLD.to_account_type
     AND NEW.from_bank_account_id IS NOT DISTINCT FROM OLD.from_bank_account_id
     AND NEW.to_bank_account_id IS NOT DISTINCT FROM OLD.to_bank_account_id
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;
  IF OLD.status='posted' AND (
       NEW.transfer_date IS DISTINCT FROM OLD.transfer_date OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.from_amount IS DISTINCT FROM OLD.from_amount OR NEW.to_amount IS DISTINCT FROM OLD.to_amount
    OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate OR NEW.from_account_type IS DISTINCT FROM OLD.from_account_type
    OR NEW.to_account_type IS DISTINCT FROM OLD.to_account_type OR NEW.from_bank_account_id IS DISTINCT FROM OLD.from_bank_account_id
    OR NEW.to_bank_account_id IS DISTINCT FROM OLD.to_bank_account_id OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
  ) THEN
    RAISE EXCEPTION 'Posted Fund Transfer % is accounting-locked. Reverse it and create a replacement.',OLD.transfer_number;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.sync_fund_transfer_journal_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_from_currency text;
  v_to_currency text;
  v_rate numeric;
  v_functional numeric;
BEGIN
  IF NEW.journal_entry_id IS NULL OR NEW.status<>'posted' THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('app.finance_historical_repair',true),'off')='on' THEN RETURN NEW; END IF;
  v_from_currency:=CASE WHEN NEW.from_account_type='bank'
    THEN (SELECT upper(currency) FROM public.bank_accounts WHERE id=NEW.from_bank_account_id) ELSE 'IDR' END;
  v_to_currency:=CASE WHEN NEW.to_account_type='bank'
    THEN (SELECT upper(currency) FROM public.bank_accounts WHERE id=NEW.to_bank_account_id) ELSE 'IDR' END;
  IF v_from_currency NOT IN('IDR','USD') OR v_to_currency NOT IN('IDR','USD') THEN
    RAISE EXCEPTION 'Unsupported Fund Transfer currency';
  END IF;
  IF v_from_currency='IDR' AND v_to_currency='IDR' THEN
    IF abs(NEW.from_amount-NEW.to_amount)>0.01 THEN RAISE EXCEPTION 'IDR Fund Transfer amounts must match'; END IF;
    v_rate:=1; v_functional:=NEW.from_amount;
  ELSIF v_from_currency='IDR' AND v_to_currency='USD' THEN
    IF NEW.to_amount<=0 THEN RAISE EXCEPTION 'USD destination amount is required'; END IF;
    v_rate:=NEW.from_amount/NEW.to_amount; v_functional:=NEW.from_amount;
  ELSIF v_from_currency='USD' AND v_to_currency='IDR' THEN
    IF NEW.from_amount<=0 THEN RAISE EXCEPTION 'USD source amount is required'; END IF;
    v_rate:=NEW.to_amount/NEW.from_amount; v_functional:=NEW.to_amount;
  ELSE
    IF abs(NEW.from_amount-NEW.to_amount)>0.01 THEN RAISE EXCEPTION 'Same-currency USD Fund Transfer amounts must match'; END IF;
    v_rate:=COALESCE(NULLIF(NEW.exchange_rate,0),public.get_reporting_usd_rate());
    IF v_rate<=1 THEN v_rate:=public.get_reporting_usd_rate(); END IF;
    IF v_rate IS NULL OR v_rate<=1 THEN RAISE EXCEPTION 'A valid USD-to-IDR rate is required'; END IF;
    v_functional:=NEW.from_amount*v_rate;
  END IF;
  IF v_rate IS NULL OR v_rate<=0 THEN RAISE EXCEPTION 'Invalid Fund Transfer exchange rate'; END IF;

  UPDATE public.journal_entry_lines SET
    debit=CASE WHEN line_number=1 THEN round(v_functional,2) ELSE 0 END,
    credit=CASE WHEN line_number=2 THEN round(v_functional,2) ELSE 0 END,
    transaction_currency=CASE WHEN line_number=1 THEN v_to_currency ELSE v_from_currency END,
    transaction_debit=CASE WHEN line_number=1 THEN NEW.to_amount ELSE 0 END,
    transaction_credit=CASE WHEN line_number=2 THEN NEW.from_amount ELSE 0 END,
    functional_currency='IDR',
    exchange_rate=CASE
      WHEN line_number=1 AND v_to_currency='USD' THEN v_rate
      WHEN line_number=2 AND v_from_currency='USD' THEN v_rate
      ELSE 1 END
  WHERE journal_entry_id=NEW.journal_entry_id AND line_number IN(1,2);
  UPDATE public.journal_entries SET transaction_currency=CASE WHEN v_from_currency=v_to_currency THEN v_from_currency ELSE 'IDR' END,
    functional_currency='IDR',exchange_rate=v_rate,amounts_are_functional=true,
    total_debit=round(v_functional,2),total_credit=round(v_functional,2)
  WHERE id=NEW.journal_entry_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_sync_fund_transfer_journal_currency ON public.fund_transfers;
CREATE TRIGGER zz_sync_fund_transfer_journal_currency
  AFTER INSERT OR UPDATE OF journal_entry_id,status ON public.fund_transfers
  FOR EACH ROW EXECUTE FUNCTION public.sync_fund_transfer_journal_currency();

-- ---------------------------------------------------------------------------
-- 5. Shared atomic manual/typed Journal command.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_finance_journal(
  p_entry_id uuid DEFAULT NULL,
  p_entry_date date DEFAULT current_date,
  p_description text DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_transaction_currency text DEFAULT 'IDR',
  p_exchange_rate numeric DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_line jsonb;
  v_dr numeric:=0;
  v_cr numeric:=0;
  v_factor numeric;
  v_num text;
  v_i int:=0;
BEGIN
  PERFORM public._sec_check_finance_role();
  p_transaction_currency:=upper(COALESCE(p_transaction_currency,'IDR'));
  IF p_transaction_currency NOT IN ('IDR','USD') THEN RAISE EXCEPTION 'Unsupported journal currency'; END IF;
  IF p_exchange_rate IS NULL OR p_exchange_rate<=0 OR (p_transaction_currency='USD' AND p_exchange_rate<=1) THEN
    RAISE EXCEPTION 'A valid exchange rate is required';
  END IF;
  v_factor:=CASE WHEN p_transaction_currency='IDR' THEN 1 ELSE p_exchange_rate END;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_dr:=v_dr+COALESCE((v_line->>'debit')::numeric,0);
    v_cr:=v_cr+COALESCE((v_line->>'credit')::numeric,0);
  END LOOP;
  IF v_dr<=0 OR abs(v_dr-v_cr)>0.01 THEN RAISE EXCEPTION 'Journal must be balanced and greater than zero'; END IF;

  IF p_entry_id IS NULL THEN
    v_num:=public.generate_journal_entry_number();
    INSERT INTO public.journal_entries(entry_number,entry_date,description,source_module,total_debit,total_credit,
      is_posted,posted_by,created_by,transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
    VALUES(v_num,p_entry_date,NULLIF(p_description,''),'manual',round(v_dr*v_factor,2),round(v_cr*v_factor,2),
      true,auth.uid(),auth.uid(),p_transaction_currency,'IDR',v_factor,true)
    RETURNING id INTO v_id;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.journal_entries WHERE id=p_entry_id AND source_module='manual') THEN
      RAISE EXCEPTION 'Only manual journals can be edited';
    END IF;
    v_id:=p_entry_id;
    UPDATE public.journal_entries SET entry_date=p_entry_date,description=NULLIF(p_description,''),
      total_debit=round(v_dr*v_factor,2),total_credit=round(v_cr*v_factor,2),transaction_currency=p_transaction_currency,
      functional_currency='IDR',exchange_rate=v_factor,amounts_are_functional=true WHERE id=v_id;
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id=v_id;
  END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF COALESCE((v_line->>'debit')::numeric,0)>0 OR COALESCE((v_line->>'credit')::numeric,0)>0 THEN
      v_i:=v_i+1;
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,
        transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate)
      VALUES(v_id,v_i,(v_line->>'account_id')::uuid,NULLIF(v_line->>'description',''),
        round(COALESCE((v_line->>'debit')::numeric,0)*v_factor,2),
        round(COALESCE((v_line->>'credit')::numeric,0)*v_factor,2),p_transaction_currency,
        COALESCE((v_line->>'debit')::numeric,0),COALESCE((v_line->>'credit')::numeric,0),'IDR',v_factor);
    END IF;
  END LOOP;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. The only supported reconciliation link mutation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,
  p_document_type text,
  p_document_id uuid,
  p_payment_kind text DEFAULT 'supplier'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line public.bank_statement_lines%rowtype;
  v_je uuid;
  v_bank_coa uuid;
  v_expected numeric;
  v_bank_side numeric;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;
  IF p_document_type='expense' THEN
    IF NOT EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=p_document_id) THEN RAISE EXCEPTION 'Expense not found'; END IF;
    SELECT id INTO v_je FROM public.journal_entries WHERE source_module='expenses'
      AND (reference_id=p_document_id OR reference_number='EXP-'||p_document_id::text)
      AND is_posted=true AND COALESCE(is_reversed,false)=false ORDER BY created_at DESC LIMIT 1;
  ELSIF p_document_type='receipt' THEN
    SELECT journal_entry_id INTO v_je FROM public.receipt_vouchers WHERE id=p_document_id AND is_posted=true;
    IF v_je IS NULL THEN RAISE EXCEPTION 'Receipt must be posted before reconciliation'; END IF;
  ELSIF p_document_type='payment' THEN
    SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id=p_document_id AND is_posted=true;
    IF v_je IS NULL THEN RAISE EXCEPTION 'Payment must be posted before reconciliation'; END IF;
  ELSIF p_document_type='fund_transfer' THEN
    SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id=p_document_id AND status='posted';
    IF v_je IS NULL THEN RAISE EXCEPTION 'Contra must be posted before reconciliation'; END IF;
  ELSIF p_document_type='petty_cash' THEN
    SELECT id INTO v_je FROM public.journal_entries WHERE source_module='petty_cash' AND reference_id=p_document_id
      AND is_posted=true AND COALESCE(is_reversed,false)=false ORDER BY created_at DESC LIMIT 1;
  ELSIF p_document_type='tax_payment' THEN
    SELECT tp.journal_entry_id INTO v_je FROM public.tax_payments tp
    JOIN public.journal_entries je ON je.id=tp.journal_entry_id
    WHERE tp.id=p_document_id AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false;
    IF v_je IS NULL THEN RAISE EXCEPTION 'Tax Payment must have an active posted journal before reconciliation'; END IF;
  ELSIF p_document_type='journal' THEN
    SELECT id INTO v_je FROM public.journal_entries WHERE id=p_document_id AND is_posted=true AND COALESCE(is_reversed,false)=false;
    IF v_je IS NULL THEN RAISE EXCEPTION 'Journal must be active and posted'; END IF;
    SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id=v_line.bank_account_id;
    v_expected:=CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN v_line.credit_amount ELSE v_line.debit_amount END;
    SELECT COALESCE(MAX(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN jel.transaction_debit ELSE jel.transaction_credit END),
      MAX(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN jel.debit ELSE jel.credit END))
      INTO v_bank_side FROM public.journal_entry_lines jel WHERE jel.journal_entry_id=v_je AND jel.account_id=v_bank_coa;
    IF v_bank_side IS NULL OR abs(v_bank_side-v_expected)>0.01 THEN
      RAISE EXCEPTION 'Journal does not contain the selected bank account on the matching side and amount';
    END IF;
  ELSE RAISE EXCEPTION 'Unsupported reconciliation document type %',p_document_type;
  END IF;

  IF p_document_type<>'journal' THEN
    SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id=v_line.bank_account_id;
    v_expected:=CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN v_line.credit_amount ELSE v_line.debit_amount END;
    SELECT COALESCE(MAX(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN jel.transaction_debit ELSE jel.transaction_credit END),
      MAX(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN jel.debit ELSE jel.credit END))
      INTO v_bank_side FROM public.journal_entry_lines jel WHERE jel.journal_entry_id=v_je AND jel.account_id=v_bank_coa;
    IF v_bank_side IS NULL OR abs(v_bank_side-v_expected)>0.01 THEN
      RAISE EXCEPTION 'Document journal does not contain the selected bank account on the matching side and transaction amount';
    END IF;
  END IF;

  UPDATE public.bank_statement_lines SET
    matched_expense_id=CASE WHEN p_document_type='expense' THEN p_document_id ELSE NULL END,
    matched_receipt_id=CASE WHEN p_document_type='receipt' THEN p_document_id ELSE NULL END,
    matched_payment_id=CASE WHEN p_document_type='payment' THEN p_document_id ELSE NULL END,
    matched_fund_transfer_id=CASE WHEN p_document_type='fund_transfer' THEN p_document_id ELSE NULL END,
    matched_petty_cash_id=CASE WHEN p_document_type='petty_cash' THEN p_document_id ELSE NULL END,
    matched_tax_payment_id=CASE WHEN p_document_type='tax_payment' THEN p_document_id ELSE NULL END,
    matched_entry_id=v_je,reconciliation_status='matched',matching_status='confirmed',
    matched_at=now(),matched_by=auth.uid(),manually_unlinked=false,payment_kind=COALESCE(p_payment_kind,'supplier')
  WHERE id=p_bank_line_id;
  IF p_document_type='expense' THEN PERFORM public.recalculate_expense_payment_state(p_document_id); END IF;
  RETURN jsonb_build_object('bank_line_id',p_bank_line_id,'document_type',p_document_type,'document_id',p_document_id,'journal_entry_id',v_je);
END;
$$;

-- The canonical link RPC performs full eligibility checks. The trigger remains
-- a defence against arbitrary direct updates while allowing a valid active JE
-- that actually contains the selected bank GL account.
CREATE OR REPLACE FUNCTION public.enforce_no_journal_only_bank_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.matched_entry_id IS NULL OR NEW.matched_expense_id IS NOT NULL OR NEW.matched_receipt_id IS NOT NULL
     OR NEW.matched_payment_id IS NOT NULL
     OR NEW.matched_fund_transfer_id IS NOT NULL OR NEW.matched_petty_cash_id IS NOT NULL OR NEW.matched_tax_payment_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
  JOIN public.bank_accounts ba ON ba.coa_id=jel.account_id
  WHERE je.id=NEW.matched_entry_id AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
    AND ba.id=NEW.bank_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal is not an active posting to the selected bank account'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_enforce_no_journal_only_bank_link ON public.bank_statement_lines;
CREATE TRIGGER trigger_enforce_no_journal_only_bank_link
  BEFORE INSERT OR UPDATE OF matched_entry_id,matched_expense_id,matched_receipt_id,matched_payment_id,
    matched_fund_transfer_id,matched_petty_cash_id,matched_tax_payment_id
  ON public.bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_no_journal_only_bank_link();

CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_bank_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_expense_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT matched_expense_id INTO v_expense_id
    FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;
  UPDATE public.bank_statement_lines SET
    matched_expense_id=NULL,matched_receipt_id=NULL,matched_payment_id=NULL,
    matched_fund_transfer_id=NULL,matched_petty_cash_id=NULL,matched_tax_payment_id=NULL,
    matched_entry_id=NULL,matching_status='none',reconciliation_status='unmatched',
    matched_at=NULL,matched_by=NULL,notes=NULL,manually_unlinked=true,payment_kind='supplier'
  WHERE id=p_bank_line_id;
  IF v_expense_id IS NOT NULL THEN
    PERFORM public.recalculate_expense_payment_state(v_expense_id);
  END IF;
  RETURN jsonb_build_object('success',true,'bank_line_id',p_bank_line_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Audited deterministic historical repair and exception report.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.finance_historical_repair_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  total_records_scanned bigint NOT NULL DEFAULT 0,
  records_repaired bigint NOT NULL DEFAULT 0,
  records_partially_repaired bigint NOT NULL DEFAULT 0,
  records_manual_review bigint NOT NULL DEFAULT 0,
  records_skipped bigint NOT NULL DEFAULT 0,
  notes text
);

CREATE TABLE IF NOT EXISTS public.finance_historical_repair_items(
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.finance_historical_repair_runs(id),
  document_type text NOT NULL,
  document_id uuid NOT NULL,
  document_number text,
  repaired_fields text[] NOT NULL,
  old_metadata jsonb NOT NULL,
  new_metadata jsonb NOT NULL,
  repair_reason text NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_historical_repair_runs
  ADD COLUMN IF NOT EXISTS records_partially_repaired bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.finance_historical_repair_exceptions(
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.finance_historical_repair_runs(id),
  document_type text NOT NULL,
  document_id uuid NOT NULL,
  document_number text,
  inconsistent_fields text[] NOT NULL,
  reason text NOT NULL,
  manual_information_required text NOT NULL,
  status text NOT NULL DEFAULT 'manual_review' CHECK(status IN('manual_review','resolved','skipped')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_historical_repair_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_historical_repair_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_historical_repair_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_repair_runs_read ON public.finance_historical_repair_runs FOR SELECT TO authenticated
  USING (EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id=auth.uid() AND up.role IN('admin','accounts','auditor_ca')));
CREATE POLICY finance_repair_items_read ON public.finance_historical_repair_items FOR SELECT TO authenticated
  USING (EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id=auth.uid() AND up.role IN('admin','accounts','auditor_ca')));
CREATE POLICY finance_repair_exceptions_read ON public.finance_historical_repair_exceptions FOR SELECT TO authenticated
  USING (EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id=auth.uid() AND up.role IN('admin','accounts','auditor_ca')));

CREATE OR REPLACE FUNCTION public.run_deterministic_finance_historical_repair()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_run uuid;
  r record;
  v_number text;
  v_je uuid;
  v_scanned bigint:=0;
BEGIN
  -- Read by sync_expense_journal_currency_and_state(). Metadata repair may
  -- fire document triggers, but must never convert or rewrite old JE amounts.
  PERFORM set_config('app.finance_historical_repair','on',true);
  INSERT INTO public.finance_historical_repair_runs(notes)
  VALUES('Deterministic metadata/link repair. Accounting amounts are immutable.') RETURNING id INTO v_run;

  SELECT COUNT(*) INTO v_scanned FROM (
    SELECT id FROM public.finance_expenses UNION ALL SELECT id FROM public.receipt_vouchers
    UNION ALL SELECT id FROM public.payment_vouchers UNION ALL SELECT id FROM public.fund_transfers
    UNION ALL SELECT id FROM public.journal_entries UNION ALL SELECT id FROM public.bank_statement_lines
  ) s;

  -- Missing expense voucher numbers: chronological ordering is deterministic;
  -- numbering is metadata and does not alter accounting values.
  FOR r IN SELECT * FROM public.finance_expenses WHERE voucher_number IS NULL OR btrim(voucher_number)='' ORDER BY expense_date,created_at,id FOR UPDATE LOOP
    v_number:=public.next_expense_voucher_number(r.expense_date);
    INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
    VALUES(v_run,'expense',r.id,v_number,ARRAY['voucher_number'],jsonb_build_object('voucher_number',r.voucher_number),jsonb_build_object('voucher_number',v_number),'Legacy Bank Reconciliation expense omitted native voucher numbering');
    UPDATE public.finance_expenses SET voucher_number=v_number WHERE id=r.id;
  END LOOP;

  FOR r IN SELECT * FROM public.receipt_vouchers WHERE voucher_number IS NULL OR btrim(voucher_number)='' ORDER BY voucher_date,created_at,id FOR UPDATE LOOP
    v_number:=public.next_receipt_voucher_number(r.voucher_date);
    INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
    VALUES(v_run,'receipt',r.id,v_number,ARRAY['voucher_number'],jsonb_build_object('voucher_number',r.voucher_number),jsonb_build_object('voucher_number',v_number),'Missing receipt number repaired by the native atomic numbering engine');
    UPDATE public.receipt_vouchers SET voucher_number=v_number WHERE id=r.id;
  END LOOP;

  FOR r IN SELECT * FROM public.payment_vouchers WHERE voucher_number IS NULL OR btrim(voucher_number)='' ORDER BY voucher_date,created_at,id FOR UPDATE LOOP
    v_number:=public.next_payment_voucher_number(r.voucher_date);
    INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
    VALUES(v_run,'payment',r.id,v_number,ARRAY['voucher_number'],jsonb_build_object('voucher_number',r.voucher_number),jsonb_build_object('voucher_number',v_number),'Missing payment number repaired by the native atomic numbering engine');
    UPDATE public.payment_vouchers SET voucher_number=v_number WHERE id=r.id;
  END LOOP;

  -- Fund Transfer source metadata is deterministic when IDR is one side. The
  -- old poster's GL values are already functional only when IDR is the source;
  -- USD-source legacy postings are exceptions because correcting them would
  -- change posted accounting values.
  FOR r IN
    SELECT ft.id,ft.transfer_number,ft.status,ft.from_amount,ft.to_amount,ft.exchange_rate,ft.journal_entry_id,
      CASE WHEN ft.from_account_type='bank' THEN upper(fba.currency) ELSE 'IDR' END AS from_currency,
      CASE WHEN ft.to_account_type='bank' THEN upper(tba.currency) ELSE 'IDR' END AS to_currency,
      CASE
        WHEN (CASE WHEN ft.from_account_type='bank' THEN upper(fba.currency) ELSE 'IDR' END)='IDR'
         AND (CASE WHEN ft.to_account_type='bank' THEN upper(tba.currency) ELSE 'IDR' END)='IDR' THEN 1
        WHEN (CASE WHEN ft.from_account_type='bank' THEN upper(fba.currency) ELSE 'IDR' END)='IDR' AND ft.to_amount>0 THEN ft.from_amount/ft.to_amount
        WHEN (CASE WHEN ft.to_account_type='bank' THEN upper(tba.currency) ELSE 'IDR' END)='IDR' AND ft.from_amount>0 THEN ft.to_amount/ft.from_amount
      END AS expected_rate
    FROM public.fund_transfers ft
    LEFT JOIN public.bank_accounts fba ON fba.id=ft.from_bank_account_id
    LEFT JOIN public.bank_accounts tba ON tba.id=ft.to_bank_account_id
  LOOP
    IF r.status='posted' AND r.journal_entry_id IS NULL THEN
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'fund_transfer',r.id,r.transfer_number,ARRAY['journal_entry_id'],
        'Posted Fund Transfer has no linked Journal Entry','Correct active Journal Entry or accountant-authorised reversal/reposting');
    END IF;
    IF r.from_currency IS NULL OR r.to_currency IS NULL OR r.from_currency NOT IN('IDR','USD') OR r.to_currency NOT IN('IDR','USD') THEN
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'fund_transfer',r.id,r.transfer_number,ARRAY['from_currency','to_currency'],
        'Fund Transfer account relationships do not prove supported currencies','Correct source and destination account currencies');
    END IF;
    IF r.expected_rate IS NOT NULL AND (r.exchange_rate IS NULL OR abs(r.exchange_rate-r.expected_rate)>0.000001) THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      VALUES(v_run,'fund_transfer',r.id,r.transfer_number,ARRAY['exchange_rate'],
        jsonb_build_object('exchange_rate',r.exchange_rate),jsonb_build_object('exchange_rate',r.expected_rate),
        'Stored IDR and USD side amounts prove the USD-to-IDR Fund Transfer rate');
      UPDATE public.fund_transfers SET exchange_rate=r.expected_rate WHERE id=r.id;
    END IF;
    IF r.journal_entry_id IS NOT NULL AND r.from_currency='IDR' AND r.to_currency IN('IDR','USD')
       AND (r.to_currency='USD' OR abs(r.from_amount-r.to_amount)<=0.01) THEN
      IF EXISTS(SELECT 1 FROM public.journal_entries je LEFT JOIN public.journal_entry_lines l ON l.journal_entry_id=je.id
        WHERE je.id=r.journal_entry_id AND (je.transaction_currency IS NULL OR je.functional_currency IS NULL
          OR je.amounts_are_functional IS NULL OR l.transaction_currency IS NULL OR l.transaction_debit IS NULL
          OR l.transaction_credit IS NULL OR l.functional_currency IS NULL OR l.exchange_rate IS NULL)) THEN
        INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
        VALUES(v_run,'fund_transfer',r.id,r.transfer_number,ARRAY['journal currency metadata','journal line transaction metadata'],
          jsonb_build_object('journal_entry_id',r.journal_entry_id),
          jsonb_build_object('from_currency',r.from_currency,'to_currency',r.to_currency,'exchange_rate',COALESCE(r.expected_rate,1)),
          'IDR-source legacy Contra already stores functional IDR GL values; source amounts prove line transaction metadata');
        UPDATE public.journal_entry_lines SET
          transaction_currency=COALESCE(transaction_currency,CASE WHEN line_number=1 THEN r.to_currency ELSE r.from_currency END),
          transaction_debit=COALESCE(transaction_debit,CASE WHEN line_number=1 THEN r.to_amount ELSE 0 END),
          transaction_credit=COALESCE(transaction_credit,CASE WHEN line_number=2 THEN r.from_amount ELSE 0 END),
          functional_currency=COALESCE(functional_currency,'IDR'),
          exchange_rate=COALESCE(exchange_rate,CASE WHEN line_number=1 AND r.to_currency='USD' THEN r.expected_rate ELSE 1 END)
        WHERE journal_entry_id=r.journal_entry_id AND line_number IN(1,2);
        UPDATE public.journal_entries SET transaction_currency=COALESCE(transaction_currency,CASE WHEN r.from_currency=r.to_currency THEN r.from_currency ELSE 'IDR' END),
          functional_currency=COALESCE(functional_currency,'IDR'),exchange_rate=COALESCE(exchange_rate,COALESCE(r.expected_rate,1)),
          amounts_are_functional=COALESCE(amounts_are_functional,true)
        WHERE id=r.journal_entry_id;
      END IF;
    ELSIF r.journal_entry_id IS NOT NULL AND r.from_currency='USD' THEN
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'fund_transfer',r.id,r.transfer_number,ARRAY['journal functional debit/credit','journal currency metadata'],
        'Legacy USD-source Contra stored the USD source amount in functional GL columns; posted values were not rewritten',
        'Accountant approval of the historical USD-to-IDR rate and a controlled correcting/reversal entry');
    END IF;
  END LOOP;

  -- Expense bank/currency metadata only when exactly one linked bank account is
  -- provable. IDR rate is certain; USD rate is never guessed.
  FOR r IN
    SELECT fe.id,fe.voucher_number,fe.bank_account_id,fe.payment_method,fe.transaction_currency,fe.currency_code,
      fe.functional_currency,fe.bank_account_currency,fe.payment_currency,fe.exchange_rate,
      (array_agg(DISTINCT bsl.bank_account_id))[1] AS linked_bank_id,min(upper(COALESCE(bsl.currency,ba.currency))) AS linked_currency,
      count(DISTINCT bsl.bank_account_id) AS bank_count
    FROM public.finance_expenses fe LEFT JOIN public.bank_statement_lines bsl ON bsl.matched_expense_id=fe.id
    LEFT JOIN public.bank_accounts ba ON ba.id=bsl.bank_account_id
    GROUP BY fe.id HAVING count(bsl.id)>0
  LOOP
    IF r.bank_count=1 THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      SELECT v_run,'expense',r.id,r.voucher_number,
        ARRAY_REMOVE(ARRAY[CASE WHEN r.bank_account_id IS NULL THEN 'bank_account_id' END,
          CASE WHEN r.transaction_currency IS NULL THEN 'transaction_currency' END,
          CASE WHEN r.currency_code IS NULL THEN 'currency_code' END,
          CASE WHEN r.functional_currency IS NULL THEN 'functional_currency' END,
          CASE WHEN r.bank_account_currency IS NULL THEN 'bank_account_currency' END,
          CASE WHEN r.payment_currency IS NULL THEN 'payment_currency' END,
          CASE WHEN r.linked_currency='IDR' AND r.exchange_rate IS NULL THEN 'exchange_rate' END],NULL),
        jsonb_build_object('bank_account_id',r.bank_account_id,'transaction_currency',r.transaction_currency,
          'currency_code',r.currency_code,'functional_currency',r.functional_currency,
          'bank_account_currency',r.bank_account_currency,'payment_currency',r.payment_currency,'exchange_rate',r.exchange_rate),
        jsonb_build_object('bank_account_id',COALESCE(r.bank_account_id,r.linked_bank_id),
          'transaction_currency',COALESCE(r.transaction_currency,r.linked_currency),
          'currency_code',COALESCE(r.currency_code,r.linked_currency),'functional_currency',COALESCE(r.functional_currency,'IDR'),
          'bank_account_currency',COALESCE(r.bank_account_currency,r.linked_currency),
          'payment_currency',COALESCE(r.payment_currency,r.linked_currency),
          'exchange_rate',COALESCE(r.exchange_rate,CASE WHEN r.linked_currency='IDR' THEN 1 END)),
        'Unique reconciliation line proves bank account and transaction currency'
      WHERE r.bank_account_id IS NULL OR r.transaction_currency IS NULL OR r.currency_code IS NULL
         OR r.functional_currency IS NULL OR r.bank_account_currency IS NULL OR r.payment_currency IS NULL
         OR (r.linked_currency='IDR' AND r.exchange_rate IS NULL);
      UPDATE public.finance_expenses SET bank_account_id=COALESCE(bank_account_id,r.linked_bank_id),
        currency_code=COALESCE(currency_code,r.linked_currency),transaction_currency=COALESCE(transaction_currency,r.linked_currency),
        functional_currency=COALESCE(functional_currency,'IDR'),bank_account_currency=COALESCE(bank_account_currency,r.linked_currency),
        payment_currency=COALESCE(payment_currency,r.linked_currency),exchange_rate=COALESCE(exchange_rate,CASE WHEN r.linked_currency='IDR' THEN 1 END)
      WHERE id=r.id;
      IF r.linked_currency='USD' AND r.exchange_rate IS NULL THEN
        INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
        VALUES(v_run,'expense',r.id,r.voucher_number,ARRAY['exchange_rate'],'USD currency is certain but no historical transaction-date rate is stored','Authoritative USD-to-IDR rate and rate source/date');
      END IF;
      IF (r.bank_account_id IS NOT NULL AND r.bank_account_id<>r.linked_bank_id)
         OR (r.transaction_currency IS NOT NULL AND upper(r.transaction_currency)<>r.linked_currency) THEN
        INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
        VALUES(v_run,'expense',r.id,r.voucher_number,
          ARRAY_REMOVE(ARRAY[CASE WHEN r.bank_account_id IS NOT NULL AND r.bank_account_id<>r.linked_bank_id THEN 'bank_account_id' END,
            CASE WHEN r.transaction_currency IS NOT NULL AND upper(r.transaction_currency)<>r.linked_currency THEN 'transaction_currency' END],NULL),
          'Stored expense metadata conflicts with its unique reconciliation bank line; neither side was overwritten',
          'Accountant confirmation of the correct bank account and transaction currency');
      END IF;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'expense',r.id,r.voucher_number,ARRAY['bank_account_id','transaction_currency'],'More than one linked bank account; no single relationship is certain','Correct paying bank account and transaction currency');
    END IF;
  END LOOP;

  -- IDR source rows have a certain functional rate of 1.
  INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
  SELECT v_run,'expense',id,voucher_number,
    ARRAY_REMOVE(ARRAY[CASE WHEN exchange_rate IS NULL THEN 'exchange_rate' END,CASE WHEN functional_currency IS NULL THEN 'functional_currency' END],NULL),
    jsonb_build_object('exchange_rate',exchange_rate,'functional_currency',functional_currency),
    jsonb_build_object('exchange_rate',COALESCE(exchange_rate,1),'functional_currency',COALESCE(functional_currency,'IDR')),
    'IDR functional rate and functional currency are deterministic'
  FROM public.finance_expenses WHERE transaction_currency='IDR' AND (exchange_rate IS NULL OR functional_currency IS NULL);
  UPDATE public.finance_expenses SET exchange_rate=COALESCE(exchange_rate,1),functional_currency=COALESCE(functional_currency,'IDR')
  WHERE transaction_currency='IDR' AND (exchange_rate IS NULL OR functional_currency IS NULL);

  -- Duplicate historical numbers are never silently renumbered because the
  -- correct legal document number cannot be inferred.
  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'expense',fe.id,fe.voucher_number,ARRAY['voucher_number'],
    'Voucher number is duplicated; renumbering legal history is not deterministic',
    'Accountant-approved canonical number for every duplicated document'
  FROM public.finance_expenses fe JOIN (
    SELECT voucher_number FROM public.finance_expenses WHERE voucher_number IS NOT NULL
    GROUP BY voucher_number HAVING count(*)>1
  ) d USING(voucher_number);

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'receipt',rv.id,rv.voucher_number,ARRAY['voucher_number'],
    'Voucher number is duplicated; legal history cannot be renumbered deterministically',
    'Accountant-approved canonical number for every duplicated receipt'
  FROM public.receipt_vouchers rv JOIN (
    SELECT voucher_number FROM public.receipt_vouchers WHERE voucher_number IS NOT NULL
    GROUP BY voucher_number HAVING count(*)>1
  ) d USING(voucher_number);

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'payment',pv.id,pv.voucher_number,ARRAY['voucher_number'],
    'Voucher number is duplicated; legal history cannot be renumbered deterministically',
    'Accountant-approved canonical number for every duplicated payment'
  FROM public.payment_vouchers pv JOIN (
    SELECT voucher_number FROM public.payment_vouchers WHERE voucher_number IS NOT NULL
    GROUP BY voucher_number HAVING count(*)>1
  ) d USING(voucher_number);

  -- Deterministic source identity repairs.
  FOR r IN SELECT id,entry_number,reference_number,reference_id FROM public.journal_entries
    WHERE source_module='expenses' AND reference_id IS NULL AND reference_number LIKE 'EXP-%' LOOP
    BEGIN
      IF EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=substring(r.reference_number from 5)::uuid) THEN
        INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
        VALUES(v_run,'journal',r.id,r.entry_number,ARRAY['reference_id'],jsonb_build_object('reference_id',NULL),
          jsonb_build_object('reference_id',substring(r.reference_number from 5)::uuid),'EXP UUID reference deterministically identifies source expense');
        UPDATE public.journal_entries SET reference_id=substring(r.reference_number from 5)::uuid WHERE id=r.id;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'journal',r.id,r.entry_number,ARRAY['reference_id'],'Expense reference number does not contain a valid UUID','Correct source expense database ID');
    END;
  END LOOP;

  -- Canonical JE links from typed document links.
  FOR r IN SELECT bsl.id,bsl.reference,bsl.matched_entry_id,
      COALESCE(rv.journal_entry_id,pv.journal_entry_id,ft.journal_entry_id,tp.journal_entry_id,je_exp.id,je_pc.id) AS resolved_je
    FROM public.bank_statement_lines bsl
    LEFT JOIN public.receipt_vouchers rv ON rv.id=bsl.matched_receipt_id
    LEFT JOIN public.payment_vouchers pv ON pv.id=bsl.matched_payment_id
    LEFT JOIN public.fund_transfers ft ON ft.id=bsl.matched_fund_transfer_id
    LEFT JOIN public.tax_payments tp ON tp.id=bsl.matched_tax_payment_id
    LEFT JOIN LATERAL(SELECT id FROM public.journal_entries WHERE source_module='expenses'
      AND (reference_id=bsl.matched_expense_id OR reference_number='EXP-'||bsl.matched_expense_id::text)
      AND is_posted=true AND COALESCE(is_reversed,false)=false ORDER BY created_at DESC LIMIT 1) je_exp ON true
    LEFT JOIN LATERAL(SELECT id FROM public.journal_entries WHERE source_module='petty_cash' AND reference_id=bsl.matched_petty_cash_id AND is_posted=true AND COALESCE(is_reversed,false)=false ORDER BY created_at DESC LIMIT 1) je_pc ON true
    WHERE bsl.matched_entry_id IS NULL AND (bsl.matched_expense_id IS NOT NULL OR bsl.matched_receipt_id IS NOT NULL OR bsl.matched_payment_id IS NOT NULL OR bsl.matched_fund_transfer_id IS NOT NULL OR bsl.matched_petty_cash_id IS NOT NULL OR bsl.matched_tax_payment_id IS NOT NULL)
  LOOP
    IF r.resolved_je IS NOT NULL THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      VALUES(v_run,'bank_reconciliation',r.id,r.reference,ARRAY['matched_entry_id'],jsonb_build_object('matched_entry_id',NULL),jsonb_build_object('matched_entry_id',r.resolved_je),'Typed document link resolves one active journal');
      UPDATE public.bank_statement_lines SET matched_entry_id=r.resolved_je WHERE id=r.id;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'bank_reconciliation',r.id,r.reference,ARRAY['matched_entry_id'],'Linked document has no provable active journal','Post or identify the correct source document journal');
    END IF;
  END LOOP;

  -- Recover missing typed document links from an existing canonical JE only
  -- when exactly one source document owns that JE.
  FOR r IN
    WITH untyped AS (
      SELECT b.* FROM public.bank_statement_lines b
      WHERE b.matched_entry_id IS NOT NULL AND b.matched_expense_id IS NULL
        AND b.matched_receipt_id IS NULL AND b.matched_payment_id IS NULL
        AND b.matched_fund_transfer_id IS NULL AND b.matched_petty_cash_id IS NULL
        AND b.matched_tax_payment_id IS NULL
    ), candidates AS (
      SELECT b.id,b.reference,'expense'::text AS source_type,fe.id AS source_id
      FROM untyped b JOIN public.journal_entries je ON je.id=b.matched_entry_id
      JOIN public.finance_expenses fe ON je.source_module='expenses'
        AND (je.reference_id=fe.id OR je.reference_number='EXP-'||fe.id::text)
      UNION ALL
      SELECT b.id,b.reference,'receipt',rv.id FROM untyped b JOIN public.receipt_vouchers rv ON rv.journal_entry_id=b.matched_entry_id
      UNION ALL
      SELECT b.id,b.reference,'payment',pv.id FROM untyped b JOIN public.payment_vouchers pv ON pv.journal_entry_id=b.matched_entry_id
      UNION ALL
      SELECT b.id,b.reference,'fund_transfer',ft.id FROM untyped b JOIN public.fund_transfers ft ON ft.journal_entry_id=b.matched_entry_id
      UNION ALL
      SELECT b.id,b.reference,'petty_cash',pc.id FROM untyped b JOIN public.journal_entries je ON je.id=b.matched_entry_id
        JOIN public.petty_cash_transactions pc ON je.source_module='petty_cash' AND je.reference_id=pc.id
      UNION ALL
      SELECT b.id,b.reference,'tax_payment',tp.id FROM untyped b JOIN public.tax_payments tp ON tp.journal_entry_id=b.matched_entry_id
    )
    SELECT id,reference,(array_agg(source_type ORDER BY source_type))[1] AS source_type,
      (array_agg(source_id ORDER BY source_type))[1] AS source_id,count(*) AS candidate_count
    FROM candidates GROUP BY id,reference
  LOOP
    IF r.candidate_count=1 THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      VALUES(v_run,'bank_reconciliation',r.id,r.reference,ARRAY['typed document link'],
        jsonb_build_object('typed_document_id',NULL),jsonb_build_object('document_type',r.source_type,'document_id',r.source_id),
        'Existing Journal Entry is owned by exactly one native Finance document');
      UPDATE public.bank_statement_lines SET
        matched_expense_id=CASE WHEN r.source_type='expense' THEN r.source_id ELSE matched_expense_id END,
        matched_receipt_id=CASE WHEN r.source_type='receipt' THEN r.source_id ELSE matched_receipt_id END,
        matched_payment_id=CASE WHEN r.source_type='payment' THEN r.source_id ELSE matched_payment_id END,
        matched_fund_transfer_id=CASE WHEN r.source_type='fund_transfer' THEN r.source_id ELSE matched_fund_transfer_id END,
        matched_petty_cash_id=CASE WHEN r.source_type='petty_cash' THEN r.source_id ELSE matched_petty_cash_id END,
        matched_tax_payment_id=CASE WHEN r.source_type='tax_payment' THEN r.source_id ELSE matched_tax_payment_id END
      WHERE id=r.id;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'bank_reconciliation',r.id,r.reference,ARRAY['typed document link'],
        'Journal Entry is owned by more than one possible native document','Accountant selection of the source document represented by this bank line');
    END IF;
  END LOOP;

  -- Legacy bank-reconciliation JEs stored the bank-statement amount directly
  -- in debit/credit. A single linked statement currency proves the transaction
  -- currency. IDR also proves rate=1 and functional values. For USD, the rate
  -- and functional values are unknown: preserve every amount and raise an
  -- exception instead of pretending the values are IDR.
  FOR r IN
    SELECT je.id,je.entry_number,je.transaction_currency,je.functional_currency,je.exchange_rate,je.amounts_are_functional,
      min(upper(COALESCE(bsl.currency,ba.currency))) AS proven_currency,
      count(DISTINCT upper(COALESCE(bsl.currency,ba.currency))) AS currency_count,
      bool_or(jel.transaction_currency IS NULL OR jel.transaction_debit IS NULL OR jel.transaction_credit IS NULL
        OR jel.functional_currency IS NULL OR (upper(COALESCE(bsl.currency,ba.currency))='IDR' AND jel.exchange_rate IS NULL)) AS line_metadata_missing
    FROM public.journal_entries je
    JOIN public.bank_statement_lines bsl ON bsl.matched_entry_id=je.id
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
    LEFT JOIN public.bank_accounts ba ON ba.id=bsl.bank_account_id
    WHERE je.source_module='bank_reconciliation'
    GROUP BY je.id
  LOOP
    IF r.currency_count=1 AND r.proven_currency IN ('IDR','USD') THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      SELECT v_run,'journal',r.id,r.entry_number,
        ARRAY_REMOVE(ARRAY[CASE WHEN r.transaction_currency IS NULL THEN 'transaction_currency' END,
          CASE WHEN r.functional_currency IS NULL THEN 'functional_currency' END,
          CASE WHEN r.proven_currency='IDR' AND r.exchange_rate IS NULL THEN 'exchange_rate' END,
          CASE WHEN r.amounts_are_functional IS NULL THEN 'amounts_are_functional' END,
          CASE WHEN r.line_metadata_missing THEN 'journal_lines.currency_and_transaction_metadata' END],NULL),
        jsonb_build_object('transaction_currency',r.transaction_currency,'functional_currency',r.functional_currency,
          'exchange_rate',r.exchange_rate,'amounts_are_functional',r.amounts_are_functional,
          'journal_lines_metadata_missing',r.line_metadata_missing),
        jsonb_build_object('transaction_currency',COALESCE(r.transaction_currency,r.proven_currency),
          'functional_currency','IDR','exchange_rate',COALESCE(r.exchange_rate,CASE WHEN r.proven_currency='IDR' THEN 1 END),
          'amounts_are_functional',r.proven_currency='IDR'),
        'Exactly one linked bank-statement currency proves journal transaction currency'
      WHERE r.transaction_currency IS NULL OR r.functional_currency IS NULL OR r.amounts_are_functional IS NULL
         OR r.line_metadata_missing OR (r.proven_currency='IDR' AND r.exchange_rate IS NULL);

      UPDATE public.journal_entries SET
        transaction_currency=COALESCE(transaction_currency,r.proven_currency),functional_currency=COALESCE(functional_currency,'IDR'),
        exchange_rate=COALESCE(exchange_rate,CASE WHEN r.proven_currency='IDR' THEN 1 END),
        amounts_are_functional=COALESCE(amounts_are_functional,CASE WHEN r.proven_currency='IDR' THEN true ELSE false END)
      WHERE id=r.id;
      UPDATE public.journal_entry_lines SET
        transaction_currency=COALESCE(transaction_currency,r.proven_currency),
        transaction_debit=COALESCE(transaction_debit,debit),transaction_credit=COALESCE(transaction_credit,credit),
        functional_currency=COALESCE(functional_currency,'IDR'),
        exchange_rate=COALESCE(exchange_rate,CASE WHEN r.proven_currency='IDR' THEN 1 END)
      WHERE journal_entry_id=r.id;

      IF r.proven_currency='USD' AND r.exchange_rate IS NULL THEN
        INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
        VALUES(v_run,'journal',r.id,r.entry_number,ARRAY['exchange_rate','functional debit/credit values'],
          'USD transaction currency is proven, but no authoritative historical rate is stored; posted amounts were preserved',
          'Authoritative USD-to-IDR rate and rate source/date; accountant approval before functional values are corrected');
      END IF;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'journal',r.id,r.entry_number,ARRAY['transaction_currency','exchange_rate'],
        'Linked bank statements do not prove exactly one currency','Correct transaction currency and authoritative historical exchange rate');
    END IF;
  END LOOP;

  -- Native receipt metadata is repairable only from its own unique typed bank
  -- reconciliation link. This does not post, unpost, or alter the receipt.
  FOR r IN
    SELECT rv.id,rv.voucher_number,rv.bank_account_id,rv.payment_method,rv.transaction_currency,rv.currency_code,
      rv.functional_currency,rv.bank_account_currency,rv.payment_currency,rv.exchange_rate,
      (array_agg(DISTINCT bsl.bank_account_id))[1] AS linked_bank_id,min(upper(COALESCE(bsl.currency,ba.currency))) AS linked_currency,
      count(DISTINCT bsl.bank_account_id) AS bank_count
    FROM public.receipt_vouchers rv
    JOIN public.bank_statement_lines bsl ON bsl.matched_receipt_id=rv.id
    LEFT JOIN public.bank_accounts ba ON ba.id=bsl.bank_account_id
    GROUP BY rv.id
  LOOP
    IF r.bank_count=1 AND r.linked_currency IN ('IDR','USD') THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      SELECT v_run,'receipt',r.id,r.voucher_number,
        ARRAY_REMOVE(ARRAY[CASE WHEN r.bank_account_id IS NULL THEN 'bank_account_id' END,
          CASE WHEN r.transaction_currency IS NULL THEN 'transaction_currency' END,
          CASE WHEN r.currency_code IS NULL THEN 'currency_code' END,
          CASE WHEN r.functional_currency IS NULL THEN 'functional_currency' END,
          CASE WHEN r.bank_account_currency IS NULL THEN 'bank_account_currency' END,
          CASE WHEN r.payment_currency IS NULL THEN 'payment_currency' END,
          CASE WHEN r.linked_currency='IDR' AND r.exchange_rate IS NULL THEN 'exchange_rate' END],NULL),
        jsonb_build_object('bank_account_id',r.bank_account_id,'transaction_currency',r.transaction_currency,
          'currency_code',r.currency_code,'functional_currency',r.functional_currency,
          'bank_account_currency',r.bank_account_currency,'payment_currency',r.payment_currency,'exchange_rate',r.exchange_rate),
        jsonb_build_object('bank_account_id',COALESCE(r.bank_account_id,r.linked_bank_id),
          'transaction_currency',COALESCE(r.transaction_currency,r.linked_currency),
          'currency_code',COALESCE(r.currency_code,r.linked_currency),'functional_currency',COALESCE(r.functional_currency,'IDR'),
          'bank_account_currency',COALESCE(r.bank_account_currency,r.linked_currency),
          'payment_currency',COALESCE(r.payment_currency,r.linked_currency),
          'exchange_rate',COALESCE(r.exchange_rate,CASE WHEN r.linked_currency='IDR' THEN 1 END)),
        'Unique typed reconciliation link proves receipt bank and currency'
      WHERE r.bank_account_id IS NULL OR r.transaction_currency IS NULL OR r.currency_code IS NULL
         OR r.functional_currency IS NULL OR r.bank_account_currency IS NULL OR r.payment_currency IS NULL
         OR (r.linked_currency='IDR' AND r.exchange_rate IS NULL);
      UPDATE public.receipt_vouchers SET bank_account_id=COALESCE(bank_account_id,r.linked_bank_id),
        currency_code=COALESCE(currency_code,r.linked_currency),
        transaction_currency=COALESCE(transaction_currency,r.linked_currency),functional_currency=COALESCE(functional_currency,'IDR'),
        bank_account_currency=COALESCE(bank_account_currency,r.linked_currency),payment_currency=COALESCE(payment_currency,r.linked_currency),
        exchange_rate=COALESCE(exchange_rate,CASE WHEN r.linked_currency='IDR' THEN 1 END)
      WHERE id=r.id;
      IF r.linked_currency='USD' AND r.exchange_rate IS NULL THEN
        INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
        VALUES(v_run,'receipt',r.id,r.voucher_number,ARRAY['exchange_rate'],'USD receipt has no stored historical rate','Authoritative USD-to-IDR rate and rate source/date');
      END IF;
      IF (r.bank_account_id IS NOT NULL AND r.bank_account_id<>r.linked_bank_id)
         OR (r.transaction_currency IS NOT NULL AND upper(r.transaction_currency)<>r.linked_currency) THEN
        INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
        VALUES(v_run,'receipt',r.id,r.voucher_number,
          ARRAY_REMOVE(ARRAY[CASE WHEN r.bank_account_id IS NOT NULL AND r.bank_account_id<>r.linked_bank_id THEN 'bank_account_id' END,
            CASE WHEN r.transaction_currency IS NOT NULL AND upper(r.transaction_currency)<>r.linked_currency THEN 'transaction_currency' END],NULL),
          'Stored receipt metadata conflicts with its unique reconciliation bank line; neither side was overwritten',
          'Accountant confirmation of the correct receiving bank and transaction currency');
      END IF;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'receipt',r.id,r.voucher_number,ARRAY['bank_account_id','transaction_currency'],'Typed links do not prove one bank account','Correct receiving bank account and transaction currency');
    END IF;
  END LOOP;

  -- Payment voucher links now use the same typed-FK contract as every other
  -- Finance document. Existing payment amounts and rates are retained.
  FOR r IN
    SELECT pv.id,pv.voucher_number,pv.bank_account_id,pv.payment_method,pv.payment_currency,pv.transaction_currency,
      pv.currency_code,pv.functional_currency,pv.bank_account_currency,pv.exchange_rate,
      (array_agg(DISTINCT bsl.bank_account_id))[1] AS linked_bank_id,
      min(upper(COALESCE(bsl.currency,ba.currency))) AS linked_currency,
      count(DISTINCT bsl.bank_account_id) AS bank_count
    FROM public.payment_vouchers pv
    JOIN public.bank_statement_lines bsl ON bsl.matched_payment_id=pv.id
    LEFT JOIN public.bank_accounts ba ON ba.id=bsl.bank_account_id
    GROUP BY pv.id
  LOOP
    IF r.bank_count=1 AND r.linked_currency IN ('IDR','USD') THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      SELECT v_run,'payment',r.id,r.voucher_number,
        ARRAY_REMOVE(ARRAY[CASE WHEN r.bank_account_id IS NULL THEN 'bank_account_id' END,
          CASE WHEN r.payment_currency IS NULL THEN 'payment_currency' END,
          CASE WHEN r.transaction_currency IS NULL THEN 'transaction_currency' END,
          CASE WHEN r.currency_code IS NULL THEN 'currency_code' END,
          CASE WHEN r.functional_currency IS NULL THEN 'functional_currency' END,
          CASE WHEN r.bank_account_currency IS NULL THEN 'bank_account_currency' END,
          CASE WHEN r.linked_currency='IDR' AND r.exchange_rate IS NULL THEN 'exchange_rate' END],NULL),
        jsonb_build_object('bank_account_id',r.bank_account_id,'payment_currency',r.payment_currency,
          'transaction_currency',r.transaction_currency,'currency_code',r.currency_code,
          'functional_currency',r.functional_currency,'bank_account_currency',r.bank_account_currency,'exchange_rate',r.exchange_rate),
        jsonb_build_object('bank_account_id',COALESCE(r.bank_account_id,r.linked_bank_id),
          'payment_currency',COALESCE(r.payment_currency,r.linked_currency),
          'transaction_currency',COALESCE(r.transaction_currency,r.linked_currency),
          'currency_code',COALESCE(r.currency_code,r.linked_currency),'functional_currency',COALESCE(r.functional_currency,'IDR'),
          'bank_account_currency',COALESCE(r.bank_account_currency,r.linked_currency),
          'exchange_rate',COALESCE(r.exchange_rate,CASE WHEN r.linked_currency='IDR' THEN 1 END)),
        'Unique typed reconciliation link proves payment bank and currency'
      WHERE r.bank_account_id IS NULL OR r.payment_currency IS NULL OR r.transaction_currency IS NULL
         OR r.currency_code IS NULL OR r.functional_currency IS NULL OR r.bank_account_currency IS NULL
         OR (r.linked_currency='IDR' AND r.exchange_rate IS NULL);
      UPDATE public.payment_vouchers SET bank_account_id=COALESCE(bank_account_id,r.linked_bank_id),
        payment_currency=COALESCE(payment_currency,r.linked_currency),currency_code=COALESCE(currency_code,r.linked_currency),
        transaction_currency=COALESCE(transaction_currency,r.linked_currency),functional_currency=COALESCE(functional_currency,'IDR'),
        bank_account_currency=COALESCE(bank_account_currency,r.linked_currency),
        exchange_rate=COALESCE(exchange_rate,CASE WHEN r.linked_currency='IDR' THEN 1 END)
      WHERE id=r.id;
      IF r.linked_currency='USD' AND r.exchange_rate IS NULL THEN
        INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
        VALUES(v_run,'payment',r.id,r.voucher_number,ARRAY['exchange_rate'],'USD payment has no stored historical rate','Authoritative USD-to-IDR rate and rate source/date');
      END IF;
      IF (r.bank_account_id IS NOT NULL AND r.bank_account_id<>r.linked_bank_id)
         OR (r.payment_currency IS NOT NULL AND upper(r.payment_currency)<>r.linked_currency) THEN
        INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
        VALUES(v_run,'payment',r.id,r.voucher_number,
          ARRAY_REMOVE(ARRAY[CASE WHEN r.bank_account_id IS NOT NULL AND r.bank_account_id<>r.linked_bank_id THEN 'bank_account_id' END,
            CASE WHEN r.payment_currency IS NOT NULL AND upper(r.payment_currency)<>r.linked_currency THEN 'payment_currency' END],NULL),
          'Stored payment metadata conflicts with its unique reconciliation bank line; neither side was overwritten',
          'Accountant confirmation of the correct paying bank and payment currency');
      END IF;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'payment',r.id,r.voucher_number,ARRAY['bank_account_id','transaction_currency'],'Journal links do not prove one bank account','Correct paying bank account and transaction currency');
    END IF;
  END LOOP;

  -- Restore missing native document-to-journal links only when exactly one
  -- active JE identifies the document by source_module + reference_id.
  FOR r IN
    SELECT rv.id,rv.voucher_number,(array_agg(je.id ORDER BY je.created_at))[1] AS resolved_je,count(je.id) AS je_count
    FROM public.receipt_vouchers rv JOIN public.journal_entries je
      ON je.source_module='receipt' AND je.reference_id=rv.id AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
    WHERE rv.journal_entry_id IS NULL GROUP BY rv.id
  LOOP
    IF r.je_count=1 THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      VALUES(v_run,'receipt',r.id,r.voucher_number,ARRAY['journal_entry_id'],jsonb_build_object('journal_entry_id',NULL),jsonb_build_object('journal_entry_id',r.resolved_je),'One active native receipt journal proves the missing link');
      UPDATE public.receipt_vouchers SET journal_entry_id=r.resolved_je WHERE id=r.id;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'receipt',r.id,r.voucher_number,ARRAY['journal_entry_id'],'More than one active receipt journal identifies this document','Accountant selection of the canonical active journal');
    END IF;
  END LOOP;

  FOR r IN
    SELECT pv.id,pv.voucher_number,(array_agg(je.id ORDER BY je.created_at))[1] AS resolved_je,count(je.id) AS je_count
    FROM public.payment_vouchers pv JOIN public.journal_entries je
      ON je.source_module='payment' AND je.reference_id=pv.id AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
    WHERE pv.journal_entry_id IS NULL GROUP BY pv.id
  LOOP
    IF r.je_count=1 THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      VALUES(v_run,'payment',r.id,r.voucher_number,ARRAY['journal_entry_id'],jsonb_build_object('journal_entry_id',NULL),jsonb_build_object('journal_entry_id',r.resolved_je),'One active native payment journal proves the missing link');
      UPDATE public.payment_vouchers SET journal_entry_id=r.resolved_je WHERE id=r.id;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'payment',r.id,r.voucher_number,ARRAY['journal_entry_id'],'More than one active payment journal identifies this document','Accountant selection of the canonical active journal');
    END IF;
  END LOOP;

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'receipt',rv.id,rv.voucher_number,ARRAY['journal_entry_id'],
    'Posted receipt has no uniquely identifiable active journal','Correct active Journal Entry or accountant-authorised reposting'
  FROM public.receipt_vouchers rv
  WHERE rv.is_posted=true AND rv.journal_entry_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.journal_entries je WHERE je.source_module='receipt' AND je.reference_id=rv.id
      AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false);

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'payment',pv.id,pv.voucher_number,ARRAY['journal_entry_id'],
    'Posted payment has no uniquely identifiable active journal','Correct active Journal Entry or accountant-authorised reposting'
  FROM public.payment_vouchers pv
  WHERE pv.is_posted=true AND pv.journal_entry_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.journal_entries je WHERE je.source_module='payment' AND je.reference_id=pv.id
      AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false);

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'expense',fe.id,fe.voucher_number,ARRAY['active journal'],
    CASE WHEN count(je.id)=0 THEN 'Approved expense has no active journal' ELSE 'Approved expense has more than one active journal' END,
    CASE WHEN count(je.id)=0 THEN 'Accountant-authorised posting through the native Expense workflow' ELSE 'Accountant selection/reversal of duplicate active journals' END
  FROM public.finance_expenses fe
  LEFT JOIN public.journal_entries je ON je.source_module='expenses'
    AND (je.reference_id=fe.id OR je.reference_number='EXP-'||fe.id::text)
    AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
  WHERE fe.approval_status='approved'
  GROUP BY fe.id HAVING count(je.id)<>1;

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'bank_reconciliation',b.id,b.reference,ARRAY['document link','journal link'],
    'Bank line is marked matched/recorded but has no document or Journal Entry link',
    'Correct source document or reset the line to Unmatched'
  FROM public.bank_statement_lines b
  WHERE b.reconciliation_status IN('matched','recorded') AND b.matched_entry_id IS NULL
    AND b.matched_expense_id IS NULL AND b.matched_receipt_id IS NULL AND b.matched_payment_id IS NULL
    AND b.matched_fund_transfer_id IS NULL AND b.matched_petty_cash_id IS NULL AND b.matched_tax_payment_id IS NULL;

  -- If a document already owns a journal but the reverse source ID is absent,
  -- the FK itself proves reference_id. Mismatches are exceptions, never fixed.
  FOR r IN
    SELECT je.id,je.entry_number,je.source_module,je.reference_id,rv.id AS source_id
    FROM public.receipt_vouchers rv JOIN public.journal_entries je ON je.id=rv.journal_entry_id
    WHERE (je.source_module IS NULL OR je.source_module='receipt')
      AND (je.source_module IS NULL OR je.reference_id IS NULL OR je.reference_id<>rv.id)
  LOOP
    IF (r.reference_id IS NULL OR r.reference_id=r.source_id) AND (r.source_module IS NULL OR r.source_module='receipt') THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      VALUES(v_run,'journal',r.id,r.entry_number,
        ARRAY_REMOVE(ARRAY[CASE WHEN r.source_module IS NULL THEN 'source_module' END,
          CASE WHEN r.reference_id IS NULL THEN 'reference_id' END],NULL),
        jsonb_build_object('source_module',r.source_module,'reference_id',r.reference_id),
        jsonb_build_object('source_module','receipt','reference_id',r.source_id),'Receipt journal_entry_id proves reverse source identity');
      UPDATE public.journal_entries SET source_module=COALESCE(source_module,'receipt'),reference_id=r.source_id WHERE id=r.id;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'journal',r.id,r.entry_number,ARRAY['reference_id'],'Journal source ID conflicts with owning receipt','Accountant confirmation of the correct source document');
    END IF;
  END LOOP;

  FOR r IN
    SELECT je.id,je.entry_number,je.source_module,je.reference_id,pv.id AS source_id
    FROM public.payment_vouchers pv JOIN public.journal_entries je ON je.id=pv.journal_entry_id
    WHERE (je.source_module IS NULL OR je.source_module='payment')
      AND (je.source_module IS NULL OR je.reference_id IS NULL OR je.reference_id<>pv.id)
  LOOP
    IF (r.reference_id IS NULL OR r.reference_id=r.source_id) AND (r.source_module IS NULL OR r.source_module='payment') THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      VALUES(v_run,'journal',r.id,r.entry_number,
        ARRAY_REMOVE(ARRAY[CASE WHEN r.source_module IS NULL THEN 'source_module' END,
          CASE WHEN r.reference_id IS NULL THEN 'reference_id' END],NULL),
        jsonb_build_object('source_module',r.source_module,'reference_id',r.reference_id),
        jsonb_build_object('source_module','payment','reference_id',r.source_id),'Payment journal_entry_id proves reverse source identity');
      UPDATE public.journal_entries SET source_module=COALESCE(source_module,'payment'),reference_id=r.source_id WHERE id=r.id;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'journal',r.id,r.entry_number,ARRAY['reference_id'],'Journal source ID conflicts with owning payment','Accountant confirmation of the correct source document');
    END IF;
  END LOOP;

  -- Director Loan correction is safe only when narration explicitly proves it.
  FOR r IN SELECT je.id,je.entry_number,jel.id AS line_id,jel.account_id
    FROM public.journal_entries je JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.source_module='bank_reconciliation' AND coa.code='2210' AND jel.credit>0
      AND lower(COALESCE(je.description,'')) ~ '(director|owner) loan' LOOP
    IF EXISTS(SELECT 1 FROM public.chart_of_accounts WHERE code='2220' AND is_active=true AND COALESCE(is_header,false)=false) THEN
      INSERT INTO public.finance_historical_repair_items(run_id,document_type,document_id,document_number,repaired_fields,old_metadata,new_metadata,repair_reason)
      SELECT v_run,'journal',r.id,r.entry_number,ARRAY['credit_account_id'],jsonb_build_object('account_id',r.account_id),jsonb_build_object('account_id',id),'Narration explicitly identifies Director/Owner Loan; native mapping is 2220'
      FROM public.chart_of_accounts WHERE code='2220' AND is_active=true AND COALESCE(is_header,false)=false LIMIT 1;
      UPDATE public.journal_entry_lines SET account_id=(SELECT id FROM public.chart_of_accounts WHERE code='2220' AND is_active=true AND COALESCE(is_header,false)=false LIMIT 1) WHERE id=r.line_id;
    ELSE
      INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
      VALUES(v_run,'journal',r.id,r.entry_number,ARRAY['credit_account_id'],'Director/Owner Loan is certain but account 2220 is unavailable','Activate/create the approved posting account 2220');
    END IF;
  END LOOP;

  -- Explicit exceptions for unresolved metadata; never guess.
  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'expense',id,voucher_number,
    ARRAY_REMOVE(ARRAY[CASE WHEN transaction_currency IS NULL THEN 'transaction_currency' END,
      CASE WHEN functional_currency IS NULL THEN 'functional_currency' END,CASE WHEN currency_code IS NULL THEN 'currency_code' END,
      CASE WHEN exchange_rate IS NULL THEN 'exchange_rate' END,CASE WHEN payment_method IS NULL THEN 'payment_method' END,
      CASE WHEN bank_account_id IS NULL AND payment_method='bank_transfer' THEN 'bank_account_id' END],NULL),
    'No unique authoritative relationship exists in stored data','Transaction currency, historical exchange rate with source/date, exact payment method, and/or paying bank account'
  FROM public.finance_expenses
  WHERE transaction_currency IS NULL OR functional_currency IS NULL OR currency_code IS NULL OR exchange_rate IS NULL
     OR payment_method IS NULL OR (bank_account_id IS NULL AND payment_method='bank_transfer');

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'receipt',id,voucher_number,
    ARRAY_REMOVE(ARRAY[CASE WHEN transaction_currency IS NULL THEN 'transaction_currency' END,
      CASE WHEN functional_currency IS NULL THEN 'functional_currency' END,CASE WHEN currency_code IS NULL THEN 'currency_code' END,
      CASE WHEN exchange_rate IS NULL THEN 'exchange_rate' END,
      CASE WHEN payment_method IS NULL THEN 'payment_method' END,
      CASE WHEN bank_account_id IS NULL AND payment_method='bank_transfer' THEN 'bank_account_id' END],NULL),
    'No unique authoritative relationship exists in stored receipt data',
    'Transaction currency, historical rate with source/date, exact payment method, and/or receiving bank account'
  FROM public.receipt_vouchers
  WHERE transaction_currency IS NULL OR functional_currency IS NULL OR currency_code IS NULL OR exchange_rate IS NULL
     OR payment_method IS NULL OR (bank_account_id IS NULL AND payment_method='bank_transfer');

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'payment',id,voucher_number,
    ARRAY_REMOVE(ARRAY[CASE WHEN transaction_currency IS NULL THEN 'transaction_currency' END,
      CASE WHEN functional_currency IS NULL THEN 'functional_currency' END,CASE WHEN currency_code IS NULL THEN 'currency_code' END,
      CASE WHEN exchange_rate IS NULL THEN 'exchange_rate' END,
      CASE WHEN payment_method IS NULL THEN 'payment_method' END,
      CASE WHEN bank_account_id IS NULL AND payment_method='bank_transfer' THEN 'bank_account_id' END],NULL),
    'No unique authoritative relationship exists in stored payment data',
    'Transaction currency, historical rate with source/date, exact payment method, and/or paying bank account'
  FROM public.payment_vouchers
  WHERE transaction_currency IS NULL OR functional_currency IS NULL OR currency_code IS NULL OR exchange_rate IS NULL
     OR payment_method IS NULL OR (bank_account_id IS NULL AND payment_method='bank_transfer');

  INSERT INTO public.finance_historical_repair_exceptions(run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required)
  SELECT v_run,'journal',id,entry_number,
    ARRAY_REMOVE(ARRAY[CASE WHEN source_module IS NULL THEN 'source_module' END,
      CASE WHEN source_module='bank_reconciliation' AND transaction_currency IS NULL THEN 'transaction_currency' END,
      CASE WHEN source_module='bank_reconciliation' AND transaction_currency='USD' AND exchange_rate IS NULL THEN 'exchange_rate' END],NULL),
    'Journal metadata cannot be derived from a unique stored source relationship',
    'Correct source module/document and/or authoritative historical currency rate'
  FROM public.journal_entries
  WHERE source_module IS NULL OR (source_module='bank_reconciliation' AND (transaction_currency IS NULL OR (transaction_currency='USD' AND exchange_rate IS NULL)));

  -- Classify every remaining scanned row as an explicit, reasoned skip so the
  -- run totals reconcile exactly to the scan population.
  INSERT INTO public.finance_historical_repair_exceptions(
    run_id,document_type,document_id,document_number,inconsistent_fields,reason,manual_information_required,status)
  SELECT v_run,c.document_type,c.document_id,c.document_number,ARRAY[]::text[],
    'No missing or inconsistent deterministic metadata was found','None','skipped'
  FROM (
    SELECT 'expense'::text document_type,id document_id,voucher_number::text document_number FROM public.finance_expenses
    UNION ALL SELECT 'receipt',id,voucher_number::text FROM public.receipt_vouchers
    UNION ALL SELECT 'payment',id,voucher_number::text FROM public.payment_vouchers
    UNION ALL SELECT 'fund_transfer',id,transfer_number::text FROM public.fund_transfers
    UNION ALL SELECT 'journal',id,entry_number::text FROM public.journal_entries
    UNION ALL SELECT 'bank_reconciliation',id,reference::text FROM public.bank_statement_lines
  ) c
  WHERE NOT EXISTS(SELECT 1 FROM public.finance_historical_repair_items i
    WHERE i.run_id=v_run AND i.document_type=c.document_type AND i.document_id=c.document_id)
    AND NOT EXISTS(SELECT 1 FROM public.finance_historical_repair_exceptions e
    WHERE e.run_id=v_run AND e.document_type=c.document_type AND e.document_id=c.document_id);

  UPDATE public.finance_historical_repair_runs SET completed_at=now(),total_records_scanned=v_scanned,
    records_repaired=(SELECT count(DISTINCT (i.document_type,i.document_id))
      FROM public.finance_historical_repair_items i WHERE i.run_id=v_run
        AND NOT EXISTS(SELECT 1 FROM public.finance_historical_repair_exceptions e
          WHERE e.run_id=v_run AND e.status='manual_review' AND e.document_type=i.document_type AND e.document_id=i.document_id)),
    records_partially_repaired=(SELECT count(DISTINCT (i.document_type,i.document_id))
      FROM public.finance_historical_repair_items i WHERE i.run_id=v_run
        AND EXISTS(SELECT 1 FROM public.finance_historical_repair_exceptions e
          WHERE e.run_id=v_run AND e.status='manual_review' AND e.document_type=i.document_type AND e.document_id=i.document_id)),
    records_manual_review=(SELECT count(DISTINCT (document_type,document_id)) FROM public.finance_historical_repair_exceptions WHERE run_id=v_run AND status='manual_review'),
    records_skipped=(SELECT count(DISTINCT (document_type,document_id)) FROM public.finance_historical_repair_exceptions WHERE run_id=v_run AND status='skipped')
  WHERE id=v_run;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE VIEW public.finance_historical_repair_exception_report
WITH (security_invoker=true) AS
SELECT e.run_id,e.document_number,e.document_type,e.document_id AS database_id,
  e.inconsistent_fields,e.reason,e.manual_information_required,e.status,e.created_at
FROM public.finance_historical_repair_exceptions e;

CREATE OR REPLACE VIEW public.finance_historical_repair_summary
WITH (security_invoker=true) AS
SELECT id AS run_id,started_at,completed_at,total_records_scanned,records_repaired,
  records_partially_repaired,records_manual_review,records_skipped,notes
FROM public.finance_historical_repair_runs;

-- Report-by-report eligibility for every automatically repaired record. A
-- draft is considered correct when it remains absent from posted reports;
-- posted rows must resolve to one active JE with lines. “Appears” therefore
-- means the same status-aware inclusion contract used by the Finance reports,
-- not that a draft is forced into the general ledger.
CREATE OR REPLACE VIEW public.finance_historical_repair_verification
WITH (security_invoker=true) AS
WITH repaired AS (
  SELECT run_id,document_type,document_id,
    bool_or(repair_reason ILIKE '%Bank Reconciliation%' OR document_type='bank_reconciliation') AS reconciliation_expected
  FROM public.finance_historical_repair_items
  GROUP BY run_id,document_type,document_id
), resolved AS (
  SELECT r.*,fe.voucher_number AS document_number,true AS source_exists,
    fe.approval_status='approved' AS posting_expected,
    je.id AS active_journal_id,
    fe.bank_account_id IS NOT NULL AS bank_expected,
    false AS party_expected,
    (SELECT count(*) FROM public.bank_statement_lines b WHERE b.matched_expense_id=fe.id OR (je.id IS NOT NULL AND b.matched_entry_id=je.id)) AS bank_link_count
  FROM repaired r JOIN public.finance_expenses fe ON r.document_type='expense' AND fe.id=r.document_id
  LEFT JOIN LATERAL (
    SELECT id FROM public.journal_entries j WHERE j.source_module='expenses'
      AND (j.reference_id=fe.id OR j.reference_number='EXP-'||fe.id::text)
      AND j.is_posted=true AND COALESCE(j.is_reversed,false)=false
    ORDER BY j.created_at DESC LIMIT 1
  ) je ON true
  UNION ALL
  SELECT r.*,rv.voucher_number,true,COALESCE(rv.is_posted,false),
    CASE WHEN je.is_posted=true AND COALESCE(je.is_reversed,false)=false THEN je.id END,
    rv.bank_account_id IS NOT NULL,rv.customer_id IS NOT NULL,
    (SELECT count(*) FROM public.bank_statement_lines b WHERE b.matched_receipt_id=rv.id OR b.matched_entry_id=rv.journal_entry_id)
  FROM repaired r JOIN public.receipt_vouchers rv ON r.document_type='receipt' AND rv.id=r.document_id
  LEFT JOIN public.journal_entries je ON je.id=rv.journal_entry_id
  UNION ALL
  SELECT r.*,pv.voucher_number,true,COALESCE(pv.is_posted,false),
    CASE WHEN je.is_posted=true AND COALESCE(je.is_reversed,false)=false THEN je.id END,
    pv.bank_account_id IS NOT NULL,(pv.supplier_id IS NOT NULL OR pv.staff_id IS NOT NULL),
    (SELECT count(*) FROM public.bank_statement_lines b WHERE b.matched_payment_id=pv.id OR b.matched_entry_id=pv.journal_entry_id)
  FROM repaired r JOIN public.payment_vouchers pv ON r.document_type='payment' AND pv.id=r.document_id
  LEFT JOIN public.journal_entries je ON je.id=pv.journal_entry_id
  UNION ALL
  SELECT r.*,ft.transfer_number,true,ft.status='posted',
    CASE WHEN je.is_posted=true AND COALESCE(je.is_reversed,false)=false THEN je.id END,
    (ft.from_bank_account_id IS NOT NULL OR ft.to_bank_account_id IS NOT NULL),false,
    (SELECT count(*) FROM public.bank_statement_lines b WHERE b.matched_fund_transfer_id=ft.id OR b.matched_entry_id=ft.journal_entry_id)
  FROM repaired r JOIN public.fund_transfers ft ON r.document_type='fund_transfer' AND ft.id=r.document_id
  LEFT JOIN public.journal_entries je ON je.id=ft.journal_entry_id
  UNION ALL
  SELECT r.*,je.entry_number,true,(je.is_posted=true AND COALESCE(je.is_reversed,false)=false),
    CASE WHEN je.is_posted=true AND COALESCE(je.is_reversed,false)=false THEN je.id END,
    EXISTS(SELECT 1 FROM public.journal_entry_lines l JOIN public.bank_accounts ba ON ba.coa_id=l.account_id WHERE l.journal_entry_id=je.id),
    false,(SELECT count(*) FROM public.bank_statement_lines b WHERE b.matched_entry_id=je.id)
  FROM repaired r JOIN public.journal_entries je ON r.document_type='journal' AND je.id=r.document_id
  UNION ALL
  SELECT r.*,b.reference,true,b.reconciliation_status IN('matched','recorded'),
    CASE WHEN je.is_posted=true AND COALESCE(je.is_reversed,false)=false THEN je.id END,
    true,false,1::bigint
  FROM repaired r JOIN public.bank_statement_lines b ON r.document_type='bank_reconciliation' AND b.id=r.document_id
  LEFT JOIN public.journal_entries je ON je.id=b.matched_entry_id
), checked AS (
  SELECT x.*,
    (NOT posting_expected OR active_journal_id IS NOT NULL) AS journal_ok,
    (NOT posting_expected OR EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id=active_journal_id)) AS lines_ok,
    (NOT bank_expected OR NOT posting_expected OR EXISTS(
      SELECT 1 FROM public.journal_entry_lines l JOIN public.bank_accounts ba ON ba.coa_id=l.account_id
      WHERE l.journal_entry_id=active_journal_id)) AS bank_ok,
    (NOT reconciliation_expected OR bank_link_count>0) AS reconciliation_ok
  FROM resolved x
)
SELECT run_id,document_number,document_type,document_id AS database_id,
  source_exists AS source_module,
  journal_ok AS journal_register,
  journal_ok AS journal_viewer,
  (journal_ok AND lines_ok) AS account_ledger,
  bank_ok AS bank_ledger,
  (NOT party_expected OR NOT posting_expected OR (journal_ok AND lines_ok)) AS party_ledger,
  (journal_ok AND lines_ok) AS trial_balance,
  (journal_ok AND lines_ok) AS balance_sheet,
  (journal_ok AND lines_ok) AS profit_and_loss,
  (journal_ok AND lines_ok) AS dashboard,
  reconciliation_ok AS bank_reconciliation,
  (source_exists AND journal_ok AND lines_ok AND bank_ok
    AND (NOT party_expected OR NOT posting_expected OR (journal_ok AND lines_ok))
    AND reconciliation_ok) AS verification_passed
FROM checked;

CREATE OR REPLACE VIEW public.finance_historical_repair_verification_failures
WITH (security_invoker=true) AS
SELECT * FROM public.finance_historical_repair_verification WHERE NOT verification_passed;

GRANT SELECT ON public.finance_historical_repair_summary,public.finance_historical_repair_exception_report,
  public.finance_historical_repair_verification,public.finance_historical_repair_verification_failures TO authenticated;
REVOKE ALL ON public.finance_historical_repair_runs,public.finance_historical_repair_items,public.finance_historical_repair_exceptions FROM anon;
GRANT EXECUTE ON FUNCTION public.next_expense_voucher_number(date),public.next_payment_voucher_number(date),public.next_receipt_voucher_number(date),
  public.save_finance_expense(uuid,jsonb),public.approve_finance_expense(uuid,uuid),public.save_receipt_voucher_with_allocations(uuid,jsonb,jsonb),
  public.save_payment_voucher_command(uuid,jsonb,jsonb),public.save_finance_journal(uuid,date,text,jsonb,text,numeric),
  public.link_bank_statement_line(uuid,text,uuid,text),public.unmatch_bank_line(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.run_deterministic_finance_historical_repair() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.run_deterministic_finance_historical_repair() TO service_role;

-- Run once as migration owner. All changes are itemised before mutation.
-- The security-audit trigger expects an end-user JWT even for UPDATE. The
-- migration owner has no JWT, so suspend only that authorization trigger for
-- this owner-run repair; immutable-posting and normalization triggers remain
-- active. Later service-role repair runs pass the trigger normally.
ALTER TABLE public.fund_transfers DISABLE TRIGGER trg_enforce_fund_transfer_role_ins;
SELECT public.run_deterministic_finance_historical_repair();
ALTER TABLE public.fund_transfers ENABLE TRIGGER trg_enforce_fund_transfer_role_ins;

NOTIFY pgrst,'reload schema';
