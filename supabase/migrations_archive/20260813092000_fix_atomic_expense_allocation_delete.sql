-- Avoid updating an expense from an allocation trigger while that same tuple
-- is already inside DELETE. Cleanup runs as a preceding statement in the
-- existing atomic delete_expense_safe RPC; direct allocated deletes remain
-- guarded.

BEGIN;

CREATE OR REPLACE FUNCTION public.prevent_deleting_allocated_finance_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
     WHERE document_type = TG_ARGV[0]
       AND document_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Document has bank reconciliation allocations. Use the canonical delete command so they can be released atomically.';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_expense_safe(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_expense public.finance_expenses%ROWTYPE;
  v_allocation_count integer;
  v_legacy_count integer;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot delete expenses', v_role;
  END IF;

  SELECT * INTO v_expense
    FROM public.finance_expenses
   WHERE id = p_expense_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  SELECT count(*) INTO v_allocation_count
    FROM public.bank_statement_allocations
   WHERE document_type = 'expense'
     AND document_id = p_expense_id;

  -- Separate statement: allocation triggers may safely recalculate the still
  -- existing expense, then the source row and its journals are deleted.
  DELETE FROM public.bank_statement_allocations
   WHERE document_type = 'expense'
     AND document_id = p_expense_id;

  -- Release pre-allocation legacy links to this expense. Allocation-owned
  -- lines have already been rebuilt by sync_bank_line_from_allocation().
  WITH released AS (
    UPDATE public.bank_statement_lines b SET
      matched_expense_id = NULL,
      matched_entry_id = NULL,
      reconciliation_status = 'unmatched',
      matching_status = 'none',
      matched_at = NULL,
      matched_by = NULL,
      manually_unlinked = true
    WHERE b.matched_expense_id = p_expense_id
      AND NOT EXISTS (
        SELECT 1 FROM public.bank_statement_allocations a
         WHERE a.bank_statement_line_id = b.id
      )
    RETURNING 1
  ) SELECT count(*) INTO v_legacy_count FROM released;

  DELETE FROM public.finance_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
     WHERE document_type = 'expense' AND document_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Expense delete left orphan bank allocations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bank_statement_lines WHERE matched_expense_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Expense delete left orphan bank references';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'released_allocations', v_allocation_count,
    'released_legacy_lines', v_legacy_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_expense_safe(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_expense_safe(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
