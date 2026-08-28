BEGIN;

CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,p_document_type text,p_document_id uuid,p_payment_kind text,p_allocation_amount numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_line public.bank_statement_lines%rowtype; v_je uuid; v_bank_coa uuid;
  v_bank_total numeric; v_bank_allocated numeric; v_bank_remaining numeric;
  v_doc_total numeric; v_doc_allocated numeric; v_doc_remaining numeric; v_allocate numeric;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;

  IF p_document_type='expense' THEN
    SELECT je.id INTO v_je FROM public.finance_expenses fe JOIN public.journal_entries je
      ON je.source_module='expenses' AND (je.reference_id=fe.id OR je.reference_number='EXP-'||fe.id::text)
     AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
     WHERE fe.id=p_document_id ORDER BY je.created_at DESC LIMIT 1;
  ELSIF p_document_type='receipt' THEN SELECT journal_entry_id INTO v_je FROM public.receipt_vouchers WHERE id=p_document_id AND is_posted;
  ELSIF p_document_type='payment' THEN SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id=p_document_id AND is_posted;
  ELSIF p_document_type='fund_transfer' THEN SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id=p_document_id AND status='posted';
  ELSIF p_document_type='petty_cash' THEN SELECT id INTO v_je FROM public.journal_entries WHERE source_module='petty_cash' AND reference_id=p_document_id AND is_posted AND NOT COALESCE(is_reversed,false) ORDER BY created_at DESC LIMIT 1;
  ELSIF p_document_type='tax_payment' THEN SELECT journal_entry_id INTO v_je FROM public.tax_payments WHERE id=p_document_id;
  ELSIF p_document_type='journal' THEN SELECT id INTO v_je FROM public.journal_entries WHERE id=p_document_id AND is_posted AND NOT COALESCE(is_reversed,false);
  ELSE RAISE EXCEPTION 'Unsupported reconciliation document type %',p_document_type; END IF;
  IF v_je IS NULL THEN RAISE EXCEPTION 'Document must have an active posted journal before reconciliation'; END IF;

  SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id=v_line.bank_account_id;
  IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'Selected bank account has no General Ledger account'; END IF;
  SELECT COALESCE(sum(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN COALESCE(jel.transaction_debit,jel.debit)
                          ELSE COALESCE(jel.transaction_credit,jel.credit) END),0)
    INTO v_doc_total FROM public.journal_entry_lines jel WHERE jel.journal_entry_id=v_je AND jel.account_id=v_bank_coa;
  IF v_doc_total<=0.01 THEN RAISE EXCEPTION 'Document journal does not contain the selected bank account on the matching side'; END IF;

  v_bank_total:=COALESCE(NULLIF(v_line.debit_amount,0),v_line.credit_amount,0);
  SELECT COALESCE(sum(allocation_amount),0) INTO v_bank_allocated FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id;
  SELECT COALESCE(sum(allocation_amount),0) INTO v_doc_allocated FROM public.bank_statement_allocations
   WHERE document_type=p_document_type AND document_id=p_document_id AND payment_kind=COALESCE(p_payment_kind,'supplier');
  v_bank_remaining:=v_bank_total-v_bank_allocated; v_doc_remaining:=v_doc_total-v_doc_allocated;
  v_allocate:=COALESCE(p_allocation_amount,LEAST(v_bank_remaining,v_doc_remaining));
  IF v_allocate<=0.01 THEN RAISE EXCEPTION 'No remaining amount is available to allocate'; END IF;
  IF v_allocate>v_bank_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds remaining bank amount'; END IF;
  IF v_allocate>v_doc_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds document outstanding amount'; END IF;

  INSERT INTO public.bank_statement_allocations(bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind,created_by)
  VALUES(p_bank_line_id,p_document_type,p_document_id,v_je,round(v_allocate,2),COALESCE(p_payment_kind,'supplier'),auth.uid());

  IF (SELECT count(*) FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id)=1 THEN
    UPDATE public.bank_statement_lines SET
      matched_expense_id=CASE WHEN p_document_type='expense' THEN p_document_id END,
      matched_receipt_id=CASE WHEN p_document_type='receipt' THEN p_document_id END,
      matched_payment_id=CASE WHEN p_document_type='payment' THEN p_document_id END,
      matched_fund_transfer_id=CASE WHEN p_document_type='fund_transfer' THEN p_document_id END,
      matched_petty_cash_id=CASE WHEN p_document_type='petty_cash' THEN p_document_id END,
      matched_tax_payment_id=CASE WHEN p_document_type='tax_payment' THEN p_document_id END,
      matched_entry_id=v_je,payment_kind=COALESCE(p_payment_kind,'supplier'),matched_at=now(),matched_by=auth.uid(),manually_unlinked=true
    WHERE id=p_bank_line_id;
  ELSE
    UPDATE public.bank_statement_lines SET matched_expense_id=NULL,matched_receipt_id=NULL,matched_payment_id=NULL,
      matched_fund_transfer_id=NULL,matched_petty_cash_id=NULL,matched_tax_payment_id=NULL,matched_entry_id=NULL,manually_unlinked=true
    WHERE id=p_bank_line_id;
  END IF;
  PERFORM public.refresh_bank_statement_allocation_status(p_bank_line_id);
  IF p_document_type='expense' THEN PERFORM public.recalculate_expense_payment_state(p_document_id); END IF;
  RETURN jsonb_build_object('allocation_amount',round(v_allocate,2),'bank_total',v_bank_total,
    'bank_allocated',v_bank_allocated+v_allocate,'bank_remaining',v_bank_remaining-v_allocate,
    'document_total',v_doc_total,'document_allocated',v_doc_allocated+v_allocate,'document_remaining',v_doc_remaining-v_allocate);
END $$;

REVOKE ALL ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
