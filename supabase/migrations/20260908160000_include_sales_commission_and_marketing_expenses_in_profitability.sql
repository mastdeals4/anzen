-- Migration: 20260908160000_include_sales_commission_and_marketing_expenses_in_profitability.sql
-- Description: Expand Sales Profitability expense filters to include all approved sales-category expenses
--              (including marketing/sales commissions and other sales expenses) linked to Delivery Challans,
--              while preventing unrelated administrative, staff, tax, and operating expenses from being included.
-- Zero GL change, zero transaction changes, report-only logic fix.

BEGIN;

-- 1. Line Expenses Resolver: allocate all approved sales-type expenses linked to Delivery Challans
CREATE OR REPLACE FUNCTION public.get_sales_profitability_line_expenses(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(line_id uuid, sales_expense numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH scoped AS (
  SELECT sii.id AS line_id, dci.challan_id AS dc_id,
         ROUND(sii.quantity * sii.unit_price, 2) AS line_sales,
         sii.quantity
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
), dc_totals AS (
  SELECT dci.challan_id AS dc_id,
         SUM(ROUND(sii.quantity * sii.unit_price, 2)) AS total_sales,
         SUM(sii.quantity) AS total_qty
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  WHERE NOT COALESCE(si.is_draft, false)
    AND dci.challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
  GROUP BY dci.challan_id
), dc_expenses AS (
  SELECT fe.delivery_challan_id AS dc_id, SUM(fe.amount) AS total_expense
  FROM public.finance_expenses fe
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
    AND fe.approval_status = 'approved'
    AND fe.delivery_challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
  GROUP BY fe.delivery_challan_id
)
SELECT s.line_id,
       COALESCE(CASE
         WHEN d.total_sales > 0 THEN ROUND(e.total_expense * s.line_sales / d.total_sales, 2)
         WHEN d.total_qty > 0 THEN ROUND(e.total_expense * s.quantity / d.total_qty, 2)
         ELSE 0
       END, 0)::numeric AS sales_expense
FROM scoped s
LEFT JOIN dc_totals d ON d.dc_id = s.dc_id
LEFT JOIN dc_expenses e ON e.dc_id = s.dc_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_line_expenses(date, date) TO authenticated;

-- 2. Summary Function: include all sales-type expenses in unallocated company calculations
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
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
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
    COALESCE(
      ROUND(SUM(authoritative_cogs) / NULLIF(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN quantity ELSE 0 END), 0), 2),
      ROUND(SUM(quantity * batch_unit_cost) / NULLIF(SUM(quantity), 0), 2)
    ) AS avg_landed_cost,
    ROUND(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs ELSE 0 END), 2) AS gross_profit,
    ROUND(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs - line_sales_expense ELSE 0 END), 2) AS profit_after_sales_expense,
    ROUND(
      SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN line_gross_sales - authoritative_cogs - line_sales_expense ELSE 0 END)
      / NULLIF(SUM(CASE WHEN authoritative_cogs IS NOT NULL THEN quantity ELSE 0 END), 0),
      2
    ) AS profit_per_unit,
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

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date, date) TO authenticated;

-- 3. Batch Orders Drilldown: include all sales-type expenses in DC expenses JSON
CREATE OR REPLACE FUNCTION public.get_sales_profitability_batch_orders(p_batch_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH x AS (
  SELECT
    ar.line_id, ar.invoice_id, si.invoice_number, si.invoice_date, si.customer_id,
    COALESCE(c.company_name, 'Unknown Customer') AS customer_name,
    si.sales_order_id, so.so_number, dci.challan_id AS dc_id, dc.challan_number AS dc_number,
    ar.quantity, sii.unit_price AS selling_price,
    ROUND(ar.quantity * sii.unit_price, 2) AS gross_sales,
    ar.authoritative_unit_cogs AS unit_cost,
    ar.authoritative_cogs AS line_cost,
    COALESCE(le.sales_expense, 0) AS line_sales_expense,
    ar.resolution_tier AS cogs_resolution
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  JOIN public.sales_invoices si ON si.id = ar.invoice_id
  LEFT JOIN public.customers c ON c.id = si.customer_id
  LEFT JOIN public.sales_orders so ON so.id = si.sales_order_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
  WHERE ar.batch_id = p_batch_id
),
ex AS (
  SELECT
    fe.delivery_challan_id AS dc_id,
    jsonb_agg(jsonb_build_object(
      'id', fe.id,
      'voucher_number', fe.voucher_number,
      'category', fe.expense_category,
      'total_amount', fe.amount,
      'description', fe.description,
      'expense_date', fe.expense_date
    )) AS expenses
  FROM public.finance_expenses fe
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
    AND fe.approval_status = 'approved'
    AND fe.delivery_challan_id IN (SELECT DISTINCT dc_id FROM x WHERE dc_id IS NOT NULL)
  GROUP BY fe.delivery_challan_id
)
SELECT jsonb_build_object(
  'batch', (
    SELECT jsonb_build_object(
      'batch_id', b.id,
      'batch_number', b.batch_number,
      'product_name', p.product_name,
      'product_code', COALESCE(p.product_code, ''),
      'product_unit', COALESCE(p.unit, 'kg'),
      'current_stock', b.current_stock
    )
    FROM public.batches b
    JOIN public.products p ON p.id = b.product_id
    WHERE b.id = p_batch_id
  ),
  'orders', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'line_id', x.line_id,
        'invoice_id', x.invoice_id,
        'invoice_number', x.invoice_number,
        'invoice_date', x.invoice_date,
        'customer_id', x.customer_id,
        'customer_name', x.customer_name,
        'sales_order_id', x.sales_order_id,
        'so_number', x.so_number,
        'dc_id', x.dc_id,
        'dc_number', x.dc_number,
        'quantity', x.quantity,
        'selling_price', x.selling_price,
        'unit_price', x.selling_price,
        'gross_sales', x.gross_sales,
        'unit_cost', x.unit_cost,
        'line_cost', x.line_cost,
        'line_sales_expense', x.line_sales_expense,
        'net_selling_realization', x.gross_sales - x.line_sales_expense,
        'gross_profit', CASE WHEN x.line_cost IS NULL THEN NULL ELSE x.gross_sales - x.line_cost END,
        'profit', CASE WHEN x.line_cost IS NULL THEN NULL ELSE x.gross_sales - x.line_cost - x.line_sales_expense END,
        'profit_margin_pct', CASE WHEN x.line_cost IS NULL OR x.gross_sales = 0 THEN NULL ELSE ROUND((x.gross_sales - x.line_cost - x.line_sales_expense) / x.gross_sales * 100, 2) END,
        'cogs_resolution', x.cogs_resolution,
        'expenses', COALESCE(ex.expenses, '[]'::jsonb)
      ) ORDER BY x.invoice_date DESC, x.invoice_number
    )
    FROM x
    LEFT JOIN ex USING (dc_id)
  ), '[]'::jsonb)
);
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_batch_orders(uuid, date, date) TO authenticated;

COMMIT;
