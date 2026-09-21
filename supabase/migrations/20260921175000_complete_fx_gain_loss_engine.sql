-- 20260921175000_complete_fx_gain_loss_engine.sql
-- Complete FX Gain & Loss Accounting Engine
-- 1. Ensure Account 4930 (Foreign Exchange Gain) exists in chart_of_accounts.
-- 2. Upgrade post_payment_voucher to compute realized FX gain/loss from allocated invoices' recognition carrying rate.
-- 3. Maintain strict separation: FX gain/loss goes to 7300/4930, Bank Charges to 7100, AP is relieved for exact carrying IDR.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE code = '4930') THEN
    INSERT INTO public.chart_of_accounts (
      code, name, name_id, account_type, account_group, normal_balance, is_active, description
    ) VALUES (
      '4930', 'Foreign Exchange Gain', 'Keuntungan Selisih Kurs', 'revenue', 'Other Income', 'credit', true, 'Realized and unrealized foreign exchange gains'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv RECORD;
  v_rate numeric;
  v_gross numeric;
  v_payment numeric;
  v_converted numeric;
  v_pph_bank numeric;
  v_charge_amt numeric;
  v_actual numeric;
  v_expected numeric;
  v_bank_spread numeric;
  v_ap_debit numeric;
  v_total_debit numeric;
  v_total_credit numeric;
  v_entry text;
  v_je uuid;
  v_line integer := 1;
  v_ap uuid;
  v_bank uuid;
  v_charge uuid;
  v_pph uuid;
  v_fx_loss uuid;
  v_fx_gain uuid;
  v_invoice_currency text;
  v_bank_currency text;
  v_actual_poster uuid;
  v_alloc_usd numeric := 0;
  v_alloc_carrying_idr numeric := 0;
  v_alloc_settle_idr numeric := 0;
  v_realized_fx numeric := 0;
  v_total_fx_loss numeric := 0;
  v_total_fx_gain numeric := 0;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number; END IF;

  v_invoice_currency := upper(COALESCE(v_pv.invoice_currency, v_pv.transaction_currency, v_pv.payment_currency, 'IDR'));
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id = v_pv.bank_account_id;
  v_bank_currency := COALESCE(v_bank_currency, v_pv.bank_currency, v_pv.payment_currency, 'IDR');
  
  v_rate := CASE WHEN v_invoice_currency = v_bank_currency THEN 1 ELSE COALESCE(v_pv.exchange_rate, 0) END;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'Missing exchange rate for %', v_pv.voucher_number; END IF;

  v_gross := COALESCE(v_pv.invoice_amount, v_pv.amount, 0);
  v_payment := COALESCE(v_pv.payment_amount, v_gross - COALESCE(v_pv.pph_amount, 0));
  v_converted := COALESCE(v_pv.converted_amount, v_payment * v_rate);
  v_pph_bank := COALESCE(v_pv.pph_amount, 0) * v_rate;
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_converted + v_charge_amt);
  v_expected := v_converted + v_charge_amt;
  v_bank_spread := v_actual - v_expected;

  -- Compute multi-allocation invoice carrying value vs settlement value
  IF v_invoice_currency <> v_bank_currency THEN
    SELECT 
      COALESCE(SUM(va.allocated_amount), 0),
      COALESCE(SUM(va.allocated_amount * COALESCE(pi.exchange_rate, v_rate)), 0),
      COALESCE(SUM(va.allocated_amount * v_rate), 0)
    INTO v_alloc_usd, v_alloc_carrying_idr, v_alloc_settle_idr
    FROM public.voucher_allocations va
    JOIN public.purchase_invoices pi ON pi.id = va.purchase_invoice_id
    WHERE va.payment_voucher_id = p_pv_id;

    IF v_alloc_usd > 0 THEN
      -- AP is debited for exact carrying amount of settled invoices + remaining unallocated at PV rate
      v_ap_debit := v_alloc_carrying_idr + ((v_gross - v_alloc_usd) * v_rate);
      v_realized_fx := v_alloc_settle_idr - v_alloc_carrying_idr;
    ELSE
      v_ap_debit := v_gross * v_rate;
      v_realized_fx := 0;
    END IF;
  ELSE
    v_ap_debit := v_gross * v_rate;
    v_realized_fx := 0;
  END IF;

  IF v_realized_fx > 0 THEN
    v_total_fx_loss := v_realized_fx;
  ELSIF v_realized_fx < 0 THEN
    v_total_fx_gain := abs(v_realized_fx);
  END IF;

  -- Resolve GL Accounts
  IF v_pv.coa_account_id IS NOT NULL THEN
    v_ap := v_pv.coa_account_id;
  ELSE
    SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
  END IF;

  IF v_pv.payment_method = 'advance_adjustment' OR v_pv.payment_purpose = 'salary_advance' THEN
    SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
  ELSE
    SELECT coa_id INTO v_bank FROM public.bank_accounts WHERE id = v_pv.bank_account_id;
    IF v_bank IS NULL THEN SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code = '1101' LIMIT 1; END IF;
  END IF;

  SELECT id INTO v_charge FROM public.chart_of_accounts WHERE code = '7100' LIMIT 1;
  SELECT id INTO v_pph FROM public.chart_of_accounts WHERE code = '2132' LIMIT 1;
  SELECT id INTO v_fx_loss FROM public.chart_of_accounts WHERE code = '7300' LIMIT 1;
  SELECT id INTO v_fx_gain FROM public.chart_of_accounts WHERE code = '4930' LIMIT 1;

  IF v_ap IS NULL OR v_bank IS NULL THEN RAISE EXCEPTION 'Required payment accounts are missing'; END IF;
  IF v_pph_bank > 0 AND v_pph IS NULL THEN RAISE EXCEPTION 'PPh payable account is missing'; END IF;

  -- Determine balanced journal totals
  v_total_debit := v_ap_debit + v_charge_amt + v_total_fx_loss + GREATEST(v_bank_spread, 0);
  v_total_credit := v_actual + v_pph_bank + v_total_fx_gain + GREATEST(-v_bank_spread, 0);

  v_entry := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(
    entry_number, entry_date, source_module, reference_id, reference_number, description,
    total_debit, total_credit, is_posted, posted_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number, 'Payment Voucher: ' || v_pv.voucher_number,
    v_total_debit, v_total_credit, true, v_actual_poster, v_invoice_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je;

  -- Line: AP Debit (carrying basis)
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
  ) VALUES (
    v_je, v_line, v_ap, 'Payment - ' || v_pv.voucher_number, v_ap_debit, 0,
    v_invoice_currency, v_gross, 0, v_rate, v_pv.supplier_id
  );
  v_line := v_line + 1;

  -- Line: Bank Charge
  IF v_charge_amt > 0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_charge, 'Bank Charge - ' || v_pv.voucher_number, v_charge_amt, 0,
      v_bank_currency, v_charge_amt, 0, 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Realized FX Loss
  IF v_total_fx_loss > 0 AND v_fx_loss IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_fx_loss, 'Realized FX loss - ' || v_pv.voucher_number, v_total_fx_loss, 0,
      'IDR', v_total_fx_loss, 0, 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Bank Spread (if bank charged more than expected debit)
  IF v_bank_spread > 0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_charge, 'Bank conversion spread - ' || v_pv.voucher_number, v_bank_spread, 0,
      v_bank_currency, v_bank_spread, 0, 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: PPh Withholding
  IF v_pph_bank > 0 AND v_pph IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_pph, 'PPh Withholding - ' || v_pv.voucher_number, 0, v_pph_bank,
      v_bank_currency, 0, v_pv.pph_amount, v_rate, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Realized FX Gain
  IF v_total_fx_gain > 0 AND v_fx_gain IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_fx_gain, 'Realized FX gain - ' || v_pv.voucher_number, 0, v_total_fx_gain,
      'IDR', 0, v_total_fx_gain, 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Bank Spread Credit (if bank charged less than expected debit)
  IF v_bank_spread < 0 AND v_fx_gain IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_fx_gain, 'Bank conversion spread - ' || v_pv.voucher_number, 0, abs(v_bank_spread),
      v_bank_currency, 0, abs(v_bank_spread), 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Bank / Cash Credit
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
  ) VALUES (
    v_je, v_line, v_bank,
    CASE WHEN v_pv.payment_method = 'advance_adjustment' THEN 'Advance Adjustment - ' ELSE 'Bank Payment - ' END || v_pv.voucher_number,
    0, v_actual, v_bank_currency, 0, v_actual, 1, v_pv.supplier_id
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;
  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_payment_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid, uuid) TO authenticated, service_role;
