-- Fix missing account_group / normal_balance on chart_of_accounts rows
UPDATE chart_of_accounts SET account_group = 'Current Assets', normal_balance = 'debit'
  WHERE code IN ('1150','1155','1160','1310') AND (account_group IS NULL OR normal_balance IS NULL);

UPDATE chart_of_accounts SET account_group = 'Fixed Assets', normal_balance = 'debit'
  WHERE code = '1203' AND (account_group IS NULL OR normal_balance IS NULL);

UPDATE chart_of_accounts SET account_group = 'Equity', normal_balance = 'credit'
  WHERE code = '3110' AND (account_group IS NULL OR normal_balance IS NULL);

UPDATE chart_of_accounts SET account_group = 'Revenue', normal_balance = 'credit'
  WHERE code IN ('4910','4920') AND (account_group IS NULL OR normal_balance IS NULL);

UPDATE chart_of_accounts SET account_group = 'Operating Expenses', normal_balance = 'debit'
  WHERE code = '5102' AND (account_group IS NULL OR normal_balance IS NULL);

UPDATE chart_of_accounts SET account_group = 'Operating Expenses', normal_balance = 'debit'
  WHERE code LIKE '6%' AND (account_group IS NULL OR normal_balance IS NULL);

UPDATE chart_of_accounts SET account_group = 'Other Expenses', normal_balance = 'debit'
  WHERE code LIKE '7%' AND (account_group IS NULL OR normal_balance IS NULL);

-- Rebuild get_trial_balance to include normal_balance in return type
DROP FUNCTION IF EXISTS get_trial_balance(DATE, DATE);
CREATE FUNCTION get_trial_balance(p_start_date DATE, p_end_date DATE)
RETURNS TABLE (
  code            VARCHAR,
  name            VARCHAR,
  name_id         VARCHAR,
  account_type    VARCHAR,
  account_group   VARCHAR,
  normal_balance  VARCHAR,
  total_debit     NUMERIC,
  total_credit    NUMERIC,
  balance         NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.code,
    c.name,
    c.name_id,
    c.account_type,
    c.account_group,
    c.normal_balance,
    COALESCE(SUM(l.debit_amount),  0) AS total_debit,
    COALESCE(SUM(l.credit_amount), 0) AS total_credit,
    COALESCE(SUM(l.debit_amount),  0) - COALESCE(SUM(l.credit_amount), 0) AS balance
  FROM chart_of_accounts c
  LEFT JOIN journal_entry_lines l ON l.account_id = c.id
  LEFT JOIN journal_entries      e ON e.id = l.journal_entry_id
    AND e.entry_date BETWEEN p_start_date AND p_end_date
    AND e.status = 'posted'
  WHERE c.is_header = false
    AND c.is_active  = true
  GROUP BY c.id, c.code, c.name, c.name_id, c.account_type, c.account_group, c.normal_balance
  HAVING COALESCE(SUM(l.debit_amount), 0) <> 0
      OR COALESCE(SUM(l.credit_amount), 0) <> 0
  ORDER BY c.code;
$$;

-- New cumulative balance sheet RPC (no start date — all history up to as_of_date)
CREATE OR REPLACE FUNCTION get_balance_sheet(p_as_of_date DATE)
RETURNS TABLE (
  code            VARCHAR,
  name            VARCHAR,
  name_id         VARCHAR,
  account_type    VARCHAR,
  account_group   VARCHAR,
  normal_balance  VARCHAR,
  total_debit     NUMERIC,
  total_credit    NUMERIC,
  balance         NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.code,
    c.name,
    c.name_id,
    c.account_type,
    c.account_group,
    c.normal_balance,
    COALESCE(SUM(l.debit_amount),  0) AS total_debit,
    COALESCE(SUM(l.credit_amount), 0) AS total_credit,
    COALESCE(SUM(l.debit_amount),  0) - COALESCE(SUM(l.credit_amount), 0) AS balance
  FROM chart_of_accounts c
  LEFT JOIN journal_entry_lines l ON l.account_id = c.id
  LEFT JOIN journal_entries      e ON e.id = l.journal_entry_id
    AND e.entry_date <= p_as_of_date
    AND e.status = 'posted'
  WHERE c.is_header     = false
    AND c.is_active     = true
    AND c.account_type IN ('asset', 'liability', 'equity', 'contra')
  GROUP BY c.id, c.code, c.name, c.name_id, c.account_type, c.account_group, c.normal_balance
  HAVING COALESCE(SUM(l.debit_amount), 0) <> 0
      OR COALESCE(SUM(l.credit_amount), 0) <> 0
  ORDER BY c.code;
$$;
