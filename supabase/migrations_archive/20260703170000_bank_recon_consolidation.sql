/*
  # Bank Reconciliation Consolidation — 2026-07-03

  Canonical rule: every match writer persists BOTH matched_entry_id (canonical
  link to the JE) AND the relevant typed FK (matched_expense_id, matched_receipt_id,
  matched_fund_transfer_id, matched_petty_cash_id). Client writers were fixed in
  BankReconciliationEnhanced.tsx. This migration:

    1. Fixes unmatch_bank_line RPC — was writing reconciliation_status='pending',
       which is not a legal value under the CHECK constraint. Changed to
       'unmatched'. matching_status='none' is preserved because other functions
       still read matching_status ('confirmed', 'suggested', 'none').

    2. Extends auto_post_fund_transfer_journal trigger to also set
       matched_entry_id (= NEW.journal_entry_id) when it writes
       matched_fund_transfer_id.

    3. One-shot data repair (idempotent DO block):
         - back-fill matched_entry_id from typed FKs where possible
         - reset orphaned matched/recorded rows (all FKs null) to 'unmatched'
         - fix rows previously corrupted by the buggy unmatch_bank_line
           (reconciliation_status='pending' → 'unmatched')

  Schema notes verified before writing:
    - petty_cash_transactions has NO journal_entry_id column. JEs link via
      journal_entries.source_module='petty_cash' AND reference_id=pct.id.
    - finance_expenses has NO journal_entry_id column. JEs link via
      journal_entries.source_module='expenses' AND reference_number='EXP-'||fe.id.
    - receipt_vouchers.journal_entry_id exists.
    - fund_transfers.journal_entry_id exists.
    - payment_vouchers.journal_entry_id exists.

  Safe to re-run.
*/

-- ─────────────────────────────────────────────────────────────────
-- 1. Fix unmatch_bank_line: 'pending' is not a legal reconciliation_status
-- ─────────────────────────────────────────────────────────────────
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
      reconciliation_status = 'unmatched', matched_at = NULL, matched_by = NULL, notes = NULL
  WHERE id = p_bank_line_id;

  RETURN jsonb_build_object('success', true, 'message', 'Match removed successfully');
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 2. Extend auto_post_fund_transfer_journal trigger: also set matched_entry_id
--    (verbatim copy of the current body from migration 20260224044022_...,
--     with matched_entry_id added to the two bank_statement_lines UPDATEs)
-- ─────────────────────────────────────────────────────────────────
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

  UPDATE fund_transfers
  SET
    journal_entry_id = v_journal_id,
    status = 'posted',
    posted_at = now(),
    posted_by = NEW.created_by
  WHERE id = NEW.id;

  -- Link to bank statement lines if provided. Persist BOTH the typed FK
  -- (matched_fund_transfer_id) AND the canonical FK (matched_entry_id) so
  -- the display can resolve the source doc either way.
  IF NEW.from_bank_statement_line_id IS NOT NULL THEN
    UPDATE bank_statement_lines
    SET
      matched_fund_transfer_id = NEW.id,
      matched_entry_id = v_journal_id,
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
      matched_entry_id = v_journal_id,
      reconciliation_status = 'matched',
      matched_at = now(),
      matched_by = NEW.created_by,
      notes = 'Linked to Fund Transfer ' || NEW.transfer_number
    WHERE id = NEW.to_bank_statement_line_id;
  END IF;

  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 3. One-shot data repair (idempotent — safe to re-run)
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Back-fill matched_entry_id from typed FKs where the target document
  -- already has (or resolves to) a journal_entry_id.

  -- petty_cash_transactions: no journal_entry_id column; JE linked via
  -- journal_entries.source_module='petty_cash' AND reference_id=pct.id.
  UPDATE bank_statement_lines b
     SET matched_entry_id = je.id
    FROM journal_entries je
   WHERE b.matched_petty_cash_id IS NOT NULL
     AND b.matched_entry_id IS NULL
     AND je.source_module = 'petty_cash'
     AND je.reference_id  = b.matched_petty_cash_id;

  -- finance_expenses: no journal_entry_id column; JE linked via
  -- journal_entries.source_module='expenses' AND reference_number='EXP-<id>'.
  UPDATE bank_statement_lines b
     SET matched_entry_id = je.id
    FROM journal_entries je
   WHERE b.matched_expense_id IS NOT NULL
     AND b.matched_entry_id IS NULL
     AND je.source_module = 'expenses'
     AND je.reference_number = 'EXP-' || b.matched_expense_id::text;

  UPDATE bank_statement_lines b
     SET matched_entry_id = rv.journal_entry_id
    FROM receipt_vouchers rv
   WHERE b.matched_receipt_id = rv.id
     AND b.matched_entry_id IS NULL
     AND rv.journal_entry_id IS NOT NULL;

  UPDATE bank_statement_lines b
     SET matched_entry_id = ft.journal_entry_id
    FROM fund_transfers ft
   WHERE b.matched_fund_transfer_id = ft.id
     AND b.matched_entry_id IS NULL
     AND ft.journal_entry_id IS NOT NULL;

  -- Reset truly orphaned rows to unmatched (all FKs null, but status
  -- matched/recorded — the "⚠️ No link found" symptom).
  UPDATE bank_statement_lines
     SET reconciliation_status = 'unmatched',
         matched_at = NULL,
         matched_by = NULL,
         notes = COALESCE(NULLIF(notes,'') || ' | ', '') || 'REPAIR 2026-07: orphan link cleared'
   WHERE reconciliation_status IN ('matched','recorded')
     AND matched_entry_id         IS NULL
     AND matched_expense_id       IS NULL
     AND matched_receipt_id       IS NULL
     AND matched_fund_transfer_id IS NULL
     AND matched_petty_cash_id    IS NULL;

  -- Repair rows previously corrupted by the buggy unmatch_bank_line
  -- (reconciliation_status='pending' is not a legal CHECK value).
  UPDATE bank_statement_lines
     SET reconciliation_status = 'unmatched'
   WHERE reconciliation_status = 'pending';
END $$;
