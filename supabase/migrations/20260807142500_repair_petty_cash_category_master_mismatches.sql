-- Repair only approved Petty Cash expense journals whose existing debit account
-- differs from their active Finance Category Master leaf COA.  This updates
-- the existing journal line in place: no journal or transaction is created.
BEGIN;

DO $$
DECLARE
  v_mismatch_count integer;
  v_invalid_shape_count integer;
BEGIN
  WITH mismatch_journals AS (
    SELECT DISTINCT p.id AS transaction_id, je.id AS journal_id, ec.coa_account_id
    FROM public.petty_cash_transactions p
    JOIN public.expense_categories ec
      ON ec.category_key=p.expense_category
     AND ec.is_active
     AND ec.is_posting_category
    JOIN public.chart_of_accounts expected_coa
      ON expected_coa.id=ec.coa_account_id
     AND expected_coa.is_active
     AND NOT expected_coa.is_header
    JOIN public.journal_entries je
      ON je.reference_id=p.id
     AND je.source_module='petty_cash'
     AND je.is_posted
     AND NOT coalesce(je.is_reversed,false)
    JOIN public.journal_entry_lines debit_line
      ON debit_line.journal_entry_id=je.id
     AND debit_line.debit>0
    WHERE p.approval_status='approved'
      AND p.transaction_type='expense'
      AND debit_line.account_id IS DISTINCT FROM ec.coa_account_id
  )
  SELECT count(*) INTO v_mismatch_count FROM mismatch_journals;

  WITH mismatch_journals AS (
    SELECT DISTINCT p.id AS transaction_id, je.id AS journal_id
    FROM public.petty_cash_transactions p
    JOIN public.expense_categories ec ON ec.category_key=p.expense_category AND ec.is_active AND ec.is_posting_category
    JOIN public.journal_entries je ON je.reference_id=p.id AND je.source_module='petty_cash' AND je.is_posted AND NOT coalesce(je.is_reversed,false)
    JOIN public.journal_entry_lines debit_line ON debit_line.journal_entry_id=je.id AND debit_line.debit>0 AND debit_line.account_id IS DISTINCT FROM ec.coa_account_id
    WHERE p.approval_status='approved' AND p.transaction_type='expense'
  )
  SELECT count(*) INTO v_invalid_shape_count
  FROM mismatch_journals m
  WHERE (SELECT count(*) FROM public.journal_entry_lines line WHERE line.journal_entry_id=m.journal_id AND line.debit>0) <> 1;

  IF v_invalid_shape_count <> 0 THEN
    RAISE EXCEPTION 'Refusing Petty Cash COA repair: % mismatched journals do not have exactly one debit line', v_invalid_shape_count;
  END IF;

  WITH mismatch_lines AS (
    SELECT debit_line.id AS line_id, ec.coa_account_id
    FROM public.petty_cash_transactions p
    JOIN public.expense_categories ec
      ON ec.category_key=p.expense_category
     AND ec.is_active
     AND ec.is_posting_category
    JOIN public.chart_of_accounts expected_coa
      ON expected_coa.id=ec.coa_account_id
     AND expected_coa.is_active
     AND NOT expected_coa.is_header
    JOIN public.journal_entries je
      ON je.reference_id=p.id
     AND je.source_module='petty_cash'
     AND je.is_posted
     AND NOT coalesce(je.is_reversed,false)
    JOIN public.journal_entry_lines debit_line
      ON debit_line.journal_entry_id=je.id
     AND debit_line.debit>0
    WHERE p.approval_status='approved'
      AND p.transaction_type='expense'
      AND debit_line.account_id IS DISTINCT FROM ec.coa_account_id
  )
  UPDATE public.journal_entry_lines line
  SET account_id=m.coa_account_id
  FROM mismatch_lines m
  WHERE line.id=m.line_id;

  RAISE NOTICE 'Repaired % approved Petty Cash journal debit line(s) from Finance Category Master', v_mismatch_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
