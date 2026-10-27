-- ================================================================
-- Finance Multi-Currency Reporting
-- Adds p_usd_rate to get_trial_balance + get_balance_sheet.
-- Detects USD journal entries via source_module + reference doc.
-- Adds get_reporting_usd_rate() — reuses rates already in system.
-- ================================================================

-- Helper: latest USD→IDR rate from existing system data (no new table)
CREATE OR REPLACE FUNCTION get_reporting_usd_rate()
RETURNS NUMERIC
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT exchange_rate
       FROM payment_vouchers
      WHERE exchange_rate > 1.5
      ORDER BY voucher_date DESC, created_at DESC
      LIMIT 1),
    (SELECT exchange_rate
       FROM purchase_invoices
      WHERE currency = 'USD' AND exchange_rate > 1.5
      ORDER BY invoice_date DESC
      LIMIT 1),
    (SELECT exchange_rate_usd_to_idr
       FROM batches
      WHERE exchange_rate_usd_to_idr > 1.5
      ORDER BY created_at DESC
      LIMIT 1),
    16000::NUMERIC
  );
$$;

-- Updated get_trial_balance with multi-currency support
CREATE OR REPLACE FUNCTION get_trial_balance(
  p_start_date DATE,
  p_end_date   DATE,
  p_usd_rate   NUMERIC DEFAULT 1
)
RETURNS TABLE (
  code           VARCHAR,
  name           VARCHAR,
  name_id        VARCHAR,
  account_type   VARCHAR,
  account_group  VARCHAR,
  normal_balance VARCHAR,
  total_debit    NUMERIC,
  total_credit   NUMERIC,
  balance        NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH je_fx AS (
    SELECT
      je.id AS je_id,
      CASE
        WHEN je.source_module = 'purchase_invoice'
             AND COALESCE(pi.currency, 'IDR') = 'USD' THEN 'USD'
        WHEN je.source_module = 'payment'
             AND (COALESCE(ba.currency, 'IDR') = 'USD'
                  OR COALESCE(pv.exchange_rate, 1) > 1.5) THEN 'USD'
        ELSE 'IDR'
      END AS je_currency
    FROM journal_entries je
    LEFT JOIN purchase_invoices pi
           ON pi.id = je.reference_id AND je.source_module = 'purchase_invoice'
    LEFT JOIN payment_vouchers pv
           ON pv.id = je.reference_id AND je.source_module = 'payment'
    LEFT JOIN bank_accounts ba ON ba.id = pv.bank_account_id
    WHERE je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND je.entry_date >= p_start_date
      AND je.entry_date <= p_end_date
  )
  SELECT
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
    ) AS normal_balance,
    COALESCE(SUM(
      CASE WHEN fx.je_currency = 'USD' THEN jel.debit  * p_usd_rate ELSE jel.debit  END
    ), 0)::NUMERIC AS total_debit,
    COALESCE(SUM(
      CASE WHEN fx.je_currency = 'USD' THEN jel.credit * p_usd_rate ELSE jel.credit END
    ), 0)::NUMERIC AS total_credit,
    (COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.debit  * p_usd_rate ELSE jel.debit  END), 0)
   - COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.credit * p_usd_rate ELSE jel.credit END), 0))::NUMERIC AS balance
  FROM chart_of_accounts      coa
  LEFT JOIN journal_entry_lines jel ON coa.id   = jel.account_id
  LEFT JOIN je_fx               fx  ON fx.je_id = jel.journal_entry_id
  WHERE coa.is_header = false AND coa.is_active = true
  GROUP BY coa.id, coa.code, coa.name, coa.name_id,
           coa.account_type, coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(jel.debit), 0) != 0 OR COALESCE(SUM(jel.credit), 0) != 0
  ORDER BY coa.code;
END;
$$;

-- Updated get_balance_sheet with multi-currency support
CREATE OR REPLACE FUNCTION get_balance_sheet(
  p_as_of_date DATE,
  p_usd_rate   NUMERIC DEFAULT 1
)
RETURNS TABLE (
  code           VARCHAR,
  name           VARCHAR,
  name_id        VARCHAR,
  account_type   VARCHAR,
  account_group  VARCHAR,
  normal_balance VARCHAR,
  total_debit    NUMERIC,
  total_credit   NUMERIC,
  balance        NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_net_income NUMERIC;
  v_has_3300   BOOLEAN;
BEGIN
  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN
        CASE WHEN fx.je_currency = 'USD' THEN (jel.credit - jel.debit) * p_usd_rate
             ELSE jel.credit - jel.debit END
      WHEN coa.account_type = 'expense' THEN
        CASE WHEN fx.je_currency = 'USD' THEN -(jel.debit - jel.credit) * p_usd_rate
             ELSE -(jel.debit - jel.credit) END
      ELSE 0
    END
  ), 0) INTO v_net_income
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN chart_of_accounts coa ON coa.id = jel.account_id
  LEFT JOIN (
    SELECT jj.id AS je_id,
      CASE
        WHEN jj.source_module = 'purchase_invoice'
             AND COALESCE(pi2.currency, 'IDR') = 'USD' THEN 'USD'
        WHEN jj.source_module = 'payment'
             AND (COALESCE(ba2.currency, 'IDR') = 'USD' OR COALESCE(pv2.exchange_rate, 1) > 1.5) THEN 'USD'
        ELSE 'IDR'
      END AS je_currency
    FROM journal_entries jj
    LEFT JOIN purchase_invoices pi2 ON pi2.id = jj.reference_id AND jj.source_module = 'purchase_invoice'
    LEFT JOIN payment_vouchers pv2  ON pv2.id = jj.reference_id AND jj.source_module = 'payment'
    LEFT JOIN bank_accounts ba2 ON ba2.id = pv2.bank_account_id
    WHERE jj.is_posted = true AND COALESCE(jj.is_reversed, false) = false AND jj.entry_date <= p_as_of_date
  ) fx ON fx.je_id = je.id
  WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date <= p_as_of_date AND coa.is_header = false;

  SELECT EXISTS (
    SELECT 1 FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '3300' AND je.is_posted = true AND je.entry_date <= p_as_of_date
  ) INTO v_has_3300;

  RETURN QUERY
  WITH je_fx AS (
    SELECT je.id AS je_id,
      CASE
        WHEN je.source_module = 'purchase_invoice' AND COALESCE(pi.currency, 'IDR') = 'USD' THEN 'USD'
        WHEN je.source_module = 'payment'
             AND (COALESCE(ba.currency, 'IDR') = 'USD' OR COALESCE(pv.exchange_rate, 1) > 1.5) THEN 'USD'
        ELSE 'IDR'
      END AS je_currency
    FROM journal_entries je
    LEFT JOIN purchase_invoices pi ON pi.id = je.reference_id AND je.source_module = 'purchase_invoice'
    LEFT JOIN payment_vouchers pv  ON pv.id = je.reference_id AND je.source_module = 'payment'
    LEFT JOIN bank_accounts ba ON ba.id = pv.bank_account_id
    WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false AND je.entry_date <= p_as_of_date
  )
  SELECT
    coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset','expense') THEN 'debit' ELSE 'credit' END) AS normal_balance,
    COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.debit  * p_usd_rate ELSE jel.debit  END), 0)::NUMERIC AS total_debit,
    COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.credit * p_usd_rate ELSE jel.credit END), 0)::NUMERIC AS total_credit,
    (COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.debit  * p_usd_rate ELSE jel.debit  END), 0)
   - COALESCE(SUM(CASE WHEN fx.je_currency = 'USD' THEN jel.credit * p_usd_rate ELSE jel.credit END), 0))::NUMERIC AS balance
  FROM chart_of_accounts coa
  LEFT JOIN journal_entry_lines jel ON coa.id   = jel.account_id
  LEFT JOIN je_fx               fx  ON fx.je_id = jel.journal_entry_id
  WHERE coa.is_header = false AND coa.is_active = true
    AND coa.account_type IN ('asset','liability','equity','contra')
  GROUP BY coa.id, coa.code, coa.name, coa.name_id,
           coa.account_type, coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(jel.debit), 0) != 0 OR COALESCE(SUM(jel.credit), 0) != 0

  UNION ALL

  SELECT '3300'::VARCHAR, 'Current Year Earnings'::VARCHAR, 'Laba/Rugi Tahun Berjalan'::VARCHAR,
    'equity'::VARCHAR, 'Equity'::VARCHAR, 'credit'::VARCHAR,
    CASE WHEN v_net_income < 0 THEN ABS(v_net_income) ELSE 0 END,
    CASE WHEN v_net_income > 0 THEN     v_net_income   ELSE 0 END,
    (-v_net_income)::NUMERIC
  WHERE NOT v_has_3300 AND ABS(v_net_income) > 0.005

  ORDER BY 1;
END;
$$;
