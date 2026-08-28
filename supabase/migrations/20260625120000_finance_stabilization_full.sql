-- ================================================================
-- Finance Stabilization — Full Fix Migration
-- Fixes: COA schema, header posting, SAPJ-26-001 journal,
--        get_balance_sheet (current year earnings), get_trial_balance
-- ================================================================

-- ────────────────────────────────────────────────────────────────
-- 1. COA SCHEMA CORRECTIONS
-- ────────────────────────────────────────────────────────────────
UPDATE chart_of_accounts
SET account_group = 'Current Assets'
WHERE code IN ('111101','111102')
  AND (account_group IS NULL OR account_group = '');

UPDATE chart_of_accounts
SET normal_balance = 'debit'
WHERE code = '1203'
  AND (normal_balance IS NULL OR normal_balance = '');

-- ────────────────────────────────────────────────────────────────
-- 2. FIX JE2606-0052: reclassify PIB-PPN line from header 6000
--    to leaf 5400 (Other Import Costs)
--    The Rp 123,035,880 debit on the rollup parent caused the
--    Trial Balance to show debits ≠ credits by exactly this amount.
-- ────────────────────────────────────────────────────────────────
UPDATE journal_entry_lines
SET account_id = (SELECT id FROM chart_of_accounts WHERE code = '5400')
WHERE account_id = (SELECT id FROM chart_of_accounts WHERE code = '6000')
  AND journal_entry_id = (
    SELECT id FROM journal_entries WHERE entry_number = 'JE2606-0052'
  );

-- ────────────────────────────────────────────────────────────────
-- 3. HARD ENFORCEMENT: block all future postings to header accounts
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_header_account_posting()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_code TEXT;
  v_is_header BOOLEAN;
BEGIN
  SELECT code, is_header
    INTO v_code, v_is_header
    FROM chart_of_accounts
   WHERE id = NEW.account_id;

  IF COALESCE(v_is_header, false) THEN
    RAISE EXCEPTION
      'Journal lines cannot be posted to header account % — use a leaf account instead', v_code;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_no_header_posting ON journal_entry_lines;
CREATE TRIGGER trg_no_header_posting
  BEFORE INSERT OR UPDATE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_header_account_posting();

-- ────────────────────────────────────────────────────────────────
-- 4. CORRECTION JOURNAL FOR SAPJ-26-001
--    Original JE2601-0037 posted only Rp 12,321 AR / 11,100 Rev /
--    1,221 VAT. Invoice face = Rp 78,480,108.
--    Receipt RV/25-26/011 already collected Rp 78,480,108 in full.
-- ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_entry_id   UUID := gen_random_uuid();
  v_invoice_id UUID;
  v_ar_id      UUID;
  v_rev_id     UUID;
  v_vat_id     UUID;
BEGIN
  SELECT id INTO v_invoice_id FROM sales_invoices   WHERE invoice_number = 'SAPJ-26-001';
  SELECT id INTO v_ar_id      FROM chart_of_accounts WHERE code = '1120';
  SELECT id INTO v_rev_id     FROM chart_of_accounts WHERE code = '4100';
  SELECT id INTO v_vat_id     FROM chart_of_accounts WHERE code = '2130';

  INSERT INTO journal_entries (
    id, entry_number, entry_date, source_module, reference_id,
    reference_number, description, total_debit, total_credit,
    is_posted, is_reversed, transaction_category
  ) VALUES (
    v_entry_id,
    'CORR-2601-SAPJ001',
    '2026-01-15',
    'correction',
    v_invoice_id,
    'SAPJ-26-001',
    'Correction: SAPJ-26-001 original journal JE2601-0037 posted Rp 12,321 instead of Rp 78,480,108. This entry records the missing Rp 78,467,787.',
    78467787.00,
    78467787.00,
    true,
    false,
    'sales_correction'
  );

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES
    (v_entry_id, 1, v_ar_id,  'AR correction — SAPJ-26-001',      78467787.00,    0.00),
    (v_entry_id, 2, v_rev_id, 'Revenue correction — SAPJ-26-001',         0.00, 70691700.00),
    (v_entry_id, 3, v_vat_id, 'PPN 11%% correction — SAPJ-26-001',        0.00,  7776087.00);
END;
$$;

-- ────────────────────────────────────────────────────────────────
-- 5. REBUILD get_trial_balance — add is_reversed filter
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_trial_balance(p_start_date DATE, p_end_date DATE)
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
  SELECT
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
    )                                                          AS normal_balance,
    COALESCE(SUM(jel.debit),  0)::NUMERIC                     AS total_debit,
    COALESCE(SUM(jel.credit), 0)::NUMERIC                     AS total_credit,
    (COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0))::NUMERIC AS balance
  FROM chart_of_accounts      coa
  LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
  LEFT JOIN journal_entries      je  ON jel.journal_entry_id = je.id
    AND je.is_posted              = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date            >= p_start_date
    AND je.entry_date            <= p_end_date
  WHERE coa.is_header = false
    AND coa.is_active  = true
  GROUP BY coa.id, coa.code, coa.name, coa.name_id,
           coa.account_type, coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(jel.debit), 0) != 0
      OR COALESCE(SUM(jel.credit), 0) != 0
  ORDER BY coa.code;
END;
$$;

-- ────────────────────────────────────────────────────────────────
-- 6. REBUILD get_balance_sheet — add Current Year Earnings equity
--    row computed dynamically from P&L accounts so that
--    Assets = Liabilities + Equity holds without manual closing.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_balance_sheet(p_as_of_date DATE)
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
      WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'expense' THEN -(jel.debit - jel.credit)
      ELSE 0
    END
  ), 0) INTO v_net_income
  FROM journal_entry_lines jel
  JOIN journal_entries     je  ON je.id  = jel.journal_entry_id
  JOIN chart_of_accounts   coa ON coa.id = jel.account_id
  WHERE je.is_posted              = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date            <= p_as_of_date
    AND coa.is_header             = false;

  SELECT EXISTS (
    SELECT 1
    FROM journal_entry_lines jel
    JOIN journal_entries   je  ON je.id  = jel.journal_entry_id
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code      = '3300'
      AND je.is_posted   = true
      AND je.entry_date <= p_as_of_date
  ) INTO v_has_3300;

  RETURN QUERY
  SELECT
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
    )                                                          AS normal_balance,
    COALESCE(SUM(jel.debit),  0)::NUMERIC                     AS total_debit,
    COALESCE(SUM(jel.credit), 0)::NUMERIC                     AS total_credit,
    (COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0))::NUMERIC AS balance
  FROM chart_of_accounts      coa
  LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
  LEFT JOIN journal_entries      je  ON jel.journal_entry_id = je.id
    AND je.is_posted              = true
    AND COALESCE(je.is_reversed, false) = false
    AND je.entry_date            <= p_as_of_date
  WHERE coa.is_header  = false
    AND coa.is_active   = true
    AND coa.account_type IN ('asset','liability','equity','contra')
  GROUP BY coa.id, coa.code, coa.name, coa.name_id,
           coa.account_type, coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(jel.debit), 0) != 0
      OR COALESCE(SUM(jel.credit), 0) != 0

  UNION ALL

  SELECT
    '3300'::VARCHAR,
    'Current Year Earnings'::VARCHAR,
    'Laba/Rugi Tahun Berjalan'::VARCHAR,
    'equity'::VARCHAR,
    'Equity'::VARCHAR,
    'credit'::VARCHAR,
    CASE WHEN v_net_income < 0 THEN ABS(v_net_income) ELSE 0 END AS total_debit,
    CASE WHEN v_net_income > 0 THEN v_net_income      ELSE 0 END AS total_credit,
    (-v_net_income)::NUMERIC                                      AS balance
  WHERE NOT v_has_3300
    AND ABS(v_net_income) > 0.005

  ORDER BY 1;
END;
$$;
