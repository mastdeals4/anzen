/*
  Broker reimbursement lines — per-line DPP + PPN rate readback
  --------------------------------------------------------------
  Additive read-only view refresh. NO schema change, NO business-logic change.

  Context (2026-07-07)
    The finance_expenses.broker_items JSONB now stores per-line
    dpp_amount and ppn_rate for each reimbursement line — one per
    forwarder sub-invoice — matching Indonesian tax invoice conventions.

    The Input PPN report Branch 5 was previously deriving DPP from
    line.amount minus line.ppn_amount (or using line.amount when the
    line was 'excluded'). Now that the line CAN carry an explicit DPP,
    the report should prefer that value and fall back to the old
    derivation only for legacy rows.

    This migration replaces vw_input_ppn_report Branch 5 with a
    DPP-aware version.

  Backward compatibility
    Legacy broker lines without dpp_amount continue to compute DPP
    from amount / ppn as before.

  Journal Entries / Ledger / Payment Voucher / Purchase Register /
  Tax Report totals — all unchanged. This is a read-only view.
*/

-- Drop and recreate the view. Branches 1-4 are copied verbatim from
-- 20260706120000_broker_items_supplier_comment.sql. Only Branch 5's DPP
-- calculation is updated.

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

-- Branch 3: Regular supplier invoice PPN (parent-level, excluding rows where broker_items own PPN)
SELECT
  date_trunc('month', fe.expense_date::timestamptz) AS month,
  fe.expense_date,
  'Supplier Invoice'::text          AS document_type,
  COALESCE(fe.invoice_number, fe.description, '-') AS reference,
  COALESCE(s.company_name, '-')     AS supplier,
  COALESCE(s.npwp, '-')             AS supplier_npwp,
  COALESCE(s.company_name, '-')     AS parent_supplier,
  COALESCE(fe.dpp_amount, fe.amount) AS dpp_amount,
  fe.ppn_amount                     AS ppn_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
LEFT JOIN suppliers s ON s.id = fe.supplier_id
WHERE COALESCE(fe.ppn_amount, 0) > 0
  AND fe.expense_category NOT IN ('pib_import', 'ppn_import', 'pph_import')
  AND NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
     WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
  )

UNION ALL

-- Branch 4: Purchase invoices
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
LEFT JOIN suppliers s ON s.id = pi.supplier_id
WHERE COALESCE(pi.tax_amount, 0) > 0

UNION ALL

-- Branch 5: Broker reimbursement lines — one row per broker_items entry.
-- Updated 2026-07-07 to prefer per-line dpp_amount when the frontend
-- persisted it explicitly. Legacy rows fall back to the amount/ppn
-- derivation so historical tax reports do not shift.
SELECT
  date_trunc('month', fe.expense_date::timestamptz) AS month,
  fe.expense_date,
  'Broker Invoice Line'::text                                   AS document_type,
  COALESCE(item->>'invoice_number', fe.invoice_number, '-')     AS reference,
  COALESCE(bs.company_name, ps.company_name, '-')               AS supplier,
  COALESCE(bs.npwp, item->>'npwp', ps.npwp, '-')                AS supplier_npwp,
  COALESCE(ps.company_name, '-')                                AS parent_supplier,
  -- DPP: prefer explicit line.dpp_amount; else derive from amount/ppn.
  COALESCE(
    NULLIF(item->>'dpp_amount', '')::numeric,
    CASE
      WHEN item->>'ppn_treatment' = 'included'
        THEN (item->>'amount')::numeric - COALESCE((item->>'ppn_amount')::numeric, 0)
      ELSE (item->>'amount')::numeric
    END
  )                                                             AS dpp_amount,
  COALESCE((item->>'ppn_amount')::numeric, 0)                   AS ppn_amount,
  COALESCE(item->>'description', fe.description)                AS description,
  fe.created_at
FROM finance_expenses fe
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
LEFT JOIN suppliers bs ON bs.id = NULLIF(item->>'supplier_id', '')::uuid
LEFT JOIN suppliers ps ON ps.id = fe.supplier_id
WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
;

COMMENT ON VIEW public.vw_input_ppn_report IS
'Indonesian Input PPN (Faktur Pajak Masukan) tax report — read-only. '
'Branches: PIB Import, Legacy ppn_import, Regular supplier invoices, '
'Purchase invoices, and per-line broker reimbursements. '
'Broker reimbursements prefer explicit per-line dpp_amount (2026-07-07 refactor); '
'legacy rows fall back to derived DPP.';
