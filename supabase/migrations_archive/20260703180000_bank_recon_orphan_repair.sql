/*
  # Bank Reconciliation — Orphaned typed-FK repair + FK cascade hardening

  The 2026-07-03 consolidation migration reset rows where ALL match FKs were
  NULL but reconciliation_status was 'matched'/'recorded'. It did NOT handle
  rows where a typed FK is still populated but points to a row that has been
  deleted — "dangling FK" orphans. Example: a Fund Transfer row was created
  ("TARIKAN TUNAI Rp 5,000,000" @ 2026-04-30), the trigger set
  matched_fund_transfer_id + reconciliation_status='matched' on the bsl row,
  the fund transfer was later removed via a code path that did not unlink the
  bsl, and now the display's `.in('id', ids)` lookup returns nothing → "No
  link found" while the FK column is still non-null.

  This migration:

    1. Nulls every dangling typed FK on bank_statement_lines
       (matched_entry_id, matched_expense_id, matched_receipt_id,
        matched_fund_transfer_id, matched_petty_cash_id).

    2. Re-runs the orphan → 'unmatched' reset from the 2026-07-03 migration
       so rows that just became all-FK-null get correctly reclassified.

    3. Adds FK constraints with ON DELETE SET NULL on every typed match FK
       so future deletions of the target document automatically clear the
       reconciliation link. Constraints are added only if missing (safe re-run).

  Additive. Idempotent. No data destroyed — only stale pointers cleared and
  orphaned status reclassified. No accounting/GL impact.
*/

-- ─────────────────────────────────────────────────────────────────
-- 1. Null out dangling typed FKs
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  UPDATE bank_statement_lines b
     SET matched_entry_id = NULL
   WHERE b.matched_entry_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = b.matched_entry_id);

  UPDATE bank_statement_lines b
     SET matched_expense_id = NULL
   WHERE b.matched_expense_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM finance_expenses WHERE id = b.matched_expense_id);

  UPDATE bank_statement_lines b
     SET matched_receipt_id = NULL
   WHERE b.matched_receipt_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM receipt_vouchers WHERE id = b.matched_receipt_id);

  UPDATE bank_statement_lines b
     SET matched_fund_transfer_id = NULL
   WHERE b.matched_fund_transfer_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM fund_transfers WHERE id = b.matched_fund_transfer_id);

  UPDATE bank_statement_lines b
     SET matched_petty_cash_id = NULL
   WHERE b.matched_petty_cash_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM petty_cash_transactions WHERE id = b.matched_petty_cash_id);
END $$;

-- ─────────────────────────────────────────────────────────────────
-- 2. Re-run the "all FKs null but status matched/recorded" reset
-- ─────────────────────────────────────────────────────────────────
UPDATE bank_statement_lines
   SET reconciliation_status = 'unmatched',
       matched_at = NULL,
       matched_by = NULL,
       notes = COALESCE(NULLIF(notes,'') || ' | ', '') || 'REPAIR 2026-07-03b: dangling FK cleared, reset to unmatched'
 WHERE reconciliation_status IN ('matched','recorded')
   AND matched_entry_id         IS NULL
   AND matched_expense_id       IS NULL
   AND matched_receipt_id       IS NULL
   AND matched_fund_transfer_id IS NULL
   AND matched_petty_cash_id    IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- 3. Install ON DELETE SET NULL FKs to prevent future dangling FKs.
--    Only add if not already present. Names are stable and readable.
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bsl_matched_entry_fk'
       AND conrelid = 'public.bank_statement_lines'::regclass
  ) THEN
    ALTER TABLE bank_statement_lines
      ADD CONSTRAINT bsl_matched_entry_fk
      FOREIGN KEY (matched_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bsl_matched_expense_fk'
       AND conrelid = 'public.bank_statement_lines'::regclass
  ) THEN
    ALTER TABLE bank_statement_lines
      ADD CONSTRAINT bsl_matched_expense_fk
      FOREIGN KEY (matched_expense_id) REFERENCES finance_expenses(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bsl_matched_receipt_fk'
       AND conrelid = 'public.bank_statement_lines'::regclass
  ) THEN
    ALTER TABLE bank_statement_lines
      ADD CONSTRAINT bsl_matched_receipt_fk
      FOREIGN KEY (matched_receipt_id) REFERENCES receipt_vouchers(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bsl_matched_fund_transfer_fk'
       AND conrelid = 'public.bank_statement_lines'::regclass
  ) THEN
    ALTER TABLE bank_statement_lines
      ADD CONSTRAINT bsl_matched_fund_transfer_fk
      FOREIGN KEY (matched_fund_transfer_id) REFERENCES fund_transfers(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bsl_matched_petty_cash_fk'
       AND conrelid = 'public.bank_statement_lines'::regclass
  ) THEN
    ALTER TABLE bank_statement_lines
      ADD CONSTRAINT bsl_matched_petty_cash_fk
      FOREIGN KEY (matched_petty_cash_id) REFERENCES petty_cash_transactions(id) ON DELETE SET NULL;
  END IF;
END $$;
