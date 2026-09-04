/*
  # Broker supplier scope — real fix, not just documentation

  Finance Stabilization Sprint (2026-07-06), Task 1.

  Problem
  -------
  When an Import / Customs Broker Invoice carries broker_items JSONB with
  per-line supplier_id + ppn_amount, the previous vw_input_ppn_report
  Branch 3 rolled the total PPN into a SINGLE row attributed to the parent
  finance_expenses.supplier_id (the main invoice supplier — e.g.
  PT TRANS EXIS JAYA). Meanwhile the actual tax invoice (faktur pajak) for
  each broker line comes from the sub-supplier (e.g. TRANSLINER MARITIME),
  so the report misrepresents WHO issued the tax invoice.

  Result: users reported that the "supplier" appearing in the Input PPN
  report did not match the tax invoice on file — either the main supplier
  showed with the wrong PPN attribution, or after a naive fix, the broker
  line supplier bled into the parent-level rows.

  Fix
  ---
  1. `vw_input_ppn_report`:
     - Branch 3 (supplier invoice PPN from regular expenses) is restricted
       to expenses that do NOT have per-line broker suppliers with PPN.
       Prevents double-counting.
     - New Branch 5 explodes broker_items and emits one row per broker line
       that carries ppn_amount > 0, attributed to the broker-line supplier
       (or the parent supplier if the line has none). The main invoice
       supplier is exposed in a separate `parent_supplier` column for
       traceability.

  2. `vw_monthly_tax_summary`:
     - Adds broker-line PPN into the input_ppn_paid rollup, so monthly
       totals match `vw_input_ppn_report` line-by-line.

  3. AP, Aging, Supplier Ledger, Expense Listing, Trial Balance are NOT
     affected — they already key off `finance_expenses.supplier_id` (the
     main invoice supplier) and never touch broker_items. Documentation
     comments added to make the invariant explicit.

  Backward compatibility: existing rows with no broker_items are unchanged.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Documentation comments on the invariant
-- ────────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.finance_expenses.supplier_id IS
'Main invoice supplier for this expense. NEVER overwritten by broker line suppliers. '
'All financial reports keyed to a single supplier (AP, Aging, Supplier Ledger, '
'Trial Balance, Expense Listing, Vendor Reports) MUST use this column.';

COMMENT ON COLUMN public.finance_expenses.broker_items IS
'JSONB array of broker-invoice line items (Import / Customs Broker Invoice only). '
'Each element may carry {type, description, amount, supplier_id, invoice_number, '
'invoice_date, ppn_treatment, ppn_amount, npwp, container_reference, attachment_path}. '
'The optional per-line supplier_id represents a sub-vendor whose tax invoice (faktur '
'pajak) covers that line only. It is used ONLY by the PPN / tax reports for faktur-pajak '
'attribution and MUST NEVER replace finance_expenses.supplier_id in any other report.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Rebuild vw_input_ppn_report with Branch 3 exclusion + Branch 5 explosion
-- ────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.vw_input_ppn_report;

CREATE VIEW public.vw_input_ppn_report AS

-- Branch 1: PIB PPN Import
SELECT
  date_trunc('month', fe.expense_date::timestamptz) AS month,
  fe.expense_date,
  'PIB Import'::text                AS document_type,
  COALESCE(ic.container_ref, '-')   AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  COALESCE(s.company_name, '-')     AS parent_supplier,
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

-- Branch 2: Legacy ppn_import category
SELECT
  date_trunc('month', fe.expense_date::timestamptz) AS month,
  fe.expense_date,
  'PPN Import (Legacy)'::text       AS document_type,
  COALESCE(ic.container_ref, fe.description, '-') AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  COALESCE(s.company_name, '-')     AS parent_supplier,
  fe.amount                         AS dpp_amount,
  fe.amount                         AS ppn_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
LEFT JOIN import_containers ic ON fe.import_container_id = ic.id
LEFT JOIN suppliers s ON ic.supplier_id = s.id
WHERE fe.expense_category = 'ppn_import'

UNION ALL

-- Branch 3: Supplier invoice PPN from regular expenses (parent-level PPN)
--   Excluded: expenses where broker_items carry per-line PPN — those are
--   emitted by Branch 5 to avoid double-counting AND to correctly attribute
--   PPN to the broker-line (faktur-pajak-issuing) supplier.
SELECT
  date_trunc('month', fe.expense_date::timestamptz) AS month,
  fe.expense_date,
  'Supplier Invoice'::text          AS document_type,
  COALESCE(fe.invoice_number, fe.description, '-') AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  COALESCE(s.company_name, '-')     AS parent_supplier,
  fe.amount                         AS dpp_amount,
  fe.ppn_amount                     AS ppn_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
LEFT JOIN suppliers s ON fe.supplier_id = s.id
WHERE COALESCE(fe.ppn_amount, 0) > 0
  AND fe.expense_category NOT IN ('pib_import', 'ppn_import', 'pph_import')
  AND NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
     WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
  )

UNION ALL

-- Branch 4: Purchase invoice PPN
SELECT
  date_trunc('month', pi.invoice_date::timestamptz) AS month,
  pi.invoice_date                   AS expense_date,
  'Purchase Invoice'::text          AS document_type,
  COALESCE(pi.invoice_number, '-')  AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  COALESCE(s.company_name, '-')     AS parent_supplier,
  pi.subtotal                       AS dpp_amount,
  pi.tax_amount                     AS ppn_amount,
  pi.notes                          AS description,
  pi.created_at
FROM purchase_invoices pi
LEFT JOIN suppliers s ON pi.supplier_id = s.id
WHERE COALESCE(pi.tax_amount, 0) > 0

UNION ALL

-- Branch 5: Broker line PPN — one row per broker_items entry with ppn_amount > 0
--   Supplier column = broker-line supplier (faktur-pajak issuer).
--   parent_supplier column = main finance_expenses.supplier_id — traceability only.
SELECT
  date_trunc('month', fe.expense_date::timestamptz)             AS month,
  fe.expense_date,
  'Broker Invoice Line'::text                                   AS document_type,
  COALESCE(item->>'invoice_number', fe.invoice_number, '-')     AS reference,
  COALESCE(bs.company_name, ps.company_name, '-')               AS supplier,
  COALESCE(bs.npwp, item->>'npwp', ps.npwp, '-')                AS supplier_npwp,
  COALESCE(ps.company_name, '-')                                AS parent_supplier,
  -- DPP for included lines = amount - ppn ; for excluded/none = amount
  CASE
    WHEN item->>'ppn_treatment' = 'included'
      THEN (item->>'amount')::numeric - COALESCE((item->>'ppn_amount')::numeric, 0)
    ELSE (item->>'amount')::numeric
  END                                                           AS dpp_amount,
  COALESCE((item->>'ppn_amount')::numeric, 0)                   AS ppn_amount,
  COALESCE(item->>'description', fe.description)                AS description,
  fe.created_at
FROM finance_expenses fe
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
LEFT JOIN suppliers bs ON bs.id = NULLIF(item->>'supplier_id', '')::uuid
LEFT JOIN suppliers ps ON ps.id = fe.supplier_id
WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
  AND fe.expense_category NOT IN ('pib_import', 'ppn_import', 'pph_import')

ORDER BY expense_date DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Rebuild vw_monthly_tax_summary to include broker-line PPN
-- ────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.vw_monthly_tax_summary;

CREATE VIEW public.vw_monthly_tax_summary AS
WITH
input_ppn AS (
  -- PIB pib_ppn_amount
  SELECT
    date_trunc('month', expense_date::timestamptz) AS month,
    COALESCE(pib_ppn_amount, 0) AS ppn
  FROM finance_expenses
  WHERE expense_category = 'pib_import' AND COALESCE(pib_ppn_amount, 0) > 0

  UNION ALL

  -- Legacy ppn_import
  SELECT
    date_trunc('month', expense_date::timestamptz) AS month,
    amount AS ppn
  FROM finance_expenses
  WHERE expense_category = 'ppn_import'

  UNION ALL

  -- Regular supplier invoice PPN (exclude those with broker-line PPN)
  SELECT
    date_trunc('month', fe.expense_date::timestamptz) AS month,
    COALESCE(fe.ppn_amount, 0) AS ppn
  FROM finance_expenses fe
  WHERE COALESCE(fe.ppn_amount, 0) > 0
    AND fe.expense_category NOT IN ('pib_import', 'ppn_import', 'pph_import')
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
       WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
    )

  UNION ALL

  -- Broker line PPN
  SELECT
    date_trunc('month', fe.expense_date::timestamptz) AS month,
    COALESCE((item->>'ppn_amount')::numeric, 0) AS ppn
  FROM finance_expenses fe
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
  WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
    AND fe.expense_category NOT IN ('pib_import', 'ppn_import', 'pph_import')

  UNION ALL

  -- Purchase invoice tax
  SELECT
    date_trunc('month', invoice_date::timestamptz) AS month,
    COALESCE(tax_amount, 0) AS ppn
  FROM purchase_invoices
  WHERE COALESCE(tax_amount, 0) > 0
),
output_ppn AS (
  SELECT
    date_trunc('month', invoice_date::timestamptz) AS month,
    COALESCE(tax_amount, 0) AS ppn
  FROM sales_invoices
  WHERE COALESCE(tax_amount, 0) > 0
),
months AS (
  SELECT DISTINCT month FROM input_ppn
  UNION
  SELECT DISTINCT month FROM output_ppn
)
SELECT
  m.month,
  COALESCE((SELECT SUM(ppn) FROM input_ppn WHERE month = m.month), 0)  AS input_ppn_paid,
  COALESCE((SELECT SUM(ppn) FROM output_ppn WHERE month = m.month), 0) AS output_ppn_collected,
  COALESCE((SELECT SUM(ppn) FROM output_ppn WHERE month = m.month), 0)
    - COALESCE((SELECT SUM(ppn) FROM input_ppn WHERE month = m.month), 0) AS net_ppn_payable
FROM months m
ORDER BY m.month DESC;

COMMENT ON VIEW public.vw_input_ppn_report IS
'Input VAT (PPN Masukan) register. Rows: PIB import, legacy ppn_import, regular supplier '
'invoice PPN (parent-level), broker-line PPN (per faktur-pajak-issuing sub-supplier), '
'and purchase invoice tax. The `supplier` column always names the faktur-pajak issuer; '
'`parent_supplier` names the expense''s main invoice supplier (finance_expenses.supplier_id) '
'and is provided for traceability. AP / Aging / Supplier Ledger / Expense List must NOT '
'consume this view — they key off finance_expenses.supplier_id directly.';

COMMENT ON VIEW public.vw_monthly_tax_summary IS
'Monthly PPN summary. input_ppn_paid = PIB + legacy ppn_import + parent-level supplier '
'PPN (only when broker_items carry no per-line PPN) + broker-line PPN + purchase invoice '
'tax. output_ppn_collected from sales_invoices.tax_amount. Aligned with vw_input_ppn_report.';
