-- Correct the synthetic Current Year Earnings calculation in the existing
-- journal-native Balance Sheet RPCs.
--
-- Revenue is credit-normal and expenses are debit-normal, so net income is
-- revenue minus expenses.  The reporting-rate argument is retained for API
-- compatibility; journal lines are already stored in functional currency.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_balance_sheet(
  p_as_of_date date
)
RETURNS TABLE(
  code varchar,
  name varchar,
  name_id varchar,
  account_type varchar,
  account_group varchar,
  normal_balance varchar,
  total_debit numeric,
  total_credit numeric,
  balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.get_balance_sheet(p_as_of_date, 1::numeric);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_balance_sheet(
  p_as_of_date date,
  p_usd_rate numeric DEFAULT 1
)
RETURNS TABLE(
  code varchar,
  name varchar,
  name_id varchar,
  account_type varchar,
  account_group varchar,
  normal_balance varchar,
  total_debit numeric,
  total_credit numeric,
  balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_net_income numeric;
  v_has_3300 boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Journal-native P&L sign convention:
  --   revenue = credit - debit
  --   expense = debit - credit
  --   net income = revenue - expense
  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'expense' THEN jel.credit - jel.debit
      ELSE 0
    END
  ), 0)
  INTO v_net_income
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date <= p_as_of_date
    AND coa.is_header = false;

  SELECT EXISTS (
    SELECT 1
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '3300'
      AND je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  )
  INTO v_has_3300;

  RETURN QUERY
  WITH active_lines AS (
    SELECT jel.account_id, jel.debit, jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  )
  SELECT
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    COALESCE(
      coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END
    ),
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
  HAVING COALESCE(SUM(al.debit), 0) <> 0
      OR COALESCE(SUM(al.credit), 0) <> 0

  UNION ALL

  SELECT
    '3300'::varchar,
    'Current Year Earnings'::varchar,
    'Laba/Rugi Tahun Berjalan'::varchar,
    'equity'::varchar,
    'Equity'::varchar,
    'credit'::varchar,
    CASE WHEN v_net_income < 0 THEN ABS(v_net_income) ELSE 0 END,
    CASE WHEN v_net_income > 0 THEN v_net_income ELSE 0 END,
    (-v_net_income)::numeric
  WHERE NOT v_has_3300
    AND ABS(v_net_income) > 0.005
  ORDER BY 1;
END;
$$;

COMMENT ON FUNCTION public.get_balance_sheet(date, numeric) IS
  'Journal-native Balance Sheet. Synthetic 3300 Current Year Earnings is revenue minus expenses; p_usd_rate is retained for API compatibility.';

GRANT EXECUTE ON FUNCTION public.get_balance_sheet(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_balance_sheet(date, numeric) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date, numeric) FROM anon;

COMMIT;
