-- Resolve the account shown in a Petty Cash export from the same posted
-- journal lines used by Journal Entry, Ledger, Trial Balance, and P&L.
-- A category mapping is used only while a Petty Cash expense has no posting.

CREATE OR REPLACE FUNCTION public.get_petty_cash_export_accounts(
  p_transaction_ids uuid[]
)
RETURNS TABLE (
  transaction_id uuid,
  coa_code text,
  coa_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested_transactions AS (
    SELECT id, transaction_type, expense_category, approval_status
    FROM public.petty_cash_transactions
    WHERE id = ANY(p_transaction_ids)
  ),
  posted_accounts AS (
    SELECT DISTINCT ON (pct.id)
      pct.id AS transaction_id,
      coa.code AS coa_code,
      coa.name AS coa_name
    FROM requested_transactions pct
    JOIN public.journal_entries je
      ON je.reference_id = pct.id
     AND je.source_module = 'petty_cash'
     AND je.is_posted = true
    JOIN public.journal_entry_lines jel
      ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts coa
      ON coa.id = jel.account_id
    WHERE (
      pct.transaction_type = 'expense'
      AND jel.debit > 0
    ) OR (
      pct.transaction_type = 'withdraw'
      AND jel.credit > 0
    )
    ORDER BY pct.id, jel.line_number
  ),
  fallback_accounts AS (
    SELECT
      pct.id AS transaction_id,
      coa.code AS coa_code,
      coa.name AS coa_name
    FROM requested_transactions pct
    JOIN public.chart_of_accounts coa
      ON coa.id = public.get_expense_account_id(pct.expense_category)
    WHERE pct.transaction_type = 'expense'
      AND pct.approval_status IS DISTINCT FROM 'approved'
  )
  SELECT
    pct.id AS transaction_id,
    COALESCE(posted.coa_code, fallback.coa_code) AS coa_code,
    COALESCE(posted.coa_name, fallback.coa_name) AS coa_name
  FROM requested_transactions pct
  LEFT JOIN posted_accounts posted ON posted.transaction_id = pct.id
  LEFT JOIN fallback_accounts fallback ON fallback.transaction_id = pct.id;
$$;

REVOKE ALL ON FUNCTION public.get_petty_cash_export_accounts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_petty_cash_export_accounts(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_petty_cash_export_accounts(uuid[]) IS
  'Petty Cash export COA: actual posted journal account first; canonical category default only before posting.';

NOTIFY pgrst, 'reload schema';
