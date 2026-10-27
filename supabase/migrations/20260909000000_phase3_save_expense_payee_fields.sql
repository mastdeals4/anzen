-- Migration: 20260909000000_phase3_save_expense_payee_fields.sql
-- Description: Extend save_finance_expense and edit_approved_finance_expense_atomic
--              to persist payee_id, linked_sales_invoice_id, and PPh snapshot columns.

BEGIN;

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
      bank_account_currency, payment_currency,
      payee_id, linked_sales_invoice_id, pph_calculation_regime, pph_dpp_ratio,
      pph_dpp_amount, pph_rate, is_tax_manual_override
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
      NULLIF(p_payload->>'payee_id','')::uuid,
      NULLIF(p_payload->>'linked_sales_invoice_id','')::uuid,
      NULLIF(p_payload->>'pph_calculation_regime',''),
      NULLIF(p_payload->>'pph_dpp_ratio','')::numeric,
      NULLIF(p_payload->>'pph_dpp_amount','')::numeric,
      NULLIF(p_payload->>'pph_rate','')::numeric,
      COALESCE((p_payload->>'is_tax_manual_override')::boolean, false)
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
      payee_id=NULLIF(p_payload->>'payee_id','')::uuid,
      linked_sales_invoice_id=NULLIF(p_payload->>'linked_sales_invoice_id','')::uuid,
      pph_calculation_regime=NULLIF(p_payload->>'pph_calculation_regime',''),
      pph_dpp_ratio=NULLIF(p_payload->>'pph_dpp_ratio','')::numeric,
      pph_dpp_amount=NULLIF(p_payload->>'pph_dpp_amount','')::numeric,
      pph_rate=NULLIF(p_payload->>'pph_rate','')::numeric,
      is_tax_manual_override=COALESCE((p_payload->>'is_tax_manual_override')::boolean, false)
    WHERE id=p_expense_id RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.edit_approved_finance_expense_atomic(
  p_expense_id uuid,
  p_payload jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL::uuid,
  p_allocation_amount numeric DEFAULT NULL::numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Preserve the edited bank mode through the legacy unlinked-payment normalizer.
  PERFORM set_config('app.expense_atomic_bank_link','on',true);

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
    bank_account_currency=COALESCE(v_bank_currency,v_currency),payment_currency=v_currency,
    payee_id=NULLIF(p_payload->>'payee_id','')::uuid,
    linked_sales_invoice_id=NULLIF(p_payload->>'linked_sales_invoice_id','')::uuid,
    pph_calculation_regime=NULLIF(p_payload->>'pph_calculation_regime',''),
    pph_dpp_ratio=NULLIF(p_payload->>'pph_dpp_ratio','')::numeric,
    pph_dpp_amount=NULLIF(p_payload->>'pph_dpp_amount','')::numeric,
    pph_rate=NULLIF(p_payload->>'pph_rate','')::numeric,
    is_tax_manual_override=COALESCE((p_payload->>'is_tax_manual_override')::boolean, false)
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
     AND v_same_selected_count=0 THEN
    PERFORM public.link_bank_statement_line(
      p_bank_statement_line_id,'expense',p_expense_id,'supplier',p_allocation_amount);
  ELSIF p_bank_statement_line_id IS NOT NULL
     AND p_allocation_amount IS NOT NULL
     AND abs(COALESCE(v_selected_amount,0)-p_allocation_amount)>0.01 THEN
    RAISE EXCEPTION 'Change an existing bank allocation through unlink/relink so other payments remain intact';
  ELSE
    UPDATE public.bank_statement_allocations SET allocation_amount=allocation_amount WHERE document_type='expense' AND document_id=p_expense_id;
  END IF;

  UPDATE public.bank_statement_allocations SET allocation_amount=allocation_amount WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind<>'supplier';

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  RETURN p_expense_id;
END;
$function$;

COMMIT;
