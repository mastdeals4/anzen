-- Correct supplier-payment posting when withholding tax is present.
-- payment_amount/converted_amount already represent the net cash settlement;
-- PPh must therefore be credited separately while AP is debited for gross.
-- No historical journals are rewritten.

CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pv record; v_je uuid; v_ap uuid; v_bank uuid; v_charge uuid; v_pph uuid; v_fx uuid;
  v_invoice_currency text; v_bank_currency text; v_rate numeric; v_gross numeric;
  v_payment numeric; v_converted numeric; v_pph_bank numeric; v_actual numeric; v_charge_amt numeric;
  v_expected numeric; v_fx_delta numeric; v_ap_debit numeric; v_total numeric; v_line int := 1; v_entry text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id=p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found',p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted',v_pv.voucher_number; END IF;

  v_invoice_currency := upper(COALESCE(v_pv.invoice_currency,v_pv.transaction_currency,v_pv.payment_currency,'IDR'));
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id=v_pv.bank_account_id;
  v_bank_currency := COALESCE(v_bank_currency,v_pv.bank_currency,v_pv.payment_currency,'IDR');
  v_rate := CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE COALESCE(v_pv.exchange_rate,0) END;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'Missing exchange rate for %',v_pv.voucher_number; END IF;

  v_gross := COALESCE(v_pv.invoice_amount,v_pv.amount,0);
  v_payment := COALESCE(v_pv.payment_amount,v_gross-COALESCE(v_pv.pph_amount,0));
  v_converted := COALESCE(v_pv.converted_amount,v_payment*v_rate);
  v_pph_bank := COALESCE(v_pv.pph_amount,0)*v_rate;
  v_charge_amt := COALESCE(v_pv.bank_charge,0);
  v_actual := COALESCE(v_pv.actual_bank_debit,v_pv.bank_amount,v_converted+v_charge_amt);
  v_expected := v_converted+v_charge_amt;
  v_fx_delta := v_actual-v_expected;
  v_ap_debit := v_gross*v_rate;

  IF v_pv.coa_account_id IS NOT NULL THEN
    v_ap := v_pv.coa_account_id;
  ELSE
    SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  END IF;
  IF v_pv.payment_method = 'advance_adjustment' THEN
    SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code='1160' LIMIT 1;
  ELSE
    SELECT coa_id INTO v_bank FROM public.bank_accounts WHERE id=v_pv.bank_account_id;
    IF v_bank IS NULL THEN SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code='1101' LIMIT 1; END IF;
  END IF;
  SELECT id INTO v_charge FROM public.chart_of_accounts WHERE code='7100' LIMIT 1;
  SELECT id INTO v_pph FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_fx FROM public.chart_of_accounts WHERE code='7300' LIMIT 1;
  IF v_ap IS NULL OR v_bank IS NULL THEN RAISE EXCEPTION 'Required payment accounts are missing'; END IF;
  IF v_pph_bank > 0 AND v_pph IS NULL THEN RAISE EXCEPTION 'PPh payable account is missing'; END IF;

  v_total := v_ap_debit + v_charge_amt + GREATEST(v_fx_delta,0);
  v_entry := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,posted_by)
  VALUES(v_entry,v_pv.voucher_date,'payment',v_pv.id,v_pv.voucher_number,'Payment Voucher: '||v_pv.voucher_number,v_total,v_total,true,p_posted_by)
  RETURNING id INTO v_je;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_ap,'Payment - '||v_pv.voucher_number,v_ap_debit,0,v_invoice_currency,v_gross,0,v_rate,v_pv.supplier_id); v_line:=v_line+1;
  IF v_charge_amt>0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_charge,'Bank Charge - '||v_pv.voucher_number,v_charge_amt,0,v_bank_currency,v_charge_amt,0,1,v_pv.supplier_id); v_line:=v_line+1;
  END IF;
  IF v_pph_bank>0 AND v_pph IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_pph,'PPh Withholding - '||v_pv.voucher_number,0,v_pph_bank,v_bank_currency,0,v_pv.pph_amount,v_rate,v_pv.supplier_id); v_line:=v_line+1;
  END IF;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_bank,CASE WHEN v_pv.payment_method='advance_adjustment' THEN 'Advance Adjustment - ' ELSE 'Bank Payment - ' END||v_pv.voucher_number,0,v_actual,v_bank_currency,0,v_actual,1,v_pv.supplier_id); v_line:=v_line+1;
  IF v_fx_delta>0 AND v_fx IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line,v_fx,'FX loss - '||v_pv.voucher_number,v_fx_delta,0,v_pv.supplier_id);
  ELSIF v_fx_delta<0 AND v_fx IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,supplier_id)
    VALUES(v_je,v_line,v_fx,'FX gain - '||v_pv.voucher_number,0,abs(v_fx_delta),v_pv.supplier_id);
  END IF;
  UPDATE public.payment_vouchers SET is_posted=true,journal_entry_id=v_je WHERE id=p_pv_id;
  INSERT INTO public.audit_logs(table_name,record_id,action_type,old_values,new_values,user_id)
  VALUES('payment_vouchers',p_pv_id,'update',jsonb_build_object('is_posted',false),jsonb_build_object('is_posted',true,'journal_entry_id',v_je),p_posted_by);
END; $$;

REVOKE ALL ON FUNCTION public.post_payment_voucher(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid,uuid) TO authenticated, service_role;
