/*
  # Fix petty cash duplicate journal entries

  ## Root cause
  A restore migration created petty_cash journal entries with:
    reference_id     = NULL
    reference_number = 'PC-' || petty_cash_transactions.id::text   ← UUID format

  The correct trigger-created entries have:
    reference_id     = petty_cash_transactions.id
    reference_number = petty_cash_transactions.transaction_number   ← PC-YYYYMM-NNN format

  Both show up in Account Ledger account 1102 → visible double entries per transaction.

  ## Delete guard — all five conditions must hold before any row is deleted
    1. source_module = 'petty_cash'
    2. reference_id IS NULL
    3. reference_number matches '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       (the 'PC-' prefix followed by exactly a 36-char lowercase UUID — never matches PC-202601-006)
    4. SUBSTRING(reference_number FROM 4)::uuid successfully casts to uuid
       (implicitly guaranteed by the regex in condition 3)
    5. EXISTS a correct journal entry:
         source_module = 'petty_cash'
         reference_id  = that extracted UUID
       If the correct entry is missing, the wrong entry is left alone.

  ## Trigger fix
  trigger_delete_petty_cash_journals (plural) + function delete_petty_cash_journal_entries()
  keyed on reference_number = 'PC-' || OLD.id::text — only matched UUID-format duplicates,
  leaving the correct entry orphaned on petty_cash_transactions delete.
  Dropping it; recreating the correct single trigger (trigger_delete_petty_cash_journal)
  that deletes by reference_id = OLD.id.

  ## Orphan backfill (step 1a — runs before any deletes)
  A PC-<uuid> journal entry where no correct reference_id entry exists is an orphan,
  not a duplicate. It must NOT be deleted; instead its fields are repaired:
    reference_id     ← extracted UUID (= petty_cash_transactions.id)
    reference_number ← pct.transaction_number (= PC-YYYYMM-NNN)
  Guard: extracted UUID must exist in petty_cash_transactions AND no correct entry exists.
  After repair the row is a valid reference_id-linked entry and will not be touched
  by the duplicate-delete guard (which requires reference_id IS NULL).

  ## Order of operations
  1. Pre-flight NOTICE — count orphans and duplicates before any change
  1a. Orphan backfill (UPDATE, not delete)
  2. Delete lines first (FK child), then headers (FK parent) — duplicates only
  3. Create IMMUTABLE helper function (no side effects, needed for index)
  4. Create two unique indexes for future protection
  5. Drop bad trigger + both possible bad function names (IF EXISTS — safe if already gone)
  6. Recreate correct delete trigger
*/

-- ===========================================================================
-- 1. PRE-FLIGHT: count orphans and duplicates — inspect NOTICEs before commit
-- ===========================================================================
DO $$
DECLARE
  v_orphans  integer;
  v_headers  integer;
  v_lines    integer;
BEGIN
  -- Orphans: UUID-format reference_number, extracted UUID exists in petty_cash_transactions,
  --          but NO correct journal entry (reference_id = that UUID) exists yet.
  --          These will be REPAIRED (not deleted).
  SELECT COUNT(*) INTO v_orphans
  FROM public.journal_entries je
  WHERE je.source_module    = 'petty_cash'
    AND je.reference_id     IS NULL
    AND je.reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM public.petty_cash_transactions pct
      WHERE pct.id = SUBSTRING(je.reference_number FROM 4)::uuid
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entries je2
      WHERE je2.source_module = 'petty_cash'
        AND je2.reference_id  = SUBSTRING(je.reference_number FROM 4)::uuid
    );

  -- Duplicates: UUID-format reference_number AND a correct entry already exists.
  --             These will be DELETED.
  SELECT COUNT(*) INTO v_headers
  FROM public.journal_entries je
  WHERE je.source_module    = 'petty_cash'
    AND je.reference_id     IS NULL
    AND je.reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM public.journal_entries je2
      WHERE je2.source_module = 'petty_cash'
        AND je2.reference_id  = SUBSTRING(je.reference_number FROM 4)::uuid
    );

  SELECT COUNT(*) INTO v_lines
  FROM public.journal_entry_lines jel
  WHERE jel.journal_entry_id IN (
    SELECT je.id FROM public.journal_entries je
    WHERE je.source_module    = 'petty_cash'
      AND je.reference_id     IS NULL
      AND je.reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND EXISTS (
        SELECT 1 FROM public.journal_entries je2
        WHERE je2.source_module = 'petty_cash'
          AND je2.reference_id  = SUBSTRING(je.reference_number FROM 4)::uuid
      )
  );

  RAISE NOTICE '[petty_cash] Orphans to repair: %  |  Duplicate headers to delete: %  |  Duplicate lines to delete: %',
    v_orphans, v_headers, v_lines;
END $$;

-- ===========================================================================
-- 1a. ORPHAN BACKFILL: repair PC-<uuid> entries that have no correct counterpart.
--     Guard conditions (all must hold):
--       a. source_module = 'petty_cash'
--       b. reference_id IS NULL
--       c. reference_number matches UUID pattern
--       d. extracted UUID exists in petty_cash_transactions
--       e. NO correct journal entry already exists (reference_id = extracted UUID)
--     Action: set reference_id = pct.id, reference_number = pct.transaction_number.
--     After this UPDATE the row is a properly linked entry and is invisible
--     to the duplicate-delete guard below (which requires reference_id IS NULL).
-- ===========================================================================
UPDATE public.journal_entries je
SET
  reference_id     = pct.id,
  reference_number = pct.transaction_number
FROM public.petty_cash_transactions pct
WHERE je.source_module    = 'petty_cash'
  AND je.reference_id     IS NULL
  AND je.reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND pct.id              = SUBSTRING(je.reference_number FROM 4)::uuid
  AND NOT EXISTS (
    SELECT 1 FROM public.journal_entries je2
    WHERE je2.source_module = 'petty_cash'
      AND je2.reference_id  = pct.id
      AND je2.id           <> je.id
  );

-- ===========================================================================
-- 2. DELETE LINES belonging to wrong duplicate journal entries
--    Subquery identifies IDs with an explicit alias — no ambiguity.
--    Guard: source_module='petty_cash' AND reference_id IS NULL
--           AND reference_number ~ UUID pattern
--           AND a correct entry (reference_id = extracted UUID) EXISTS
-- ===========================================================================
DELETE FROM public.journal_entry_lines
WHERE journal_entry_id IN (
  SELECT je.id
  FROM public.journal_entries je
  WHERE je.source_module    = 'petty_cash'
    AND je.reference_id     IS NULL
    AND je.reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1
      FROM public.journal_entries je2
      WHERE je2.source_module = 'petty_cash'
        AND je2.reference_id  = SUBSTRING(je.reference_number FROM 4)::uuid
    )
);

-- ===========================================================================
-- 3. DELETE HEADERS of wrong duplicate journal entries (same five-condition guard)
--    Uses id IN (SELECT je.id ...) with explicit alias to avoid any ambiguity.
-- ===========================================================================
DELETE FROM public.journal_entries
WHERE id IN (
  SELECT je.id
  FROM public.journal_entries je
  WHERE je.source_module    = 'petty_cash'
    AND je.reference_id     IS NULL
    AND je.reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1
      FROM public.journal_entries je2
      WHERE je2.source_module = 'petty_cash'
        AND je2.reference_id  = SUBSTRING(je.reference_number FROM 4)::uuid
    )
);

-- ===========================================================================
-- 4. IMMUTABLE HELPER: petty_cash_resolved_tx_id(reference_id, reference_number)
--
--    Returns the petty_cash_transactions.id regardless of how it was stored:
--      (pct.id, 'PC-YYYYMM-NNN')  → pct.id         [correct trigger entry]
--      (NULL,   'PC-<uuid>')       → extracted UUID  [wrong restore entry — now deleted,
--                                                      but index blocks future re-inserts]
--      (NULL,   NULL)              → NULL             [not indexed — skip]
--      (NULL,   'PC-202601-006')   → NULL             [human number, not a UUID — skip]
--      (NULL,   'anything-else')   → NULL             [skip]
--
--    IMMUTABLE + pure SQL — PostgreSQL allows this in index expressions.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.petty_cash_resolved_tx_id(
  p_reference_id     uuid,
  p_reference_number text
)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    p_reference_id,
    CASE
      WHEN p_reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN SUBSTRING(p_reference_number FROM 4)::uuid
      ELSE NULL::uuid
    END
  )
$$;

-- ===========================================================================
-- 5a. FAST INDEX: (source_module, reference_id) WHERE NOT NULL
--     Prevents any future duplicate entry that sets reference_id directly.
-- ===========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uniq_journal_entries_petty_cash_reference_id
  ON public.journal_entries (source_module, reference_id)
  WHERE source_module = 'petty_cash'
    AND reference_id IS NOT NULL;

-- ===========================================================================
-- 5b. STRONG INDEX: (source_module, resolved_tx_id) WHERE NOT NULL
--     Prevents future bad restore migrations that insert reference_id=NULL with
--     reference_number='PC-<uuid>' for a transaction that already has a correct entry.
--     COALESCE resolves both storage forms to the same uuid → unique violation.
-- ===========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uniq_petty_cash_resolved_tx_id
  ON public.journal_entries (
    source_module,
    public.petty_cash_resolved_tx_id(reference_id, reference_number)
  )
  WHERE source_module = 'petty_cash'
    AND public.petty_cash_resolved_tx_id(reference_id, reference_number) IS NOT NULL;

-- ===========================================================================
-- 6. DROP BAD DELETE TRIGGER + BOTH POSSIBLE FUNCTION NAMES (IF EXISTS = safe)
-- ===========================================================================
DROP TRIGGER IF EXISTS trigger_delete_petty_cash_journals ON public.petty_cash_transactions;
DROP FUNCTION IF EXISTS public.delete_petty_cash_journals();
DROP FUNCTION IF EXISTS public.delete_petty_cash_journal_entries();

-- ===========================================================================
-- 7. CORRECT DELETE TRIGGER: deletes by reference_id = OLD.id
--    Drops + recreates so it is always in the correct final state.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.delete_petty_cash_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete child lines first to respect FK ordering
  DELETE FROM journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM journal_entries
    WHERE source_module = 'petty_cash'
      AND reference_id  = OLD.id
  );
  -- Delete parent header
  DELETE FROM journal_entries
  WHERE source_module = 'petty_cash'
    AND reference_id  = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_delete_petty_cash_journal ON public.petty_cash_transactions;
CREATE TRIGGER trigger_delete_petty_cash_journal
  AFTER DELETE ON public.petty_cash_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.delete_petty_cash_journal();


-- ===========================================================================
-- VERIFICATION SQL — run these SELECT statements AFTER applying the migration
-- ===========================================================================

-- V1. Count remaining PC-uuid journal entries (must be 0)
-- SELECT COUNT(*)  AS remaining_uuid_duplicates
-- FROM public.journal_entries
-- WHERE source_module    = 'petty_cash'
--   AND reference_id     IS NULL
--   AND reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- V2. Count petty_cash transactions that still have more than one journal entry
--     via the resolved ID. Must return 0 rows.
-- SELECT
--   public.petty_cash_resolved_tx_id(reference_id, reference_number) AS resolved_tx_id,
--   COUNT(*)                                                           AS je_count
-- FROM public.journal_entries
-- WHERE source_module = 'petty_cash'
--   AND public.petty_cash_resolved_tx_id(reference_id, reference_number) IS NOT NULL
-- GROUP BY 1
-- HAVING COUNT(*) > 1;

-- V3. First 20 suspicious petty_cash journal entries still having reference_id=NULL.
--     After migration these should all have reference_number NOT matching the UUID pattern.
-- SELECT id, reference_id, reference_number, entry_number, entry_date, created_at
-- FROM public.journal_entries
-- WHERE source_module = 'petty_cash'
--   AND reference_id IS NULL
-- ORDER BY created_at DESC
-- LIMIT 20;

-- V4. Account 1102 (Petty Cash) ledger duplicate check.
--     Each petty_cash_transaction should appear exactly once. Must return 0 rows.
-- WITH pc_coa AS (
--   SELECT id FROM public.chart_of_accounts WHERE code = '1102' LIMIT 1
-- )
-- SELECT
--   pct.transaction_number,
--   pct.transaction_date,
--   COUNT(jel.id) AS ledger_line_count
-- FROM public.petty_cash_transactions pct
-- JOIN public.journal_entries je
--   ON je.source_module = 'petty_cash'
--  AND public.petty_cash_resolved_tx_id(je.reference_id, je.reference_number) = pct.id
-- JOIN public.journal_entry_lines jel
--   ON jel.journal_entry_id = je.id
--  AND jel.account_id = (SELECT id FROM pc_coa)
-- GROUP BY pct.transaction_number, pct.transaction_date
-- HAVING COUNT(jel.id) > 1
-- ORDER BY pct.transaction_date;
