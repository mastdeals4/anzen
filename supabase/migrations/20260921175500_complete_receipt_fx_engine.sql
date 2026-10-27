-- 20260921175500_complete_receipt_fx_engine.sql
-- Complete Customer Receipt FX Engine
-- Support cross-currency customer receipts with realized FX gain/loss:
-- Dr Bank (Actual IDR received)
-- Cr AR (Carrying value settled)
-- Dr 7300 FX Loss (if actual IDR received < carrying value)
-- Cr 4930 FX Gain (if actual IDR received > carrying value)

CREATE OR REPLACE FUNCTION public.post_receipt_voucher(p_rv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_debit_account_id   UUID;
  v_credit_account_id  UUID;
  v_fx_loss_id         UUID;
  v_fx_gain_id         UUID;
  v_actual_poster      UUID;
  v_rate               NUMERIC := 1;
  v_actual_received    NUMERIC;
  v_carrying_ar        NUMERIC;
  v_realized_fx        NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_rv FROM receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF v_rv.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number; END IF;

  IF v_rv.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_debit_account_id FROM bank_accounts WHERE id = v_rv.bank_account_id;
  ELSIF v_rv.payment_method = 'cash' THEN
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_debit_account_id IS NULL THEN
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  IF v_rv.coa_account_id IS NOT NULL THEN
    v_credit_account_id := v_rv.coa_account_id;
  ELSE
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
  END IF;

  SELECT id INTO v_fx_loss_id FROM chart_of_accounts WHERE code = '7300' LIMIT 1;
  SELECT id INTO v_fx_gain_id FROM chart_of_accounts WHERE code = '4930' LIMIT 1;

  IF v_debit_account_id IS NULL OR v_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post: required chart of accounts entries missing';
  END IF;

  v_rate := COALESCE(v_rv.exchange_rate, 1);
  IF v_rate <= 0 THEN v_rate := 1; END IF;

  -- If cross-currency receipt:
  -- v_rv.amount is in receipt currency, v_rv.bank_amount or v_rv.settlement_amount is actual bank receipt in IDR
  v_actual_received := COALESCE(v_rv.settlement_amount, v_rv.bank_amount, v_rv.amount * v_rate);
  v_carrying_ar := v_rv.amount * v_rate; -- Default carrying if standard IDR invoice

  -- If sales invoice has carrying rate:
  IF EXISTS (SELECT 1 FROM voucher_allocations va JOIN sales_invoices si ON si.id = va.sales_invoice_id WHERE va.receipt_voucher_id = p_rv_id) THEN
    -- In SAPJ ERP, sales_invoices are currently IDR.
    -- If allocated amount in IDR differs from actual bank receipt, difference is bank FX / spread
    SELECT 
      COALESCE(SUM(va.allocated_amount), v_carrying_ar)
    INTO v_carrying_ar
    FROM voucher_allocations va
    WHERE va.receipt_voucher_id = p_rv_id;
  END IF;

  -- Realized FX for Customer Receipt:
  -- Actual IDR Received - Carrying AR
  -- If > 0: Received MORE than carrying AR -> FX GAIN (Credit 4930)
  -- If < 0: Received LESS than carrying AR -> FX LOSS (Debit 7300)
  v_realized_fx := v_actual_received - v_carrying_ar;

  v_total_debit := v_actual_received + CASE WHEN v_realized_fx < 0 THEN abs(v_realized_fx) ELSE 0 END;
  v_total_credit := v_carrying_ar + CASE WHEN v_realized_fx > 0 THEN v_realized_fx ELSE 0 END;

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by,
    transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_je_number, v_rv.voucher_date, 'receipt', v_rv.id, v_rv.voucher_number,
    'Receipt Voucher: ' || v_rv.voucher_number,
    v_total_debit, v_total_credit, TRUE, v_actual_poster,
    COALESCE(v_rv.payment_currency, 'IDR'), 'IDR', v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1: Debit Bank/Cash with Actual IDR received
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line, v_debit_account_id, 'Cash Receipt - ' || v_rv.voucher_number, v_actual_received, 0, v_rv.customer_id);
  v_line := v_line + 1;

  -- Line 2: Debit FX Loss if Received Less than Carrying
  IF v_realized_fx < 0 AND v_fx_loss_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line, v_fx_loss_id, 'Realized FX loss - ' || v_rv.voucher_number, abs(v_realized_fx), 0, v_rv.customer_id);
    v_line := v_line + 1;
  END IF;

  -- Line 3: Credit AR with Carrying Value
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line, v_credit_account_id, 'Receipt - ' || v_rv.voucher_number, 0, v_carrying_ar, v_rv.customer_id);
  v_line := v_line + 1;

  -- Line 4: Credit FX Gain if Received More than Carrying
  IF v_realized_fx > 0 AND v_fx_gain_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line, v_fx_gain_id, 'Realized FX gain - ' || v_rv.voucher_number, 0, v_realized_fx, v_rv.customer_id);
    v_line := v_line + 1;
  END IF;

  UPDATE receipt_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_rv_id;

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'receipt_vouchers', p_rv_id, 'update',
    jsonb_build_object('is_posted', FALSE),
    jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', v_actual_poster),
    v_actual_poster
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated, service_role;
