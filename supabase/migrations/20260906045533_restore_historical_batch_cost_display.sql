BEGIN;

-- Reporting-only: preserve the existing authoritative COGS values, but allow
-- historical batch drilldowns to display a valid batch landed/purchase cost
-- when the batch is explicitly known and line-level accounting attribution is
-- unavailable. Final profit/margin remains NULL for partial historical batches.
CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(
  p_product_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
WITH l AS (
  SELECT ar.*, sii.unit_price,
    ROUND(ar.quantity * sii.unit_price, 2) AS gross_sales,
    b.batch_number,
    b.current_stock,
    COALESCE(le.sales_expense, 0) AS sales_expense,
    b.import_price,
    b.import_price_usd,
    b.exchange_rate_usd_to_idr,
    b.duty_charges,
    b.freight_charges,
    b.other_charges,
    b.landed_cost_per_unit,
    b.cost_per_unit AS batch_cost_per_unit
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  LEFT JOIN public.batches b ON b.id = ar.batch_id
  LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
  WHERE ar.product_id = p_product_id
), b AS (
  SELECT
    batch_id,
    COALESCE(batch_number, 'Unassigned Batch') AS batch_number,
    COALESCE(current_stock, 0) AS current_stock,
    SUM(quantity) AS sold_qty,
    SUM(gross_sales) AS gross_sales,
    SUM(authoritative_cogs) AS product_cost,
    SUM(sales_expense) AS sales_expense,
    CASE WHEN COUNT(authoritative_cogs) = COUNT(*) THEN SUM(gross_sales) - SUM(authoritative_cogs) END AS gross_profit,
    CASE WHEN COUNT(authoritative_cogs) = COUNT(*) THEN SUM(gross_sales) - SUM(authoritative_cogs) - SUM(sales_expense) END AS profit_after_sales_expense,
    CASE
      WHEN COUNT(authoritative_cogs) = COUNT(*) THEN ROUND(SUM(authoritative_cogs) / NULLIF(SUM(quantity), 0), 2)
      WHEN MAX(COALESCE(NULLIF(landed_cost_per_unit, 0), NULLIF(batch_cost_per_unit, 0), NULLIF(import_price, 0))) IS NOT NULL
        THEN MAX(COALESCE(NULLIF(landed_cost_per_unit, 0), NULLIF(batch_cost_per_unit, 0), NULLIF(import_price, 0)))
      ELSE NULL
    END AS cost_per_unit,
    ROUND(SUM(gross_sales) / NULLIF(SUM(quantity), 0), 2) AS avg_selling_price,
    ROUND(SUM(sales_expense) / NULLIF(SUM(quantity), 0), 2) AS sales_expense_per_unit,
    ROUND((SUM(gross_sales) - SUM(sales_expense)) / NULLIF(SUM(quantity), 0), 2) AS net_selling_price_per_unit,
    CASE WHEN COUNT(authoritative_cogs) = COUNT(*) THEN ROUND((SUM(gross_sales) - SUM(authoritative_cogs) - SUM(sales_expense)) / NULLIF(SUM(quantity), 0), 2) END AS profit_per_unit,
    CASE WHEN COUNT(authoritative_cogs) = COUNT(*) AND SUM(gross_sales) <> 0 THEN ROUND((SUM(gross_sales) - SUM(authoritative_cogs) - SUM(sales_expense)) / SUM(gross_sales) * 100, 2) END AS profit_margin_pct,
    COUNT(authoritative_cogs) AS costed_lines,
    COUNT(*) AS total_lines,
    CASE WHEN COUNT(authoritative_cogs) = 0 THEN 'unavailable' WHEN COUNT(authoritative_cogs) < COUNT(*) THEN 'partial' ELSE 'complete' END AS cost_coverage,
    BOOL_OR(import_price IS NOT NULL OR landed_cost_per_unit IS NOT NULL) AS is_imported,
    jsonb_build_object(
      'import_price', MAX(import_price),
      'import_price_usd', MAX(import_price_usd),
      'exchange_rate', MAX(exchange_rate_usd_to_idr),
      'duty_charges', MAX(duty_charges),
      'freight_charges', MAX(freight_charges),
      'other_charges', MAX(other_charges),
      'landed_cost_per_unit', MAX(landed_cost_per_unit),
      'local_cost_per_unit', MAX(batch_cost_per_unit)
    ) AS cost_breakdown
  FROM l
  GROUP BY batch_id, batch_number, current_stock
), p AS (
  SELECT
    pr.id AS product_id,
    pr.product_name,
    COALESCE(pr.product_code, '') AS product_code,
    COALESCE(pr.unit, 'kg') AS product_unit,
    COALESCE(SUM(b.sold_qty), 0) AS sold_qty,
    COALESCE(SUM(b.gross_sales), 0) AS gross_sales,
    COALESCE(SUM(b.product_cost), 0) AS product_cost,
    COALESCE(SUM(b.sales_expense), 0) AS sales_expense,
    COALESCE(SUM(b.costed_lines), 0) AS costed_lines,
    COALESCE(SUM(b.total_lines), 0) AS total_lines,
    CASE WHEN SUM(b.costed_lines) = SUM(b.total_lines) THEN SUM(b.gross_profit) END AS gross_profit,
    CASE WHEN SUM(b.costed_lines) = SUM(b.total_lines) THEN SUM(b.profit_after_sales_expense) END AS profit_after_sales_expense
  FROM public.products pr
  LEFT JOIN b ON true
  WHERE pr.id = p_product_id
  GROUP BY pr.id, pr.product_name, pr.product_code, pr.unit
)
SELECT jsonb_build_object(
  'product', (SELECT to_jsonb(p) FROM p),
  'batches', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.profit_after_sales_expense DESC NULLS LAST, b.batch_number) FROM b), '[]'::jsonb)
);
$function$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_product_batches(uuid,date,date) TO authenticated;
COMMIT;
