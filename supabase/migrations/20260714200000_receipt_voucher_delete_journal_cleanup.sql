-- ============================================================================
-- Receipt Voucher — cascade journal cleanup on delete
-- ============================================================================
-- Audit finding (2026-07-14):
--   post_receipt_voucher_journal (20251216150001) posts an "acct receipt"
--   JE on INSERT (Dr Bank, Cr A/R via journal_entry_lines). When a receipt
--   voucher is deleted the frontend clears voucher_allocations and BSL
--   links, but no trigger or RPC touches the journal_entries + lines
--   rows. Result: Party Ledger, Bank Ledger, Trial Balance, and P&L keep
--   an orphaned reversal-less entry. Same class of bug that
--   20260619170000 closed for petty_cash — just never installed for RV.
--
-- This mirrors public.delete_petty_cash_journal exactly:
--   AFTER DELETE trigger on receipt_vouchers
--   → DELETE journal_entry_lines WHERE journal_entry_id IN (…)
--   → DELETE journal_entries     WHERE source_module='receipt' AND reference_id=OLD.id
--
-- Also releases any bank_statement_lines that were matched via
-- matched_entry_id (not just matched_receipt_id) so BSL never keeps a
-- stale FK to a deleted JE. matched_receipt_id already has ON DELETE
-- SET NULL from 20260703180000.
--
-- Note on bank_statement_lines.updated_at:
--   Two conflicting CREATE TABLE IF NOT EXISTS definitions exist in
--   the migration history (20251216150001 includes updated_at,
--   20251230043928 does not). Whichever ran first wins. This migration
--   does NOT write updated_at — there is no owning trigger to bump it
--   consistently across environments, and the write threw
--   ERROR 42703 in prod. matched_at is the authoritative recon
--   timestamp; setting it to NULL is enough.
--
-- Additive, idempotent.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_receipt_voucher_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_ids uuid[];
BEGIN
  -- Collect every JE posted by this RV. reference_number OR reference_id can
  -- carry the link depending on when the RV was posted; we look up both.
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_je_ids
    FROM public.journal_entries
   WHERE source_module = 'receipt'
     AND (reference_id = OLD.id
          OR (OLD.journal_entry_id IS NOT NULL AND id = OLD.journal_entry_id));

  IF array_length(v_je_ids, 1) IS NULL THEN
    RETURN OLD;
  END IF;

  -- Release BSL matches on matched_entry_id (matched_receipt_id already
  -- clears itself via ON DELETE SET NULL, but the untyped JE FK doesn't).
  -- Do NOT touch updated_at — the column is not present in every env.
  UPDATE public.bank_statement_lines
     SET matched_entry_id      = NULL,
         reconciliation_status = 'unmatched',
         matched_at            = NULL
   WHERE matched_entry_id = ANY (v_je_ids);

  -- bank_reconciliation_items.journal_entry_id has ON DELETE SET NULL
  -- (installed in 20260714150000), so no explicit unlink needed.

  DELETE FROM public.journal_entry_lines WHERE journal_entry_id = ANY (v_je_ids);
  DELETE FROM public.journal_entries     WHERE id = ANY (v_je_ids);

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_delete_receipt_voucher_journal ON public.receipt_vouchers;
CREATE TRIGGER trg_delete_receipt_voucher_journal
  AFTER DELETE ON public.receipt_vouchers
  FOR EACH ROW
  EXECUTE FUNCTION public.delete_receipt_voucher_journal();

COMMENT ON FUNCTION public.delete_receipt_voucher_journal() IS
  'Cascade cleanup of journal_entries + journal_entry_lines when a receipt_voucher is deleted. Mirrors delete_petty_cash_journal from 20260619170000. Also releases matched_entry_id on bank_statement_lines so BSL never keeps a stale FK.';

-- Backfill: repair any orphaned "receipt" JEs whose RV no longer exists.
-- Safe on a clean DB (no-op). Same updated_at caveat applies.
DO $$
DECLARE v_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(je.id), ARRAY[]::uuid[]) INTO v_ids
  FROM public.journal_entries je
  WHERE je.source_module = 'receipt'
    AND NOT EXISTS (
      SELECT 1 FROM public.receipt_vouchers rv WHERE rv.id = je.reference_id
    );

  IF array_length(v_ids, 1) IS NOT NULL THEN
    UPDATE public.bank_statement_lines
       SET matched_entry_id      = NULL,
           reconciliation_status = 'unmatched',
           matched_at            = NULL
     WHERE matched_entry_id = ANY (v_ids);

    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = ANY (v_ids);
    DELETE FROM public.journal_entries     WHERE id = ANY (v_ids);

    RAISE NOTICE 'delete_receipt_voucher_journal backfill: cleaned % orphan receipt JE(s).', array_length(v_ids, 1);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
