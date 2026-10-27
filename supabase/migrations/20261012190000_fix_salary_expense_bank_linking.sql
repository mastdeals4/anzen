-- Migration: 20261012190000_fix_salary_expense_bank_linking.sql
-- Description: Fix bank linking calculation failure for salary expenses.
-- 1. Exclude the line being linked (b.id <> p_bank_line_id) when calculating unallocated confirmed bank lines.
-- 2. Include posted salary_advance_applications in v_doc_allocated to match recalculate_expense_payment_state.
-- 3. Treat zero/empty allocation amounts safely (fallback to LEAST(bank_remaining, doc_remaining)).

BEGIN;

-- 1. Update public.link_bank_statement_line
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

-- 2. Update public.edit_approved_finance_expense_atomic to pass NULLIF(p_allocation_amount, 0)
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
  v_effective_allocation numeric;
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

  v_effective_allocation := CASE WHEN COALESCE(p_allocation_amount, 0) > 0.01 THEN p_allocation_amount ELSE NULL END;

  SELECT count(*),max(allocation_amount)
    INTO v_same_selected_count,v_selected_amount
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='supplier'
     AND bank_statement_line_id=p_bank_statement_line_id;

  IF p_bank_statement_line_id IS NOT NULL
     AND v_same_selected_count=0 THEN
    PERFORM public.link_bank_statement_line(
      p_bank_statement_line_id,'expense',p_expense_id,'supplier',v_effective_allocation);
  ELSIF p_bank_statement_line_id IS NOT NULL
     AND v_effective_allocation IS NOT NULL
     AND abs(COALESCE(v_selected_amount,0)-v_effective_allocation)>0.01 THEN
    RAISE EXCEPTION 'Change an existing bank allocation through unlink/relink so other payments remain intact';
  END IF;

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  RETURN p_expense_id;
END;
$function$;

COMMIT;
