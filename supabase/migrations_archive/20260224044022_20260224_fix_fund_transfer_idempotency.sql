/*
  # Fix Fund Transfer Journal Trigger - Idempotency

  ## Problem
  FT2601-0003 was posted 3 times. The trigger fires on INSERT only, but the RPC function
  `post_fund_transfer_journal` also existed and was called directly — creating duplicates
  when both paths were used for the same transfer.

  The `auto_post_fund_transfer_journal` trigger fires on INSERT and does:
    UPDATE fund_transfers SET journal_entry_id = v_journal_id
  This UPDATE on fund_transfers could trigger additional calls.

  ## Fix
  1. Add `NEW.journal_entry_id IS NOT NULL` guard at the start of the trigger function.
  2. The UPDATE inside the trigger (SET journal_entry_id) won't re-trigger because
     the trigger only fires on INSERT. But add the guard anyway to be safe.
  3. Also fix the `post_fund_transfer_journal` RPC to check for existing JE properly.
*/

CREATE OR REPLACE FUNCTION auto_post_fund_transfer_journal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_from_account_id UUID;
  v_to_account_id UUID;
  v_from_currency TEXT;
  v_to_currency TEXT;
  v_journal_id UUID;
  v_entry_number TEXT;
  v_description TEXT;
  v_from_amount NUMERIC;
  v_to_amount NUMERIC;
BEGIN
  -- IDEMPOTENCY: If journal already posted, do nothing
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Also check by reference number to catch race conditions
  IF EXISTS (SELECT 1 FROM journal_entries WHERE reference_number = NEW.transfer_number) THEN
    -- Link the existing JE back if not linked
    SELECT id INTO v_journal_id FROM journal_entries 
    WHERE reference_number = NEW.transfer_number 
    AND source_module = 'fund_transfers'
    ORDER BY created_at DESC LIMIT 1;

    IF v_journal_id IS NOT NULL THEN
      UPDATE fund_transfers SET journal_entry_id = v_journal_id WHERE id = NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  SELECT generate_journal_entry_number() INTO v_entry_number;

  -- Determine from_account_id and currency
  IF NEW.from_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO v_from_account_id, v_from_currency
    FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF NEW.from_account_type = 'cash_on_hand' THEN
    SELECT id, 'IDR' INTO v_from_account_id, v_from_currency
    FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF NEW.from_account_type = 'bank' THEN
    SELECT coa_id, currency INTO v_from_account_id, v_from_currency
    FROM bank_accounts WHERE id = NEW.from_bank_account_id;
  END IF;

  -- Determine to_account_id and currency
  IF NEW.to_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO v_to_account_id, v_to_currency
    FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF NEW.to_account_type = 'cash_on_hand' THEN
    SELECT id, 'IDR' INTO v_to_account_id, v_to_currency
    FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF NEW.to_account_type = 'bank' THEN
    SELECT coa_id, currency INTO v_to_account_id, v_to_currency
    FROM bank_accounts WHERE id = NEW.to_bank_account_id;
  END IF;

  IF v_from_account_id IS NULL OR v_to_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot determine chart of accounts for transfer';
  END IF;

  v_from_amount := NEW.from_amount;
  v_to_amount := NEW.to_amount;

  v_description := 'Fund Transfer ' || NEW.transfer_number;
  IF v_from_currency != v_to_currency THEN
    v_description := v_description || ' (FX: ' || v_from_currency || ' → ' || v_to_currency || ')';
  END IF;
  IF NEW.description IS NOT NULL THEN
    v_description := v_description || ' - ' || NEW.description;
  END IF;

  -- Same-currency transfer
  IF v_from_currency = v_to_currency THEN
    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, created_by
    ) VALUES (
      v_entry_number, NEW.transfer_date, 'fund_transfers', NEW.id, NEW.transfer_number,
      v_description, v_from_amount, v_from_amount, true, NEW.created_by
    ) RETURNING id INTO v_journal_id;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, 1, v_to_account_id, v_from_amount, 0, 'Transfer In: ' || NEW.transfer_number),
      (v_journal_id, 2, v_from_account_id, 0, v_from_amount, 'Transfer Out: ' || NEW.transfer_number);

  ELSE
    -- Cross-currency: post in FROM currency (functional currency is IDR)
    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, created_by
    ) VALUES (
      v_entry_number, NEW.transfer_date, 'fund_transfers', NEW.id, NEW.transfer_number,
      v_description, v_from_amount, v_from_amount, true, NEW.created_by
    ) RETURNING id INTO v_journal_id;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, 1, v_to_account_id, v_from_amount, 0,
       'Transfer In: ' || NEW.transfer_number || ' (' || v_to_currency || ' ' || v_to_amount::TEXT || ')'),
      (v_journal_id, 2, v_from_account_id, 0, v_from_amount,
       'Transfer Out: ' || NEW.transfer_number || ' (' || v_from_currency || ' ' || v_from_amount::TEXT || ')');
  END IF;

  -- Update fund transfer with journal and status
  UPDATE fund_transfers
  SET
    journal_entry_id = v_journal_id,
    status = 'posted',
    posted_at = now(),
    posted_by = NEW.created_by
  WHERE id = NEW.id;

  -- Link to bank statement lines if provided
  IF NEW.from_bank_statement_line_id IS NOT NULL THEN
    UPDATE bank_statement_lines
    SET
      matched_fund_transfer_id = NEW.id,
      reconciliation_status = 'matched',
      matched_at = now(),
      matched_by = NEW.created_by,
      notes = 'Linked to Fund Transfer ' || NEW.transfer_number
    WHERE id = NEW.from_bank_statement_line_id;
  END IF;

  IF NEW.to_bank_statement_line_id IS NOT NULL THEN
    UPDATE bank_statement_lines
    SET
      matched_fund_transfer_id = NEW.id,
      reconciliation_status = 'matched',
      matched_at = now(),
      matched_by = NEW.created_by,
      notes = 'Linked to Fund Transfer ' || NEW.transfer_number
    WHERE id = NEW.to_bank_statement_line_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Also add idempotency to the RPC post_fund_transfer_journal function
CREATE OR REPLACE FUNCTION post_fund_transfer_journal(p_transfer_id UUID, p_user_id UUID DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_transfer RECORD;
  v_journal_id UUID;
  v_from_account_id UUID;
  v_to_account_id UUID;
  v_description TEXT;
BEGIN
  SELECT * INTO v_transfer FROM fund_transfers WHERE id = p_transfer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund transfer not found';
  END IF;

  -- IDEMPOTENCY: If already posted, return existing journal entry ID
  IF v_transfer.journal_entry_id IS NOT NULL THEN
    RETURN v_transfer.journal_entry_id;
  END IF;

  -- Also check by reference number
  SELECT id INTO v_journal_id FROM journal_entries
  WHERE reference_number = v_transfer.transfer_number
  AND source_module = 'fund_transfers'
  ORDER BY created_at DESC LIMIT 1;

  IF v_journal_id IS NOT NULL THEN
    UPDATE fund_transfers SET journal_entry_id = v_journal_id WHERE id = p_transfer_id;
    RETURN v_journal_id;
  END IF;

  -- Determine accounts
  IF v_transfer.from_account_type = 'petty_cash' THEN
    SELECT id INTO v_from_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN
    SELECT id INTO v_from_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF v_transfer.from_account_type = 'bank' THEN
    SELECT coa_id INTO v_from_account_id FROM bank_accounts WHERE id = v_transfer.from_bank_account_id;
  END IF;

  IF v_transfer.to_account_type = 'petty_cash' THEN
    SELECT id INTO v_to_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN
    SELECT id INTO v_to_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF v_transfer.to_account_type = 'bank' THEN
    SELECT coa_id INTO v_to_account_id FROM bank_accounts WHERE id = v_transfer.to_bank_account_id;
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
    (v_journal_id, v_to_account_id, v_transfer.amount, 0, 'Transfer In'),
    (v_journal_id, v_from_account_id, 0, v_transfer.amount, 'Transfer Out');

  UPDATE fund_transfers SET journal_entry_id = v_journal_id WHERE id = p_transfer_id;

  RETURN v_journal_id;
END;
$$;
