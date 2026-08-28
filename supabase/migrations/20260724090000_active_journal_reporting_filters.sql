-- Financial reporting must derive exclusively from active journals.
-- Reversal and draft journals remain stored for audit history, but their
-- lines cannot contribute to ledgers, balances, or financial statements.

CREATE OR REPLACE FUNCTION public.get_trial_balance(
  p_start_date date,
  p_end_date date
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
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  WITH active_lines AS (
    SELECT
      jel.account_id,
      jel.debit,
      jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je
      ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date BETWEEN p_start_date AND p_end_date
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
    ) AS normal_balance,
    COALESCE(SUM(al.debit), 0)::numeric AS total_debit,
    COALESCE(SUM(al.credit), 0)::numeric AS total_credit,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric AS balance
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al
    ON al.account_id = coa.id
  WHERE coa.is_header = false
    AND coa.is_active = true
  GROUP BY
    coa.id,
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    coa.normal_balance
  HAVING COALESCE(SUM(al.debit), 0) <> 0
      OR COALESCE(SUM(al.credit), 0) <> 0
  ORDER BY coa.code;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trial_balance(
  p_start_date date,
  p_end_date date,
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
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  WITH active_lines AS (
    SELECT
      jel.account_id,
      CASE
        WHEN je.source_module = 'purchase_invoice'
             AND COALESCE(pi.currency, 'IDR') = 'USD'
          THEN jel.debit * p_usd_rate
        WHEN je.source_module = 'payment'
             AND (
               COALESCE(ba.currency, 'IDR') = 'USD'
               OR COALESCE(pv.exchange_rate, 1) > 1.5
             )
          THEN jel.debit * p_usd_rate
        ELSE jel.debit
      END AS debit,
      CASE
        WHEN je.source_module = 'purchase_invoice'
             AND COALESCE(pi.currency, 'IDR') = 'USD'
          THEN jel.credit * p_usd_rate
        WHEN je.source_module = 'payment'
             AND (
               COALESCE(ba.currency, 'IDR') = 'USD'
               OR COALESCE(pv.exchange_rate, 1) > 1.5
             )
          THEN jel.credit * p_usd_rate
        ELSE jel.credit
      END AS credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je
      ON je.id = jel.journal_entry_id
    LEFT JOIN public.purchase_invoices pi
      ON pi.id = je.reference_id
     AND je.source_module = 'purchase_invoice'
    LEFT JOIN public.payment_vouchers pv
      ON pv.id = je.reference_id
     AND je.source_module = 'payment'
    LEFT JOIN public.bank_accounts ba
      ON ba.id = pv.bank_account_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date BETWEEN p_start_date AND p_end_date
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
    ) AS normal_balance,
    COALESCE(SUM(al.debit), 0)::numeric AS total_debit,
    COALESCE(SUM(al.credit), 0)::numeric AS total_credit,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric AS balance
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al
    ON al.account_id = coa.id
  WHERE coa.is_header = false
    AND coa.is_active = true
  GROUP BY
    coa.id,
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    coa.normal_balance
  HAVING COALESCE(SUM(al.debit), 0) <> 0
      OR COALESCE(SUM(al.credit), 0) <> 0
  ORDER BY coa.code;
END;
$$;

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
SET search_path = public
AS $$
DECLARE
  v_net_income numeric;
  v_has_3300 boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'expense' THEN -(jel.debit - jel.credit)
      ELSE 0
    END
  ), 0)
  INTO v_net_income
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je
    ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa
    ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date <= p_as_of_date
    AND coa.is_header = false;

  SELECT EXISTS (
    SELECT 1
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je
      ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa
      ON coa.id = jel.account_id
    WHERE coa.code = '3300'
      AND je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  )
  INTO v_has_3300;

  RETURN QUERY
  WITH active_lines AS (
    SELECT
      jel.account_id,
      jel.debit,
      jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je
      ON je.id = jel.journal_entry_id
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
    ) AS normal_balance,
    COALESCE(SUM(al.debit), 0)::numeric AS total_debit,
    COALESCE(SUM(al.credit), 0)::numeric AS total_credit,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric AS balance
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al
    ON al.account_id = coa.id
  WHERE coa.is_header = false
    AND coa.is_active = true
    AND coa.account_type IN ('asset', 'liability', 'equity', 'contra')
  GROUP BY
    coa.id,
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    coa.normal_balance
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
SET search_path = public
AS $$
DECLARE
  v_net_income numeric;
  v_has_3300 boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN
        CASE
          WHEN je.source_module = 'purchase_invoice'
               AND COALESCE(pi.currency, 'IDR') = 'USD'
            THEN (jel.credit - jel.debit) * p_usd_rate
          WHEN je.source_module = 'payment'
               AND (
                 COALESCE(ba.currency, 'IDR') = 'USD'
                 OR COALESCE(pv.exchange_rate, 1) > 1.5
               )
            THEN (jel.credit - jel.debit) * p_usd_rate
          ELSE jel.credit - jel.debit
        END
      WHEN coa.account_type = 'expense' THEN
        CASE
          WHEN je.source_module = 'purchase_invoice'
               AND COALESCE(pi.currency, 'IDR') = 'USD'
            THEN -(jel.debit - jel.credit) * p_usd_rate
          WHEN je.source_module = 'payment'
               AND (
                 COALESCE(ba.currency, 'IDR') = 'USD'
                 OR COALESCE(pv.exchange_rate, 1) > 1.5
               )
            THEN -(jel.debit - jel.credit) * p_usd_rate
          ELSE -(jel.debit - jel.credit)
        END
      ELSE 0
    END
  ), 0)
  INTO v_net_income
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je
    ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa
    ON coa.id = jel.account_id
  LEFT JOIN public.purchase_invoices pi
    ON pi.id = je.reference_id
   AND je.source_module = 'purchase_invoice'
  LEFT JOIN public.payment_vouchers pv
    ON pv.id = je.reference_id
   AND je.source_module = 'payment'
  LEFT JOIN public.bank_accounts ba
    ON ba.id = pv.bank_account_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date <= p_as_of_date
    AND coa.is_header = false;

  SELECT EXISTS (
    SELECT 1
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je
      ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa
      ON coa.id = jel.account_id
    WHERE coa.code = '3300'
      AND je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date <= p_as_of_date
  )
  INTO v_has_3300;

  RETURN QUERY
  WITH active_lines AS (
    SELECT
      jel.account_id,
      CASE
        WHEN je.source_module = 'purchase_invoice'
             AND COALESCE(pi.currency, 'IDR') = 'USD'
          THEN jel.debit * p_usd_rate
        WHEN je.source_module = 'payment'
             AND (
               COALESCE(ba.currency, 'IDR') = 'USD'
               OR COALESCE(pv.exchange_rate, 1) > 1.5
             )
          THEN jel.debit * p_usd_rate
        ELSE jel.debit
      END AS debit,
      CASE
        WHEN je.source_module = 'purchase_invoice'
             AND COALESCE(pi.currency, 'IDR') = 'USD'
          THEN jel.credit * p_usd_rate
        WHEN je.source_module = 'payment'
             AND (
               COALESCE(ba.currency, 'IDR') = 'USD'
               OR COALESCE(pv.exchange_rate, 1) > 1.5
             )
          THEN jel.credit * p_usd_rate
        ELSE jel.credit
      END AS credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je
      ON je.id = jel.journal_entry_id
    LEFT JOIN public.purchase_invoices pi
      ON pi.id = je.reference_id
     AND je.source_module = 'purchase_invoice'
    LEFT JOIN public.payment_vouchers pv
      ON pv.id = je.reference_id
     AND je.source_module = 'payment'
    LEFT JOIN public.bank_accounts ba
      ON ba.id = pv.bank_account_id
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
    ) AS normal_balance,
    COALESCE(SUM(al.debit), 0)::numeric AS total_debit,
    COALESCE(SUM(al.credit), 0)::numeric AS total_credit,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric AS balance
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al
    ON al.account_id = coa.id
  WHERE coa.is_header = false
    AND coa.is_active = true
    AND coa.account_type IN ('asset', 'liability', 'equity', 'contra')
  GROUP BY
    coa.id,
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    coa.normal_balance
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

CREATE OR REPLACE FUNCTION public.get_petty_cash_balance()
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je
    ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa
    ON coa.id = jel.account_id
  WHERE coa.code = '1102'
    AND je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false;
$$;

CREATE OR REPLACE FUNCTION public.get_petty_cash_balance_by_date(
  start_date date,
  end_date date
)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je
    ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa
    ON coa.id = jel.account_id
  WHERE coa.code = '1102'
    AND je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date BETWEEN start_date AND end_date;
$$;

GRANT EXECUTE ON FUNCTION public.get_trial_balance(date, date)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_trial_balance(date, date, numeric)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_balance_sheet(date)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_balance_sheet(date, numeric)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_petty_cash_balance()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_petty_cash_balance_by_date(date, date)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_trial_balance(date, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_trial_balance(date, date, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_petty_cash_balance() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_petty_cash_balance_by_date(date, date) FROM anon;

NOTIFY pgrst, 'reload schema';
