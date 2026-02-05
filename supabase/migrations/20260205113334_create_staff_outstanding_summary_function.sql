/*
  # Create Staff Outstanding Summary Function

  1. New Functions
    - `get_staff_outstanding_summary()` - Returns outstanding balances for staff loans and advances

  2. Details
    - Calculates outstanding balance from journal entries
    - Groups by staff member (derived from account descriptions/names)
    - Returns structured data with staff name, employee ID, account code, balance, and last transaction date

  3. Security
    - Function is SECURITY DEFINER to ensure proper access
    - Sets search_path for security
*/

-- Drop existing function if it exists
DROP FUNCTION IF EXISTS get_staff_outstanding_summary();

CREATE OR REPLACE FUNCTION get_staff_outstanding_summary()
RETURNS TABLE (
  staff_name TEXT,
  employee_id TEXT,
  account_code VARCHAR,
  outstanding_balance DECIMAL,
  last_transaction_date DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    coa.name as staff_name,
    coa.code as employee_id,
    coa.code as account_code,
    COALESCE(SUM(
      CASE
        WHEN coa.normal_balance = 'debit' THEN jel.debit - jel.credit
        ELSE jel.credit - jel.debit
      END
    ), 0) as outstanding_balance,
    MAX(je.entry_date)::DATE as last_transaction_date
  FROM chart_of_accounts coa
  LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
  LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.is_posted = true
  WHERE
    coa.is_active = true
    AND (
      coa.account_group ILIKE '%Staff%'
      OR coa.account_group ILIKE '%Employee%'
      OR coa.name ILIKE '%Staff%'
      OR coa.name ILIKE '%Employee%'
      OR coa.code LIKE '1150%'
    )
  GROUP BY coa.id, coa.name, coa.code, coa.normal_balance
  HAVING COALESCE(SUM(
    CASE
      WHEN coa.normal_balance = 'debit' THEN jel.debit - jel.credit
      ELSE jel.credit - jel.debit
    END
  ), 0) != 0
  ORDER BY coa.code;
END;
$$;
