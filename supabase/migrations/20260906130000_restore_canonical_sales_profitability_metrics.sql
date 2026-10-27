-- Restore canonical profitability calculations, metrics, and reconciliation
-- while preserving authoritative accounting COGS and sales expense resolvers.
BEGIN;

-- 1. Summary function: preserve authoritative COGS and sales expenses,
--    compute canonical metrics for all products, and clearly report partial coverage.
CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(p_start_date date, p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH lines AS (
  SELECT
    ar.*,
    si.invoice_date,
    si.invoice_number,
    si.customer_id,
    COALESCE(c.company_name, 'Unknown Customer') AS customer_name,
    si.sales_order_id,
    so.so_number,
    sii.unit_price,
    ROUND(sii.quantity * sii.unit_price, 2) AS line_gross_sales,
    p.product_name,
    COALESCE(p.product_code, '') AS product_code,
    COALESCE(p.unit, 'kg') AS product_unit,
    b.batch_number,
    COALESCE(b.landed_cost_per_unit, b.cost_per_unit) AS batch_unit_cost,
    COALESCE(le.sales_expense, 0) AS line_sales_expense,
    dci.challan_id AS dc_id,
    dc.challan_number AS dc_number
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  JOIN public.sales_invoices si ON si.id = ar.invoice_id
  JOIN public.products p ON p.id = ar.product_id
  LEFT JOIN public.customers c ON c.id = si.customer_id
  LEFT JOIN public.sales_orders so ON so.id = si.sales_order_id
  LEFT JOIN public.batches b ON b.id = ar.batch_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
),
unallocated AS (
  SELECT COALESCE(SUM(fe.amount), 0) AS amount
  FROM public.finance_expenses fe
  WHERE fe.expense_category IN ('delivery_sales', 'loading_sales')
    AND fe.approval_status = 'approved'
    AND fe.expense_date BETWEEN p_start_date AND p_end_date
    AND (fe.delivery_challan_id IS NULL OR NOT EXISTS (SELECT 1 FROM lines l WHERE l.dc_id = fe.delivery_challan_id))
),
prod AS (
  SELECT
    product_id,
    MAX(product_name) AS product_name,
    MAX(product_code) AS product_code,
    MAX(product_unit) AS product_unit,
    COALESCE((SELECT SUM(b.current_stock) FROM public.batches b WHERE b.product_id = l.product_id AND b.is_active), 0) AS current_stock,
    SUM(quantity) AS sold_qty,
    SUM(line_gross_sales) AS gross_sales,
    SUM(authoritative_cogs) AS product_cost,
    SUM(line_sales_expense) AS sales_expense,
    ROUND(SUM(line_gross_sales) / NULLIF(SUM(quantity), 0), 2) AS avg_selling_price,
    ROUND(SUM(line_sales_expense) / NULLIF(SUM(quantity), 0), 2) AS sales_expense_per_unit,
    ROUND((SUM(line_gross_sales) - SUM(line_sales_expense)) / NULLIF(SUM(quantity), 0), 2) AS net_selling_price_per_unit,
    -- Landed cost: weighted average of known authoritative COGS per unit, fallback to weighted average of batch unit cost if costed lines exist
    COALESCE(
      ROUND(SUM(authoritative_cogs) / NULLIF(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN quantity ELSE 0 END), 0), 2),
      ROUND(SUM(quantity * batch_unit_cost) / NULLIF(SUM(quantity), 0), 2)
    ) AS avg_landed_cost,
    -- Gross profit: realized gross profit on known COGS lines
    ROUND(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs ELSE 0 END), 2) AS gross_profit,
    -- Profit after sales expense: gross profit on costed lines minus sales expense on costed lines
    ROUND(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs - line_sales_expense ELSE 0 END), 2) AS profit_after_sales_expense,
    -- Profit per unit: on costed volume
    ROUND(
      SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs - line_sales_expense ELSE 0 END)
      / NULLIF(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN quantity ELSE 0 END), 0),
      2
    ) AS profit_per_unit,
    -- Profit margin %: on costed sales volume
    CASE
      WHEN SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales ELSE 0 END) = 0 THEN NULL
      ELSE ROUND(
        SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs - line_sales_expense ELSE 0 END)
        / SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales ELSE 0 END) * 100,
        2
      )
    END AS profit_margin_pct,
    COUNT(authoritative_cogs) AS costed_lines,
    COUNT(*) AS total_lines,
    COUNT(authoritative_cogs) < COUNT(*) AS has_unreported_cost
  FROM lines l
  GROUP BY product_id
),
inv AS (
  SELECT
    invoice_id,
    MAX(invoice_date) AS invoice_date,
    MAX(posted_invoice_cogs) AS product_cost,
    SUM(line_gross_sales) AS gross_sales,
    SUM(quantity) AS total_qty_sold,
    SUM(line_sales_expense) AS sales_expenses
  FROM lines
  GROUP BY invoice_id
),
months AS (
  SELECT
    DATE_TRUNC('month', invoice_date)::date AS month_start,
    TO_CHAR(DATE_TRUNC('month', invoice_date), 'Mon YYYY') AS month_label,
    SUM(gross_sales) AS gross_sales,
    SUM(product_cost) AS product_cost,
    SUM(sales_expenses) AS sales_expenses,
    SUM(total_qty_sold) AS total_qty_sold,
    COUNT(*) AS order_count
  FROM inv
  GROUP BY 1, 2
),
company AS (
  SELECT
    COALESCE(SUM(gross_sales), 0) AS gross_sales,
    COALESCE(SUM(product_cost), 0) AS product_cost,
    COALESCE(SUM(sales_expenses), 0) + (SELECT amount FROM unallocated) AS sales_expenses,
    (SELECT amount FROM unallocated) AS unallocated_sales_expenses,
    COALESCE(SUM(total_qty_sold), 0) AS total_qty_sold,
    COUNT(*) AS order_count,
    (SELECT COUNT(DISTINCT product_id) FROM lines) AS product_count
  FROM inv
)
SELECT jsonb_build_object(
  'company', jsonb_build_object(
    'gross_sales', c.gross_sales,
    'product_cost', c.product_cost,
    'sales_expenses', c.sales_expenses,
    'unallocated_sales_expenses', c.unallocated_sales_expenses,
    'gross_profit', c.gross_sales - c.product_cost,
    'profit_after_sales_expenses', c.gross_sales - c.product_cost - c.sales_expenses,
    'profit_margin_pct', CASE WHEN c.gross_sales = 0 THEN NULL ELSE ROUND((c.gross_sales - c.product_cost - c.sales_expenses) / c.gross_sales * 100, 2) END,
    'total_qty_sold', c.total_qty_sold,
    'order_count', c.order_count,
    'product_count', c.product_count
  ),
  'products', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.product_name) FROM prod p), '[]'::jsonb),
  'monthly', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'month_label', m.month_label,
        'month_start', m.month_start,
        'gross_sales', m.gross_sales,
        'product_cost', m.product_cost,
        'sales_expenses', m.sales_expenses,
        'gross_profit', m.gross_sales - m.product_cost,
        'profit_after_sales_expenses', m.gross_sales - m.product_cost - m.sales_expenses,
        'profit_margin_pct', CASE WHEN m.gross_sales = 0 THEN NULL ELSE ROUND((m.gross_sales - m.product_cost - m.sales_expenses) / m.gross_sales * 100, 2) END,
        'total_qty_sold', m.total_qty_sold,
        'order_count', m.order_count
      ) ORDER BY m.month_start
    ) FROM months m
  ), '[]'::jsonb)
)
FROM company c;
$$;

-- 2. Product batches drilldown: return complete canonical product summary and batch rows
CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(p_product_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH l AS (
  SELECT
    ar.*,
    sii.unit_price,
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
    b.cost_per_unit
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  LEFT JOIN public.batches b ON b.id = ar.batch_id
  LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
  WHERE ar.product_id = p_product_id
),
b AS (
  SELECT
    batch_id,
    COALESCE(batch_number, 'Unassigned Batch') AS batch_number,
    COALESCE(current_stock, 0) AS current_stock,
    SUM(quantity) AS sold_qty,
    SUM(gross_sales) AS gross_sales,
    SUM(authoritative_cogs) AS product_cost,
    SUM(sales_expense) AS sales_expense,
    ROUND(SUM(gross_sales) / NULLIF(SUM(quantity), 0), 2) AS avg_selling_price,
    ROUND(SUM(sales_expense) / NULLIF(SUM(quantity), 0), 2) AS sales_expense_per_unit,
    ROUND((SUM(gross_sales) - SUM(sales_expense)) / NULLIF(SUM(quantity), 0), 2) AS net_selling_price_per_unit,
    -- Cost per unit: authoritative cost per unit if costed, otherwise batch landed/local cost
    COALESCE(
      ROUND(SUM(authoritative_cogs) / NULLIF(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN quantity ELSE 0 END), 0), 2),
      MAX(COALESCE(landed_cost_per_unit, cost_per_unit))
    ) AS cost_per_unit,
    -- Gross profit & Profit after sales expense on costed lines
    ROUND(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN gross_sales - authoritative_cogs ELSE 0 END), 2) AS gross_profit,
    ROUND(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN gross_sales - authoritative_cogs - sales_expense ELSE 0 END), 2) AS profit_after_sales_expense,
    ROUND(
      SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN gross_sales - authoritative_cogs - sales_expense ELSE 0 END)
      / NULLIF(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN quantity ELSE 0 END), 0),
      2
    ) AS profit_per_unit,
    CASE
      WHEN SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN gross_sales ELSE 0 END) = 0 THEN NULL
      ELSE ROUND(
        SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN gross_sales - authoritative_cogs - sales_expense ELSE 0 END)
        / SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN gross_sales ELSE 0 END) * 100,
        2
      )
    END AS profit_margin_pct,
    COUNT(authoritative_cogs) AS costed_lines,
    COUNT(*) AS total_lines,
    CASE
      WHEN COUNT(authoritative_cogs) = 0 THEN 'unavailable'
      WHEN COUNT(authoritative_cogs) < COUNT(*) THEN 'partial'
      ELSE 'complete'
    END AS cost_coverage,
    BOOL_OR(import_price IS NOT NULL OR landed_cost_per_unit IS NOT NULL) AS is_imported,
    jsonb_build_object(
      'import_price', MAX(import_price),
      'import_price_usd', MAX(import_price_usd),
      'exchange_rate', MAX(exchange_rate_usd_to_idr),
      'duty_charges', MAX(duty_charges),
      'freight_charges', MAX(freight_charges),
      'other_charges', MAX(other_charges),
      'landed_cost_per_unit', MAX(landed_cost_per_unit),
      'local_cost_per_unit', MAX(cost_per_unit)
    ) AS cost_breakdown
  FROM l
  GROUP BY batch_id, batch_number, current_stock
),
p AS (
  SELECT
    pr.id AS product_id,
    pr.product_name,
    COALESCE(pr.product_code, '') AS product_code,
    COALESCE(pr.unit, 'kg') AS product_unit,
    COALESCE((SELECT SUM(cur_b.current_stock) FROM public.batches cur_b WHERE cur_b.product_id = pr.id AND cur_b.is_active), 0) AS current_stock,
    COALESCE(SUM(b.sold_qty), 0) AS sold_qty,
    COALESCE(SUM(b.gross_sales), 0) AS gross_sales,
    COALESCE(SUM(b.product_cost), 0) AS product_cost,
    COALESCE(SUM(b.sales_expense), 0) AS sales_expense,
    COALESCE(SUM(b.costed_lines), 0) AS costed_lines,
    COALESCE(SUM(b.total_lines), 0) AS total_lines,
    ROUND(COALESCE(SUM(b.gross_sales), 0) / NULLIF(SUM(b.sold_qty), 0), 2) AS avg_selling_price,
    ROUND(COALESCE(SUM(b.sales_expense), 0) / NULLIF(SUM(b.sold_qty), 0), 2) AS sales_expense_per_unit,
    ROUND((COALESCE(SUM(b.gross_sales), 0) - COALESCE(SUM(b.sales_expense), 0)) / NULLIF(SUM(b.sold_qty), 0), 2) AS net_selling_price_per_unit,
    ROUND(COALESCE(SUM(b.product_cost), 0) / NULLIF(SUM(CASE WHEN b.costed_lines > 0 THEN b.sold_qty ELSE 0 END), 0), 2) AS avg_landed_cost,
    ROUND(SUM(b.gross_profit), 2) AS gross_profit,
    ROUND(SUM(b.profit_after_sales_expense), 2) AS profit_after_sales_expense,
    ROUND(SUM(b.profit_after_sales_expense) / NULLIF(SUM(CASE WHEN b.costed_lines > 0 THEN b.sold_qty ELSE 0 END), 0), 2) AS profit_per_unit,
    CASE
      WHEN SUM(CASE WHEN b.costed_lines > 0 THEN b.gross_sales ELSE 0 END) = 0 THEN NULL
      ELSE ROUND(SUM(b.profit_after_sales_expense) / SUM(CASE WHEN b.costed_lines > 0 THEN b.gross_sales ELSE 0 END) * 100, 2)
    END AS profit_margin_pct
  FROM public.products pr
  LEFT JOIN b ON true
  WHERE pr.id = p_product_id
  GROUP BY pr.id, pr.product_name, pr.product_code, pr.unit
)
SELECT jsonb_build_object(
  'product', (SELECT to_jsonb(p) FROM p),
  'batches', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.profit_after_sales_expense DESC NULLS LAST) FROM b), '[]'::jsonb)
);
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_product_batches(uuid, date, date) TO authenticated;

COMMIT;
