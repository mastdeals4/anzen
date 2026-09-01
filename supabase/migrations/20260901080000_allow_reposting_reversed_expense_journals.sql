-- Reversal lifecycle: a reversed source journal must not permanently reserve
-- the source/reference key. This allows a cancelled expense to be approved
-- again with exactly one new active journal while preserving the reversal.
DROP INDEX IF EXISTS public.uniq_journal_entries_source_ref_number;
CREATE UNIQUE INDEX uniq_journal_entries_source_ref_number
  ON public.journal_entries (source_module, reference_number)
  WHERE reference_number IS NOT NULL
    AND source_module IS NOT NULL
    AND NOT COALESCE(is_reversed, false);

