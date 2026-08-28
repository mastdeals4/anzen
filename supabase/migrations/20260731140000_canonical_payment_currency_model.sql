-- Canonical payment currency model and deterministic repair of the five
-- cross-currency vouchers identified by the 2026-07-31 finance audit.
-- This migration is idempotent: columns, functions, and repairs are guarded.

ALTER TABLE public.payment_vouchers
  ADD COLUMN IF NOT EXISTS invoice_currency text,
  ADD COLUMN IF NOT EXISTS invoice_amount numeric,
  ADD COLUMN IF NOT EXISTS payment_amount numeric,
  ADD COLUMN IF NOT EXISTS bank_currency text,
  ADD COLUMN IF NOT EXISTS converted_amount numeric,
  ADD COLUMN IF NOT EXISTS actual_bank_debit numeric;

COMMENT ON COLUMN public.payment_vouchers.invoice_currency IS 'Currency of the invoices being settled.';
COMMENT ON COLUMN public.payment_vouchers.invoice_amount IS 'Gross amount allocated in invoice currency.';
COMMENT ON COLUMN public.payment_vouchers.payment_amount IS 'Net amount settled in invoice currency after withholding, before conversion.';
COMMENT ON COLUMN public.payment_vouchers.bank_currency IS 'Currency of the selected bank account.';
COMMENT ON COLUMN public.payment_vouchers.converted_amount IS 'Payment amount converted to bank currency, before bank charges.';
COMMENT ON COLUMN public.payment_vouchers.actual_bank_debit IS 'Actual bank-side debit, including bank charges.';

-- Backfill canonical metadata without changing legacy amount fields or journals.
UPDATE public.payment_vouchers pv
SET invoice_currency = COALESCE(
      NULLIF((SELECT va.allocated_currency FROM public.voucher_allocations va
              WHERE va.payment_voucher_id = pv.id AND va.allocated_currency IS NOT NULL
              ORDER BY va.id LIMIT 1), ''),
      NULLIF(pv.invoice_currency, ''), pv.payment_currency, 'IDR'),
    invoice_amount = COALESCE(pv.invoice_amount, pv.amount),
    payment_amount = COALESCE(pv.payment_amount, pv.amount - COALESCE(pv.pph_amount, 0)),
    bank_currency = COALESCE(NULLIF(pv.bank_currency, ''),
      (SELECT upper(ba.currency) FROM public.bank_accounts ba WHERE ba.id = pv.bank_account_id),
      pv.payment_currency, 'IDR'),
    converted_amount = COALESCE(pv.converted_amount,
      (pv.amount - COALESCE(pv.pph_amount, 0)) * COALESCE(NULLIF(pv.exchange_rate, 0), 1)),
    actual_bank_debit = COALESCE(pv.actual_bank_debit, pv.bank_amount,
      (pv.amount - COALESCE(pv.pph_amount, 0)) * COALESCE(NULLIF(pv.exchange_rate, 0), 1)
      + COALESCE(pv.bank_charge, 0));

CREATE OR REPLACE FUNCTION public.save_payment_voucher_command(
  p_voucher_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_number text;
  v_id uuid;
  v_date date := (p_payload->>'voucher_date')::date;
  v_payment_currency text := upper(COALESCE(NULLIF(p_payload->>'payment_currency',''),'IDR'));
  v_invoice_currency text := upper(COALESCE(
    NULLIF(p_payload->>'invoice_currency',''),
    NULLIF((SELECT COALESCE(a->>'currency', a->>'allocated_currency')
            FROM jsonb_array_elements(COALESCE(p_allocations,'[]'::jsonb)) a
            WHERE COALESCE(a->>'currency', a->>'allocated_currency') IS NOT NULL LIMIT 1), ''),
    v_payment_currency));
  v_bank_currency text;
  v_rate numeric := COALESCE(NULLIF(p_payload->>'exchange_rate','')::numeric, 1);
  v_invoice_amount numeric := COALESCE(NULLIF(p_payload->>'invoice_amount','')::numeric,
    NULLIF(p_payload->>'amount','')::numeric, 0);
  v_payment_amount numeric := COALESCE(NULLIF(p_payload->>'payment_amount','')::numeric,
    v_invoice_amount - COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0));
  v_converted numeric;
  v_actual numeric;
  v_bank_charge numeric := COALESCE(NULLIF(p_payload->>'bank_charge','')::numeric,0);
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts
   WHERE id = NULLIF(p_payload->>'bank_account_id','')::uuid;
  v_bank_currency := COALESCE(v_bank_currency, v_payment_currency);
  IF v_rate <= 0 OR (v_invoice_currency <> v_bank_currency AND v_rate <= 1) THEN
    RAISE EXCEPTION 'Invalid exchange rate for % to % payment', v_invoice_currency, v_bank_currency;
  END IF;
  v_converted := COALESCE(NULLIF(p_payload->>'converted_amount','')::numeric,
    v_payment_amount * CASE WHEN v_invoice_currency = v_bank_currency THEN 1 ELSE v_rate END);
  v_actual := COALESCE(NULLIF(p_payload->>'actual_bank_debit','')::numeric,
    NULLIF(p_payload->>'bank_amount','')::numeric, v_converted + v_bank_charge);
  IF v_actual <= 0 AND v_invoice_amount > 0 THEN
    RAISE EXCEPTION 'Actual bank debit must be positive';
  END IF;

  SELECT voucher_number INTO v_number FROM public.payment_vouchers WHERE id = p_voucher_id;
  v_number := COALESCE(v_number, public.next_payment_voucher_number(v_date));
  v_id := public.save_payment_voucher_with_allocations(
    p_voucher_id => p_voucher_id, p_voucher_number => v_number, p_voucher_date => v_date,
    p_supplier_id => NULLIF(p_payload->>'supplier_id','')::uuid,
    p_payment_method => p_payload->>'payment_method',
    p_bank_account_id => NULLIF(p_payload->>'bank_account_id','')::uuid,
    p_reference_number => NULLIF(p_payload->>'reference_number',''),
    p_amount => v_invoice_amount,
    p_pph_amount => COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    p_pph_code_id => NULLIF(p_payload->>'pph_code_id','')::uuid,
    p_description => NULLIF(p_payload->>'description',''),
    p_payment_currency => v_payment_currency, p_exchange_rate => v_rate,
    p_bank_amount => v_actual, p_bank_charge => v_bank_charge,
    p_created_by => COALESCE(NULLIF(p_payload->>'created_by','')::uuid, auth.uid()),
    p_allocations => p_allocations, p_staff_id => NULLIF(p_payload->>'staff_id','')::uuid
  );
  UPDATE public.payment_vouchers SET
    invoice_currency=v_invoice_currency, invoice_amount=v_invoice_amount,
    payment_amount=v_payment_amount, payment_currency=v_payment_currency,
    transaction_currency=v_invoice_currency, functional_currency='IDR',
    exchange_rate=v_rate, bank_currency=v_bank_currency,
    bank_account_currency=v_bank_currency, converted_amount=v_converted,
    actual_bank_debit=v_actual, bank_amount=v_actual
  WHERE id=v_id;
  RETURN jsonb_build_object('id',v_id,'voucher_number',v_number);
END; $$;

CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pv record; v_je uuid; v_ap uuid; v_bank uuid; v_charge uuid; v_pph uuid; v_fx uuid;
  v_invoice_currency text; v_bank_currency text; v_rate numeric; v_gross numeric;
  v_payment numeric; v_converted numeric; v_pph_bank numeric; v_actual numeric; v_charge_amt numeric;
  v_expected numeric; v_fx_delta numeric; v_total numeric; v_line int := 1; v_entry text;
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
  v_actual := COALESCE(v_pv.actual_bank_debit,v_pv.bank_amount,v_converted-v_pph_bank+v_charge_amt);
  v_expected := v_converted-v_pph_bank+v_charge_amt;
  v_fx_delta := v_actual-v_expected;
  SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  SELECT coa_id INTO v_bank FROM public.bank_accounts WHERE id=v_pv.bank_account_id;
  IF v_bank IS NULL THEN SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code='1101' LIMIT 1; END IF;
  SELECT id INTO v_charge FROM public.chart_of_accounts WHERE code='7100' LIMIT 1;
  SELECT id INTO v_pph FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_fx FROM public.chart_of_accounts WHERE code='7300' LIMIT 1;
  IF v_ap IS NULL OR v_bank IS NULL THEN RAISE EXCEPTION 'Required payment accounts are missing'; END IF;
  v_total := v_converted + v_charge_amt + GREATEST(v_fx_delta,0);
  IF v_fx_delta < 0 THEN v_total := v_converted + v_charge_amt; END IF;
  v_entry := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,description,total_debit,total_credit,is_posted,posted_by)
  VALUES(v_entry,v_pv.voucher_date,'payment',v_pv.id,v_pv.voucher_number,'Payment Voucher: '||v_pv.voucher_number,v_total,v_total,true,p_posted_by)
  RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_ap,'Payment - '||v_pv.voucher_number,v_converted,0,v_invoice_currency,v_gross,0,v_rate,v_pv.supplier_id); v_line:=v_line+1;
  IF v_charge_amt>0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_charge,'Bank Charge - '||v_pv.voucher_number,v_charge_amt,0,v_bank_currency,v_charge_amt,0,1,v_pv.supplier_id); v_line:=v_line+1;
  END IF;
  IF v_pph_bank>0 AND v_pph IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_pph,'PPh Withholding - '||v_pv.voucher_number,0,v_pph_bank,v_bank_currency,0,v_pv.pph_amount,v_rate,v_pv.supplier_id); v_line:=v_line+1;
  END IF;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_bank,'Bank Payment - '||v_pv.voucher_number,0,v_actual,v_bank_currency,0,v_actual,1,v_pv.supplier_id); v_line:=v_line+1;
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

-- Repair only the five vouchers proven inconsistent by the audit report.
DO $$
DECLARE r record; je uuid; ap uuid; bank uuid; charge uuid; line_no int; gross numeric; rate numeric; converted numeric; actual numeric; bc numeric;
BEGIN
  FOR r IN SELECT pv.id,pv.journal_entry_id,pv.voucher_number,pv.amount,pv.bank_amount,pv.bank_charge,
                  COALESCE((SELECT va.allocated_currency FROM voucher_allocations va WHERE va.payment_voucher_id=pv.id ORDER BY va.id LIMIT 1),'IDR') invoice_ccy,
                  COALESCE(pv.exchange_rate,1) old_rate, upper(COALESCE(ba.currency,'IDR')) bank_ccy
             FROM payment_vouchers pv LEFT JOIN bank_accounts ba ON ba.id=pv.bank_account_id
             WHERE pv.voucher_number IN ('PV/25-26/003','PV/25-26/004','PV/26-26/001','PV/26-26/005','PV/26-27/001')
               AND (pv.invoice_currency IS NULL OR pv.actual_bank_debit IS NULL OR pv.converted_amount IS NULL
                    OR pv.payment_currency IS DISTINCT FROM upper(COALESCE(ba.currency,'IDR'))
                    OR pv.exchange_rate IS DISTINCT FROM CASE
                      WHEN COALESCE((SELECT va.allocated_currency FROM voucher_allocations va WHERE va.payment_voucher_id=pv.id ORDER BY va.id LIMIT 1),'IDR')=upper(COALESCE(ba.currency,'IDR')) THEN 1
                      WHEN pv.voucher_number='PV/25-26/004' THEN 16990
                      WHEN pv.voucher_number='PV/26-26/001' THEN 17990
                      WHEN pv.voucher_number='PV/26-26/005' THEN 17830
                      WHEN pv.voucher_number='PV/26-27/001' THEN 17136 ELSE 1 END
                    OR EXISTS (SELECT 1 FROM journal_entries j WHERE j.id=pv.journal_entry_id
                              AND j.total_debit IS DISTINCT FROM
                                (pv.amount * CASE WHEN COALESCE((SELECT va.allocated_currency FROM voucher_allocations va WHERE va.payment_voucher_id=pv.id ORDER BY va.id LIMIT 1),'IDR')=upper(COALESCE(ba.currency,'IDR')) THEN 1
                                                   WHEN pv.voucher_number='PV/25-26/004' THEN 16990
                                                   WHEN pv.voucher_number='PV/26-26/001' THEN 17990
                                                   WHEN pv.voucher_number='PV/26-26/005' THEN 17830
                                                   WHEN pv.voucher_number='PV/26-27/001' THEN 17136 ELSE 1 END) + COALESCE(pv.bank_charge,0)))
  LOOP
    gross:=r.amount; rate:=CASE WHEN r.invoice_ccy=r.bank_ccy THEN 1 ELSE CASE r.voucher_number
      WHEN 'PV/25-26/004' THEN 16990 WHEN 'PV/26-26/001' THEN 17990 WHEN 'PV/26-26/005' THEN 17830 WHEN 'PV/26-27/001' THEN 17136 ELSE 1 END END;
    converted:=gross*rate; actual:=COALESCE(r.bank_amount,converted+COALESCE(r.bank_charge,0)); bc:=COALESCE(r.bank_charge,0);
    UPDATE payment_vouchers SET invoice_currency=r.invoice_ccy,invoice_amount=gross,payment_amount=gross,
      payment_currency=r.bank_ccy,transaction_currency=r.invoice_ccy,exchange_rate=rate,bank_currency=r.bank_ccy,
      bank_account_currency=r.bank_ccy,converted_amount=converted,actual_bank_debit=actual,bank_amount=actual WHERE id=r.id;
    je:=r.journal_entry_id;
    IF je IS NULL THEN CONTINUE; END IF;
    SELECT id INTO ap FROM chart_of_accounts WHERE code='2110' LIMIT 1;
    SELECT coa_id INTO bank FROM bank_accounts WHERE id=(SELECT bank_account_id FROM payment_vouchers WHERE id=r.id);
    SELECT id INTO charge FROM chart_of_accounts WHERE code='7100' LIMIT 1;
    DELETE FROM journal_entry_lines WHERE journal_entry_id=je;
    line_no:=1;
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
      VALUES(je,line_no,ap,'Payment - '||r.voucher_number,converted,0,r.invoice_ccy,gross,0,rate,(SELECT supplier_id FROM payment_vouchers WHERE id=r.id)); line_no:=line_no+1;
    IF bc>0 AND charge IS NOT NULL THEN
      INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
        VALUES(je,line_no,charge,'Bank Charge - '||r.voucher_number,bc,0,r.bank_ccy,bc,0,1,(SELECT supplier_id FROM payment_vouchers WHERE id=r.id)); line_no:=line_no+1;
    END IF;
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,transaction_currency,transaction_debit,transaction_credit,exchange_rate,supplier_id)
      VALUES(je,line_no,bank,'Bank Payment - '||r.voucher_number,0,actual,r.bank_ccy,0,actual,1,(SELECT supplier_id FROM payment_vouchers WHERE id=r.id));
    UPDATE journal_entries SET total_debit=converted+bc,total_credit=converted+bc WHERE id=je;
    INSERT INTO audit_logs(table_name,record_id,action_type,old_values,new_values,user_id)
      VALUES('payment_vouchers',r.id,'update',jsonb_build_object('historical_repair',true,'voucher_number',r.voucher_number),jsonb_build_object('canonical_repair',true,'converted_amount',converted,'actual_bank_debit',actual),NULL);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.save_payment_voucher_command(uuid,jsonb,jsonb) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid,uuid) TO authenticated,service_role;
NOTIFY pgrst, 'reload schema';
