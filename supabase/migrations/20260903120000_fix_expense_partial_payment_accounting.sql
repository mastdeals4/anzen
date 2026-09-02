/*
 * Keep expense recognition and direct bank payments as separate accounting
 * events.  This migration changes functions only; it does not rewrite any
 * expense, allocation, bank statement, or historical journal row.
 */

BEGIN;

-- A bank-transfer selection on the expense is payment intent.  Recognition
-- remains Dr expense/tax, Cr A/P; confirmed cash is posted by the allocation
-- RPC below. Cash and petty-cash behavior is intentionally unchanged.
DO $migration$
DECLARE
  v_definition text;
  v_old text := $old$  ELSIF NEW.payment_method IS NOT NULL AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM public.bank_accounts WHERE id=NEW.bank_account_id;
  ELSIF NEW.payment_method IS NULL THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
$old$;
  v_new text := $new$  ELSIF NEW.payment_method = 'bank_transfer' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  ELSIF NEW.payment_method IS NOT NULL AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM public.bank_accounts WHERE id=NEW.bank_account_id;
  ELSIF NEW.payment_method IS NULL THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
$new$;
BEGIN
  SELECT pg_get_functiondef('public.auto_post_expense_accounting()'::regprocedure)
    INTO v_definition;
  IF position(v_new IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected expense journal account-resolution definition';
    END IF;
    EXECUTE replace(v_definition, v_old, v_new);
  END IF;

  SELECT pg_get_functiondef('public.post_customs_broker_canonical()'::regprocedure)
    INTO v_definition;
  IF position($needle$v_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method='outstanding';$needle$ IN v_definition) > 0 THEN
    EXECUTE replace(
      v_definition,
      $needle$v_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method='outstanding';$needle$,
      $replacement$v_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method IN ('outstanding','bank_transfer');$replacement$
    );
  ELSIF position($replacement$v_outstanding boolean := NEW.payment_method IS NULL OR NEW.payment_method IN ('outstanding','bank_transfer');$replacement$ IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected broker expense recognition definition';
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,
  p_document_type text,
  p_document_id uuid,
  p_payment_kind text,
  p_allocation_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_line public.bank_statement_lines%rowtype;
  v_expense public.finance_expenses%rowtype;
  v_je uuid; v_recognition_je uuid; v_bank_coa uuid; v_settlement_coa uuid;
  v_bank_total numeric; v_bank_allocated numeric; v_bank_remaining numeric;
  v_doc_total numeric; v_doc_allocated numeric; v_doc_remaining numeric; v_allocate numeric;
  v_functional_amount numeric; v_rate numeric := 1; v_entry text; v_allocation_id uuid := gen_random_uuid();
  v_bank_currency text; v_expense_currency text; v_period_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;

  IF p_document_type='expense' THEN
    SELECT * INTO v_expense FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    IF v_expense.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'Expense must be approved before bank allocation';
    END IF;
    SELECT je.id INTO v_recognition_je FROM public.journal_entries je
     WHERE je.source_module IN ('expense','expenses')
       AND (je.reference_id=p_document_id OR je.reference_number='EXP-'||p_document_id::text)
       AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
     ORDER BY je.created_at DESC,je.id DESC LIMIT 1;
    v_je := v_recognition_je;
  ELSIF p_document_type='receipt' THEN SELECT journal_entry_id INTO v_je FROM public.receipt_vouchers WHERE id=p_document_id AND is_posted;
  ELSIF p_document_type='payment' THEN SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id=p_document_id AND is_posted;
  ELSIF p_document_type='fund_transfer' THEN SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id=p_document_id AND status='posted';
  ELSIF p_document_type='petty_cash' THEN SELECT id INTO v_je FROM public.journal_entries WHERE source_module='petty_cash' AND reference_id=p_document_id AND is_posted AND NOT COALESCE(is_reversed,false) ORDER BY created_at DESC LIMIT 1;
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
                     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id)),0)
      + COALESCE((SELECT sum(va.allocated_amount) FROM public.voucher_allocations va
                    JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
                   WHERE va.finance_expense_id=p_document_id
                     AND COALESCE(va.payment_kind,'supplier')=COALESCE(p_payment_kind,'supplier')
                     AND pv.is_posted=true
                     AND COALESCE(pv.payment_purpose,'general') NOT IN ('salary_advance','salary_advance_settlement')),0)
      INTO v_doc_allocated;
  ELSE
    SELECT COALESCE(sum(allocation_amount),0) INTO v_doc_allocated
      FROM public.bank_statement_allocations
     WHERE document_type=p_document_type AND document_id=p_document_id
       AND payment_kind=COALESCE(p_payment_kind,'supplier');
  END IF;

  v_bank_remaining:=v_bank_total-v_bank_allocated;
  v_doc_remaining:=v_doc_total-v_doc_allocated;
  v_allocate:=round(COALESCE(p_allocation_amount,LEAST(v_bank_remaining,v_doc_remaining)),2);
  IF v_allocate<=0.01 THEN RAISE EXCEPTION 'No remaining amount is available to allocate'; END IF;
  IF v_allocate>v_bank_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds remaining bank amount'; END IF;
  IF v_allocate>v_doc_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds document outstanding amount'; END IF;

  IF p_document_type='expense' THEN
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
$$;

CREATE OR REPLACE FUNCTION public.unmatch_bank_statement_allocation(p_allocation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_a public.bank_statement_allocations%rowtype; v_payment_je public.journal_entries%rowtype;
  v_reversal_id uuid; v_reversal_number text; v_period_status text;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_a FROM public.bank_statement_allocations WHERE id=p_allocation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank allocation not found'; END IF;
  SELECT * INTO v_payment_je FROM public.journal_entries
   WHERE id=v_a.journal_entry_id AND source_module='expense_payment'
     AND reference_number='EXP-PAY-'||p_allocation_id::text
     AND is_posted AND NOT COALESCE(is_reversed,false) FOR UPDATE;
  IF FOUND THEN
    SELECT status INTO v_period_status FROM public.accounting_periods
     WHERE start_date<=v_payment_je.entry_date AND end_date>=v_payment_je.entry_date
     ORDER BY start_date DESC LIMIT 1;
    IF v_period_status IS NOT NULL AND v_period_status<>'open' THEN
      RAISE EXCEPTION 'Cannot unlink expense payment in a closed accounting period';
    END IF;
    v_reversal_number:=public.next_journal_entry_number();
    INSERT INTO public.journal_entries(entry_number,entry_date,period_id,source_module,reference_id,
      reference_number,description,total_debit,total_credit,is_posted,is_reversed,posted_by,posted_at,created_by,
      transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
    VALUES(v_reversal_number,v_payment_je.entry_date,v_payment_je.period_id,'expense_payment_reversal',v_a.document_id,
      'REV-EXP-PAY-'||p_allocation_id::text,'Reversal of '||v_payment_je.entry_number,
      v_payment_je.total_credit,v_payment_je.total_debit,true,true,auth.uid(),now(),auth.uid(),
      v_payment_je.transaction_currency,v_payment_je.functional_currency,v_payment_je.exchange_rate,v_payment_je.amounts_are_functional)
    RETURNING id INTO v_reversal_id;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,
      tax_code_id,customer_id,supplier_id,batch_id,transaction_currency,transaction_debit,transaction_credit,
      functional_currency,exchange_rate)
    SELECT v_reversal_id,line_number,account_id,'REVERSAL: '||COALESCE(description,''),credit,debit,
      tax_code_id,customer_id,supplier_id,batch_id,transaction_currency,transaction_credit,transaction_debit,
      functional_currency,exchange_rate
      FROM public.journal_entry_lines WHERE journal_entry_id=v_payment_je.id ORDER BY line_number;
    UPDATE public.journal_entries SET is_reversed=true,reversed_by_id=v_reversal_id
     WHERE id=v_payment_je.id;
  END IF;
  DELETE FROM public.bank_statement_allocations WHERE id=p_allocation_id;
  PERFORM public.sync_bank_line_allocation_owner(v_a.bank_statement_line_id);
  PERFORM public.refresh_bank_statement_allocation_status(v_a.bank_statement_line_id);
  IF v_a.document_type='expense' THEN PERFORM public.recalculate_expense_payment_state(v_a.document_id); END IF;
  RETURN jsonb_build_object('success',true,'bank_line_id',v_a.bank_statement_line_id,
    'allocation_id',p_allocation_id,'reversal_journal_id',v_reversal_id);
END;
$$;

-- Allocation rows retain their payment journal. Approved expense edits rebuild
-- only recognition and re-run the allocation guards without repointing history.
DO $migration$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric)'::regprocedure)
    INTO v_definition;
  v_definition:=regexp_replace(v_definition,
    'UPDATE public\.bank_statement_allocations\s+SET journal_entry_id=v_journal_id\s+WHERE document_type=''expense'' AND document_id=p_expense_id;',
    'UPDATE public.bank_statement_allocations SET allocation_amount=allocation_amount WHERE document_type=''expense'' AND document_id=p_expense_id;', 'g');
  v_definition:=regexp_replace(v_definition,
    'UPDATE public\.bank_statement_allocations\s+SET journal_entry_id=v_journal_id\s+WHERE document_type=''expense'' AND document_id=p_expense_id AND payment_kind<>''supplier'';',
    'UPDATE public.bank_statement_allocations SET allocation_amount=allocation_amount WHERE document_type=''expense'' AND document_id=p_expense_id AND payment_kind<>''supplier'';', 'g');
  -- Selecting a new line during an edit adds that allocation; it must not
  -- silently release the other valid multi-bank allocations. Amount changes
  -- remain an explicit unlink/relink operation.
  v_definition:=replace(v_definition,
    $old$  IF p_bank_statement_line_id IS NOT NULL
     AND (v_same_selected_count=0 OR (p_allocation_amount IS NOT NULL AND abs(COALESCE(v_selected_amount,0)-p_allocation_amount)>0.01)) THEN
    FOR v_allocation IN
      SELECT id FROM public.bank_statement_allocations
       WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='supplier'
       ORDER BY id FOR UPDATE
    LOOP
      PERFORM public.unmatch_bank_statement_allocation(v_allocation.id);
    END LOOP;
    PERFORM public.link_bank_statement_line(
      p_bank_statement_line_id,'expense',p_expense_id,'supplier',p_allocation_amount);$old$,
    $new$  IF p_bank_statement_line_id IS NOT NULL
     AND v_same_selected_count=0 THEN
    PERFORM public.link_bank_statement_line(
      p_bank_statement_line_id,'expense',p_expense_id,'supplier',p_allocation_amount);
  ELSIF p_bank_statement_line_id IS NOT NULL
     AND p_allocation_amount IS NOT NULL
     AND abs(COALESCE(v_selected_amount,0)-p_allocation_amount)>0.01 THEN
    RAISE EXCEPTION 'Change an existing bank allocation through unlink/relink so other payments remain intact';$new$);
  IF v_definition ~ 'SET journal_entry_id=v_journal_id' THEN
    RAISE EXCEPTION 'Approved expense edit still repoints payment journals';
  END IF;
  EXECUTE v_definition;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.validate_expense_bank_allocation_against_journal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_payable numeric; v_allocated numeric; v_journal_cash numeric;
BEGIN
  IF NEW.document_type<>'expense' THEN RETURN NEW; END IF;
  v_payable:=CASE WHEN NEW.payment_kind='pph23'
    THEN COALESCE((SELECT pph_amount FROM public.finance_expenses WHERE id=NEW.document_id),0)
    ELSE COALESCE(public.calculate_finance_expense_payable(NEW.document_id),0) END;
  SELECT COALESCE(sum(allocation_amount),0)+NEW.allocation_amount INTO v_allocated
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=NEW.document_id
     AND payment_kind=NEW.payment_kind AND (TG_OP<>'UPDATE' OR id<>NEW.id);
  IF v_allocated>v_payable+0.01 THEN RAISE EXCEPTION 'Allocation exceeds document outstanding amount'; END IF;
  IF (SELECT source_module FROM public.journal_entries WHERE id=NEW.journal_entry_id)='expense_payment' THEN
    SELECT COALESCE(sum(l.credit),0) INTO v_journal_cash
      FROM public.journal_entry_lines l JOIN public.bank_accounts ba ON ba.coa_id=l.account_id
     WHERE l.journal_entry_id=NEW.journal_entry_id;
    IF abs(v_journal_cash-NEW.allocation_amount)>0.01 THEN
      RAISE EXCEPTION 'Expense payment journal bank credit must equal the confirmed allocation amount';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric),
  public.unmatch_bank_statement_allocation(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric),
  public.unmatch_bank_statement_allocation(uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.validate_expense_bank_allocation_against_journal()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_expense_bank_allocation_against_journal() TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
