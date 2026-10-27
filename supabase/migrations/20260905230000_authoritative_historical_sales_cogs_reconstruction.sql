-- Reconstruct report-only historical line COGS when posted accounting and
-- batch evidence prove the allocation. This migration writes no business data.
--
-- Rp1.00 is the maximum permitted reconciliation difference. It accommodates
-- whole-rupiah/document rounding only; percentage or material tolerances are
-- deliberately prohibited.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_authoritative_sales_line_cogs(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  line_id uuid,
  invoice_id uuid,
  product_id uuid,
  batch_id uuid,
  quantity numeric,
  authoritative_cogs numeric,
  authoritative_unit_cogs numeric,
  resolution_tier text,
  invoice_line_count bigint,
  invoice_product_count bigint,
  posted_invoice_cogs numeric,
  base_line_cost numeric,
  reconciliation_difference numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
WITH posted_cogs AS (
  SELECT
    je.reference_id AS invoice_id,
    SUM(jel.debit - jel.credit) AS posted_invoice_cogs
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.source_module = 'sales_invoice_cogs'
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100'
  GROUP BY je.reference_id
), line_basis AS (
  SELECT
    sii.id AS line_id,
    sii.invoice_id,
    sii.product_id,
    sii.batch_id,
    sii.quantity,
    sii.cogs_total_cost AS snapshot_cogs,
    CASE
      WHEN COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)) IS NULL
        THEN NULL
      ELSE sii.quantity * COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0))
    END AS base_line_cost,
    pc.posted_invoice_cogs
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  LEFT JOIN posted_cogs pc ON pc.invoice_id = sii.invoice_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
), invoice_evidence AS (
  SELECT
    invoice_id,
    COUNT(*) AS invoice_line_count,
    COUNT(DISTINCT product_id) AS invoice_product_count,
    COUNT(*) FILTER (WHERE snapshot_cogs IS NULL) AS unresolved_line_count,
    COUNT(*) FILTER (WHERE snapshot_cogs IS NULL AND base_line_cost IS NOT NULL) AS unresolved_base_line_count,
    COALESCE(SUM(snapshot_cogs), 0) AS snapshot_cogs_total,
    SUM(base_line_cost) FILTER (WHERE snapshot_cogs IS NULL) AS unresolved_base_cost_total,
    MAX(posted_invoice_cogs) AS posted_invoice_cogs
  FROM line_basis
  GROUP BY invoice_id
), resolved AS (
  SELECT
    lb.*,
    ie.invoice_line_count,
    ie.invoice_product_count,
    ie.unresolved_line_count,
    ie.unresolved_base_line_count,
    ie.snapshot_cogs_total,
    ie.unresolved_base_cost_total,
    ie.posted_invoice_cogs AS invoice_posted_cogs,
    ie.posted_invoice_cogs - ie.snapshot_cogs_total AS residual_posted_cogs,
    ABS(ie.unresolved_base_cost_total - (ie.posted_invoice_cogs - ie.snapshot_cogs_total)) AS reconciliation_difference
  FROM line_basis lb
  JOIN invoice_evidence ie ON ie.invoice_id = lb.invoice_id
)
SELECT
  r.line_id,
  r.invoice_id,
  r.product_id,
  r.batch_id,
  r.quantity,
  CASE
    -- Tier 1: immutable posting-time snapshot.
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs
    -- Tier 2: the only invoice line owns all posted invoice COGS.
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs
    -- Tiers 3/4: allocate only when every unresolved line has usable batch
    -- evidence and its total agrees with residual posted COGS within Rp1.00.
    WHEN r.invoice_line_count > 1
      AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)
    ELSE NULL
  END AS authoritative_cogs,
  CASE
    WHEN r.quantity = 0 THEN NULL
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs / r.quantity
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs / r.quantity
    WHEN r.invoice_line_count > 1
      AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN (r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)) / r.quantity
    ELSE NULL
  END AS authoritative_unit_cogs,
  CASE
    WHEN r.snapshot_cogs IS NOT NULL THEN 'snapshot'
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN 'single_line_posted_cogs'
    WHEN r.invoice_line_count > 1
      AND r.invoice_product_count = 1
      AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN 'single_product_proven_allocation'
    WHEN r.invoice_line_count > 1
      AND r.invoice_product_count > 1
      AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN 'multi_product_proven_allocation'
    ELSE 'unresolved'
  END AS resolution_tier,
  r.invoice_line_count,
  r.invoice_product_count,
  r.invoice_posted_cogs,
  r.base_line_cost,
  r.reconciliation_difference
FROM resolved r;
$$;

COMMENT ON FUNCTION public.get_authoritative_sales_line_cogs(date, date) IS
  'Read-only historical COGS waterfall: snapshot, single-line posted COGS, then batch-evidence allocation only when it reconciles to active posted GL 5100 within Rp1.00; otherwise NULL.';

CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH resolved AS (
  SELECT
    ar.*,
    si.invoice_date,
    ROUND(sii.quantity * sii.unit_price, 2) AS sales,
    p.product_name,
    COALESCE(p.product_code, '') AS product_code,
    COALESCE(p.unit, 'kg') AS product_unit
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  JOIN public.sales_invoices si ON si.id = ar.invoice_id
  JOIN public.products p ON p.id = ar.product_id
), products_report AS (
  SELECT
    r.product_id,
    r.product_name,
    r.product_code,
    r.product_unit,
    COALESCE((SELECT SUM(b.current_stock) FROM public.batches b WHERE b.product_id = r.product_id AND b.is_active), 0) AS current_stock,
    SUM(r.quantity) AS sold_qty,
    SUM(r.sales) AS gross_sales,
    SUM(r.authoritative_cogs) AS product_cost,
    0::numeric AS sales_expense,
    CASE WHEN COUNT(r.authoritative_cogs) = COUNT(*) THEN SUM(r.sales) - SUM(r.authoritative_cogs) ELSE NULL END AS gross_profit,
    CASE WHEN COUNT(r.authoritative_cogs) = COUNT(*) THEN SUM(r.sales) - SUM(r.authoritative_cogs) ELSE NULL END AS profit_after_sales_expense,
    CASE WHEN COUNT(r.authoritative_cogs) = COUNT(*) THEN ROUND(SUM(r.authoritative_cogs) / NULLIF(SUM(r.quantity), 0), 2) ELSE NULL END AS avg_landed_cost,
    ROUND(SUM(r.sales) / NULLIF(SUM(r.quantity), 0), 2) AS avg_selling_price,
    0::numeric AS sales_expense_per_unit,
    ROUND(SUM(r.sales) / NULLIF(SUM(r.quantity), 0), 2) AS net_selling_price_per_unit,
    CASE WHEN COUNT(r.authoritative_cogs) = COUNT(*) THEN ROUND((SUM(r.sales) - SUM(r.authoritative_cogs)) / NULLIF(SUM(r.quantity), 0), 2) ELSE NULL END AS profit_per_unit,
    CASE WHEN COUNT(r.authoritative_cogs) = COUNT(*) AND SUM(r.sales) <> 0
      THEN ROUND((SUM(r.sales) - SUM(r.authoritative_cogs)) / SUM(r.sales) * 100, 2) ELSE NULL END AS profit_margin_pct,
    COUNT(r.authoritative_cogs) AS costed_lines,
    COUNT(*) AS total_lines,
    COUNT(r.authoritative_cogs) < COUNT(*) AS has_unreported_cost
  FROM resolved r
  GROUP BY r.product_id, r.product_name, r.product_code, r.product_unit
), invoice_scope AS (
  SELECT invoice_id, MAX(invoice_date) AS invoice_date, MAX(posted_invoice_cogs) AS posted_invoice_cogs,
    SUM(sales) AS invoice_sales, SUM(quantity) AS invoice_qty
  FROM resolved GROUP BY invoice_id
), company AS (
  SELECT
    COALESCE(SUM(invoice_sales), 0) AS gross_sales,
    COALESCE(SUM(posted_invoice_cogs), 0) AS product_cost,
    COALESCE(SUM(invoice_qty), 0) AS total_qty_sold,
    COUNT(*) AS order_count,
    (SELECT COUNT(DISTINCT product_id) FROM resolved) AS product_count
  FROM invoice_scope
), monthly AS (
  SELECT
    TO_CHAR(DATE_TRUNC('month', i.invoice_date), 'Mon YYYY') AS month_label,
    DATE_TRUNC('month', i.invoice_date)::date AS month_start,
    SUM(i.invoice_sales) AS gross_sales,
    COALESCE(SUM(i.posted_invoice_cogs), 0) AS product_cost,
    SUM(i.invoice_qty) AS total_qty_sold,
    COUNT(*) AS order_count
  FROM invoice_scope i
  GROUP BY 1, 2
)
SELECT jsonb_build_object(
  'company', jsonb_build_object(
    'gross_sales', c.gross_sales, 'product_cost', c.product_cost,
    'sales_expenses', 0, 'unallocated_sales_expenses', 0,
    'gross_profit', c.gross_sales - c.product_cost,
    'profit_after_sales_expenses', c.gross_sales - c.product_cost,
    'profit_margin_pct', CASE WHEN c.gross_sales = 0 THEN NULL ELSE ROUND((c.gross_sales-c.product_cost)/c.gross_sales*100,2) END,
    'total_qty_sold', c.total_qty_sold, 'order_count', c.order_count, 'product_count', c.product_count
  ),
  'products', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM (SELECT * FROM products_report ORDER BY product_name) p), '[]'::jsonb),
  'monthly', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'month_label', m.month_label, 'month_start', m.month_start,
    'gross_sales', m.gross_sales, 'product_cost', m.product_cost, 'sales_expenses', 0,
    'gross_profit', m.gross_sales-m.product_cost,
    'profit_after_sales_expenses', m.gross_sales-m.product_cost,
    'profit_margin_pct', CASE WHEN m.gross_sales=0 THEN NULL ELSE ROUND((m.gross_sales-m.product_cost)/m.gross_sales*100,2) END,
    'total_qty_sold', m.total_qty_sold, 'order_count', m.order_count
  )) FROM (SELECT * FROM monthly ORDER BY month_start) m), '[]'::jsonb)
)
FROM company c;
$$;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(p_product_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH x AS (
  SELECT
    ar.*,
    ROUND(sii.quantity * sii.unit_price, 2) AS sales,
    b.batch_number,
    b.current_stock,
    (b.import_container_id IS NOT NULL OR COALESCE(b.landed_cost_per_unit, 0) > 0) AS is_imported,
    b.import_price, b.import_price_usd, b.exchange_rate_usd_to_idr,
    b.duty_charges, b.freight_charges, b.other_charges,
    b.landed_cost_per_unit, b.cost_per_unit
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  LEFT JOIN public.batches b ON b.id = ar.batch_id
  WHERE ar.product_id = p_product_id
), s AS (
  SELECT
    batch_id,
    COALESCE(batch_number, 'Unassigned Batch') AS batch_number,
    COALESCE(current_stock, 0) AS current_stock,
    SUM(quantity) AS sold_qty,
    SUM(sales) AS gross_sales,
    SUM(authoritative_cogs) AS product_cost,
    0::numeric AS sales_expense,
    CASE WHEN COUNT(authoritative_cogs)=COUNT(*) THEN SUM(sales)-SUM(authoritative_cogs) ELSE NULL END AS gross_profit,
    CASE WHEN COUNT(authoritative_cogs)=COUNT(*) THEN SUM(sales)-SUM(authoritative_cogs) ELSE NULL END AS profit_after_sales_expense,
    CASE WHEN COUNT(authoritative_cogs)=COUNT(*) THEN ROUND(SUM(authoritative_cogs)/NULLIF(SUM(quantity),0),2) ELSE NULL END AS cost_per_unit,
    ROUND(SUM(sales)/NULLIF(SUM(quantity),0),2) AS avg_selling_price,
    0::numeric AS sales_expense_per_unit,
    ROUND(SUM(sales)/NULLIF(SUM(quantity),0),2) AS net_selling_price_per_unit,
    CASE WHEN COUNT(authoritative_cogs)=COUNT(*) THEN ROUND((SUM(sales)-SUM(authoritative_cogs))/NULLIF(SUM(quantity),0),2) ELSE NULL END AS profit_per_unit,
    CASE WHEN COUNT(authoritative_cogs)=COUNT(*) AND SUM(sales)<>0 THEN ROUND((SUM(sales)-SUM(authoritative_cogs))/SUM(sales)*100,2) ELSE NULL END AS profit_margin_pct,
    COUNT(authoritative_cogs) AS costed_lines,
    COUNT(*) AS total_lines,
    CASE WHEN COUNT(authoritative_cogs)=0 THEN 'unavailable' WHEN COUNT(authoritative_cogs)<COUNT(*) THEN 'partial' ELSE 'complete' END AS cost_coverage,
    BOOL_OR(is_imported) AS is_imported,
    jsonb_build_object(
      'is_imported', BOOL_OR(is_imported), 'import_price', MAX(import_price),
      'import_price_usd', MAX(import_price_usd), 'exchange_rate', MAX(exchange_rate_usd_to_idr),
      'duty_charges', MAX(duty_charges), 'freight_charges', MAX(freight_charges),
      'other_charges', MAX(other_charges), 'landed_cost_per_unit', MAX(landed_cost_per_unit),
      'local_cost_per_unit', MAX(cost_per_unit)
    ) AS cost_breakdown
  FROM x
  GROUP BY batch_id, batch_number, current_stock
), product_report AS (
  SELECT
    p.id AS product_id, p.product_name, COALESCE(p.product_code,'') AS product_code,
    COALESCE(p.unit,'kg') AS product_unit,
    COALESCE((SELECT SUM(b.current_stock) FROM public.batches b WHERE b.product_id=p.id AND b.is_active),0) AS current_stock,
    COALESCE(SUM(s.sold_qty),0) AS sold_qty, COALESCE(SUM(s.gross_sales),0) AS gross_sales,
    SUM(s.product_cost) AS product_cost, 0::numeric AS sales_expense,
    CASE WHEN COALESCE(SUM(s.costed_lines),0)=COALESCE(SUM(s.total_lines),0) THEN SUM(s.gross_profit) ELSE NULL END AS gross_profit,
    CASE WHEN COALESCE(SUM(s.costed_lines),0)=COALESCE(SUM(s.total_lines),0) THEN SUM(s.profit_after_sales_expense) ELSE NULL END AS profit_after_sales_expense,
    CASE WHEN COALESCE(SUM(s.costed_lines),0)=COALESCE(SUM(s.total_lines),0) THEN ROUND(SUM(s.product_cost)/NULLIF(SUM(s.sold_qty),0),2) ELSE NULL END AS avg_landed_cost,
    ROUND(SUM(s.gross_sales)/NULLIF(SUM(s.sold_qty),0),2) AS avg_selling_price,
    0::numeric AS sales_expense_per_unit,
    ROUND(SUM(s.gross_sales)/NULLIF(SUM(s.sold_qty),0),2) AS net_selling_price_per_unit,
    CASE WHEN COALESCE(SUM(s.costed_lines),0)=COALESCE(SUM(s.total_lines),0) THEN ROUND((SUM(s.gross_sales)-SUM(s.product_cost))/NULLIF(SUM(s.sold_qty),0),2) ELSE NULL END AS profit_per_unit,
    CASE WHEN COALESCE(SUM(s.costed_lines),0)=COALESCE(SUM(s.total_lines),0) AND SUM(s.gross_sales)<>0 THEN ROUND((SUM(s.gross_sales)-SUM(s.product_cost))/SUM(s.gross_sales)*100,2) ELSE NULL END AS profit_margin_pct,
    COALESCE(SUM(s.costed_lines),0) AS costed_lines, COALESCE(SUM(s.total_lines),0) AS total_lines
  FROM public.products p LEFT JOIN s ON true WHERE p.id=p_product_id
  GROUP BY p.id,p.product_name,p.product_code,p.unit
)
SELECT jsonb_build_object(
  'product', (SELECT to_jsonb(p) FROM product_report p),
  'batches', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.profit_after_sales_expense DESC NULLS LAST) FROM s), '[]'::jsonb)
);
$$;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_batch_orders(p_batch_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH x AS (
  SELECT
    ar.line_id, ar.invoice_id, si.invoice_number, si.invoice_date, si.customer_id,
    COALESCE(c.company_name,'Unknown Customer') AS customer_name,
    si.sales_order_id, so.so_number, dci.challan_id AS dc_id, dc.challan_number AS dc_number,
    ar.quantity, sii.unit_price AS selling_price,
    ROUND(ar.quantity*sii.unit_price,2) AS gross_sales,
    ar.authoritative_unit_cogs AS unit_cost, ar.authoritative_cogs AS line_cost,
    0::numeric AS line_sales_expense,
    ROUND(ar.quantity*sii.unit_price,2) AS net_selling_realization,
    CASE WHEN ar.authoritative_cogs IS NULL THEN NULL ELSE ROUND(ar.quantity*sii.unit_price,2)-ar.authoritative_cogs END AS gross_profit,
    CASE WHEN ar.authoritative_cogs IS NULL THEN NULL ELSE ROUND(ar.quantity*sii.unit_price,2)-ar.authoritative_cogs END AS profit,
    CASE WHEN ar.authoritative_cogs IS NULL OR ar.quantity*sii.unit_price=0 THEN NULL
      ELSE ROUND((ar.quantity*sii.unit_price-ar.authoritative_cogs)/(ar.quantity*sii.unit_price)*100,2) END AS profit_margin_pct,
    ar.resolution_tier AS cogs_resolution,
    '[]'::jsonb AS expenses
  FROM public.get_authoritative_sales_line_cogs(p_start_date,p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id=ar.line_id
  JOIN public.sales_invoices si ON si.id=ar.invoice_id
  LEFT JOIN public.customers c ON c.id=si.customer_id
  LEFT JOIN public.sales_orders so ON so.id=si.sales_order_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id=sii.delivery_challan_item_id
  LEFT JOIN public.delivery_challans dc ON dc.id=dci.challan_id
  WHERE ar.batch_id=p_batch_id
)
SELECT jsonb_build_object(
  'batch', (SELECT jsonb_build_object(
    'batch_id',b.id,'batch_number',b.batch_number,'product_name',p.product_name,
    'product_code',COALESCE(p.product_code,''),'product_unit',COALESCE(p.unit,'kg'),
    'current_stock',b.current_stock
  ) FROM public.batches b JOIN public.products p ON p.id=b.product_id WHERE b.id=p_batch_id),
  'orders', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.invoice_date DESC,x.invoice_number) FROM x),'[]'::jsonb)
);
$$;

GRANT EXECUTE ON FUNCTION public.get_authoritative_sales_line_cogs(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_product_batches(uuid,date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_batch_orders(uuid,date,date) TO authenticated;

COMMIT;
