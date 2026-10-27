-- Prevent duplicate journal posting by source module + reference
CREATE UNIQUE INDEX IF NOT EXISTS uniq_source_posting
ON journal_entries(source_module, reference_id)
WHERE reference_id IS NOT NULL;

-- Prevent orphan journal lines with cascading cleanup
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_journal'
      AND conrelid = 'journal_entry_lines'::regclass
  ) THEN
    ALTER TABLE journal_entry_lines
    ADD CONSTRAINT fk_journal
    FOREIGN KEY (journal_entry_id)
    REFERENCES journal_entries(id)
    ON DELETE CASCADE;
  END IF;
END $$;
