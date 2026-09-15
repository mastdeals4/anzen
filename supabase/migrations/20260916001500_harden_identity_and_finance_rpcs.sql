-- ============================================================================
-- HARDEN SENSITIVE FINANCE, INVENTORY & IDENTITY RPCs
-- Migration: 20260916001500_harden_identity_and_finance_rpcs.sql
-- ============================================================================

-- 1. post_payment_voucher (finance role check + enforce auth.uid() as poster)
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  v_fx_delta numeric;
  v_ap_debit numeric;
  v_total numeric;
  v_entry text;
  v_je uuid;
  v_line integer := 1;
  v_ap uuid;
  v_bank uuid;
  v_charge uuid;
  v_pph uuid;
  v_fx uuid;
  v_invoice_currency text;
  v_bank_currency text;
  v_actual_poster uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := auth.uid();

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id=p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number; END IF;

  v_invoice_currency := upper(COALESCE(v_pv.invoice_currency, v_pv.transaction_currency, v_pv.payment_currency, 'IDR'));
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id=v_pv.bank_account_id;
  v_bank_currency := COALESCE(v_bank_currency, v_pv.bank_currency, v_pv.payment_currency, 'IDR');
  v_rate := CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE COALESCE(v_pv.exchange_rate, 0) END;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'Missing exchange rate for %', v_pv.voucher_number; END IF;

  v_gross := COALESCE(v_pv.invoice_amount, v_pv.amount, 0);
  v_payment := COALESCE(v_pv.payment_amount, v_gross - COALESCE(v_pv.pph_amount, 0));
  v_converted := COALESCE(v_pv.converted_amount, v_payment * v_rate);
  v_pph_bank := COALESCE(v_pv.pph_amount, 0) * v_rate;
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_converted + v_charge_amt);
  v_expected := v_converted + v_charge_amt;
  v_fx_delta := v_actual - v_expected;
  v_ap_debit := v_gross * v_rate;

  IF v_pv.coa_account_id IS NOT NULL THEN
    v_ap := v_pv.coa_account_id;
  ELSE
    SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  END IF;
  IF v_pv.payment_method = 'advance_adjustment' OR v_pv.payment_purpose = 'salary_advance' THEN
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

  v_total := v_ap_debit + v_charge_amt + GREATEST(v_fx_delta, 0);
  v_entry := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, posted_by)
  VALUES(v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number, 'Payment Voucher: ' || v_pv.voucher_number, v_total, v_total, true, v_actual_poster)
  RETURNING id INTO v_je;

  INSERT INTO public.journal_entry_lines(journal_entry_id, line_number, account_id, description, debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id)
  VALUES(v_je, v_line, v_ap, 'Payment - ' || v_pv.voucher_number, v_ap_debit, 0, v_invoice_currency, v_gross, 0, v_rate, v_pv.supplier_id); v_line := v_line + 1;
  IF v_charge_amt > 0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id, line_number, account_id, description, debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id)
    VALUES(v_je, v_line, v_charge, 'Bank Charge - ' || v_pv.voucher_number, v_charge_amt, 0, v_bank_currency, v_charge_amt, 0, 1, v_pv.supplier_id); v_line := v_line + 1;
  END IF;
  IF v_pph_bank > 0 AND v_pph IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id, line_number, account_id, description, debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id)
    VALUES(v_je, v_line, v_pph, 'PPh Withholding - ' || v_pv.voucher_number, 0, v_pph_bank, v_bank_currency, 0, v_pv.pph_amount, v_rate, v_pv.supplier_id); v_line := v_line + 1;
  END IF;
  INSERT INTO public.journal_entry_lines(journal_entry_id, line_number, account_id, description, debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id)
  VALUES(v_je, v_line, v_bank, CASE WHEN v_pv.payment_method='advance_adjustment' THEN 'Advance Adjustment - ' ELSE 'Bank Payment - ' END || v_pv.voucher_number, 0, v_actual, v_bank_currency, 0, v_actual, 1, v_pv.supplier_id); v_line := v_line + 1;
  IF v_fx_delta > 0 AND v_fx IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES(v_je, v_line, v_fx, 'FX loss - ' || v_pv.voucher_number, v_fx_delta, 0, v_pv.supplier_id);
  ELSIF v_fx_delta < 0 AND v_fx IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES(v_je, v_line, v_fx, 'FX gain - ' || v_pv.voucher_number, 0, abs(v_fx_delta), v_pv.supplier_id);
  END IF;
  UPDATE public.payment_vouchers SET is_posted=true, journal_entry_id=v_je WHERE id=p_pv_id;
  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$$;

-- 2. post_receipt_voucher (finance role check + enforce auth.uid() as poster)
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
  v_actual_poster      UUID;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := auth.uid();

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

  IF v_debit_account_id IS NULL OR v_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post: required chart of accounts entries missing';
  END IF;

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by
  ) VALUES (
    v_je_number, v_rv.voucher_date, 'receipt', v_rv.id, v_rv.voucher_number,
    'Receipt Voucher: ' || v_rv.voucher_number,
    v_rv.amount, v_rv.amount, TRUE, v_actual_poster
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_debit_account_id, 'Cash Receipt - ' || v_rv.voucher_number, v_rv.amount, 0, v_rv.customer_id);
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 2, v_credit_account_id, 'Receipt - ' || v_rv.voucher_number, 0, v_rv.amount, v_rv.customer_id);

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

-- 3. cancel_gl_posting (finance role check + enforce auth.uid() in audit)
CREATE OR REPLACE FUNCTION public.cancel_gl_posting(p_je_id uuid, p_doc_id uuid, p_table_name text, p_cancelled_by uuid, p_reason text, p_extra_audit jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_je            journal_entries%ROWTYPE;
  v_period_status TEXT;
  v_actor         UUID;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := auth.uid();

  SELECT * INTO v_je FROM journal_entries WHERE id = p_je_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry % not found', p_je_id;
  END IF;

  SELECT ap.status INTO v_period_status
  FROM accounting_periods ap
  WHERE ap.start_date <= v_je.entry_date AND ap.end_date >= v_je.entry_date
  ORDER BY ap.start_date DESC
  LIMIT 1;

  IF v_period_status IS NOT NULL AND v_period_status != 'open' THEN
    RAISE EXCEPTION
      'Cannot cancel posting: the accounting period for % is closed. Contact your finance manager to reopen the period.',
      TO_CHAR(v_je.entry_date, 'FMMonth YYYY');
  END IF;

  DELETE FROM journal_entry_lines WHERE journal_entry_id = p_je_id;
  DELETE FROM journal_entries      WHERE id              = p_je_id;

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    p_table_name, p_doc_id, 'update',
    p_extra_audit || jsonb_build_object(
      '_action',              'CANCEL_POSTING',
      'journal_entry_id',     p_je_id,
      'journal_entry_number', v_je.entry_number,
      'entry_date',           v_je.entry_date,
      'reason',               p_reason
    ),
    jsonb_build_object('cancelled_by', v_actor, 'cancelled_at', NOW()),
    v_actor
  );
END;
$$;

-- 4. save_payment_voucher_with_allocations (finance role check + enforce auth.uid() as creator)
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_allocations(
  p_voucher_id uuid DEFAULT NULL::uuid,
  p_voucher_number text DEFAULT NULL::text,
  p_voucher_date date DEFAULT NULL::date,
  p_supplier_id uuid DEFAULT NULL::uuid,
  p_payment_method text DEFAULT NULL::text,
  p_bank_account_id uuid DEFAULT NULL::uuid,
  p_reference_number text DEFAULT NULL::text,
  p_amount numeric DEFAULT 0,
  p_pph_amount numeric DEFAULT 0,
  p_pph_code_id uuid DEFAULT NULL::uuid,
  p_description text DEFAULT NULL::text,
  p_payment_currency text DEFAULT 'IDR'::text,
  p_exchange_rate numeric DEFAULT 1,
  p_bank_amount numeric DEFAULT NULL::numeric,
  p_bank_charge numeric DEFAULT 0,
  p_created_by uuid DEFAULT NULL::uuid,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_staff_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_voucher_id    UUID;
  v_alloc         JSONB;
  v_invoice_id    UUID;
  v_expense_id    UUID;
  v_alloc_amount  NUMERIC;
  v_creator       UUID;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_creator := auth.uid();

  IF p_supplier_id IS NULL AND p_staff_id IS NULL THEN
    RAISE EXCEPTION 'Payment voucher needs a payee: supplier or staff';
  END IF;

  IF p_voucher_id IS NULL THEN
    INSERT INTO payment_vouchers (
      voucher_number, voucher_date, supplier_id, staff_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate,
      bank_amount, bank_charge, created_by
    ) VALUES (
      p_voucher_number, p_voucher_date, p_supplier_id, p_staff_id, p_payment_method,
      p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
      p_description, p_payment_currency, p_exchange_rate,
      p_bank_amount, p_bank_charge, v_creator
    ) RETURNING id INTO v_voucher_id;
  ELSE
    v_voucher_id := p_voucher_id;

    IF EXISTS (SELECT 1 FROM payment_vouchers WHERE id = v_voucher_id AND is_posted = TRUE) THEN
      RAISE EXCEPTION 'Cannot edit: % is posted. Cancel Posting first to make changes.', p_voucher_number;
    END IF;

    UPDATE payment_vouchers SET
      voucher_date      = p_voucher_date,
      supplier_id       = p_supplier_id,
      staff_id          = p_staff_id,
      payment_method    = p_payment_method,
      bank_account_id   = p_bank_account_id,
      reference_number  = p_reference_number,
      amount            = p_amount,
      pph_amount        = p_pph_amount,
      pph_code_id       = p_pph_code_id,
      description       = p_description,
      payment_currency  = p_payment_currency,
      exchange_rate     = p_exchange_rate,
      bank_amount       = p_bank_amount,
      bank_charge       = p_bank_charge,
      updated_at        = NOW()
    WHERE id = v_voucher_id;
  END IF;

  DELETE FROM voucher_allocations WHERE payment_voucher_id = v_voucher_id;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) AS value
  LOOP
    v_alloc_amount := COALESCE((v_alloc->>'amount')::NUMERIC, 0);
    IF v_alloc_amount <= 0 THEN
      CONTINUE;
    END IF;

    v_invoice_id := NULLIF(v_alloc->>'invoice_id', '')::UUID;
    v_expense_id := NULLIF(v_alloc->>'finance_expense_id', '')::UUID;

    IF v_invoice_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, purchase_invoice_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id, v_invoice_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
      );
    ELSIF v_expense_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, finance_expense_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id, v_expense_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
      );
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$$;

-- 5. create_fund_transfer_with_posting (finance role check + enforce auth.uid() as creator)
CREATE OR REPLACE FUNCTION public.create_fund_transfer_with_posting(
  p_transfer_date date,
  p_from_amount numeric,
  p_to_amount numeric,
  p_from_account_type text,
  p_to_account_type text,
  p_description text DEFAULT NULL::text,
  p_from_bank_account_id uuid DEFAULT NULL::uuid,
  p_to_bank_account_id uuid DEFAULT NULL::uuid,
  p_from_bank_statement_line_id uuid DEFAULT NULL::uuid,
  p_to_bank_statement_line_id uuid DEFAULT NULL::uuid,
  p_exchange_rate numeric DEFAULT NULL::numeric,
  p_created_by uuid DEFAULT NULL::uuid
)
RETURNS fund_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_transfer_number text;
  v_transfer public.fund_transfers;
  v_source_account_name text;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_user_id := auth.uid();

  v_transfer_number := public.generate_fund_transfer_number();

  INSERT INTO public.fund_transfers (
    transfer_number,
    transfer_date,
    amount,
    from_amount,
    to_amount,
    exchange_rate,
    from_account_type,
    to_account_type,
    from_bank_account_id,
    to_bank_account_id,
    from_bank_statement_line_id,
    to_bank_statement_line_id,
    description,
    created_by
  ) VALUES (
    v_transfer_number,
    p_transfer_date,
    p_from_amount,
    p_from_amount,
    p_to_amount,
    p_exchange_rate,
    p_from_account_type,
    p_to_account_type,
    CASE WHEN p_from_account_type = 'bank' THEN p_from_bank_account_id ELSE NULL END,
    CASE WHEN p_to_account_type = 'bank' THEN p_to_bank_account_id ELSE NULL END,
    p_from_bank_statement_line_id,
    p_to_bank_statement_line_id,
    NULLIF(p_description, ''),
    v_user_id
  )
  RETURNING * INTO v_transfer;

  IF v_transfer.to_account_type = 'petty_cash' THEN
    IF v_transfer.from_account_type = 'bank' THEN
      SELECT COALESCE(ba.alias, ba.bank_name, 'Bank')
        INTO v_source_account_name
      FROM public.bank_accounts ba
      WHERE ba.id = v_transfer.from_bank_account_id;
    ELSE
      v_source_account_name := 'Cash on Hand';
    END IF;

    INSERT INTO public.petty_cash_transactions (
      transaction_date,
      transaction_type,
      amount,
      description,
      bank_account_id,
      bank_statement_line_id,
      source,
      fund_transfer_id,
      approval_status,
      created_by
    ) VALUES (
      v_transfer.transfer_date,
      'withdraw',
      v_transfer.to_amount,
      COALESCE(v_transfer.description, 'Fund transfer from ' || COALESCE(v_source_account_name, 'Bank')),
      v_transfer.from_bank_account_id,
      v_transfer.from_bank_statement_line_id,
      'Fund Transfer ' || v_transfer.transfer_number,
      v_transfer.id,
      'approved',
      v_user_id
    )
    ON CONFLICT (fund_transfer_id) WHERE fund_transfer_id IS NOT NULL DO NOTHING;
  END IF;

  RETURN v_transfer;
END;
$$;

-- 6. post_fund_transfer_journal (enforce auth.uid() as creator)
CREATE OR REPLACE FUNCTION public.post_fund_transfer_journal(p_transfer_id uuid, p_user_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transfer        RECORD;
  v_journal_id      UUID;
  v_from_account_id UUID;
  v_to_account_id   UUID;
  v_description     TEXT;
  v_actor           UUID;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := auth.uid();

  SELECT * INTO v_transfer FROM fund_transfers WHERE id = p_transfer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fund transfer not found'; END IF;
  IF v_transfer.journal_entry_id IS NOT NULL THEN RETURN v_transfer.journal_entry_id; END IF;

  SELECT id INTO v_journal_id FROM journal_entries
  WHERE reference_number = v_transfer.transfer_number AND source_module = 'fund_transfers'
  ORDER BY created_at DESC LIMIT 1;
  IF v_journal_id IS NOT NULL THEN
    UPDATE fund_transfers SET journal_entry_id = v_journal_id WHERE id = p_transfer_id;
    RETURN v_journal_id;
  END IF;

  IF    v_transfer.from_account_type = 'petty_cash'   THEN SELECT id INTO v_from_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN SELECT id INTO v_from_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF v_transfer.from_account_type = 'bank'         THEN SELECT coa_id INTO v_from_account_id FROM bank_accounts WHERE id = v_transfer.from_bank_account_id;
  END IF;

  IF    v_transfer.to_account_type = 'petty_cash'   THEN SELECT id INTO v_to_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN SELECT id INTO v_to_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF v_transfer.to_account_type = 'bank'         THEN SELECT coa_id INTO v_to_account_id FROM bank_accounts WHERE id = v_transfer.to_bank_account_id;
  END IF;

  IF v_from_account_id IS NULL OR v_to_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot determine chart of accounts for transfer';
  END IF;

  v_description := 'Fund Transfer ' || v_transfer.transfer_number;
  IF v_transfer.description IS NOT NULL THEN
    v_description := v_description || ' - ' || v_transfer.description;
  END IF;

  INSERT INTO journal_entries (
    entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, created_by
  ) VALUES (
    v_transfer.transfer_date, 'fund_transfers', v_transfer.id, v_transfer.transfer_number,
    v_description, 0, 0, true, v_actor
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES
    (v_journal_id, v_to_account_id,   v_transfer.amount, 0,                  'Transfer In'),
    (v_journal_id, v_from_account_id, 0,                  v_transfer.amount, 'Transfer Out');

  UPDATE fund_transfers SET journal_entry_id = v_journal_id WHERE id = p_transfer_id;
  RETURN v_journal_id;
END;
$$;

-- 7. move_expense_to_petty_cash (enforce auth.uid() as creator)
CREATE OR REPLACE FUNCTION public.move_expense_to_petty_cash(p_expense_id uuid, p_user_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense          RECORD;
  v_pc_number        TEXT;
  v_petty_cash_tx_id UUID;
  v_actor            UUID;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := auth.uid();

  SELECT * INTO v_expense FROM finance_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_expense.petty_cash_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'Expense already linked to petty cash';
  END IF;

  SELECT 'PC-' || TO_CHAR(v_expense.expense_date, 'YYYYMMDD') || '-' ||
    LPAD((COUNT(*) + 1)::TEXT, 4, '0')
  INTO v_pc_number FROM petty_cash_transactions WHERE transaction_date = v_expense.expense_date;

  INSERT INTO petty_cash_transactions (
    transaction_number, transaction_date, transaction_type, amount, description,
    expense_category, bank_account_id, created_by, source, paid_to, paid_by, finance_expense_id
  ) VALUES (
    v_pc_number, v_expense.expense_date, 'expense', v_expense.amount, v_expense.description,
    v_expense.expense_category, v_expense.bank_account_id, v_actor,
    'moved_from_tracker', v_expense.description, 'cash', v_expense.id
  ) RETURNING id INTO v_petty_cash_tx_id;

  UPDATE finance_expenses
  SET petty_cash_transaction_id = v_petty_cash_tx_id, payment_method = 'cash', paid_by = 'cash'
  WHERE id = p_expense_id;

  RETURN v_petty_cash_tx_id;
END;
$$;

-- 8. move_expense_to_tracker (enforce auth.uid() as creator)
CREATE OR REPLACE FUNCTION public.move_expense_to_tracker(p_petty_cash_id uuid, p_bank_account_id uuid, p_payment_method text, p_user_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pc_tx            RECORD;
  v_expense_id       UUID;
  v_finance_category TEXT;
  v_actor            UUID;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := auth.uid();

  SELECT * INTO v_pc_tx FROM petty_cash_transactions
  WHERE id = p_petty_cash_id AND transaction_type = 'expense';
  IF NOT FOUND THEN RAISE EXCEPTION 'Petty cash expense not found'; END IF;

  IF v_pc_tx.finance_expense_id IS NOT NULL THEN
    UPDATE finance_expenses
    SET payment_method = p_payment_method, bank_account_id = p_bank_account_id, paid_by = 'bank'
    WHERE id = v_pc_tx.finance_expense_id RETURNING id INTO v_expense_id;
    RETURN v_expense_id;
  END IF;

  v_finance_category := CASE
    WHEN v_pc_tx.expense_category IN ('Office Supplies','Postage & Courier','Cleaning & Maintenance','Miscellaneous') THEN 'office_admin'
    WHEN v_pc_tx.expense_category = 'Transportation' THEN 'delivery_sales'
    WHEN v_pc_tx.expense_category = 'Utilities'      THEN 'utilities'
    ELSE 'other'
  END;

  INSERT INTO finance_expenses (
    expense_category, expense_type, amount, expense_date, description,
    payment_method, bank_account_id, paid_by, created_by, petty_cash_transaction_id
  ) VALUES (
    v_finance_category, 'admin', v_pc_tx.amount, v_pc_tx.transaction_date,
    v_pc_tx.description || ' (Moved from Petty Cash: ' || v_pc_tx.transaction_number || ')',
    p_payment_method, p_bank_account_id, 'bank', v_actor, v_pc_tx.id
  ) RETURNING id INTO v_expense_id;

  UPDATE petty_cash_transactions
  SET finance_expense_id = v_expense_id, source = 'moved_to_tracker'
  WHERE id = p_petty_cash_id;

  RETURN v_expense_id;
END;
$$;

-- 9. lock_import_container (enforce auth.uid() as locked_by)
CREATE OR REPLACE FUNCTION public.lock_import_container(p_container_id uuid, p_user_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._sec_check_finance_role();

  UPDATE import_containers
  SET status = 'locked', locked_at = now(), locked_by = auth.uid(), updated_at = now()
  WHERE id = p_container_id AND status = 'allocated';
  IF NOT FOUND THEN RAISE EXCEPTION 'Container not found or already locked'; END IF;

  UPDATE batches SET cost_locked = true, cost_locked_at = now(), updated_at = now()
  WHERE import_container_id = p_container_id AND cost_locked = false;

  RETURN true;
END;
$$;

-- 10. post_inventory_movement (role authorization check)
CREATE OR REPLACE FUNCTION public.post_inventory_movement(
  p_operation_id uuid,
  p_product_id uuid,
  p_batch_id uuid,
  p_transaction_type text,
  p_quantity numeric,
  p_transaction_date date DEFAULT CURRENT_DATE,
  p_reference_number text DEFAULT NULL::text,
  p_reference_type text DEFAULT NULL::text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_created_by uuid DEFAULT NULL::uuid,
  p_stock_before numeric DEFAULT NULL::numeric,
  p_stock_after numeric DEFAULT NULL::numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.inventory_transactions%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_transaction_id uuid;
  v_new_stock numeric;
  v_previous_context text;
  v_creator uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse']) THEN
      RAISE EXCEPTION 'Permission denied for inventory movement';
    END IF;
  END IF;

  v_creator := COALESCE(auth.uid(), p_created_by);

  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Canonical inventory posting requires operation_id';
  END IF;
  IF p_batch_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'Canonical inventory posting requires product_id and batch_id';
  END IF;
  IF COALESCE(p_quantity, 0) = 0 THEN
    RAISE EXCEPTION 'Canonical inventory posting quantity cannot be zero';
  END IF;
  IF p_transaction_type NOT IN (
    'purchase', 'delivery_challan', 'return', 'adjustment', 'rejection'
  ) THEN
    RAISE EXCEPTION 'Unsupported canonical inventory transaction type: %',
      p_transaction_type;
  END IF;

  SELECT *
  INTO v_existing
  FROM public.inventory_transactions
  WHERE operation_id = p_operation_id;

  IF FOUND THEN
    IF v_existing.batch_id IS DISTINCT FROM p_batch_id
       OR v_existing.product_id IS DISTINCT FROM p_product_id
       OR v_existing.transaction_type IS DISTINCT FROM p_transaction_type
       OR v_existing.quantity IS DISTINCT FROM p_quantity
       OR v_existing.reference_type IS DISTINCT FROM p_reference_type
       OR v_existing.reference_id IS DISTINCT FROM p_reference_id THEN
      RAISE EXCEPTION 'operation_id % was already used with different inventory values',
        p_operation_id;
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT *
  INTO v_batch
  FROM public.batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found: %', p_batch_id;
  END IF;
  IF v_batch.product_id IS DISTINCT FROM p_product_id THEN
    RAISE EXCEPTION 'Product % does not match batch % product %',
      p_product_id, p_batch_id, v_batch.product_id;
  END IF;

  IF p_transaction_type IN ('purchase', 'return') AND p_quantity <= 0 THEN
    RAISE EXCEPTION '% movement must be positive', p_transaction_type;
  END IF;
  IF p_transaction_type IN ('delivery_challan', 'rejection') AND p_quantity >= 0 THEN
    RAISE EXCEPTION '% movement must be negative', p_transaction_type;
  END IF;
  IF p_transaction_type = 'delivery_challan'
     AND v_batch.expiry_date IS NOT NULL
     AND v_batch.expiry_date <= COALESCE(p_transaction_date, CURRENT_DATE) THEN
    RAISE EXCEPTION 'Expired batch % cannot be delivered (expiry %)',
      v_batch.batch_number, v_batch.expiry_date;
  END IF;
  IF p_transaction_type = 'purchase'
     AND EXISTS (
       SELECT 1
       FROM public.inventory_transactions it
       WHERE it.batch_id = p_batch_id
         AND it.transaction_type = 'purchase'
     ) THEN
    RAISE EXCEPTION 'Batch % already has a Batch Creation movement',
      v_batch.batch_number;
  END IF;

  v_new_stock := v_batch.current_stock + p_quantity;
  IF v_new_stock < 0 THEN
    RAISE EXCEPTION 'Insufficient stock in batch %: current %, movement %, result %',
      v_batch.batch_number, v_batch.current_stock, p_quantity, v_new_stock;
  END IF;

  IF p_stock_before IS NOT NULL
     AND p_stock_before IS DISTINCT FROM v_batch.current_stock THEN
    RAISE EXCEPTION 'Stale stock_before for batch %: expected %, received %',
      v_batch.batch_number, v_batch.current_stock, p_stock_before;
  END IF;
  IF p_stock_after IS NOT NULL
     AND p_stock_after IS DISTINCT FROM v_new_stock THEN
    RAISE EXCEPTION 'Invalid stock_after for batch %: expected %, received %',
      v_batch.batch_number, v_new_stock, p_stock_after;
  END IF;

  v_previous_context := current_setting('app.canonical_stock_engine', true);
  PERFORM set_config('app.canonical_stock_engine', 'on', true);

  UPDATE public.batches
  SET current_stock = v_new_stock,
      updated_at = now()
  WHERE id = p_batch_id;

  INSERT INTO public.inventory_transactions (
    operation_id,
    product_id,
    batch_id,
    transaction_type,
    quantity,
    transaction_date,
    reference_number,
    reference_type,
    reference_id,
    notes,
    created_by,
    stock_before,
    stock_after,
    metadata
  )
  VALUES (
    p_operation_id,
    p_product_id,
    p_batch_id,
    p_transaction_type,
    p_quantity,
    COALESCE(p_transaction_date, CURRENT_DATE),
    p_reference_number,
    p_reference_type,
    p_reference_id,
    p_notes,
    v_creator,
    v_batch.current_stock,
    v_new_stock,
    jsonb_build_object(
      'canonical_engine_version', '1.0',
      'canonical_posted_at', clock_timestamp()
    )
  )
  RETURNING id INTO v_transaction_id;

  PERFORM set_config(
    'app.canonical_stock_engine',
    COALESCE(v_previous_context, ''),
    true
  );

  RETURN v_transaction_id;
END;
$$;

-- 11. save_purchase_invoice_with_receiving_details (role authorization check)
CREATE OR REPLACE FUNCTION public.save_purchase_invoice_with_receiving_details(p_invoice_id uuid, p_purchase_order_id uuid, p_invoice_data jsonb, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_data jsonb := coalesce(p_invoice_data, '{}'::jsonb);
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_old public.purchase_invoice_items%rowtype;
  v_po uuid;
  v_result jsonb;
  v_id uuid;
  v_rate numeric;
  v_ccy text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'warehouse')
    ) THEN
      RAISE EXCEPTION 'Permission denied for purchase invoice receiving';
    END IF;
  END IF;

  IF p_invoice_id IS NOT NULL AND nullif(v_data->>'purchase_order_id', '') IS NULL THEN
    SELECT purchase_order_id INTO v_po FROM purchase_invoices WHERE id = p_invoice_id;
    IF v_po IS NOT NULL THEN v_data := jsonb_set(v_data, '{purchase_order_id}', to_jsonb(v_po), true); END IF;
  ELSIF p_invoice_id IS NULL AND p_purchase_order_id IS NOT NULL AND nullif(v_data->>'purchase_order_id', '') IS NULL THEN
    v_data := jsonb_set(v_data, '{purchase_order_id}', to_jsonb(p_purchase_order_id), true);
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) LOOP
    IF p_invoice_id IS NOT NULL AND nullif(v_item->>'id', '') IS NOT NULL THEN
      SELECT * INTO v_old FROM purchase_invoice_items WHERE id = (v_item->>'id')::uuid AND purchase_invoice_id = p_invoice_id;
      IF FOUND THEN
        IF nullif(v_item->>'purchase_order_item_id', '') IS NULL AND v_old.purchase_order_item_id IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{purchase_order_item_id}', to_jsonb(v_old.purchase_order_item_id), true);
        END IF;
        IF nullif(v_item->>'receiving_make_id', '') IS NULL AND v_old.receiving_make_id IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_make_id}', to_jsonb(v_old.receiving_make_id), true);
        END IF;
        IF nullif(v_item->>'receiving_batch_number', '') IS NULL AND v_old.receiving_batch_number IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_batch_number}', to_jsonb(v_old.receiving_batch_number), true);
        END IF;
        IF nullif(v_item->>'receiving_expiry_date', '') IS NULL AND v_old.receiving_expiry_date IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_expiry_date}', to_jsonb(v_old.receiving_expiry_date), true);
        END IF;
        IF nullif(v_item->>'receiving_import_container_id', '') IS NULL AND v_old.receiving_import_container_id IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_import_container_id}', to_jsonb(v_old.receiving_import_container_id), true);
        END IF;
        IF nullif(v_item->>'receiving_notes', '') IS NULL AND v_old.receiving_notes IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_notes}', to_jsonb(v_old.receiving_notes), true);
        END IF;
      END IF;
    END IF;
    v_items := v_items || jsonb_build_array(v_item);
  END LOOP;

  v_result := CASE
    WHEN p_invoice_id IS NOT NULL THEN save_purchase_invoice(p_invoice_id, v_data, v_items)
    WHEN p_purchase_order_id IS NOT NULL THEN create_purchase_invoice_from_po(p_purchase_order_id, v_data, v_items)
    ELSE save_purchase_invoice(NULL, v_data, v_items)
  END;

  v_id := (v_result->>'invoice_id')::uuid;
  SELECT upper(currency), exchange_rate INTO v_ccy, v_rate FROM purchase_invoices WHERE id = v_id;
  RETURN v_result;
END;
$$;
