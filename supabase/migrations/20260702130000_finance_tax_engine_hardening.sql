-- ============================================================================
-- Migration: 20260702130000_finance_tax_engine_hardening
-- Date:      2026-07-02
--
-- Purpose: Fix critical tax engine gaps identified in audit:
--
-- 1. Add COA 1150 — PPN Masukan (Input VAT receivable/creditable)
--    CRITICAL: auto_post_expense_accounting() and save_purchase_invoice()
--    already reference code '1150' but the account was missing, causing
--    PPN Input debit lines to be silently skipped.
--
-- 2. Fix get_expense_account_id('professional_services')
--    Was mapping to 6410 (Office Administration) — should map to 6700 (Professional Fees)
--
-- 3. Extend vw_input_ppn_report to include supplier invoice PPN
--    The view previously only showed PIB/import PPN. Expenses with ppn_amount > 0
--    (standard invoices: rent, utilities, professional services, broker) were
--    excluded from the input VAT register — breaking the monthly SPT calculation.
--
-- 4. Extend vw_monthly_tax_summary to include supplier invoice PPN in input_ppn_paid
--    The summary fed only import PPN into input_ppn_paid. Standard supplier invoice
--    PPN (from finance_expenses.ppn_amount and purchase_invoices.tax_amount) was excluded.
--
-- Backward compatibility: All existing JEs, triggers, RPCs are unchanged.
-- Existing posted expense entries with ppn_amount > 0 were silently missing the
-- DR 1150 line. Those historical JEs are NOT retroactively corrected (correcting
-- historical postings would require auditor approval). Going forward, all new
-- expense postings will correctly include DR 1150 for PPN Input.
-- ============================================================================

-- ── 1. Add PPN Masukan account (1150) ────────────────────────────────────────
-- This is the creditable Input VAT account (Pajak Masukan).
-- Used by: auto_post_expense_accounting(), save_purchase_invoice()
-- DR when: supplier charges PPN on their invoice
-- CR when: PPN Input is settled against PPN Output in monthly tax settlement

INSERT INTO chart_of_accounts (code, name, account_type, is_header, normal_balance, is_active, created_at)
SELECT '1150', 'PPN Masukan (Input VAT)', 'asset', false, 'debit', true, now()
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '1150');

-- ── 2. Fix professional_services → 6700 in get_expense_account_id() ─────────
-- Previous mapping: professional_services → 6410 (Office Administration) — wrong
-- Correct mapping:  professional_services → 6700 (Professional Fees) — exists

CREATE OR REPLACE FUNCTION public.get_expense_account_id(p_category TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  v_account_id := CASE p_category
    WHEN 'salary'                    THEN (SELECT id FROM chart_of_accounts WHERE code = '6100' LIMIT 1)
    WHEN 'staff_overtime'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6100' LIMIT 1)
    WHEN 'staff_welfare'             THEN (SELECT id FROM chart_of_accounts WHERE code = '6150' LIMIT 1)
    WHEN 'employee_benefits'         THEN (SELECT id FROM chart_of_accounts WHERE code = '6110' LIMIT 1)
    WHEN 'travel_conveyance'         THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'office_rent'               THEN (SELECT id FROM chart_of_accounts WHERE code = '6220' LIMIT 1)
    WHEN 'warehouse_rent'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6210' LIMIT 1)
    WHEN 'rent'                      THEN (SELECT id FROM chart_of_accounts WHERE code = '6200' LIMIT 1)
    WHEN 'office_admin'              THEN (SELECT id FROM chart_of_accounts WHERE code = '6410' LIMIT 1)
    WHEN 'office_supplies'           THEN (SELECT id FROM chart_of_accounts WHERE code = '6400' LIMIT 1)
    WHEN 'office_shifting_renovation'THEN (SELECT id FROM chart_of_accounts WHERE code = '6420' LIMIT 1)
    WHEN 'utilities'                 THEN (SELECT id FROM chart_of_accounts WHERE code = '6300' LIMIT 1)
    WHEN 'electricity'               THEN (SELECT id FROM chart_of_accounts WHERE code = '6310' LIMIT 1)
    WHEN 'water'                     THEN (SELECT id FROM chart_of_accounts WHERE code = '6320' LIMIT 1)
    WHEN 'internet_phone'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6330' LIMIT 1)
    WHEN 'fuel'                      THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'vehicle_maintenance'       THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'delivery_sales'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6510' LIMIT 1)
    WHEN 'loading_sales'             THEN (SELECT id FROM chart_of_accounts WHERE code = '6520' LIMIT 1)
    WHEN 'other_sales'               THEN (SELECT id FROM chart_of_accounts WHERE code = '6510' LIMIT 1)
    WHEN 'marketing_advertising'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6600' LIMIT 1)
    WHEN 'legal_professional'        THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'consulting_fees'           THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'accounting_audit'          THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    -- FIXED: professional_services now maps to 6700 (Professional Fees), not 6410
    WHEN 'professional_services'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'bank_charges'              THEN (SELECT id FROM chart_of_accounts WHERE code = '7100' LIMIT 1)
    WHEN 'interest_expense'          THEN (SELECT id FROM chart_of_accounts WHERE code = '7200' LIMIT 1)
    WHEN 'duty_customs'              THEN (SELECT id FROM chart_of_accounts WHERE code = '1130' LIMIT 1)
    WHEN 'duty_import'               THEN (SELECT id FROM chart_of_accounts WHERE code = '1130' LIMIT 1)
    WHEN 'freight_import'            THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'clearing_forwarding'       THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'port_charges'              THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'container_handling'        THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'transport_import'          THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'loading_import'            THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'bpom_ski_fees'             THEN (SELECT id FROM chart_of_accounts WHERE code = '5410' LIMIT 1)
    WHEN 'other_import'              THEN (SELECT id FROM chart_of_accounts WHERE code = '5400' LIMIT 1)
    WHEN 'import_broker'             THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'ppn_import'                THEN (SELECT id FROM chart_of_accounts WHERE code = '1150' LIMIT 1)
    WHEN 'pph_import'                THEN (SELECT id FROM chart_of_accounts WHERE code = '1155' LIMIT 1)
    -- PIB handled by dedicated path; no single account
    WHEN 'pib_import'                THEN NULL
    WHEN 'duty'                      THEN (SELECT id FROM chart_of_accounts WHERE code = '1130' LIMIT 1)
    WHEN 'freight'                   THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'office'                    THEN (SELECT id FROM chart_of_accounts WHERE code = '6400' LIMIT 1)
    WHEN 'other'                     THEN (SELECT id FROM chart_of_accounts WHERE code = '6900' LIMIT 1)
    -- fixed_asset handled separately in auto_post_expense_accounting(); NULL here is correct
    WHEN 'fixed_asset'               THEN NULL
    ELSE (SELECT id FROM chart_of_accounts WHERE code = '6900' LIMIT 1)
  END;

  -- Fallback: if still NULL and not PIB/fixed_asset, use General Expense account
  IF v_account_id IS NULL AND p_category NOT IN ('pib_import', 'fixed_asset') THEN
    SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '6000' LIMIT 1;
  END IF;

  RETURN v_account_id;
END;
$$;

-- ── 3. Extend vw_input_ppn_report to include supplier invoice PPN ────────────
-- The old view only showed PPn from PIB imports and ppn_import category expenses.
-- The new view also includes:
--   a) Regular expense invoices with ppn_amount > 0 (rent, utilities, broker, etc.)
--   b) Purchase invoices with tax_amount > 0
-- This gives a complete Buku Pajak Masukan for SPT filing.

DROP VIEW IF EXISTS public.vw_input_ppn_report;
CREATE VIEW public.vw_input_ppn_report AS

-- Branch 1: PIB PPN Import (pib_import category with pib_ppn_amount)
SELECT
  date_trunc('month', fe.expense_date::timestamptz) AS month,
  fe.expense_date,
  'PIB Import'::text                AS document_type,
  COALESCE(ic.container_ref, '-')   AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  COALESCE(ic.import_invoice_value, fe.amount) AS dpp_amount,
  COALESCE(fe.pib_ppn_amount, 0)    AS ppn_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
LEFT JOIN import_containers ic ON fe.import_container_id = ic.id
LEFT JOIN suppliers s ON ic.supplier_id = s.id
WHERE fe.expense_category = 'pib_import'
  AND COALESCE(fe.pib_ppn_amount, 0) > 0

UNION ALL

-- Branch 2: Legacy ppn_import category expenses (standalone PPN rows in older workflow)
SELECT
  date_trunc('month', fe.expense_date::timestamptz) AS month,
  fe.expense_date,
  'PPN Import (Legacy)'::text       AS document_type,
  COALESCE(ic.container_ref, fe.description, '-') AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  fe.amount                         AS dpp_amount,
  fe.amount                         AS ppn_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
LEFT JOIN import_containers ic ON fe.import_container_id = ic.id
LEFT JOIN suppliers s ON ic.supplier_id = s.id
WHERE fe.expense_category = 'ppn_import'

UNION ALL

-- Branch 3: Supplier invoice PPN from regular expenses (ppn_amount > 0, non-PIB)
SELECT
  date_trunc('month', fe.expense_date::timestamptz) AS month,
  fe.expense_date,
  'Supplier Invoice'::text          AS document_type,
  COALESCE(fe.invoice_number, fe.description, '-') AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  fe.amount                         AS dpp_amount,
  fe.ppn_amount                     AS ppn_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
LEFT JOIN suppliers s ON fe.supplier_id = s.id
WHERE COALESCE(fe.ppn_amount, 0) > 0
  AND fe.expense_category NOT IN ('pib_import', 'ppn_import', 'pph_import')

UNION ALL

-- Branch 4: Purchase invoice PPN (tax_amount > 0)
SELECT
  date_trunc('month', pi.invoice_date::timestamptz) AS month,
  pi.invoice_date                   AS expense_date,
  'Purchase Invoice'::text          AS document_type,
  COALESCE(pi.invoice_number, '-')  AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  pi.subtotal                       AS dpp_amount,
  pi.tax_amount                     AS ppn_amount,
  pi.notes                          AS description,
  pi.created_at
FROM purchase_invoices pi
LEFT JOIN suppliers s ON pi.supplier_id = s.id
WHERE COALESCE(pi.tax_amount, 0) > 0

ORDER BY expense_date DESC;

-- ── 4. Extend vw_monthly_tax_summary to include all PPN sources ──────────────
-- Old version: input_ppn_paid only from PIB/ppn_import expenses
-- New version: input_ppn_paid = PIB PPN + legacy ppn_import + supplier invoice PPN + purchase invoice PPN
-- output_ppn_collected: unchanged (from sales_invoices.tax_amount)

DROP VIEW IF EXISTS public.vw_monthly_tax_summary;
CREATE VIEW public.vw_monthly_tax_summary AS
WITH

-- All input PPN from all sources (mirrors vw_input_ppn_report branches)
input_ppn AS (
  -- PIB pib_ppn_amount
  SELECT
    date_trunc('month', expense_date::timestamptz) AS month,
    COALESCE(pib_ppn_amount, 0) AS ppn
  FROM finance_expenses
  WHERE expense_category = 'pib_import' AND COALESCE(pib_ppn_amount, 0) > 0

  UNION ALL

  -- Legacy ppn_import category
  SELECT
    date_trunc('month', expense_date::timestamptz) AS month,
    amount AS ppn
  FROM finance_expenses
  WHERE expense_category = 'ppn_import'

  UNION ALL

  -- Supplier invoice ppn_amount (regular expenses)
  SELECT
    date_trunc('month', expense_date::timestamptz) AS month,
    ppn_amount AS ppn
  FROM finance_expenses
  WHERE COALESCE(ppn_amount, 0) > 0
    AND expense_category NOT IN ('pib_import', 'ppn_import', 'pph_import')

  UNION ALL

  -- Purchase invoice tax_amount
  SELECT
    date_trunc('month', invoice_date::timestamptz) AS month,
    tax_amount AS ppn
  FROM purchase_invoices
  WHERE COALESCE(tax_amount, 0) > 0
),

-- All output PPN from sales invoices
output_ppn AS (
  SELECT
    date_trunc('month', invoice_date::timestamptz) AS month,
    tax_amount AS ppn
  FROM sales_invoices
  WHERE COALESCE(tax_amount, 0) > 0
),

all_months AS (
  SELECT DISTINCT month FROM input_ppn
  UNION
  SELECT DISTINCT month FROM output_ppn
)

SELECT
  m.month,
  COALESCE(SUM(i.ppn), 0) AS input_ppn_paid,
  COALESCE((SELECT SUM(o.ppn) FROM output_ppn o WHERE o.month = m.month), 0) AS output_ppn_collected,
  COALESCE((SELECT SUM(o.ppn) FROM output_ppn o WHERE o.month = m.month), 0)
    - COALESCE(SUM(i.ppn), 0) AS net_ppn_payable
FROM all_months m
LEFT JOIN input_ppn i ON i.month = m.month
GROUP BY m.month
ORDER BY m.month DESC;

-- ── 5. Grant view access (consistent with other finance views) ───────────────
GRANT SELECT ON public.vw_input_ppn_report     TO authenticated;
GRANT SELECT ON public.vw_monthly_tax_summary  TO authenticated;
