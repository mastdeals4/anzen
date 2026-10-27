/*
  # Security Fix Part 3: Add role guards to finance/accounting and bank reconciliation functions

  ## Role assignments:
  - delete_expense_safe                      → admin, accounts
  - move_expense_to_petty_cash               → admin, accounts
  - move_expense_to_tracker                  → admin, accounts
  - post_fund_transfer_journal               → admin, accounts
  - manually_post_pending_fund_transfers     → admin, accounts
  - safe_delete_bank_statement_lines         → admin, accounts
  - confirm_bank_match                       → admin, accounts
  - unlink_expense_from_bank_statement       → admin, accounts
  - unmatch_bank_line                        → admin, accounts
  - auto_match_smart                         → admin, accounts
  - auto_match_bank_transactions_smart       → admin, accounts
  - learn_from_match                         → admin, accounts
*/

CREATE OR REPLACE FUNCTION public.delete_expense_safe(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_linked_count int;
  v_role         text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot delete expenses', v_role;
  END IF;

  SELECT COUNT(*) INTO v_linked_count
  FROM bank_statement_lines WHERE matched_expense_id = p_expense_id;

  IF v_linked_count > 0 THEN
    UPDATE bank_statement_lines
    SET matched_expense_id = NULL, reconciliation_status = 'unmatched',
        matched_at = NULL, matched_by = NULL, notes = NULL
    WHERE matched_expense_id = p_expense_id;
  END IF;

  DELETE FROM finance_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  RETURN jsonb_build_object('success', true, 'unlinked_statements', v_linked_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.move_expense_to_petty_cash(p_expense_id uuid, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_expense          RECORD;
  v_pc_number        TEXT;
  v_petty_cash_tx_id UUID;
  v_role             text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot move expenses to petty cash', v_role;
  END IF;

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
    v_expense.expense_category, v_expense.bank_account_id, p_user_id,
    'moved_from_tracker', v_expense.description, 'cash', v_expense.id
  ) RETURNING id INTO v_petty_cash_tx_id;

  UPDATE finance_expenses
  SET petty_cash_transaction_id = v_petty_cash_tx_id, payment_method = 'cash', paid_by = 'cash'
  WHERE id = p_expense_id;

  RETURN v_petty_cash_tx_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.move_expense_to_tracker(
  p_petty_cash_id uuid, p_bank_account_id uuid, p_payment_method text, p_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_pc_tx            RECORD;
  v_expense_id       UUID;
  v_finance_category TEXT;
  v_role             text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot move petty cash to tracker', v_role;
  END IF;

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
    p_payment_method, p_bank_account_id, 'bank', p_user_id, v_pc_tx.id
  ) RETURNING id INTO v_expense_id;

  UPDATE petty_cash_transactions
  SET finance_expense_id = v_expense_id, source = 'moved_to_tracker'
  WHERE id = p_petty_cash_id;

  RETURN v_expense_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.post_fund_transfer_journal(
  p_transfer_id uuid, p_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public, pg_temp'
AS $$
DECLARE
  v_transfer        RECORD;
  v_journal_id      UUID;
  v_from_account_id UUID;
  v_to_account_id   UUID;
  v_description     TEXT;
  v_role            text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot post fund transfer journals', v_role;
  END IF;

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
    v_description, 0, 0, true, p_user_id
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES
    (v_journal_id, v_to_account_id,   v_transfer.amount, 0,                  'Transfer In'),
    (v_journal_id, v_from_account_id, 0,                  v_transfer.amount, 'Transfer Out');

  UPDATE fund_transfers SET journal_entry_id = v_journal_id WHERE id = p_transfer_id;
  RETURN v_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.safe_delete_bank_statement_lines(
  p_bank_account_id uuid, p_start_date date, p_end_date date
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_total_count      INTEGER;
  v_reconciled_count INTEGER;
  v_deletable_count  INTEGER;
  v_deleted_count    INTEGER;
  v_role             text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot delete bank statement lines', v_role;
  END IF;

  SELECT COUNT(*) INTO v_total_count FROM bank_statement_lines
  WHERE bank_account_id = p_bank_account_id
    AND transaction_date BETWEEN p_start_date AND p_end_date;

  SELECT COUNT(*) INTO v_reconciled_count FROM bank_statement_lines
  WHERE bank_account_id = p_bank_account_id
    AND transaction_date BETWEEN p_start_date AND p_end_date
    AND reconciliation_status IN ('matched','recorded','suggested');

  v_deletable_count := v_total_count - v_reconciled_count;

  IF v_reconciled_count > 0 THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Cannot delete: ' || v_reconciled_count || ' transaction(s) are reconciled',
      'total_count', v_total_count, 'reconciled_count', v_reconciled_count,
      'deletable_count', v_deletable_count, 'deleted_count', 0
    );
  END IF;

  DELETE FROM bank_statement_lines
  WHERE bank_account_id = p_bank_account_id
    AND transaction_date BETWEEN p_start_date AND p_end_date
    AND reconciliation_status = 'unmatched';
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN json_build_object(
    'success', true, 'total_count', v_total_count, 'reconciled_count', v_reconciled_count,
    'deletable_count', v_deletable_count, 'deleted_count', v_deleted_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_bank_match(p_bank_line_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_line              RECORD;
  v_already_confirmed BOOLEAN;
  v_role              text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot confirm bank matches', v_role;
  END IF;

  SELECT * INTO v_line FROM bank_statement_lines WHERE id = p_bank_line_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Bank line not found'); END IF;
  IF v_line.matching_status = 'confirmed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Match already confirmed');
  END IF;

  IF v_line.matched_expense_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM bank_statement_lines
      WHERE matched_expense_id = v_line.matched_expense_id
        AND matching_status = 'confirmed' AND id != p_bank_line_id
    ) INTO v_already_confirmed;
    IF v_already_confirmed THEN
      RETURN jsonb_build_object('success', false, 'error', 'This expense is already confirmed with another bank transaction');
    END IF;
  END IF;

  IF v_line.matched_receipt_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM bank_statement_lines
      WHERE matched_receipt_id = v_line.matched_receipt_id
        AND matching_status = 'confirmed' AND id != p_bank_line_id
    ) INTO v_already_confirmed;
    IF v_already_confirmed THEN
      RETURN jsonb_build_object('success', false, 'error', 'This receipt is already confirmed with another bank transaction');
    END IF;
  END IF;

  UPDATE bank_statement_lines
  SET matching_status = 'confirmed', reconciliation_status = 'matched',
      matched_at = now(), matched_by = p_user_id, notes = 'User confirmed match'
  WHERE id = p_bank_line_id;

  RETURN jsonb_build_object('success', true, 'message', 'Match confirmed successfully');
END;
$$;

CREATE OR REPLACE FUNCTION public.unlink_expense_from_bank_statement(p_bank_statement_line_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot unlink bank statement entries', v_role;
  END IF;

  UPDATE bank_statement_lines
  SET matched_expense_id = NULL, reconciliation_status = 'unmatched',
      matched_at = NULL, matched_by = NULL, notes = NULL
  WHERE id = p_bank_statement_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_bank_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot unmatch bank lines', v_role;
  END IF;

  UPDATE bank_statement_lines
  SET matched_expense_id = NULL, matched_receipt_id = NULL, matched_petty_cash_id = NULL,
      matched_fund_transfer_id = NULL, matched_entry_id = NULL, matching_status = 'none',
      reconciliation_status = 'pending', matched_at = NULL, matched_by = NULL, notes = NULL
  WHERE id = p_bank_line_id;

  RETURN jsonb_build_object('success', true, 'message', 'Match removed successfully');
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_match_smart()
RETURNS TABLE(matched_count integer, suggested_count integer, skipped_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_matched_count   int := 0;
  v_suggested_count int := 0;
  v_skipped_count   int := 0;
  v_line            record;
  v_expense         record;
  v_best_match_id   uuid;
  v_best_score      numeric;
  v_amount          numeric;
  v_role            text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot run auto-match', v_role;
  END IF;

  FOR v_line IN
    SELECT * FROM bank_statement_lines
    WHERE reconciliation_status = 'unmatched' AND debit_amount > 0
      AND matched_expense_id IS NULL AND matched_receipt_id IS NULL
      AND matched_petty_cash_id IS NULL AND matched_entry_id IS NULL
      AND matched_fund_transfer_id IS NULL
    ORDER BY transaction_date DESC
  LOOP
    v_amount := v_line.debit_amount;
    v_best_match_id := NULL;
    v_best_score := 0;

    FOR v_expense IN
      SELECT fe.id, fe.amount, fe.expense_date, fe.bank_account_id, fe.expense_category,
             ABS(v_line.transaction_date::date - fe.expense_date::date) as date_diff_days,
             ABS(fe.amount - v_amount) as amount_diff,
             EXISTS (SELECT 1 FROM bank_statement_lines bsl WHERE bsl.matched_expense_id = fe.id AND bsl.id != v_line.id) as already_matched
      FROM finance_expenses fe
      WHERE fe.paid_by = 'bank' AND ABS(fe.amount - v_amount) <= 10000
        AND ABS(v_line.transaction_date::date - fe.expense_date::date) <= 7
        AND (v_line.bank_account_id IS NULL OR fe.bank_account_id IS NULL OR v_line.bank_account_id = fe.bank_account_id)
      ORDER BY ABS(fe.amount - v_amount), ABS(v_line.transaction_date::date - fe.expense_date::date)
      LIMIT 1
    LOOP
      IF v_expense.already_matched THEN v_skipped_count := v_skipped_count + 1; CONTINUE; END IF;
      v_best_score := 0;
      IF v_expense.amount_diff < 1       THEN v_best_score := v_best_score + 60;
      ELSIF v_expense.amount_diff <= 100 THEN v_best_score := v_best_score + 50;
      ELSIF v_expense.amount_diff <= 1000 THEN v_best_score := v_best_score + 35;
      ELSE  v_best_score := v_best_score + 20; END IF;
      IF v_expense.date_diff_days = 0    THEN v_best_score := v_best_score + 30;
      ELSIF v_expense.date_diff_days <= 1 THEN v_best_score := v_best_score + 25;
      ELSIF v_expense.date_diff_days <= 3 THEN v_best_score := v_best_score + 15;
      ELSE  v_best_score := v_best_score + 5; END IF;
      IF v_line.bank_account_id IS NOT NULL AND v_expense.bank_account_id IS NOT NULL
         AND v_line.bank_account_id = v_expense.bank_account_id THEN
        v_best_score := v_best_score + 10;
      END IF;
      v_best_match_id := v_expense.id;
    END LOOP;

    IF v_best_match_id IS NOT NULL AND v_best_score >= 70 THEN
      UPDATE bank_statement_lines
      SET matched_expense_id = v_best_match_id,
          reconciliation_status = CASE WHEN v_best_score >= 85 THEN 'matched' ELSE 'needs_review' END,
          matched_at = now(), matched_by = (SELECT auth.uid()),
          notes = 'Auto-matched (confidence: ' || ROUND(v_best_score)::text || '%)'
      WHERE id = v_line.id;
      IF v_best_score >= 85 THEN v_matched_count := v_matched_count + 1;
      ELSE v_suggested_count := v_suggested_count + 1; END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_matched_count, v_suggested_count, v_skipped_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_match_bank_transactions_smart()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_line        RECORD;
  v_matched_id  UUID;
  v_match_type  TEXT;
  v_match_count INTEGER;
  v_role        text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot run auto-match', v_role;
  END IF;

  FOR v_line IN
    SELECT * FROM bank_statement_lines
    WHERE matching_status = 'none'
      AND matched_expense_id IS NULL AND matched_receipt_id IS NULL
      AND matched_petty_cash_id IS NULL AND matched_fund_transfer_id IS NULL
  LOOP
    v_matched_id := NULL; v_match_type := NULL;

    IF v_line.debit_amount > 0 THEN
      SELECT id INTO v_matched_id FROM finance_expenses
      WHERE ABS(amount - v_line.debit_amount) < 0.01
        AND ABS(EXTRACT(EPOCH FROM (expense_date - v_line.transaction_date)) / 86400) <= 3
        AND id NOT IN (SELECT matched_expense_id FROM bank_statement_lines WHERE matching_status = 'confirmed' AND matched_expense_id IS NOT NULL)
      ORDER BY ABS(EXTRACT(EPOCH FROM (expense_date - v_line.transaction_date))) LIMIT 1;

      IF v_matched_id IS NOT NULL THEN
        SELECT COUNT(*) INTO v_match_count FROM finance_expenses
        WHERE ABS(amount - v_line.debit_amount) < 0.01
          AND ABS(EXTRACT(EPOCH FROM (expense_date - v_line.transaction_date)) / 86400) <= 3
          AND id NOT IN (SELECT matched_expense_id FROM bank_statement_lines WHERE matching_status = 'confirmed' AND matched_expense_id IS NOT NULL);
        UPDATE bank_statement_lines
        SET matched_expense_id = v_matched_id, matching_status = 'suggested',
            reconciliation_status = CASE WHEN v_match_count > 1 THEN 'conflict' ELSE 'suggested' END,
            notes = CASE WHEN v_match_count > 1 THEN 'Multiple possible matches - please verify' ELSE 'Auto-suggested match - needs confirmation' END
        WHERE id = v_line.id;
        CONTINUE;
      END IF;

      SELECT id INTO v_matched_id FROM petty_cash_transactions
      WHERE transaction_type = 'expense' AND ABS(amount - v_line.debit_amount) < 0.01
        AND ABS(EXTRACT(EPOCH FROM (transaction_date - v_line.transaction_date)) / 86400) <= 3
        AND id NOT IN (SELECT matched_petty_cash_id FROM bank_statement_lines WHERE matching_status = 'confirmed' AND matched_petty_cash_id IS NOT NULL)
      ORDER BY ABS(EXTRACT(EPOCH FROM (transaction_date - v_line.transaction_date))) LIMIT 1;

      IF v_matched_id IS NOT NULL THEN
        UPDATE bank_statement_lines
        SET matched_petty_cash_id = v_matched_id, matching_status = 'suggested',
            reconciliation_status = 'suggested', notes = 'Auto-suggested match - needs confirmation'
        WHERE id = v_line.id;
        CONTINUE;
      END IF;
    END IF;

    IF v_line.credit_amount > 0 THEN
      SELECT rv.id INTO v_matched_id FROM receipt_vouchers rv
      WHERE ABS(rv.amount - v_line.credit_amount) < 0.01
        AND ABS(EXTRACT(EPOCH FROM (rv.receipt_date - v_line.transaction_date)) / 86400) <= 3
        AND rv.id NOT IN (SELECT matched_receipt_id FROM bank_statement_lines WHERE matching_status = 'confirmed' AND matched_receipt_id IS NOT NULL)
      ORDER BY ABS(EXTRACT(EPOCH FROM (rv.receipt_date - v_line.transaction_date))) LIMIT 1;

      IF v_matched_id IS NOT NULL THEN
        UPDATE bank_statement_lines
        SET matched_receipt_id = v_matched_id, matching_status = 'suggested',
            reconciliation_status = 'suggested', notes = 'Auto-suggested match - needs confirmation'
        WHERE id = v_line.id;
        CONTINUE;
      END IF;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.learn_from_match(p_description text, p_expense_category text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_pattern  text;
  v_existing record;
  v_role     text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update match memory', v_role;
  END IF;

  v_pattern := LOWER(TRIM(SUBSTRING(p_description FROM 1 FOR 50)));

  SELECT * INTO v_existing FROM bank_match_memory
  WHERE description_pattern = v_pattern AND expense_category = p_expense_category;

  IF v_existing.id IS NOT NULL THEN
    UPDATE bank_match_memory
    SET match_count = match_count + 1, confidence_score = LEAST(confidence_score + 5, 100),
        last_matched_at = now()
    WHERE id = v_existing.id;
  ELSE
    INSERT INTO bank_match_memory (
      description_pattern, expense_category, match_count, confidence_score, created_by
    ) VALUES (v_pattern, p_expense_category, 1, 50, auth.uid());
  END IF;
END;
$$;
