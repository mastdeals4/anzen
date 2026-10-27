-- ============================================================================
-- Fund transfer delete + reversal
-- ----------------------------------------------------------------------------
-- Root cause of the "tuple already modified" error on DELETE FROM fund_transfers:
--   A row-level trigger on fund_transfers ran
--     DELETE FROM journal_entries WHERE source_module='fund_transfers' ...
--   INSIDE the DELETE. That JE delete cascaded back through
--     fund_transfers.journal_entry_id  REFERENCES journal_entries(id) ON DELETE SET NULL
--   and issued an UPDATE on the same fund_transfers row that Postgres was
--   already deleting -> "tuple already modified by an operation triggered
--   by the current command".
--
-- Fix: drop that self-mutating trigger and move reversal into an RPC that runs
-- the steps in the correct order, breaking the FK cycle before touching JEs
-- and deleting the fund_transfers row LAST.
-- ============================================================================

-- 1. Drop the trigger + function that cause the cascade-back self-mutation.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tgname FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_proc  p ON p.oid = t.tgfoid
    WHERE c.relname = 'fund_transfers'
      AND p.proname = 'delete_fund_transfer_journal_entries'
      AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.fund_transfers', r.tgname);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.delete_fund_transfer_journal_entries();

-- 2. Extend the status CHECK to allow 'reversed' + add reversed_at / reversed_by.
ALTER TABLE fund_transfers
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid;

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT conname INTO v_conname
    FROM pg_constraint
   WHERE conrelid = 'public.fund_transfers'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE fund_transfers DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE fund_transfers
    ADD CONSTRAINT fund_transfers_status_check
    CHECK (status IN ('pending','posted','cancelled','reversed'));
END $$;

-- 2b. Support index for the reference_number branch of the RPC lookups.
--     idx_je_source already covers (source_module, reference_id).
CREATE INDEX IF NOT EXISTS idx_je_source_refnum
  ON journal_entries(source_module, reference_number);

-- 3. delete_fund_transfer(p_id UUID) — pending / cancelled transfers only.
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
    FROM fund_transfers WHERE id = p_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund transfer % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'Posted fund transfer cannot be deleted. Use reverse_fund_transfer instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (a) Break the FK cycle first: NULL the parent's journal_entry_id BEFORE we
  --     touch journal_entries. This prevents ON DELETE SET NULL from firing
  --     an UPDATE on the row we are about to delete.
  UPDATE fund_transfers SET journal_entry_id = NULL WHERE id = p_id;

  -- (b) Reverse ledger entries. journal_entry_lines cascades ON DELETE from
  --     journal_entries, but we delete them explicitly to be safe against any
  --     future FK config drift.
  DELETE FROM journal_entry_lines
   WHERE journal_entry_id IN (
     SELECT id FROM journal_entries
      WHERE source_module = 'fund_transfers'
        AND (reference_id = p_id
             OR reference_number = v_transfer_number)
   );

  DELETE FROM journal_entries
   WHERE source_module = 'fund_transfers'
     AND (reference_id = p_id
          OR reference_number = v_transfer_number);

  -- (c) Reverse bank balances / reconciliation state.
  UPDATE bank_statement_lines
     SET matched_fund_transfer_id = NULL,
         reconciliation_status    = 'unmatched',
         matched_at               = NULL,
         matched_by               = NULL
   WHERE matched_fund_transfer_id = p_id;

  -- (d) Remove linked petty-cash allocations.
  DELETE FROM petty_cash_transactions WHERE fund_transfer_id = p_id;

  -- (e) Finally delete the fund transfer row itself. No trigger on
  --     fund_transfers now touches this row on DELETE, so Postgres cannot
  --     encounter the "tuple already modified" error.
  DELETE FROM fund_transfers WHERE id = p_id;
END $$;

GRANT EXECUTE ON FUNCTION public.delete_fund_transfer(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_fund_transfer(uuid) FROM anon;

-- 4. reverse_fund_transfer(p_id UUID) — posted transfers only.
--    Posts a reversing JE (debit/credit flipped), marks status='reversed',
--    preserves the original row for audit.
CREATE OR REPLACE FUNCTION public.reverse_fund_transfer(p_id UUID)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row               fund_transfers%ROWTYPE;
  v_original_je_id    uuid;
  v_new_je_id         uuid;
  v_new_je_number     text;
BEGIN
  SELECT * INTO v_row FROM fund_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund transfer % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_row.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted fund transfers can be reversed (current status: %)', v_row.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_original_je_id
    FROM journal_entries
   WHERE source_module = 'fund_transfers'
     AND (reference_id = p_id
          OR reference_number = v_row.transfer_number)
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_original_je_id IS NULL THEN
    RAISE EXCEPTION 'Original journal entry for fund transfer % not found', v_row.transfer_number
      USING ERRCODE = 'no_data_found';
  END IF;

  v_new_je_number := 'REV-' || v_row.transfer_number;

  -- Post reversing header. Schema: entry_number / entry_date / source_module /
  -- reference_id / reference_number / description / is_posted / created_by.
  INSERT INTO journal_entries (
    entry_number, entry_date, description,
    source_module, reference_id, reference_number,
    is_posted, created_by
  )
  SELECT
    v_new_je_number,
    CURRENT_DATE,
    'Reversal of ' || COALESCE(je.description, je.entry_number),
    'fund_transfers',
    p_id,
    v_new_je_number,
    true,
    auth.uid()
  FROM journal_entries je WHERE je.id = v_original_je_id
  RETURNING id INTO v_new_je_id;

  -- Mark the original JE as reversed and link.
  UPDATE journal_entries
     SET is_reversed = true,
         reversed_by_id = v_new_je_id
   WHERE id = v_original_je_id;

  -- Post reversing lines: swap debit/credit. Real column names: debit / credit.
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description,
    debit, credit
  )
  SELECT
    v_new_je_id, line_number, account_id, 'REV: ' || COALESCE(description, ''),
    credit, debit
  FROM journal_entry_lines
  WHERE journal_entry_id = v_original_je_id;

  UPDATE fund_transfers
     SET status      = 'reversed',
         reversed_at = now(),
         reversed_by = auth.uid()
   WHERE id = p_id;

  RETURN v_new_je_id;
END $$;

GRANT EXECUTE ON FUNCTION public.reverse_fund_transfer(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_fund_transfer(uuid) FROM anon;
