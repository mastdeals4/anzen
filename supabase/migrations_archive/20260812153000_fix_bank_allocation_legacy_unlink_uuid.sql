BEGIN;

CREATE OR REPLACE FUNCTION public.sync_sole_allocation_from_legacy_unlink()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_allocation_id uuid;
BEGIN
  IF OLD.matched_expense_id IS NOT NULL AND NEW.matched_expense_id IS NULL
     AND (SELECT count(*) FROM public.bank_statement_allocations WHERE bank_statement_line_id=NEW.id)=1 THEN
    SELECT id INTO v_allocation_id
    FROM public.bank_statement_allocations
    WHERE bank_statement_line_id=NEW.id
      AND document_type='expense' AND document_id=OLD.matched_expense_id
    LIMIT 1;
    IF v_allocation_id IS NOT NULL THEN
      DELETE FROM public.bank_statement_allocations WHERE id=v_allocation_id;
      PERFORM public.recalculate_expense_payment_state(OLD.matched_expense_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
