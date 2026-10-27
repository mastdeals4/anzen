-- Tier 3 product reporting: a multi-line invoice containing exactly one
-- product proves that product's total COGS from the posted GL 5100 amount even
-- when current batch fields cannot prove a finer line/batch allocation.
-- This replaces a read-only report function and writes no business data.
BEGIN;

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
), invoice_product_evidence AS (
  SELECT
    invoice_id,
    product_id,
    COUNT(*) AS line_count,
    COUNT(authoritative_cogs) AS resolved_line_count,
    MAX(invoice_product_count) AS invoice_product_count,
    MAX(posted_invoice_cogs) AS posted_invoice_cogs,
    CASE
      WHEN COUNT(authoritative_cogs) = COUNT(*) THEN SUM(authoritative_cogs)
      WHEN MAX(invoice_product_count) = 1 AND MAX(posted_invoice_cogs) IS NOT NULL
        THEN MAX(posted_invoice_cogs)
      ELSE NULL
    END AS authoritative_product_cogs
  FROM resolved
  GROUP BY invoice_id, product_id
), product_costs AS (
  SELECT
    product_id,
    SUM(authoritative_product_cogs) AS product_cost,
    SUM(line_count) FILTER (WHERE authoritative_product_cogs IS NOT NULL) AS costed_lines,
    SUM(line_count) AS total_lines
  FROM invoice_product_evidence
  GROUP BY product_id
), product_activity AS (
  SELECT
    product_id,
    MAX(product_name) AS product_name,
    MAX(product_code) AS product_code,
    MAX(product_unit) AS product_unit,
    SUM(quantity) AS sold_qty,
    SUM(sales) AS gross_sales
  FROM resolved
  GROUP BY product_id
), products_report AS (
  SELECT
    a.product_id,
    a.product_name,
    a.product_code,
    a.product_unit,
    COALESCE((SELECT SUM(b.current_stock) FROM public.batches b WHERE b.product_id=a.product_id AND b.is_active),0) AS current_stock,
    a.sold_qty,
    a.gross_sales,
    pc.product_cost,
    0::numeric AS sales_expense,
    CASE WHEN pc.costed_lines=pc.total_lines THEN a.gross_sales-pc.product_cost ELSE NULL END AS gross_profit,
    CASE WHEN pc.costed_lines=pc.total_lines THEN a.gross_sales-pc.product_cost ELSE NULL END AS profit_after_sales_expense,
    CASE WHEN pc.costed_lines=pc.total_lines THEN ROUND(pc.product_cost/NULLIF(a.sold_qty,0),2) ELSE NULL END AS avg_landed_cost,
    ROUND(a.gross_sales/NULLIF(a.sold_qty,0),2) AS avg_selling_price,
    0::numeric AS sales_expense_per_unit,
    ROUND(a.gross_sales/NULLIF(a.sold_qty,0),2) AS net_selling_price_per_unit,
    CASE WHEN pc.costed_lines=pc.total_lines THEN ROUND((a.gross_sales-pc.product_cost)/NULLIF(a.sold_qty,0),2) ELSE NULL END AS profit_per_unit,
    CASE WHEN pc.costed_lines=pc.total_lines AND a.gross_sales<>0 THEN ROUND((a.gross_sales-pc.product_cost)/a.gross_sales*100,2) ELSE NULL END AS profit_margin_pct,
    COALESCE(pc.costed_lines,0) AS costed_lines,
    pc.total_lines,
    COALESCE(pc.costed_lines,0)<pc.total_lines AS has_unreported_cost
  FROM product_activity a
  JOIN product_costs pc ON pc.product_id=a.product_id
), invoice_scope AS (
  SELECT invoice_id, MAX(invoice_date) AS invoice_date, MAX(posted_invoice_cogs) AS posted_invoice_cogs,
    SUM(sales) AS invoice_sales, SUM(quantity) AS invoice_qty
  FROM resolved GROUP BY invoice_id
), company AS (
  SELECT COALESCE(SUM(invoice_sales),0) AS gross_sales,
    COALESCE(SUM(posted_invoice_cogs),0) AS product_cost,
    COALESCE(SUM(invoice_qty),0) AS total_qty_sold,
    COUNT(*) AS order_count,
    (SELECT COUNT(DISTINCT product_id) FROM resolved) AS product_count
  FROM invoice_scope
), monthly AS (
  SELECT TO_CHAR(DATE_TRUNC('month',invoice_date),'Mon YYYY') AS month_label,
    DATE_TRUNC('month',invoice_date)::date AS month_start,
    SUM(invoice_sales) AS gross_sales,
    COALESCE(SUM(posted_invoice_cogs),0) AS product_cost,
    SUM(invoice_qty) AS total_qty_sold,
    COUNT(*) AS order_count
  FROM invoice_scope GROUP BY 1,2
)
SELECT jsonb_build_object(
  'company',jsonb_build_object(
    'gross_sales',c.gross_sales,'product_cost',c.product_cost,
    'sales_expenses',0,'unallocated_sales_expenses',0,
    'gross_profit',c.gross_sales-c.product_cost,
    'profit_after_sales_expenses',c.gross_sales-c.product_cost,
    'profit_margin_pct',CASE WHEN c.gross_sales=0 THEN NULL ELSE ROUND((c.gross_sales-c.product_cost)/c.gross_sales*100,2) END,
    'total_qty_sold',c.total_qty_sold,'order_count',c.order_count,'product_count',c.product_count
  ),
  'products',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM (SELECT * FROM products_report ORDER BY product_name) p),'[]'::jsonb),
  'monthly',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'month_label',m.month_label,'month_start',m.month_start,
    'gross_sales',m.gross_sales,'product_cost',m.product_cost,'sales_expenses',0,
    'gross_profit',m.gross_sales-m.product_cost,
    'profit_after_sales_expenses',m.gross_sales-m.product_cost,
    'profit_margin_pct',CASE WHEN m.gross_sales=0 THEN NULL ELSE ROUND((m.gross_sales-m.product_cost)/m.gross_sales*100,2) END,
    'total_qty_sold',m.total_qty_sold,'order_count',m.order_count
  )) FROM (SELECT * FROM monthly ORDER BY month_start) m),'[]'::jsonb)
)
FROM company c;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date,date) TO authenticated;

COMMIT;
