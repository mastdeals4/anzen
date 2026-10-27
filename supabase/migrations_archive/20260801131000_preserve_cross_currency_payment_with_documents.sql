-- Preserve the certified bidirectional cross-currency Payment command while
-- extending it with the existing payment_vouchers.document_urls field.
BEGIN;

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
    NULLIF((SELECT COALESCE(a->>'currency',a->>'allocated_currency')
            FROM jsonb_array_elements(COALESCE(p_allocations,'[]'::jsonb)) a
            WHERE COALESCE(a->>'currency',a->>'allocated_currency') IS NOT NULL LIMIT 1),''),
    v_payment_currency));
  v_bank_currency text;
  v_rate numeric := COALESCE(NULLIF(p_payload->>'exchange_rate','')::numeric,1);
  v_invoice_amount numeric := COALESCE(NULLIF(p_payload->>'invoice_amount','')::numeric,
    NULLIF(p_payload->>'amount','')::numeric,0);
  v_payment_amount numeric := COALESCE(NULLIF(p_payload->>'payment_amount','')::numeric,
    v_invoice_amount-COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0));
  v_converted numeric;
  v_actual numeric;
  v_bank_charge numeric := COALESCE(NULLIF(p_payload->>'bank_charge','')::numeric,0);
  v_docs text[];
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts
   WHERE id=NULLIF(p_payload->>'bank_account_id','')::uuid;
  v_bank_currency:=COALESCE(v_bank_currency,v_payment_currency);
  IF v_payment_currency NOT IN('IDR','USD') OR v_invoice_currency NOT IN('IDR','USD')
     OR v_bank_currency NOT IN('IDR','USD') OR v_rate<=0 THEN
    RAISE EXCEPTION 'Payment currencies or exchange rate are invalid';
  END IF;
  v_converted:=COALESCE(NULLIF(p_payload->>'converted_amount','')::numeric,
    v_payment_amount*CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE v_rate END);
  v_actual:=COALESCE(NULLIF(p_payload->>'actual_bank_debit','')::numeric,
    NULLIF(p_payload->>'bank_amount','')::numeric,v_converted+v_bank_charge);
  IF v_actual<=0 AND v_invoice_amount>0 THEN RAISE EXCEPTION 'Actual bank debit must be positive'; END IF;
  SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO v_docs
    FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls','[]'::jsonb));

  SELECT voucher_number INTO v_number FROM public.payment_vouchers WHERE id=p_voucher_id;
  v_number:=COALESCE(v_number,public.next_payment_voucher_number(v_date));
  v_id:=public.save_payment_voucher_with_allocations(
    p_voucher_id=>p_voucher_id,p_voucher_number=>v_number,p_voucher_date=>v_date,
    p_supplier_id=>NULLIF(p_payload->>'supplier_id','')::uuid,
    p_payment_method=>p_payload->>'payment_method',
    p_bank_account_id=>NULLIF(p_payload->>'bank_account_id','')::uuid,
    p_reference_number=>NULLIF(p_payload->>'reference_number',''),p_amount=>v_invoice_amount,
    p_pph_amount=>COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    p_pph_code_id=>NULLIF(p_payload->>'pph_code_id','')::uuid,
    p_description=>NULLIF(p_payload->>'description',''),
    p_payment_currency=>v_payment_currency,p_exchange_rate=>v_rate,
    p_bank_amount=>v_actual,p_bank_charge=>v_bank_charge,
    p_created_by=>COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),
    p_allocations=>p_allocations,p_staff_id=>NULLIF(p_payload->>'staff_id','')::uuid);
  UPDATE public.payment_vouchers SET
    invoice_currency=v_invoice_currency,invoice_amount=v_invoice_amount,
    payment_amount=v_payment_amount,payment_currency=v_payment_currency,
    transaction_currency=v_invoice_currency,functional_currency='IDR',
    exchange_rate=v_rate,bank_currency=v_bank_currency,
    bank_account_currency=v_bank_currency,converted_amount=v_converted,
    actual_bank_debit=v_actual,bank_amount=v_actual,
    document_urls=NULLIF(v_docs,ARRAY[]::text[])
  WHERE id=v_id;
  RETURN jsonb_build_object('id',v_id,'voucher_number',v_number);
END;
$$;

REVOKE ALL ON FUNCTION public.save_payment_voucher_command(uuid,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_payment_voucher_command(uuid,jsonb,jsonb) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
