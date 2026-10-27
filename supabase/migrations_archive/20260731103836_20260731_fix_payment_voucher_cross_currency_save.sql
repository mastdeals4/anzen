-- Allow cross-currency payment vouchers (USD invoice → IDR bank).
-- The previous guard required payment_currency == bank_account currency, which
-- blocked the legitimate USD-invoice / IDR-bank scenario where bank_amount
-- carries the converted IDR debit. Relax the check to only enforce same-currency
-- when NO conversion amount is supplied.
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
  v_number        text;
  v_id            uuid;
  v_date          date    := (p_payload->>'voucher_date')::date;
  v_currency      text    := upper(COALESCE(NULLIF(p_payload->>'payment_currency',''),'IDR'));
  v_bank_currency text;
  v_rate          numeric := COALESCE(NULLIF(p_payload->>'exchange_rate','')::numeric, 1);
  v_bank_amount   numeric := NULLIF(p_payload->>'bank_amount','')::numeric;
  v_is_cross      boolean;
BEGIN
  PERFORM public._sec_check_finance_role();

  SELECT upper(currency) INTO v_bank_currency
    FROM public.bank_accounts
   WHERE id = NULLIF(p_payload->>'bank_account_id','')::uuid;

  -- Basic currency / rate sanity check
  IF v_currency NOT IN ('IDR','USD') OR v_rate <= 0
     OR (v_currency = 'USD' AND v_rate <= 1) THEN
    RAISE EXCEPTION 'Payment currency or exchange rate is invalid';
  END IF;

  -- Detect cross-currency: invoice in USD, bank in IDR (or vice-versa).
  -- Cross-currency is allowed when bank_amount (the converted debit) is provided.
  v_is_cross := v_bank_currency IS NOT NULL AND v_bank_currency <> v_currency;

  IF v_is_cross AND (v_bank_amount IS NULL OR v_bank_amount <= 0) THEN
    RAISE EXCEPTION
      'Cross-currency payment (% invoice → % bank) requires a bank_amount. Please enter the exchange rate.',
      v_currency, v_bank_currency;
  END IF;

  -- Same-currency mismatch (no conversion pathway) — hard error
  IF NOT v_is_cross AND v_bank_currency IS NOT NULL AND v_bank_currency <> v_currency THEN
    RAISE EXCEPTION
      'Payment currency % does not match selected bank currency %', v_currency, v_bank_currency;
  END IF;

  SELECT voucher_number INTO v_number FROM public.payment_vouchers WHERE id = p_voucher_id;
  v_number := COALESCE(v_number, public.next_payment_voucher_number(v_date));

  v_id := public.save_payment_voucher_with_allocations(
    p_voucher_id      => p_voucher_id,
    p_voucher_number  => v_number,
    p_voucher_date    => v_date,
    p_supplier_id     => NULLIF(p_payload->>'supplier_id','')::uuid,
    p_payment_method  => p_payload->>'payment_method',
    p_bank_account_id => NULLIF(p_payload->>'bank_account_id','')::uuid,
    p_reference_number=> NULLIF(p_payload->>'reference_number',''),
    p_amount          => (p_payload->>'amount')::numeric,
    p_pph_amount      => COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric, 0),
    p_pph_code_id     => NULLIF(p_payload->>'pph_code_id','')::uuid,
    p_description     => NULLIF(p_payload->>'description',''),
    p_payment_currency=> v_currency,
    p_exchange_rate   => v_rate,
    p_bank_amount     => v_bank_amount,
    p_bank_charge     => COALESCE(NULLIF(p_payload->>'bank_charge','')::numeric, 0),
    p_created_by      => COALESCE(NULLIF(p_payload->>'created_by','')::uuid, auth.uid()),
    p_allocations     => p_allocations,
    p_staff_id        => NULLIF(p_payload->>'staff_id','')::uuid
  );

  UPDATE public.payment_vouchers pv SET
    currency_code         = upper(COALESCE(pv.payment_currency,'IDR')),
    transaction_currency  = upper(COALESCE(pv.payment_currency,'IDR')),
    functional_currency   = 'IDR',
    bank_account_currency = upper(COALESCE(
      (SELECT ba.currency FROM public.bank_accounts ba WHERE ba.id = pv.bank_account_id),
      pv.payment_currency,'IDR'))
  WHERE pv.id = v_id;

  RETURN jsonb_build_object('id', v_id, 'voucher_number', v_number);
END;
$$;
