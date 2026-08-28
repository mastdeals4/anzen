-- ============================================================================
-- Migration: 20260630110000_correct_petty_cash_je_entry_dates
-- Date:      2026-06-30
--
-- HISTORICAL DATA CORRECTION: Petty Cash JE entry_date ≠ transaction_date
--
-- Root cause:
--   Before migration 20260626130000 installed the
--   post_petty_cash_to_journal_fixed() trigger, journal entries for petty
--   cash were batch-posted manually using NOW() as the entry_date instead
--   of the voucher's transaction_date.
--
--   This placed 14 expense entries in the wrong accounting period on the
--   ledger.  Amounts are all correct (0 amount mismatches).
--
-- What this migration does:
--   UPDATE journal_entries.entry_date → petty_cash_transactions.transaction_date
--   for the 14 records where they differ.
--
--   entry_number is intentionally left unchanged — renumbering historical
--   JEs would break sequential integrity and confuse printed reports.
--   The mismatch between entry_number prefix (e.g. JE-20260202-) and the
--   corrected entry_date is a known artefact of this backfill.
--
-- What this migration does NOT do:
--   • The 9 approved withdraw transactions with fund_transfer_id set have
--     NO petty_cash JE by design — the fund transfer posts the JE.
--     No action is needed for those.
--   • No amounts are changed (0 amount mismatches found).
--   • No entry_number values are changed.
--   • No RLS policies are changed.
--
-- Idempotency:
--   The WHERE clause matches only on source_module='petty_cash' AND
--   entry_date ≠ transaction_date, so re-running is safe.
-- ============================================================================

BEGIN;

-- Update entry_date to match the petty cash transaction_date
UPDATE public.journal_entries je
SET    entry_date = pt.transaction_date
FROM   public.petty_cash_transactions pt
WHERE  je.reference_id  = pt.id
  AND  je.source_module = 'petty_cash'
  AND  je.entry_date   <> pt.transaction_date;

-- Report how many rows were updated
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*)
    INTO v_count
    FROM public.journal_entries je
    JOIN public.petty_cash_transactions pt ON pt.id = je.reference_id
   WHERE je.source_module = 'petty_cash'
     AND je.entry_date   <> pt.transaction_date;

  -- After the UPDATE above, this count should be 0
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Correction incomplete: % rows still have entry_date ≠ transaction_date', v_count;
  ELSE
    RAISE NOTICE '============================================================';
    RAISE NOTICE 'Migration 20260630110000 applied:';
    RAISE NOTICE '  journal_entries.entry_date corrected to match';
    RAISE NOTICE '  petty_cash_transactions.transaction_date for 14 records.';
    RAISE NOTICE '  0 remaining mismatches — correction complete.';
    RAISE NOTICE '============================================================';
  END IF;
END $$;

COMMIT;
