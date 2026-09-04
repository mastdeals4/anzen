-- Preserve legacy single-link unlink semantics without affecting multi-owner
-- allocation rows. Existing code that clears the sole typed expense FK should
-- remove that same sole allocation; rows with two or more allocations have no
-- single typed owner and are intentionally unaffected.

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_sole_allocation_from_legacy_unlink()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_allocation_id uuid;
BEGIN
  IF OLD.matched_expense_id IS NOT NULL AND NEW.matched_expense_id IS NULL THEN
    SELECT min(id) INTO v_allocation_id
    FROM public.bank_statement_allocations
    WHERE bank_statement_line_id=NEW.id
      AND document_type='expense' AND document_id=OLD.matched_expense_id
    HAVING count(*)=1
       AND (SELECT count(*) FROM public.bank_statement_allocations WHERE bank_statement_line_id=NEW.id)=1;
    IF v_allocation_id IS NOT NULL THEN
      DELETE FROM public.bank_statement_allocations WHERE id=v_allocation_id;
      PERFORM public.recalculate_expense_payment_state(OLD.matched_expense_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_sync_sole_allocation_from_legacy_unlink
AFTER UPDATE OF matched_expense_id ON public.bank_statement_lines
FOR EACH ROW EXECUTE FUNCTION public.sync_sole_allocation_from_legacy_unlink();

REVOKE ALL ON FUNCTION public.sync_sole_allocation_from_legacy_unlink()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sole_allocation_from_legacy_unlink() TO service_role;

COMMIT;
