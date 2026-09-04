-- Final Finance stabilization: posted journal line debit/credit values are
-- already functional-currency accounting amounts. Trial Balance and Balance
-- Sheet must sum those values directly and must not revalue selected journals
-- with a UI reporting rate.

CREATE OR REPLACE FUNCTION public.get_trial_balance(
  p_start_date date,
  p_end_date date,
  p_usd_rate numeric DEFAULT 1
)
RETURNS TABLE(
  code varchar, name varchar, name_id varchar, account_type varchar,
  account_group varchar, normal_balance varchar,
  total_debit numeric, total_credit numeric, balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  RETURN QUERY
  WITH active_lines AS (
    SELECT jel.account_id, jel.debit, jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date BETWEEN p_start_date AND p_end_date
  )
  SELECT coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END),
    COALESCE(SUM(al.debit), 0)::numeric,
    COALESCE(SUM(al.credit), 0)::numeric,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al ON al.account_id = coa.id
  WHERE coa.is_header = false AND coa.is_active = true
  GROUP BY coa.id, coa.code, coa.name, coa.name_id, coa.account_type,
    coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(al.debit), 0) <> 0 OR COALESCE(SUM(al.credit), 0) <> 0
  ORDER BY coa.code;
END;
$$

CREATE OR REPLACE FUNCTION public.get_balance_sheet(
  p_as_of_date date,
  p_usd_rate numeric DEFAULT 1
)
RETURNS TABLE(
  code varchar, name varchar, name_id varchar, account_type varchar,
  account_group varchar, normal_balance varchar,
  total_debit numeric, total_credit numeric, balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_net_income numeric;
  v_has_3300 boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  WITH active_lines AS (
    SELECT jel.account_id, jel.debit, jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  )
  SELECT COALESCE(SUM(CASE
    WHEN coa.account_type = 'revenue' THEN al.credit - al.debit
    WHEN coa.account_type = 'expense' THEN al.debit - al.credit
    ELSE 0 END), 0)
  INTO v_net_income
  FROM active_lines al
  JOIN public.chart_of_accounts coa ON coa.id = al.account_id
  WHERE coa.is_header = false;

  SELECT EXISTS (
    SELECT 1
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '3300'
      AND je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  ) INTO v_has_3300;

  RETURN QUERY
  WITH active_lines AS (
    SELECT jel.account_id, jel.debit, jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  )
  SELECT coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END),
    COALESCE(SUM(al.debit), 0)::numeric,
    COALESCE(SUM(al.credit), 0)::numeric,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al ON al.account_id = coa.id
  WHERE coa.is_header = false
    AND coa.is_active = true
    AND coa.account_type IN ('asset', 'liability', 'equity', 'contra')
  GROUP BY coa.id, coa.code, coa.name, coa.name_id, coa.account_type,
    coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(al.debit), 0) <> 0 OR COALESCE(SUM(al.credit), 0) <> 0

  UNION ALL
  SELECT '3300'::varchar, 'Current Year Earnings'::varchar,
    'Laba/Rugi Tahun Berjalan'::varchar, 'equity'::varchar,
    'Equity'::varchar, 'credit'::varchar,
    CASE WHEN v_net_income < 0 THEN ABS(v_net_income) ELSE 0 END,
    CASE WHEN v_net_income > 0 THEN v_net_income ELSE 0 END,
    (-v_net_income)::numeric
  WHERE NOT v_has_3300 AND ABS(v_net_income) > 0.005
  ORDER BY 1;
END;
$$

COMMENT ON FUNCTION public.get_trial_balance(date,date,numeric) IS
  'Canonical Trial Balance: sums active posted functional journal lines directly. The rate argument is retained only for API compatibility.'

COMMENT ON FUNCTION public.get_balance_sheet(date,numeric) IS
  'Canonical Balance Sheet: sums active posted functional journal lines directly. The rate argument is retained only for API compatibility.'
