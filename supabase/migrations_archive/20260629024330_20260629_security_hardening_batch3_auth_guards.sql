-- ============================================================
-- Security Hardening Batch 3 – add auth.uid() guards on all
-- SECURITY DEFINER functions that anon can still execute.
-- Each function is recreated with an unauthenticated-caller
-- check at the very top of the body.
-- ============================================================

-- Helper: revoke anon for all affected functions up-front
REVOKE EXECUTE ON FUNCTION public.cancel_expense_posting(uuid, uuid, text)                    FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_gl_posting(uuid, uuid, text, uuid, text, jsonb)      FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_payment_voucher_posting(uuid, uuid, text)            FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_petty_cash_posting(uuid, uuid, text)                 FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_receipt_voucher_posting(uuid, uuid, text)            FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_payment_voucher_with_allocations(uuid)               FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_reporting_usd_rate()                                    FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date)                                     FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date, numeric)                            FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_trial_balance(date, date)                               FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_trial_balance(date, date, numeric)                      FROM anon;
REVOKE EXECUTE ON FUNCTION public.post_expense_to_journal()                                   FROM anon;
REVOKE EXECUTE ON FUNCTION public.post_payment_voucher(uuid, uuid)                            FROM anon;
REVOKE EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid)                            FROM anon;
REVOKE EXECUTE ON FUNCTION public.save_payment_voucher_with_allocations(uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text, text, numeric, numeric, numeric, uuid, jsonb) FROM anon;

-- ============================================================
-- Recreate each function with an auth guard at the top.
-- We use CREATE OR REPLACE so signatures and grants are
-- preserved for the authenticated role.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_expense_posting(
  p_exp_id       uuid,
  p_cancelled_by uuid,
  p_reason       text DEFAULT 'Posting cancelled by administrator'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exp RECORD;
  v_je  RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_exp FROM finance_expenses WHERE id = p_exp_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense % not found', p_exp_id; END IF;
  IF v_exp.approval_status != 'approved' THEN
    RAISE EXCEPTION 'Cannot cancel posting: expense % is not approved (current: %)',
      p_exp_id, v_exp.approval_status;
  END IF;

  SELECT * INTO v_je FROM journal_entries
  WHERE source_module IN ('expense', 'expenses')
    AND (reference_id = p_exp_id OR reference_number = 'EXP-' || p_exp_id::text)
  ORDER BY created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for expense %', p_exp_id;
  END IF;

  PERFORM cancel_gl_posting(
    v_je.id, p_exp_id, 'finance_expenses', p_cancelled_by, p_reason,
    jsonb_build_object(
      'amount',           v_exp.amount,
      'expense_category', v_exp.expense_category,
      'expense_date',     v_exp.expense_date,
      'approval_status',  'approved'
    )
  );

  UPDATE finance_expenses
  SET approval_status = 'pending_approval', approved_by = NULL, approved_at = NULL
  WHERE id = p_exp_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_gl_posting(
  p_je_id        uuid,
  p_doc_id       uuid,
  p_table_name   text,
  p_cancelled_by uuid,
  p_reason       text,
  p_extra_audit  jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je            journal_entries%ROWTYPE;
  v_period_status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

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
    jsonb_build_object('cancelled_by', p_cancelled_by, 'cancelled_at', NOW()),
    p_cancelled_by
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_payment_voucher_posting(
  p_pv_id        uuid,
  p_cancelled_by uuid,
  p_reason       text DEFAULT 'Posting cancelled by administrator'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pv RECORD;
  v_je RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_pv FROM payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF NOT v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is not posted', COALESCE(v_pv.voucher_number, p_pv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = v_pv.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for payment voucher %', v_pv.voucher_number;
  END IF;

  PERFORM cancel_gl_posting(
    v_je.id, p_pv_id, 'payment_vouchers', p_cancelled_by, p_reason,
    jsonb_build_object(
      'voucher_number', v_pv.voucher_number,
      'amount',         v_pv.amount,
      'is_posted',      TRUE
    )
  );

  UPDATE payment_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_pv_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_petty_cash_posting(
  p_pct_id       uuid,
  p_cancelled_by uuid,
  p_reason       text DEFAULT 'Posting cancelled by administrator'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pct RECORD;
  v_je  RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_pct FROM petty_cash_transactions WHERE id = p_pct_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Petty cash transaction % not found', p_pct_id;
  END IF;
  IF v_pct.approval_status != 'approved' THEN
    RAISE EXCEPTION 'Cannot cancel posting: transaction % is not approved (current: %)',
      COALESCE(v_pct.transaction_number, p_pct_id::TEXT), v_pct.approval_status;
  END IF;

  SELECT * INTO v_je FROM journal_entries
  WHERE reference_id = p_pct_id AND source_module = 'petty_cash'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for %',
      COALESCE(v_pct.transaction_number, p_pct_id::TEXT);
  END IF;

  PERFORM cancel_gl_posting(
    v_je.id, p_pct_id, 'petty_cash_transactions', p_cancelled_by, p_reason,
    jsonb_build_object(
      'transaction_number', v_pct.transaction_number,
      'amount',             v_pct.amount,
      'approval_status',    'approved'
    )
  );

  UPDATE petty_cash_transactions
  SET approval_status = 'pending_approval', approved_by = NULL, approved_at = NULL
  WHERE id = p_pct_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_receipt_voucher_posting(
  p_rv_id        uuid,
  p_cancelled_by uuid,
  p_reason       text DEFAULT 'Posting cancelled by administrator'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rv RECORD;
  v_je RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_rv FROM receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF NOT v_rv.is_posted THEN
    RAISE EXCEPTION 'Receipt voucher % is not posted', COALESCE(v_rv.voucher_number, p_rv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = v_rv.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for receipt voucher %', v_rv.voucher_number;
  END IF;

  PERFORM cancel_gl_posting(
    v_je.id, p_rv_id, 'receipt_vouchers', p_cancelled_by, p_reason,
    jsonb_build_object(
      'voucher_number', v_rv.voucher_number,
      'amount',         v_rv.amount,
      'is_posted',      TRUE
    )
  );

  UPDATE receipt_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_rv_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_payment_voucher_with_allocations(
  p_voucher_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_je_id UUID; v_is_posted BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT journal_entry_id, is_posted INTO v_je_id, v_is_posted
  FROM payment_vouchers WHERE id = p_voucher_id;

  IF v_is_posted THEN
    RAISE EXCEPTION 'Cannot delete: payment voucher is posted. Cancel Posting first.';
  END IF;

  DELETE FROM voucher_allocations WHERE payment_voucher_id = p_voucher_id;
  DELETE FROM payment_vouchers    WHERE id = p_voucher_id;

  IF v_je_id IS NOT NULL THEN
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
    DELETE FROM journal_entries      WHERE id = v_je_id;
  END IF;
END;
$$;

-- get_reporting_usd_rate is SQL (lang=14) – recreate as plpgsql with guard
CREATE OR REPLACE FUNCTION public.get_reporting_usd_rate()
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN (
    SELECT COALESCE(
      (SELECT exchange_rate FROM payment_vouchers
        WHERE exchange_rate > 1.5
        ORDER BY voucher_date DESC, created_at DESC LIMIT 1),
      (SELECT exchange_rate FROM purchase_invoices
        WHERE currency = 'USD' AND exchange_rate > 1.5
        ORDER BY invoice_date DESC LIMIT 1),
      (SELECT exchange_rate_usd_to_idr FROM batches
        WHERE exchange_rate_usd_to_idr > 1.5
        ORDER BY created_at DESC LIMIT 1),
      16000::NUMERIC
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.post_payment_voucher(
  p_pv_id     uuid,
  p_posted_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pv                RECORD;
  v_je_id             UUID;
  v_je_number         TEXT;
  v_credit_account_id UUID;
  v_debit_account_id  UUID;
  v_pph_account_id    UUID;
  v_net_amount        NUMERIC;
  v_line_num          INT := 1;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_pv FROM payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number; END IF;

  IF v_pv.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_credit_account_id FROM bank_accounts WHERE id = v_pv.bank_account_id;
  ELSIF v_pv.payment_method = 'cash' THEN
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_credit_account_id IS NULL THEN
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  IF v_pv.coa_account_id IS NOT NULL THEN
    v_debit_account_id := v_pv.coa_account_id;
  ELSE
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  END IF;

  SELECT id INTO v_pph_account_id FROM chart_of_accounts WHERE code = '2132' LIMIT 1;

  IF v_credit_account_id IS NULL OR v_debit_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post: required chart of accounts entries missing';
  END IF;

  v_net_amount := v_pv.amount - COALESCE(v_pv.pph_amount, 0);
  v_je_number  := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by
  ) VALUES (
    v_je_number, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher: ' || v_pv.voucher_number,
    v_pv.amount, v_pv.amount, TRUE, p_posted_by
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
  VALUES (v_je_id, v_line_num, v_debit_account_id, 'Payment - ' || v_pv.voucher_number, v_pv.amount, 0, v_pv.supplier_id);
  v_line_num := v_line_num + 1;

  IF COALESCE(v_pv.pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, v_line_num, v_pph_account_id, 'PPh Withholding - ' || v_pv.voucher_number, 0, v_pv.pph_amount, v_pv.supplier_id);
    v_line_num := v_line_num + 1;
  END IF;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
  VALUES (v_je_id, v_line_num, v_credit_account_id, 'Cash Payment - ' || v_pv.voucher_number, 0, v_net_amount, v_pv.supplier_id);

  UPDATE payment_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_pv_id;

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'payment_vouchers', p_pv_id, 'update',
    jsonb_build_object('is_posted', FALSE),
    jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', p_posted_by),
    p_posted_by
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.post_receipt_voucher(
  p_rv_id     uuid,
  p_posted_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_debit_account_id   UUID;
  v_credit_account_id  UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

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
    v_rv.amount, v_rv.amount, TRUE, p_posted_by
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
    jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', p_posted_by),
    p_posted_by
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_allocations(
  p_voucher_id        uuid,
  p_voucher_number    text,
  p_voucher_date      date,
  p_supplier_id       uuid,
  p_payment_method    text,
  p_bank_account_id   uuid,
  p_reference_number  text,
  p_amount            numeric,
  p_pph_amount        numeric,
  p_pph_code_id       uuid,
  p_description       text,
  p_payment_currency  text,
  p_exchange_rate     numeric,
  p_bank_amount       numeric,
  p_bank_charge       numeric,
  p_created_by        uuid,
  p_allocations       jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_voucher_id UUID;
  v_alloc      JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_voucher_id IS NULL THEN
    INSERT INTO payment_vouchers (
      voucher_number, voucher_date, supplier_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate,
      bank_amount, bank_charge, created_by
    ) VALUES (
      p_voucher_number, p_voucher_date, p_supplier_id, p_payment_method,
      p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
      p_description, p_payment_currency, p_exchange_rate,
      p_bank_amount, p_bank_charge, p_created_by
    ) RETURNING id INTO v_voucher_id;
  ELSE
    v_voucher_id := p_voucher_id;

    IF EXISTS (SELECT 1 FROM payment_vouchers WHERE id = v_voucher_id AND is_posted = TRUE) THEN
      RAISE EXCEPTION 'Cannot edit: % is posted. Cancel Posting first to make changes.', p_voucher_number;
    END IF;

    UPDATE payment_vouchers SET
      voucher_date     = p_voucher_date,
      supplier_id      = p_supplier_id,
      payment_method   = p_payment_method,
      bank_account_id  = p_bank_account_id,
      reference_number = p_reference_number,
      amount           = p_amount,
      pph_amount       = p_pph_amount,
      pph_code_id      = p_pph_code_id,
      description      = p_description,
      payment_currency = p_payment_currency,
      exchange_rate    = p_exchange_rate,
      bank_amount      = p_bank_amount,
      bank_charge      = p_bank_charge,
      updated_at       = NOW()
    WHERE id = v_voucher_id;
  END IF;

  DELETE FROM voucher_allocations WHERE payment_voucher_id = v_voucher_id;
  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) AS value
  LOOP
    IF (v_alloc->>'amount')::NUMERIC > 0 THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, purchase_invoice_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id,
        (v_alloc->>'invoice_id')::UUID,
        (v_alloc->>'amount')::NUMERIC,
        COALESCE(v_alloc->>'currency', 'IDR'),
        'payment'
      );
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$$;

-- get_balance_sheet (two overloads) – add auth guard

CREATE OR REPLACE FUNCTION public.get_balance_sheet(p_as_of_date date)
RETURNS TABLE(
  code            varchar, name varchar, name_id varchar,
  account_type    varchar, account_group varchar, normal_balance varchar,
  total_debit     numeric, total_credit numeric, balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_net_income NUMERIC;
  v_has_3300   BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'expense' THEN -(jel.debit - jel.credit)
      ELSE 0
    END
  ), 0) INTO v_net_income
  FROM journal_entry_lines jel
  JOIN journal_entries     je  ON je.id  = jel.journal_entry_id
  JOIN chart_of_accounts   coa ON coa.id = jel.account_id
  WHERE je.is_posted              = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date            <= p_as_of_date
    AND coa.is_header             = false;

  SELECT EXISTS (
    SELECT 1
    FROM journal_entry_lines jel
    JOIN journal_entries   je  ON je.id  = jel.journal_entry_id
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code           = '3300'
      AND je.is_posted        = true
      AND je.entry_date      <= p_as_of_date
  ) INTO v_has_3300;

  RETURN QUERY
  SELECT
    coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
    )                                                          AS normal_balance,
    COALESCE(SUM(jel.debit),  0)::NUMERIC                     AS total_debit,
    COALESCE(SUM(jel.credit), 0)::NUMERIC                     AS total_credit,
    (COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0))::NUMERIC AS balance
  FROM chart_of_accounts      coa
  LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
  LEFT JOIN journal_entries      je  ON jel.journal_entry_id = je.id
    AND je.is_posted              = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date            <= p_as_of_date
  WHERE coa.is_header  = false
    AND coa.is_active   = true
    AND coa.account_type IN ('asset','liability','equity','contra')
  GROUP BY coa.id, coa.code, coa.name, coa.name_id,
           coa.account_type, coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(jel.debit), 0) != 0
      OR COALESCE(SUM(jel.credit), 0) != 0

  UNION ALL

  SELECT
    '3300'::VARCHAR, 'Current Year Earnings'::VARCHAR,
    'Laba/Rugi Tahun Berjalan'::VARCHAR, 'equity'::VARCHAR,
    'Equity'::VARCHAR, 'credit'::VARCHAR,
    CASE WHEN v_net_income < 0 THEN ABS(v_net_income) ELSE 0 END,
    CASE WHEN v_net_income > 0 THEN v_net_income      ELSE 0 END,
    (-v_net_income)::NUMERIC
  WHERE NOT v_has_3300
    AND ABS(v_net_income) > 0.005

  ORDER BY 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_balance_sheet(p_as_of_date date, p_usd_rate numeric DEFAULT 1)
RETURNS TABLE(
  code            varchar, name varchar, name_id varchar,
  account_type    varchar, account_group varchar, normal_balance varchar,
  total_debit     numeric, total_credit numeric, balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_net_income NUMERIC;
  v_has_3300   BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN
        CASE WHEN fx.je_currency = 'USD'
             THEN (jel.credit - jel.debit) * p_usd_rate
             ELSE  jel.credit - jel.debit  END
      WHEN coa.account_type = 'expense' THEN
        CASE WHEN fx.je_currency = 'USD'
             THEN -(jel.debit - jel.credit) * p_usd_rate
             ELSE -(jel.debit - jel.credit) END
      ELSE 0
    END
  ), 0) INTO v_net_income
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN chart_of_accounts coa ON coa.id = jel.account_id
  LEFT JOIN (
    SELECT
      jj.id AS je_id,
      CASE
        WHEN jj.source_module = 'purchase_invoice'
             AND COALESCE(pi2.currency, 'IDR') = 'USD' THEN 'USD'
        WHEN jj.source_module = 'payment'
             AND (COALESCE(ba2.currency, 'IDR') = 'USD'
                  OR COALESCE(pv2.exchange_rate, 1) > 1.5) THEN 'USD'
        ELSE 'IDR'
      END AS je_currency
    FROM journal_entries jj
    LEFT JOIN purchase_invoices pi2
           ON pi2.id = jj.reference_id AND jj.source_module = 'purchase_invoice'
    LEFT JOIN payment_vouchers pv2
           ON pv2.id = jj.reference_id AND jj.source_module = 'payment'
    LEFT JOIN bank_accounts ba2 ON ba2.id = pv2.bank_account_id
    WHERE jj.is_posted = true
      AND COALESCE(jj.is_reversed, false) = false
      AND jj.entry_date <= p_as_of_date
  ) fx ON fx.je_id = je.id
  WHERE je.is_posted                    = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date                  <= p_as_of_date
    AND coa.is_header                   = false;

  SELECT EXISTS (
    SELECT 1 FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '3300' AND je.is_posted = true AND je.entry_date <= p_as_of_date
  ) INTO v_has_3300;

  RETURN QUERY
  WITH je_fx AS (
    SELECT
      je.id AS je_id,
      CASE
        WHEN je.source_module = 'purchase_invoice'
             AND COALESCE(pi.currency, 'IDR') = 'USD' THEN 'USD'
        WHEN je.source_module = 'payment'
             AND (COALESCE(ba.currency, 'IDR') = 'USD'
                  OR COALESCE(pv.exchange_rate, 1) > 1.5) THEN 'USD'
        ELSE 'IDR'
      END AS je_currency
    FROM journal_entries je
    LEFT JOIN purchase_invoices pi
           ON pi.id = je.reference_id AND je.source_module = 'purchase_invoice'
    LEFT JOIN payment_vouchers pv
           ON pv.id = je.reference_id AND je.source_module = 'payment'
    LEFT JOIN bank_accounts ba ON ba.id = pv.bank_account_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  )
  SELECT
    coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
    ) AS normal_balance,
    COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.debit  * p_usd_rate ELSE jel.debit  END), 0)::NUMERIC AS total_debit,
    COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.credit * p_usd_rate ELSE jel.credit END), 0)::NUMERIC AS total_credit,
    (COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.debit  * p_usd_rate ELSE jel.debit  END), 0)
   - COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.credit * p_usd_rate ELSE jel.credit END), 0))::NUMERIC AS balance
  FROM chart_of_accounts coa
  LEFT JOIN journal_entry_lines jel ON coa.id   = jel.account_id
  LEFT JOIN je_fx               fx  ON fx.je_id = jel.journal_entry_id
  WHERE coa.is_header = false AND coa.is_active = true
    AND coa.account_type IN ('asset','liability','equity','contra')
  GROUP BY coa.id, coa.code, coa.name, coa.name_id,
           coa.account_type, coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(jel.debit), 0) != 0 OR COALESCE(SUM(jel.credit), 0) != 0

  UNION ALL

  SELECT
    '3300'::VARCHAR, 'Current Year Earnings'::VARCHAR,
    'Laba/Rugi Tahun Berjalan'::VARCHAR, 'equity'::VARCHAR,
    'Equity'::VARCHAR, 'credit'::VARCHAR,
    CASE WHEN v_net_income < 0 THEN ABS(v_net_income) ELSE 0 END,
    CASE WHEN v_net_income > 0 THEN v_net_income      ELSE 0 END,
    (-v_net_income)::NUMERIC
  WHERE NOT v_has_3300 AND ABS(v_net_income) > 0.005

  ORDER BY 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trial_balance(p_start_date date, p_end_date date)
RETURNS TABLE(
  code            varchar, name varchar, name_id varchar,
  account_type    varchar, account_group varchar, normal_balance varchar,
  total_debit     numeric, total_credit numeric, balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT
    coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
    ) AS normal_balance,
    COALESCE(SUM(jel.debit),  0)::NUMERIC AS total_debit,
    COALESCE(SUM(jel.credit), 0)::NUMERIC AS total_credit,
    (COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0))::NUMERIC AS balance
  FROM chart_of_accounts coa
  LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
  LEFT JOIN journal_entries      je  ON jel.journal_entry_id = je.id
    AND je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date >= p_start_date
    AND je.entry_date <= p_end_date
  WHERE coa.is_header = false AND coa.is_active = true
  GROUP BY coa.id, coa.code, coa.name, coa.name_id,
           coa.account_type, coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(jel.debit), 0) != 0 OR COALESCE(SUM(jel.credit), 0) != 0
  ORDER BY coa.code;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trial_balance(p_start_date date, p_end_date date, p_usd_rate numeric DEFAULT 1)
RETURNS TABLE(
  code            varchar, name varchar, name_id varchar,
  account_type    varchar, account_group varchar, normal_balance varchar,
  total_debit     numeric, total_credit numeric, balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  WITH je_fx AS (
    SELECT
      je.id AS je_id,
      CASE
        WHEN je.source_module = 'purchase_invoice'
             AND COALESCE(pi.currency, 'IDR') = 'USD' THEN 'USD'
        WHEN je.source_module = 'payment'
             AND (COALESCE(ba.currency, 'IDR') = 'USD'
                  OR COALESCE(pv.exchange_rate, 1) > 1.5) THEN 'USD'
        ELSE 'IDR'
      END AS je_currency
    FROM journal_entries je
    LEFT JOIN purchase_invoices pi ON pi.id = je.reference_id AND je.source_module = 'purchase_invoice'
    LEFT JOIN payment_vouchers pv  ON pv.id = je.reference_id AND je.source_module = 'payment'
    LEFT JOIN bank_accounts ba     ON ba.id = pv.bank_account_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date >= p_start_date
      AND je.entry_date <= p_end_date
  )
  SELECT
    coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
    ) AS normal_balance,
    COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.debit  * p_usd_rate ELSE jel.debit  END), 0)::NUMERIC AS total_debit,
    COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.credit * p_usd_rate ELSE jel.credit END), 0)::NUMERIC AS total_credit,
    (COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.debit  * p_usd_rate ELSE jel.debit  END), 0)
   - COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.credit * p_usd_rate ELSE jel.credit END), 0))::NUMERIC AS balance
  FROM chart_of_accounts coa
  LEFT JOIN journal_entry_lines jel ON coa.id   = jel.account_id
  LEFT JOIN je_fx               fx  ON fx.je_id = jel.journal_entry_id
  WHERE coa.is_header = false AND coa.is_active = true
  GROUP BY coa.id, coa.code, coa.name, coa.name_id,
           coa.account_type, coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(jel.debit), 0) != 0 OR COALESCE(SUM(jel.credit), 0) != 0
  ORDER BY coa.code;
END;
$$;

-- Verify the revokes stuck
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_reporting_usd_rate()', 'execute') THEN
    REVOKE EXECUTE ON FUNCTION public.get_reporting_usd_rate() FROM anon;
  END IF;
END $$;
