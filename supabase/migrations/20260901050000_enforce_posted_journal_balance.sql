-- Prevent newly posted journal entries from being committed out of balance.
-- Deferred constraint allows the normal posting flow to insert the header first
-- and lines immediately afterwards in the same transaction.
CREATE OR REPLACE FUNCTION public.assert_posted_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF COALESCE(NEW.is_posted, false) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO v_debit, v_credit
    FROM public.journal_entry_lines
   WHERE journal_entry_id = NEW.id;

  IF abs(v_debit - v_credit) > 0.01 THEN
    RAISE EXCEPTION 'Posted journal % is out of balance: debit %, credit %',
      NEW.entry_number, v_debit, v_credit;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_posted_journal_balanced ON public.journal_entries;
CREATE CONSTRAINT TRIGGER trg_assert_posted_journal_balanced
AFTER INSERT OR UPDATE OF is_posted ON public.journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.assert_posted_journal_balanced();

COMMENT ON FUNCTION public.assert_posted_journal_balanced() IS
  'Deferred invariant: newly inserted or posted journals must have equal debit and credit totals.';

CREATE OR REPLACE FUNCTION public.assert_posted_journal_lines_balanced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_journal_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  v_posted boolean;
  v_debit numeric;
  v_credit numeric;
BEGIN
  SELECT is_posted INTO v_posted FROM public.journal_entries WHERE id = v_journal_id;
  IF COALESCE(v_posted, false) IS NOT TRUE THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO v_debit, v_credit
    FROM public.journal_entry_lines WHERE journal_entry_id = v_journal_id;
  IF abs(v_debit - v_credit) > 0.01 THEN
    RAISE EXCEPTION 'Posted journal % is out of balance after line change: debit %, credit %',
      v_journal_id, v_debit, v_credit;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_posted_journal_lines_balanced ON public.journal_entry_lines;
CREATE CONSTRAINT TRIGGER trg_assert_posted_journal_lines_balanced
AFTER INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.assert_posted_journal_lines_balanced();
