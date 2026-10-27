-- Expense export COA values must be journal-native after approval and use the
-- existing category resolver only before an Expense has been posted.

CREATE OR REPLACE FUNCTION public.get_expense_export_accounts(
  p_expense_ids uuid[]
)
RETURNS TABLE (
  expense_id uuid,
  coa_code text,
  coa_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested_expenses AS (
    SELECT id, expense_category, approval_status
    FROM public.finance_expenses
    WHERE id = ANY(p_expense_ids)
  ),
  posted_accounts AS (
    SELECT DISTINCT ON (expense.id)
      expense.id AS expense_id,
      coa.code AS coa_code,
      coa.name AS coa_name
    FROM requested_expenses expense
    JOIN public.journal_entries journal
      ON journal.source_module IN ('expense', 'expenses')
     AND (
       journal.reference_id = expense.id
       OR journal.reference_number = 'EXP-' || expense.id::text
     )
     AND journal.is_posted = true
    JOIN public.journal_entry_lines line
      ON line.journal_entry_id = journal.id
     AND line.debit > 0
    JOIN public.chart_of_accounts coa
      ON coa.id = line.account_id
    ORDER BY expense.id, journal.posted_at DESC NULLS LAST, journal.created_at DESC, line.line_number
  ),
  fallback_accounts AS (
    SELECT
      expense.id AS expense_id,
      coa.code AS coa_code,
      coa.name AS coa_name
    FROM requested_expenses expense
    JOIN public.chart_of_accounts coa
      ON coa.id = public.get_expense_account_id(expense.expense_category)
    WHERE expense.approval_status IS DISTINCT FROM 'approved'
  )
  SELECT
    expense.id AS expense_id,
    COALESCE(posted.coa_code, fallback.coa_code) AS coa_code,
    COALESCE(posted.coa_name, fallback.coa_name) AS coa_name
  FROM requested_expenses expense
  LEFT JOIN posted_accounts posted ON posted.expense_id = expense.id
  LEFT JOIN fallback_accounts fallback ON fallback.expense_id = expense.id;
$$;

REVOKE ALL ON FUNCTION public.get_expense_export_accounts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_expense_export_accounts(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_expense_export_accounts(uuid[]) IS
  'Expense export COA: posted journal debit account first; canonical category default before approval.';

NOTIFY pgrst, 'reload schema';
