-- Keep bank reconciliation allocations authoritative throughout document
-- unlink/delete lifecycles. No source document, bank line, amount, or journal
-- accounting is rewritten by this migration.

BEGIN;

-- Every allocation mutation must refresh its owning bank line. This also
-- covers FK cascades during journal deletion, which RPC-local refresh calls
-- cannot see after the row has gone.
CREATE OR REPLACE FUNCTION public.sync_bank_line_from_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_line uuid;
  v_new_line uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_line := OLD.bank_statement_line_id;
    PERFORM public.refresh_bank_statement_allocation_status(v_old_line);
    IF OLD.document_type = 'expense' AND EXISTS (
      SELECT 1 FROM public.finance_expenses WHERE id = OLD.document_id
    ) THEN
      PERFORM public.recalculate_expense_payment_state(OLD.document_id);
    ELSIF OLD.document_type = 'tax_payment' THEN
      UPDATE public.tax_payments
         SET status = 'posted'
       WHERE id = OLD.document_id
         AND NOT EXISTS (
           SELECT 1 FROM public.bank_statement_allocations
            WHERE document_type = 'tax_payment' AND document_id = OLD.document_id
         );
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_line := NEW.bank_statement_line_id;
    IF v_new_line IS DISTINCT FROM v_old_line THEN
      PERFORM public.refresh_bank_statement_allocation_status(v_new_line);
    END IF;
    IF NEW.document_type = 'expense' AND EXISTS (
      SELECT 1 FROM public.finance_expenses WHERE id = NEW.document_id
    ) THEN
      PERFORM public.recalculate_expense_payment_state(NEW.document_id);
    ELSIF NEW.document_type = 'tax_payment' THEN
      UPDATE public.tax_payments SET status = 'reconciled' WHERE id = NEW.document_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_bank_line_from_allocation
  ON public.bank_statement_allocations;
CREATE TRIGGER trg_sync_bank_line_from_allocation
AFTER INSERT OR UPDATE OR DELETE ON public.bank_statement_allocations
FOR EACH ROW EXECUTE FUNCTION public.sync_bank_line_from_allocation();

-- Deleting an owned journal must release its reconciliation allocation in the
-- same transaction. The trigger above then refreshes the surviving bank line.
ALTER TABLE public.bank_statement_allocations
  DROP CONSTRAINT bank_statement_allocations_journal_entry_id_fkey,
  ADD CONSTRAINT bank_statement_allocations_journal_entry_id_fkey
    FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries(id)
    ON DELETE CASCADE;

-- The existing BEFORE DELETE guards become atomic cleanup guards: allocations
-- owned by the document are released before the document row is removed.
-- All other failures still roll the entire statement/transaction back.
CREATE OR REPLACE FUNCTION public.prevent_deleting_allocated_finance_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.bank_statement_allocations
   WHERE document_type = TG_ARGV[0]
     AND document_id = OLD.id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_bank_line_from_allocation(),
  public.prevent_deleting_allocated_finance_document() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_bank_line_from_allocation(),
  public.prevent_deleting_allocated_finance_document() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
