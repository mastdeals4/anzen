-- Report-only correction: include all active posted COGS evidence for an
-- invoice, including historical correction/final-correction journals.
-- No accounting or business rows are modified. Rp1.00 remains the sole
-- reconciliation tolerance for reconstructed multi-line allocations.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_authoritative_sales_line_cogs(
  p_start_date date, p_end_date date
)
RETURNS TABLE (
  line_id uuid, invoice_id uuid, product_id uuid, batch_id uuid, quantity numeric,
  authoritative_cogs numeric, authoritative_unit_cogs numeric, resolution_tier text,
  invoice_line_count bigint, invoice_product_count bigint, posted_invoice_cogs numeric,
  base_line_cost numeric, reconciliation_difference numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
WITH active_cogs AS (
  SELECT je.reference_id AS invoice_id, je.id AS journal_id,
         SUM(jel.debit - jel.credit) AS cogs_amount
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100'
    AND je.reference_id IS NOT NULL
    AND (
      je.source_module = 'sales_invoice_cogs'
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
    )
  GROUP BY je.reference_id, je.id
), posted_cogs AS (
  SELECT invoice_id, SUM(cogs_amount) AS posted_invoice_cogs
  FROM active_cogs GROUP BY invoice_id
), posted_item_cogs AS (
  SELECT jel.sales_invoice_item_id AS line_id,
         SUM(jel.debit - jel.credit) AS posted_item_cogs
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100' AND jel.sales_invoice_item_id IS NOT NULL
    AND (
      je.source_module = 'sales_invoice_cogs'
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
    )
  GROUP BY jel.sales_invoice_item_id
), line_basis AS (
  SELECT sii.id AS line_id, sii.invoice_id, sii.product_id, sii.batch_id,
         sii.quantity, pic.posted_item_cogs, sii.cogs_total_cost AS snapshot_cogs,
         CASE WHEN COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)) IS NULL
              THEN NULL ELSE sii.quantity * COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)) END AS base_line_cost,
         pc.posted_invoice_cogs
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  LEFT JOIN posted_cogs pc ON pc.invoice_id = sii.invoice_id
  LEFT JOIN posted_item_cogs pic ON pic.line_id = sii.id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
), invoice_evidence AS (
  SELECT invoice_id, COUNT(*) AS invoice_line_count,
         COUNT(DISTINCT product_id) AS invoice_product_count,
         COUNT(*) FILTER (WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL) AS unresolved_line_count,
         COUNT(*) FILTER (WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL AND base_line_cost IS NOT NULL) AS unresolved_base_line_count,
         COALESCE(SUM(COALESCE(posted_item_cogs, snapshot_cogs)), 0) AS resolved_cogs_total,
         SUM(base_line_cost) FILTER (WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL) AS unresolved_base_cost_total,
         MAX(posted_invoice_cogs) AS posted_invoice_cogs
  FROM line_basis GROUP BY invoice_id
), resolved AS (
  SELECT lb.*, ie.invoice_line_count, ie.invoice_product_count,
         ie.unresolved_line_count, ie.unresolved_base_line_count,
         ie.resolved_cogs_total, ie.unresolved_base_cost_total,
         ie.posted_invoice_cogs AS invoice_posted_cogs,
         ie.posted_invoice_cogs - ie.resolved_cogs_total AS residual_posted_cogs,
         ABS(ie.unresolved_base_cost_total - (ie.posted_invoice_cogs - ie.resolved_cogs_total)) AS reconciliation_difference
  FROM line_basis lb JOIN invoice_evidence ie ON ie.invoice_id = lb.invoice_id
)
SELECT r.line_id, r.invoice_id, r.product_id, r.batch_id, r.quantity,
  CASE
    WHEN r.posted_item_cogs IS NOT NULL THEN r.posted_item_cogs
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs
    WHEN r.invoice_line_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)
    ELSE NULL END AS authoritative_cogs,
  CASE
    WHEN r.quantity = 0 THEN NULL
    WHEN r.posted_item_cogs IS NOT NULL THEN r.posted_item_cogs / r.quantity
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs / r.quantity
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs / r.quantity
    WHEN r.invoice_line_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN (r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)) / r.quantity
    ELSE NULL END AS authoritative_unit_cogs,
  CASE
    WHEN r.posted_item_cogs IS NOT NULL THEN 'posted_item_cogs'
    WHEN r.snapshot_cogs IS NOT NULL THEN 'snapshot'
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN 'single_line_posted_cogs'
    WHEN r.invoice_line_count > 1 AND r.invoice_product_count = 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00 THEN 'single_product_proven_allocation'
    WHEN r.invoice_line_count > 1 AND r.invoice_product_count > 1 AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00 THEN 'multi_product_proven_allocation'
    ELSE 'unresolved' END AS resolution_tier,
  r.invoice_line_count, r.invoice_product_count, r.invoice_posted_cogs,
  r.base_line_cost, r.reconciliation_difference
FROM resolved r;
$$;

COMMENT ON FUNCTION public.get_authoritative_sales_line_cogs(date, date) IS
  'Read-only COGS waterfall including active posted sales COGS and historical correction/final-correction 5100 evidence; Rp1.00 reconciliation tolerance.';

COMMIT;
