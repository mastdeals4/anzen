-- Enforce balance when lines are inserted, edited, or removed from a posted JE.
-- The deferred check runs after the posting transaction has assembled all lines.
CREATE OR REPLACE FUNCTION public.assert_posted_journal_lines_balanced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_je_id uuid := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  v_posted boolean;
  v_debit numeric;
  v_credit numeric;
  v_entry_number text;
BEGIN
  SELECT is_posted, entry_number INTO v_posted, v_entry_number
    FROM public.journal_entries WHERE id = v_je_id;
  IF COALESCE(v_posted, false) IS NOT TRUE THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO v_debit, v_credit
    FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id;
  IF abs(v_debit - v_credit) > 0.01 THEN
    RAISE EXCEPTION 'Posted journal % is out of balance: debit %, credit %', v_entry_number, v_debit, v_credit;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_posted_journal_lines_balanced ON public.journal_entry_lines;
CREATE CONSTRAINT TRIGGER trg_assert_posted_journal_lines_balanced
AFTER INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_posted_journal_lines_balanced();
