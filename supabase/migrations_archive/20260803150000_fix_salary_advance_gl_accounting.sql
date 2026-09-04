-- Finance V1.1.2 approved exception: restore canonical Salary Advance GL
-- accounting without changing schema or workflow.
--
-- Salary Advance issued:     Dr 1160 Staff Advances / Cr Bank or Cash
-- Salary Advance settlement: Dr 2110 Accounts Payable / Cr 1160 Staff Advances
-- Ordinary payments retain the existing canonical currency/payment behavior.

BEGIN;

CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_pv record; v_je uuid; v_debit_account uuid; v_credit_account uuid;
  v_bank uuid; v_charge uuid; v_pph uuid; v_fx uuid; v_advance uuid;
  v_invoice_currency text; v_bank_currency text; v_rate numeric; v_gross numeric;
  v_payment numeric; v_converted numeric; v_pph_bank numeric; v_actual numeric;
  v_charge_amt numeric; v_expected numeric; v_fx_delta numeric; v_total numeric;
  v_line int:=1; v_entry text; v_is_advance boolean; v_is_settlement boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id=p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found',p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted',v_pv.voucher_number; END IF;

  v_is_advance:=v_pv.payment_purpose='salary_advance';
  v_is_settlement:=v_pv.payment_purpose='salary_advance_settlement'
    OR v_pv.payment_method='advance_adjustment';
  IF v_is_advance AND v_is_settlement THEN
    RAISE EXCEPTION 'Salary Advance issuance cannot use advance_adjustment';
  END IF;

  v_invoice_currency:=upper(COALESCE(v_pv.invoice_currency,v_pv.transaction_currency,v_pv.payment_currency,'IDR'));
  SELECT upper(currency),coa_id INTO v_bank_currency,v_bank
    FROM public.bank_accounts WHERE id=v_pv.bank_account_id;
  v_bank_currency:=COALESCE(v_bank_currency,v_pv.bank_currency,v_pv.payment_currency,'IDR');
  v_rate:=CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE COALESCE(v_pv.exchange_rate,0) END;
  IF v_rate<=0 THEN RAISE EXCEPTION 'Missing exchange rate for %',v_pv.voucher_number; END IF;
  v_gross:=COALESCE(v_pv.invoice_amount,v_pv.amount,0);
  v_payment:=COALESCE(v_pv.payment_amount,v_gross-COALESCE(v_pv.pph_amount,0));
  v_converted:=COALESCE(v_pv.converted_amount,v_payment*v_rate);
  v_pph_bank:=COALESCE(v_pv.pph_amount,0)*v_rate;
  v_charge_amt:=COALESCE(v_pv.bank_charge,0);
  v_actual:=COALESCE(v_pv.actual_bank_debit,v_pv.bank_amount,v_converted-v_pph_bank+v_charge_amt);
  v_expected:=v_converted-v_pph_bank+v_charge_amt;
  v_fx_delta:=v_actual-v_expected;

  SELECT id INTO v_advance FROM public.chart_of_accounts WHERE code='1160' LIMIT 1;
  IF v_advance IS NULL AND (v_is_advance OR v_is_settlement) THEN
    RAISE EXCEPTION 'Staff Advances account (1160) is missing';
  END IF;
  IF v_is_advance THEN
    v_debit_account:=v_advance;
  ELSE
    SELECT id INTO v_debit_account FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  END IF;
  IF v_is_settlement THEN
    v_credit_account:=v_advance;
    v_actual:=v_converted;
    v_charge_amt:=0;
    v_fx_delta:=0;
  ELSE
    v_credit_account:=v_bank;
    IF v_credit_account IS NULL THEN
      SELECT id INTO v_credit_account FROM public.chart_of_accounts
       WHERE code=CASE WHEN v_pv.payment_method='cash' THEN '1101' ELSE '1111' END LIMIT 1;
    END IF;
  END IF;
  SELECT id INTO v_charge FROM public.chart_of_accounts WHERE code='7100' LIMIT 1;
  SELECT id INTO v_pph FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_fx FROM public.chart_of_accounts WHERE code='7300' LIMIT 1;
  IF v_debit_account IS NULL OR v_credit_account IS NULL THEN
    RAISE EXCEPTION 'Required payment accounts are missing';
  END IF;

  v_total:=v_converted+v_charge_amt+greatest(v_fx_delta,0);
  IF v_fx_delta<0 THEN v_total:=v_converted+v_charge_amt; END IF;
  v_entry:=public.next_journal_entry_number();
  INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,
    reference_number,description,total_debit,total_credit,is_posted,posted_by)
  VALUES(v_entry,v_pv.voucher_date,'payment',v_pv.id,v_pv.voucher_number,
    'Payment Voucher: '||v_pv.voucher_number,v_total,v_total,true,p_posted_by)
  RETURNING id INTO v_je;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
    description,debit,credit,transaction_currency,transaction_debit,
    transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_debit_account,
    CASE WHEN v_is_advance THEN 'Salary Advance Issued - '||v_pv.voucher_number
         WHEN v_is_settlement THEN 'Salary Payable Settled by Advance - '||v_pv.voucher_number
         ELSE 'Payment - '||v_pv.voucher_number END,
    v_converted,0,v_invoice_currency,v_gross,0,v_rate,v_pv.supplier_id);
  v_line:=v_line+1;
  IF v_charge_amt>0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
      description,debit,credit,transaction_currency,transaction_debit,
      transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_charge,'Bank Charge - '||v_pv.voucher_number,
      v_charge_amt,0,v_bank_currency,v_charge_amt,0,1,v_pv.supplier_id);
    v_line:=v_line+1;
  END IF;
  IF v_pph_bank>0 AND v_pph IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
      description,debit,credit,transaction_currency,transaction_debit,
      transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_pph,'PPh Withholding - '||v_pv.voucher_number,
      0,v_pph_bank,v_bank_currency,0,v_pv.pph_amount,v_rate,v_pv.supplier_id);
    v_line:=v_line+1;
  END IF;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
    description,debit,credit,transaction_currency,transaction_debit,
    transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_credit_account,
    CASE WHEN v_is_settlement THEN 'Salary Advance Cleared - '||v_pv.voucher_number
         WHEN v_is_advance THEN 'Salary Advance Bank Payment - '||v_pv.voucher_number
         ELSE 'Bank Payment - '||v_pv.voucher_number END,
    0,v_actual,v_bank_currency,0,v_actual,1,v_pv.supplier_id);
  v_line:=v_line+1;
  IF v_fx_delta>0 AND v_fx IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
      description,debit,credit,supplier_id)
    VALUES(v_je,v_line,v_fx,'FX loss - '||v_pv.voucher_number,v_fx_delta,0,v_pv.supplier_id);
  ELSIF v_fx_delta<0 AND v_fx IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
      description,debit,credit,supplier_id)
    VALUES(v_je,v_line,v_fx,'FX gain - '||v_pv.voucher_number,0,abs(v_fx_delta),v_pv.supplier_id);
  END IF;
  UPDATE public.payment_vouchers SET is_posted=true,journal_entry_id=v_je WHERE id=p_pv_id;
  INSERT INTO public.audit_logs(table_name,record_id,action_type,old_values,new_values,user_id)
  VALUES('payment_vouchers',p_pv_id,'update',jsonb_build_object('is_posted',false),
    jsonb_build_object('is_posted',true,'journal_entry_id',v_je),p_posted_by);
END;
$$;

-- Repost approved expenses only when an accounting input changes. Allocation
-- updates to paid_amount must never delete or regenerate the gross salary JE.
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting_insert ON public.finance_expenses;
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting_update ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting_insert
  AFTER INSERT ON public.finance_expenses FOR EACH ROW
  WHEN (NEW.approval_status='approved'
    AND COALESCE(current_setting('app.finance_historical_repair',true),'off')<>'on')
  EXECUTE FUNCTION public.auto_post_expense_accounting();
CREATE TRIGGER trigger_auto_post_expense_accounting_update
  AFTER UPDATE ON public.finance_expenses FOR EACH ROW
  WHEN (NEW.approval_status='approved'
    AND COALESCE(current_setting('app.finance_historical_repair',true),'off')<>'on'
    AND (OLD.approval_status IS DISTINCT FROM NEW.approval_status
      OR OLD.amount IS DISTINCT FROM NEW.amount
      OR OLD.expense_category IS DISTINCT FROM NEW.expense_category
      OR OLD.payment_method IS DISTINCT FROM NEW.payment_method
      OR OLD.bank_account_id IS DISTINCT FROM NEW.bank_account_id
      OR OLD.ppn_amount IS DISTINCT FROM NEW.ppn_amount
      OR OLD.pph_amount IS DISTINCT FROM NEW.pph_amount
      OR OLD.pph_code_id IS DISTINCT FROM NEW.pph_code_id
      OR OLD.stamp_duty_amount IS DISTINCT FROM NEW.stamp_duty_amount
      OR OLD.bank_charges_amount IS DISTINCT FROM NEW.bank_charges_amount
      OR OLD.fixed_asset_account_id IS DISTINCT FROM NEW.fixed_asset_account_id
      OR OLD.broker_items IS DISTINCT FROM NEW.broker_items
      OR OLD.description IS DISTINCT FROM NEW.description
      OR OLD.expense_date IS DISTINCT FROM NEW.expense_date))
  EXECUTE FUNCTION public.auto_post_expense_accounting();

-- Repair only posted Salary Advance workflow documents whose journal account
-- classification proves they were produced by the regressed payment poster.
UPDATE public.journal_entry_lines jel
   SET account_id=(SELECT id FROM public.chart_of_accounts WHERE code='1160' LIMIT 1),
       description='Salary Advance Issued - '||pv.voucher_number
  FROM public.journal_entries je
  JOIN public.payment_vouchers pv ON pv.id=je.reference_id
 WHERE jel.journal_entry_id=je.id AND je.source_module='payment'
   AND pv.payment_purpose='salary_advance' AND pv.is_posted=true
   AND jel.debit>0 AND jel.credit=0
   AND jel.account_id=(SELECT id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1);

UPDATE public.journal_entry_lines jel
   SET account_id=(SELECT id FROM public.chart_of_accounts WHERE code='1160' LIMIT 1),
       description='Salary Advance Cleared - '||pv.voucher_number,
       transaction_currency=COALESCE(jel.transaction_currency,pv.payment_currency,'IDR')
  FROM public.journal_entries je
  JOIN public.payment_vouchers pv ON pv.id=je.reference_id
 WHERE jel.journal_entry_id=je.id AND je.source_module='payment'
   AND pv.payment_purpose='salary_advance_settlement' AND pv.is_posted=true
   AND pv.payment_method='advance_adjustment' AND jel.credit>0 AND jel.debit=0
   AND jel.account_id<>(SELECT id FROM public.chart_of_accounts WHERE code='1160' LIMIT 1);

REVOKE ALL ON FUNCTION public.post_payment_voucher(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid,uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
