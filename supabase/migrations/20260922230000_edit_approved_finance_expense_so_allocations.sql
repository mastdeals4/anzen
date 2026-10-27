-- Description: Ensure edit_approved_finance_expense_atomic persists sales_order_allocations

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
  v_same_selected_count integer;
  v_selected_amount numeric;
  v_period_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

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

  IF v_bank_id IS NOT NULL THEN
    SELECT currency INTO v_bank_currency FROM public.bank_accounts WHERE id=v_bank_id;
    IF v_bank_currency IS NULL THEN RAISE EXCEPTION 'Selected bank account does not exist'; END IF;
  END IF;

  v_currency:=COALESCE(NULLIF(p_payload->>'transaction_currency',''),v_bank_currency,v_exp.transaction_currency,'IDR');
  IF v_currency='USD' THEN
    v_rate:=COALESCE((p_payload->>'exchange_rate')::numeric,v_exp.exchange_rate,1);
    IF v_rate<=1 THEN RAISE EXCEPTION 'A valid USD rate greater than 1 is required'; END IF;
  ELSE
    v_currency:='IDR';
    v_rate:=1;
  END IF;

  IF p_payload ? 'document_urls' THEN
    SELECT COALESCE(array_agg(elem::text),ARRAY[]::text[])
      INTO v_docs
      FROM jsonb_array_elements_text(p_payload->'document_urls') AS elem;
  ELSE
    v_docs:=v_exp.document_urls;
  END IF;

  UPDATE public.finance_expenses SET
    expense_category=p_payload->>'expense_category',
    expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),v_exp.expense_type,'general'),
    amount=(p_payload->>'amount')::numeric,
    expense_date=v_date,
    description=NULLIF(p_payload->>'description',''),
    batch_id=NULLIF(p_payload->>'batch_id','')::uuid,
    import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
    delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
    payment_method=NULLIF(p_payload->>'payment_method',''),
    bank_account_id=v_bank_id,
    payment_reference=NULLIF(p_payload->>'payment_reference',''),
    paid_by=CASE WHEN NULLIF(p_payload->>'payment_method','') IN('cash','petty_cash') THEN 'cash' WHEN v_bank_id IS NOT NULL THEN 'bank' ELSE NULL END,
    document_urls=v_docs,
    supplier_id=NULLIF(p_payload->>'supplier_id','')::uuid,
    staff_id=NULLIF(p_payload->>'staff_id','')::uuid,
    invoice_number=NULLIF(p_payload->>'invoice_number',''),
    due_date=NULLIF(p_payload->>'due_date','')::date,
    broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
    pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,
    pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
    pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,
    ppn_amount=COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0),
    ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
    ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),
    dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric,
    ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),
    pph_amount=COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,
    stamp_duty_amount=COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
    fixed_asset_account_id=NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
    bank_charges_amount=COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
    currency_code=v_currency,
    transaction_currency=v_currency,
    functional_currency='IDR',
    exchange_rate=v_rate,
    bank_account_currency=COALESCE(v_bank_currency,v_currency),
    payment_currency=v_currency,
    payee_id=NULLIF(p_payload->>'payee_id','')::uuid,
    linked_sales_invoice_id=NULLIF(p_payload->>'linked_sales_invoice_id','')::uuid,
    pph_calculation_regime=NULLIF(p_payload->>'pph_calculation_regime',''),
    pph_dpp_ratio=NULLIF(p_payload->>'pph_dpp_ratio','')::numeric,
    pph_dpp_amount=NULLIF(p_payload->>'pph_dpp_amount','')::numeric,
    pph_rate=NULLIF(p_payload->>'pph_rate','')::numeric,
    is_tax_manual_override=COALESCE((p_payload->>'is_tax_manual_override')::boolean, false),
    sales_order_allocations=COALESCE(p_payload->'sales_order_allocations', v_exp.sales_order_allocations, '[]'::jsonb)
  WHERE id=p_expense_id;

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
  END IF;

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  RETURN p_expense_id;
END;
$function$;
