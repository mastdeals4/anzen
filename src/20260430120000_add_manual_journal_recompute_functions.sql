/*
  # Manual journal recompute functions (safe per-record recovery)

  Adds manually invokable recompute functions for:
  - expenses
  - petty cash
  - fund transfers

  Design:
  - Runs in a single transaction per function call
  - Deletes existing journal entries and lines for that source+reference
  - Rebuilds journal from current source record
  - Logs every recompute action into audit_logs
  - Not auto-run globally (manual RPC/function invocation only)
*/

CREATE OR REPLACE FUNCTION public.recompute_expense_journal(p_reference_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_expense finance_expenses%ROWTYPE;
  v_existing_journal_id uuid;
  v_journal_id uuid;
  v_expense_account_id uuid;
  v_payment_account_id uuid;
  v_payment_desc text;
  v_description text;
BEGIN
  SELECT * INTO v_expense
  FROM finance_expenses
  WHERE id = p_reference_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found: %', p_reference_id;
  END IF;

  SELECT id INTO v_existing_journal_id
  FROM journal_entries
  WHERE source_module = 'expenses'
    AND reference_id = p_reference_id
  LIMIT 1;

  DELETE FROM journal_entries
  WHERE source_module = 'expenses'
    AND reference_id = p_reference_id;

  v_expense_account_id := get_expense_account_id(v_expense.expense_category);
  IF v_expense_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot determine expense account for category: %', v_expense.expense_category;
  END IF;

  IF v_expense.payment_method = 'cash' THEN
    SELECT id, 'Cash on Hand' INTO v_payment_account_id, v_payment_desc
    FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF v_expense.payment_method = 'petty_cash' THEN
    SELECT id, 'Petty Cash' INTO v_payment_account_id, v_payment_desc
    FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF v_expense.payment_method = 'bank_transfer' AND v_expense.bank_account_id IS NOT NULL THEN
    SELECT coa_id, account_name INTO v_payment_account_id, v_payment_desc
    FROM bank_accounts WHERE id = v_expense.bank_account_id;
    IF v_payment_account_id IS NULL THEN
      SELECT id, 'Bank Account' INTO v_payment_account_id, v_payment_desc
      FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
  ELSIF v_expense.payment_method IS NULL THEN
    SELECT id, 'Accounts Payable' INTO v_payment_account_id, v_payment_desc
    FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  ELSE
    SELECT id, 'Cash on Hand' INTO v_payment_account_id, v_payment_desc
    FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_payment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot determine payment account for expense: %', p_reference_id;
  END IF;

  v_description := COALESCE(v_expense.description, v_expense.expense_category);

  INSERT INTO journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_at,
    created_by
  ) VALUES (
    next_journal_entry_number(),
    v_expense.expense_date,
    'expenses',
    v_expense.id,
    'EXP-' || v_expense.id::text,
    v_description,
    v_expense.amount,
    v_expense.amount,
    true,
    now(),
    v_expense.created_by
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES
    (v_journal_id, 1, v_expense_account_id, v_expense.amount, 0, v_description),
    (v_journal_id, 2, v_payment_account_id, 0, v_expense.amount, v_payment_desc);

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, changed_fields, user_id, user_email, created_at)
  VALUES (
    'journal_entries',
    v_journal_id,
    'update',
    jsonb_build_object('event', 'recompute', 'source_module', 'expenses', 'reference_id', p_reference_id, 'previous_journal_id', v_existing_journal_id),
    jsonb_build_object('event', 'recompute', 'source_module', 'expenses', 'reference_id', p_reference_id, 'new_journal_id', v_journal_id),
    ARRAY['recompute']::text[],
    auth.uid(),
    NULL,
    now()
  );

  RETURN v_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_petty_cash_journal(p_reference_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_txn petty_cash_transactions%ROWTYPE;
  v_existing_journal_id uuid;
  v_journal_id uuid;
  v_petty_cash_account_id uuid;
  v_bank_account_coa_id uuid;
  v_expense_account_id uuid;
BEGIN
  SELECT * INTO v_txn FROM petty_cash_transactions WHERE id = p_reference_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Petty cash transaction not found: %', p_reference_id;
  END IF;

  IF v_txn.source IN ('moved_from_tracker', 'finance_expense', 'migrated_from_expenses') THEN
    RAISE EXCEPTION 'Petty cash source % is excluded from journal recompute to avoid double posting', v_txn.source;
  END IF;

  SELECT id INTO v_existing_journal_id
  FROM journal_entries
  WHERE source_module = 'petty_cash'
    AND reference_id = p_reference_id
  LIMIT 1;

  DELETE FROM journal_entries
  WHERE source_module = 'petty_cash'
    AND reference_id = p_reference_id;

  SELECT id INTO v_petty_cash_account_id
  FROM chart_of_accounts
  WHERE code = '1102' OR code LIKE '1-103%' OR LOWER(name) LIKE '%petty%cash%'
  ORDER BY code
  LIMIT 1;

  IF v_petty_cash_account_id IS NULL THEN
    INSERT INTO chart_of_accounts (code, name, account_type, is_active)
    VALUES ('1102', 'Petty Cash', 'asset', true)
    RETURNING id INTO v_petty_cash_account_id;
  END IF;

  IF v_txn.transaction_type = 'withdraw' THEN
    IF v_txn.bank_account_id IS NOT NULL THEN
      SELECT coa_id INTO v_bank_account_coa_id FROM bank_accounts WHERE id = v_txn.bank_account_id;
    END IF;

    IF v_bank_account_coa_id IS NULL THEN
      SELECT id INTO v_bank_account_coa_id
      FROM chart_of_accounts
      WHERE code LIKE '1-102%' OR LOWER(name) LIKE '%bank%'
      ORDER BY code
      LIMIT 1;
    END IF;

    INSERT INTO journal_entries (entry_number, entry_date, source_module, reference_id, description, total_debit, total_credit, is_posted, posted_at, created_by)
    VALUES (
      next_journal_entry_number(),
      v_txn.transaction_date,
      'petty_cash',
      v_txn.id,
      'Petty cash withdrawal: ' || COALESCE(v_txn.description, ''),
      v_txn.amount,
      v_txn.amount,
      true,
      now(),
      v_txn.created_by
    ) RETURNING id INTO v_journal_id;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, 1, v_petty_cash_account_id, v_txn.amount, 0, 'Cash withdrawal'),
      (v_journal_id, 2, v_bank_account_coa_id, 0, v_txn.amount, 'Transfer to petty cash');

  ELSIF v_txn.transaction_type = 'expense' THEN
    SELECT id INTO v_expense_account_id
    FROM chart_of_accounts
    WHERE account_type = 'expense'
    ORDER BY code
    LIMIT 1;

    IF v_expense_account_id IS NULL THEN
      RAISE EXCEPTION 'No expense account available for petty cash expense recompute';
    END IF;

    INSERT INTO journal_entries (entry_number, entry_date, source_module, reference_id, description, total_debit, total_credit, is_posted, posted_at, created_by)
    VALUES (
      next_journal_entry_number(),
      v_txn.transaction_date,
      'petty_cash',
      v_txn.id,
      'Petty cash expense: ' || COALESCE(v_txn.description, ''),
      v_txn.amount,
      v_txn.amount,
      true,
      now(),
      v_txn.created_by
    ) RETURNING id INTO v_journal_id;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, 1, v_expense_account_id, v_txn.amount, 0, COALESCE(v_txn.expense_category, 'Petty cash expense')),
      (v_journal_id, 2, v_petty_cash_account_id, 0, v_txn.amount, 'Petty cash payment');
  ELSE
    RAISE EXCEPTION 'Unsupported petty cash transaction_type for recompute: %', v_txn.transaction_type;
  END IF;

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, changed_fields, user_id, user_email, created_at)
  VALUES (
    'journal_entries',
    v_journal_id,
    'update',
    jsonb_build_object('event', 'recompute', 'source_module', 'petty_cash', 'reference_id', p_reference_id, 'previous_journal_id', v_existing_journal_id),
    jsonb_build_object('event', 'recompute', 'source_module', 'petty_cash', 'reference_id', p_reference_id, 'new_journal_id', v_journal_id),
    ARRAY['recompute']::text[],
    auth.uid(),
    NULL,
    now()
  );

  RETURN v_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_fund_transfer_journal(p_reference_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_transfer fund_transfers%ROWTYPE;
  v_existing_journal_id uuid;
  v_journal_id uuid;
  v_from_account_id uuid;
  v_to_account_id uuid;
  v_from_currency text;
  v_to_currency text;
  v_description text;
  v_post_amount numeric;
BEGIN
  SELECT * INTO v_transfer FROM fund_transfers WHERE id = p_reference_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund transfer not found: %', p_reference_id;
  END IF;

  SELECT id INTO v_existing_journal_id
  FROM journal_entries
  WHERE source_module IN ('fund_transfer', 'fund_transfers')
    AND reference_id = p_reference_id
  LIMIT 1;

  DELETE FROM journal_entries
  WHERE source_module IN ('fund_transfer', 'fund_transfers')
    AND reference_id = p_reference_id;

  IF v_transfer.from_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO v_from_account_id, v_from_currency FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN
    SELECT id, 'IDR' INTO v_from_account_id, v_from_currency FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF v_transfer.from_account_type = 'bank' THEN
    SELECT coa_id, currency INTO v_from_account_id, v_from_currency FROM bank_accounts WHERE id = v_transfer.from_bank_account_id;
  END IF;

  IF v_transfer.to_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO v_to_account_id, v_to_currency FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN
    SELECT id, 'IDR' INTO v_to_account_id, v_to_currency FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF v_transfer.to_account_type = 'bank' THEN
    SELECT coa_id, currency INTO v_to_account_id, v_to_currency FROM bank_accounts WHERE id = v_transfer.to_bank_account_id;
  END IF;

  IF v_from_account_id IS NULL OR v_to_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot determine chart of accounts for transfer %', p_reference_id;
  END IF;

  v_description := 'Fund Transfer ' || v_transfer.transfer_number;
  IF COALESCE(v_from_currency, 'IDR') <> COALESCE(v_to_currency, 'IDR') THEN
    v_description := v_description || ' (FX: ' || v_from_currency || ' → ' || v_to_currency || ')';
  END IF;
  IF v_transfer.description IS NOT NULL THEN
    v_description := v_description || ' - ' || v_transfer.description;
  END IF;

  v_post_amount := COALESCE(v_transfer.from_amount, v_transfer.amount);

  INSERT INTO journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_at,
    created_by
  ) VALUES (
    next_journal_entry_number(),
    v_transfer.transfer_date,
    'fund_transfer',
    v_transfer.id,
    v_transfer.transfer_number,
    v_description,
    v_post_amount,
    v_post_amount,
    true,
    now(),
    v_transfer.created_by
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES
    (v_journal_id, 1, v_to_account_id, v_post_amount, 0, 'Transfer In: ' || v_transfer.transfer_number),
    (v_journal_id, 2, v_from_account_id, 0, v_post_amount, 'Transfer Out: ' || v_transfer.transfer_number);

  UPDATE fund_transfers
  SET journal_entry_id = v_journal_id,
      status = 'posted',
      posted_at = now(),
      posted_by = COALESCE(auth.uid(), v_transfer.created_by)
  WHERE id = v_transfer.id;

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, changed_fields, user_id, user_email, created_at)
  VALUES (
    'journal_entries',
    v_journal_id,
    'update',
    jsonb_build_object('event', 'recompute', 'source_module', 'fund_transfer', 'reference_id', p_reference_id, 'previous_journal_id', v_existing_journal_id),
    jsonb_build_object('event', 'recompute', 'source_module', 'fund_transfer', 'reference_id', p_reference_id, 'new_journal_id', v_journal_id),
    ARRAY['recompute']::text[],
    auth.uid(),
    NULL,
    now()
  );

  RETURN v_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_journal(source_module text, reference_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  CASE lower(source_module)
    WHEN 'expense', 'expenses' THEN
      RETURN public.recompute_expense_journal(reference_id);
    WHEN 'petty_cash', 'petty cash' THEN
      RETURN public.recompute_petty_cash_journal(reference_id);
    WHEN 'fund_transfer', 'fund_transfers', 'fund transfer' THEN
      RETURN public.recompute_fund_transfer_journal(reference_id);
    ELSE
      RAISE EXCEPTION 'Unsupported source_module: %', source_module;
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.recompute_journal(text, uuid)
IS 'Manual per-record journal recompute. Deletes existing journal for source+reference and recreates it atomically. Not auto-run globally.';
