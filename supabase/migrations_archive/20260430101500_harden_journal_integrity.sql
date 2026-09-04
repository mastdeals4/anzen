/*
  # Harden journal integrity and prevent invalid accounting data

  Adds DB-level guardrails so duplicate, orphan, and unbalanced journal data
  cannot be persisted.
*/

-- 1) Prevent duplicate posting per (source_module, reference_id)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_source_posting
ON public.journal_entries(source_module, reference_id)
WHERE reference_id IS NOT NULL;

-- 2) Prevent orphan journal lines
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_journal_entry'
      AND conrelid = 'public.journal_entry_lines'::regclass
  ) THEN
    ALTER TABLE public.journal_entry_lines
    ADD CONSTRAINT fk_journal_entry
    FOREIGN KEY (journal_entry_id)
    REFERENCES public.journal_entries(id)
    ON DELETE CASCADE;
  END IF;
END;
$$;

-- 3) Enforce debit = credit at the database layer
CREATE OR REPLACE FUNCTION public.validate_journal_entry_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_journal_id uuid;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
BEGIN
  v_journal_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
  INTO v_total_debit, v_total_credit
  FROM public.journal_entry_lines
  WHERE journal_entry_id = v_journal_id;

  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'Journal not balanced for % (debit %, credit %)', v_journal_id, v_total_debit, v_total_credit;
  END IF;

  RETURN COALESCE(NEW, OLD);
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'Journal posting validation failed for %: %', v_journal_id, SQLERRM;
    RAISE;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_journal_entry_balance ON public.journal_entry_lines;
CREATE CONSTRAINT TRIGGER trg_validate_journal_entry_balance
AFTER INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.validate_journal_entry_balance();
