-- ============================================================================
-- Re-backfill PPh period totals (idempotent safety net)
-- ============================================================================
-- Context:
--   20260713200000 fixed compute_period_ppn PPh branch to use date-based
--   lookup (EXTRACT year+month from expense_date / voucher_date) instead of
--   tax_period_id, which was always a PPN period ID and therefore always
--   returned 0 rows for PPh. It also ran a backfill at that time.
--
--   20260713190000 (single-engine migration) ran its own backfill BEFORE
--   20260713200000 applied the date-based fix, meaning any environment where
--   these migrations ran in a fresh sequence ended up with PPh totals zeroed
--   by 20260713190000's backfill and only partially corrected if
--   20260713200000 ran successfully afterward.
--
--   This migration is a safe re-run: it calls the CURRENT (already-live)
--   compute_period_ppn on every PPh period. Because compute_period_ppn now
--   uses date-based lookup, this is guaranteed to produce correct totals.
--   It is pure SELECT + UPDATE — no schema changes, no data destruction.
--
-- Safe to run multiple times. No net effect if totals are already correct.
-- ============================================================================

BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id FROM tax_periods
    WHERE tax_type <> 'PPN'
    ORDER BY fiscal_year, period_month
  LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
