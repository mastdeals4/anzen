-- Extend delete_fund_transfer so that 'reversed' transfers can also be deleted.
-- Rule: pending / cancelled / reversed = hard delete; posted = must reverse first.
--
-- Also cleans up BOTH the original JE and the reversal JE (REV-<transfer_number>)
-- and their lines, then bank reconciliation links and petty cash rows.
CREATE OR REPLACE FUNCTION public.delete_fund_transfer(p_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_transfer_number text;
BEGIN
  SELECT status, transfer_number
    INTO v_status, v_transfer_number
    FROM fund_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund transfer % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'Posted fund transfer cannot be deleted. Reverse it first, then delete.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Break FK cycle first (fund_transfers.journal_entry_id -> journal_entries ON DELETE SET NULL).
  UPDATE fund_transfers SET journal_entry_id = NULL WHERE id = p_id;

  -- Clear the reversal-pointer on the ORIGINAL JE so deleting the reversal JE
  -- does not trip a cascade-back on the original JE row.
  UPDATE journal_entries
     SET is_reversed    = false,
         reversed_by_id = NULL
   WHERE reversed_by_id IN (
     SELECT id FROM journal_entries
      WHERE source_module = 'fund_transfers'
        AND reference_id  = p_id
   );

  -- Delete BOTH the original JE and the reversal JE (if any) and all their lines.
  -- Reversal JE has reference_number = 'REV-' || transfer_number.
  DELETE FROM journal_entry_lines
   WHERE journal_entry_id IN (
     SELECT id FROM journal_entries
      WHERE source_module = 'fund_transfers'
        AND (reference_id = p_id
             OR reference_number = v_transfer_number
             OR reference_number = 'REV-' || v_transfer_number)
   );

  DELETE FROM journal_entries
   WHERE source_module = 'fund_transfers'
     AND (reference_id = p_id
          OR reference_number = v_transfer_number
          OR reference_number = 'REV-' || v_transfer_number);

  -- Unlink bank reconciliation.
  UPDATE bank_statement_lines
     SET matched_fund_transfer_id = NULL,
         reconciliation_status    = 'unmatched',
         matched_at               = NULL,
         matched_by               = NULL
   WHERE matched_fund_transfer_id = p_id;

  -- Linked petty cash allocations.
  DELETE FROM petty_cash_transactions WHERE fund_transfer_id = p_id;

  -- Finally the transfer row itself.
  DELETE FROM fund_transfers WHERE id = p_id;
END $$;

GRANT EXECUTE ON FUNCTION public.delete_fund_transfer(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_fund_transfer(uuid) FROM anon;
