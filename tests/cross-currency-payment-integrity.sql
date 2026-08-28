-- Read-only regression assertions for the canonical payment model.
-- Run with a PostgreSQL client against the finance database.
DO $$
DECLARE
  v_converted numeric;
  v_actual numeric;
  v_debit numeric;
  v_credit numeric;
  v_bank_debit numeric;
  v_bank_currency text;
  v_invoice_currency text;
BEGIN
  -- Production scenario: USD 21,000 -> BCA IDR at 16,990 + Rp50,000 charge.
  v_converted := 21000 * 16990;
  v_actual := v_converted + 50000;
  IF v_converted <> 356790000 OR v_actual <> 356840000 THEN
    RAISE EXCEPTION 'USD to IDR conversion regression: %, %', v_converted, v_actual;
  END IF;

  -- Rates are directional: IDR -> USD is a positive fractional rate.
  IF 21000 * 16990 <> 356790000
     OR 356790000 * (1.0 / 16990) <> 21000
     OR 1000000 * 0.000058858151 <> 58.858151 THEN
    RAISE EXCEPTION 'Bidirectional currency conversion regression';
  END IF;

  SELECT invoice_currency, bank_currency, converted_amount, actual_bank_debit
    INTO v_invoice_currency, v_bank_currency, v_converted, v_actual
  FROM public.payment_vouchers WHERE voucher_number='PV/25-26/004';
  IF v_invoice_currency <> 'USD' OR v_bank_currency <> 'IDR'
     OR v_converted <> 356790000 OR v_actual <> 356840000 THEN
    RAISE EXCEPTION 'Historical USD/IDR canonical fields do not reconcile';
  END IF;

  SELECT COALESCE(SUM(l.debit),0), COALESCE(SUM(l.credit),0)
    INTO v_debit, v_credit
  FROM public.journal_entry_lines l
  JOIN public.payment_vouchers p ON p.journal_entry_id=l.journal_entry_id
  WHERE p.voucher_number='PV/25-26/004';
  IF v_debit <> v_credit OR v_debit <> 356840000 THEN
    RAISE EXCEPTION 'Historical USD/IDR journal does not balance: %, %', v_debit, v_credit;
  END IF;

  -- Every posted voucher with a bank amount must have a matching bank-side
  -- journal amount, regardless of currency.
  IF EXISTS (
    SELECT 1 FROM public.payment_vouchers p
    JOIN public.journal_entries j ON j.id=p.journal_entry_id
    WHERE p.is_posted AND p.actual_bank_debit IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        JOIN public.bank_accounts b ON b.coa_id=l.account_id
        WHERE l.journal_entry_id=j.id AND l.credit=p.actual_bank_debit
      )
  ) THEN
    RAISE EXCEPTION 'Posted payment voucher bank-side journal mismatch';
  END IF;
END $$;
