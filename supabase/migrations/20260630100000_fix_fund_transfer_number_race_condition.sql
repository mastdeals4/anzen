-- ============================================================================
-- Migration: 20260630100000_fix_fund_transfer_number_race_condition
-- Date:      2026-06-30
--
-- BUG 2 FIX: "duplicate key value violates unique constraint
--             fund_transfers_transfer_number_key" on Fund Transfer save
--
-- Root cause:
--   generate_fund_transfer_number() uses COUNT(*) with no transaction lock:
--
--     SELECT COUNT(*) INTO v_count
--     FROM fund_transfers
--     WHERE transfer_number LIKE 'FT' || v_year || v_month || '%';
--
--     v_number := 'FT' || v_year || v_month || '-' || LPAD((v_count + 1)::TEXT, 4, '0');
--
--   Two concurrent sessions both read the same COUNT(*), both generate the
--   same transfer_number, both attempt INSERT → second one hits the UNIQUE
--   constraint on fund_transfers.transfer_number.
--
--   Additionally, COUNT(*) is incorrect when rows have been deleted (it will
--   generate a number that already existed before the deletion).
--
-- Fix:
--   1. Add pg_advisory_xact_lock per month to serialize number generation —
--      the same pattern used by petty cash JE numbering (migration 20260626130000).
--   2. Replace COUNT(*) with COALESCE(MAX(CAST(substring AS INT)), 0) + 1
--      which is correct even when rows have been deleted (no gaps issue).
--
-- Existing transfer numbers are unchanged — no data modifications.
-- Idempotency: CREATE OR REPLACE is safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.generate_fund_transfer_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year   TEXT;
  v_month  TEXT;
  v_prefix TEXT;
  v_max    INT;
  v_number TEXT;
BEGIN
  v_year   := TO_CHAR(CURRENT_DATE, 'YY');
  v_month  := TO_CHAR(CURRENT_DATE, 'MM');
  v_prefix := 'FT' || v_year || v_month;

  -- Serialise concurrent calls for the same calendar month so that
  -- two sessions cannot both read the same MAX and generate the same number.
  -- Lock is scoped to the transaction; released automatically on commit/rollback.
  PERFORM pg_advisory_xact_lock(
    hashtext('ft_number_' || v_year || v_month)
  );

  -- Use MAX(parsed sequence) instead of COUNT(*) so that:
  --   a) deleted rows do not cause duplicate numbers
  --   b) the result is always one higher than the largest existing number
  SELECT COALESCE(
           MAX(
             CAST(
               SUBSTRING(transfer_number FROM '^FT\d{4}-(\d+)$')
               AS INTEGER
             )
           ),
           0
         ) + 1
    INTO v_max
    FROM fund_transfers
   WHERE transfer_number LIKE v_prefix || '-%';

  v_number := v_prefix || '-' || LPAD(v_max::TEXT, 4, '0');
  RETURN v_number;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_fund_transfer_number() TO authenticated;

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Bug fix 20260630100000 applied:';
  RAISE NOTICE '  generate_fund_transfer_number():';
  RAISE NOTICE '    - Added pg_advisory_xact_lock (prevents duplicate under concurrency)';
  RAISE NOTICE '    - Replaced COUNT(*) with MAX(+1) (correct even with gaps)';
  RAISE NOTICE '    - Changed to SECURITY DEFINER for consistent execution context';
  RAISE NOTICE 'Fund Transfer (Contra) save now works correctly.';
  RAISE NOTICE 'Existing transfer numbers are unchanged.';
  RAISE NOTICE '============================================================';
END $$;
