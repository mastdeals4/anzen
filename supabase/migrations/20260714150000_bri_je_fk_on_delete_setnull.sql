-- ============================================================================
-- Bank Reconciliation Items — journal_entry_id FK ON DELETE SET NULL
-- ============================================================================
-- Root cause of "Tax Payment delete error" and a class of latent finance
-- delete failures:
--
--   bank_reconciliation_items.journal_entry_id was declared in
--   20251216150000_complete_indonesian_accounting_system.sql line 382 as
--     journal_entry_id UUID REFERENCES journal_entries(id)
--   with the default ON DELETE NO ACTION.
--
--   delete_tax_payment() (and by extension every finance delete flow that
--   deletes its journal_entries row — expense, receipt, petty cash, fund
--   transfer) sets is_matched=false, matched_at=NULL on the BRI rows but
--   never nulls journal_entry_id. Postgres therefore refuses the JE DELETE
--   with a 23503 foreign_key_violation, aborting the whole transaction and
--   surfacing "Failed to delete tax payment: … violates foreign key
--   constraint …_journal_entry_id_fkey" to the user.
--
-- 20260703180000_bank_recon_orphan_repair.sql closed the same hole for
-- bank_statement_lines.matched_entry_id but did not touch BRI. This
-- migration finishes the job.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_conname text;
BEGIN
  -- Locate the FK constraint on bank_reconciliation_items.journal_entry_id
  -- that targets journal_entries(id) — Postgres auto-names it, so look it up.
  SELECT c.conname INTO v_conname
  FROM pg_constraint c
  JOIN pg_class rel     ON rel.oid = c.conrelid
  JOIN pg_class trel    ON trel.oid = c.confrelid
  WHERE c.contype = 'f'
    AND rel.relname  = 'bank_reconciliation_items'
    AND trel.relname = 'journal_entries'
    AND c.conkey = ARRAY[
      (SELECT attnum FROM pg_attribute
        WHERE attrelid = rel.oid AND attname = 'journal_entry_id')
    ];

  IF v_conname IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.bank_reconciliation_items DROP CONSTRAINT %I',
      v_conname
    );
  END IF;

  ALTER TABLE public.bank_reconciliation_items
    ADD CONSTRAINT bank_reconciliation_items_journal_entry_id_fkey
      FOREIGN KEY (journal_entry_id)
      REFERENCES public.journal_entries(id)
      ON DELETE SET NULL;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
