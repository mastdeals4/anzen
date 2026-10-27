-- Operational / management reports: authoritative stored landed cost only.
--
-- Revenue is calculated from posted invoice lines (quantity * unit_price),
-- which avoids multiplying invoice headers by their line count. COGS is only
-- calculated when batches.landed_cost_per_unit > 0. No historical data is
-- updated and no inventory, finance, tax, or landed-cost writer is changed.

DROP FUNCTION IF EXISTS public.get_sales_profit_summary(date, date);
DROP FUNCTION IF EXISTS public.get_sales_profit_drilldown(uuid, date, date);
DROP FUNCTION IF EXISTS public.get_monthly_sales_report(date, date);
DROP FUNCTION IF EXISTS public.get_product_performance_report(date, date);
DROP FUNCTION IF EXISTS public.get_customer_sales_report(date, date);
DROP FUNCTION IF EXISTS public.get_expense_vs_profit_report(date, date);

CREATE FUNCTION public.get_sales_profit_summary(p_start_date date, p_end_date date)
RETURNS TABLE (
  product_id uuid, product_name text, product_code text, product_unit text,
  total_qty_sold numeric, total_revenue numeric, costed_revenue numeric,
  total_cogs numeric, total_profit numeric, profit_pct numeric,
  costed_lines bigint, total_lines bigint, no_cost boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lines AS (
    SELECT sii.product_id, p.product_name, COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, '') AS product_unit, sii.quantity, sii.unit_price,
      b.landed_cost_per_unit,
      (b.landed_cost_per_unit IS NOT NULL AND b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    JOIN public.products p ON p.id = sii.product_id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ), grouped AS (
    SELECT product_id, product_name, product_code, product_unit,
      SUM(quantity) AS total_qty_sold,
      SUM(quantity * unit_price) AS total_revenue,
      SUM(quantity * unit_price) FILTER (WHERE is_costed) AS costed_revenue,
      COALESCE(SUM(quantity * landed_cost_per_unit) FILTER (WHERE is_costed), 0) AS total_cogs,
      COUNT(*) FILTER (WHERE is_costed) AS costed_lines,
      COUNT(*) AS total_lines
    FROM lines GROUP BY product_id, product_name, product_code, product_unit
  )
  SELECT *,
    ROUND(COALESCE(costed_revenue, 0) - total_cogs, 2) AS total_profit,
    CASE WHEN COALESCE(costed_revenue, 0) = 0 THEN NULL
      ELSE ROUND((costed_revenue - total_cogs) / costed_revenue * 100, 2) END AS profit_pct,
    costed_lines = 0 AS no_cost
  FROM grouped ORDER BY total_profit DESC NULLS LAST;
$$;

CREATE FUNCTION public.get_sales_profit_drilldown(p_product_id uuid, p_start_date date, p_end_date date)
RETURNS TABLE (
  invoice_id uuid, invoice_number text, invoice_date date, customer_name text,
  batch_number text, qty numeric, product_unit text, selling_price numeric,
  landed_cost numeric, line_sales numeric, line_cost numeric, line_profit numeric,
  profit_pct numeric, no_cost boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT si.id, si.invoice_number, si.invoice_date, COALESCE(c.company_name, ''),
    COALESCE(b.batch_number, ''), sii.quantity, COALESCE(p.unit, ''), sii.unit_price,
    CASE WHEN b.landed_cost_per_unit > 0 THEN b.landed_cost_per_unit END,
    ROUND(sii.quantity * sii.unit_price, 2),
    CASE WHEN b.landed_cost_per_unit > 0 THEN ROUND(sii.quantity * b.landed_cost_per_unit, 2) END,
    CASE WHEN b.landed_cost_per_unit > 0
      THEN ROUND(sii.quantity * (sii.unit_price - b.landed_cost_per_unit), 2) END,
    CASE WHEN b.landed_cost_per_unit > 0 AND sii.unit_price <> 0
      THEN ROUND((sii.unit_price - b.landed_cost_per_unit) / sii.unit_price * 100, 2) END,
    NOT COALESCE(b.landed_cost_per_unit > 0, false)
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.customers c ON c.id = si.customer_id
  JOIN public.products p ON p.id = sii.product_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  WHERE sii.product_id = p_product_id AND si.invoice_date >= p_start_date
    AND si.invoice_date <= p_end_date AND COALESCE(si.is_draft, false) = false
  ORDER BY si.invoice_date DESC, si.invoice_number;
$$;

CREATE FUNCTION public.get_monthly_sales_report(p_start_date date, p_end_date date)
RETURNS TABLE (
  month_label text, month_start date, total_sales numeric, total_orders bigint,
  total_qty_sold numeric, avg_order_value numeric, total_cogs numeric,
  gross_profit numeric, profit_pct numeric, outbound_delivery numeric,
  operational_profit numeric, costed_lines bigint, total_lines bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lines AS (
    SELECT si.id, si.invoice_date, sii.quantity, sii.unit_price, b.landed_cost_per_unit,
      (b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoices si
    JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ), monthly AS (
    SELECT date_trunc('month', invoice_date)::date AS month_start,
      to_char(date_trunc('month', invoice_date), 'Mon YYYY') AS month_label,
      SUM(quantity * unit_price) AS total_sales, COUNT(DISTINCT id) AS total_orders,
      SUM(quantity) AS total_qty_sold,
      SUM(quantity * unit_price) FILTER (WHERE is_costed) AS costed_revenue,
      COALESCE(SUM(quantity * landed_cost_per_unit) FILTER (WHERE is_costed), 0) AS total_cogs,
      COUNT(*) FILTER (WHERE is_costed) AS costed_lines, COUNT(*) AS total_lines
    FROM lines GROUP BY 1, 2
  ), expenses AS (
    SELECT date_trunc('month', expense_date)::date AS month_start,
      COALESCE(SUM(amount) FILTER (WHERE expense_category IN ('delivery_sales', 'loading_sales')), 0) AS outbound_delivery
    FROM public.finance_expenses
    WHERE expense_date >= p_start_date AND expense_date <= p_end_date
    GROUP BY 1
  )
  SELECT m.month_label, m.month_start, ROUND(m.total_sales, 2), m.total_orders,
    m.total_qty_sold, ROUND(m.total_sales / NULLIF(m.total_orders, 0), 2),
    ROUND(m.total_cogs, 2), ROUND(COALESCE(m.costed_revenue, 0) - m.total_cogs, 2),
    CASE WHEN COALESCE(m.costed_revenue, 0) = 0 THEN NULL
      ELSE ROUND((m.costed_revenue - m.total_cogs) / m.costed_revenue * 100, 2) END,
    ROUND(COALESCE(e.outbound_delivery, 0), 2),
    ROUND(COALESCE(m.costed_revenue, 0) - m.total_cogs - COALESCE(e.outbound_delivery, 0), 2),
    m.costed_lines, m.total_lines
  FROM monthly m LEFT JOIN expenses e USING (month_start) ORDER BY m.month_start;
$$;

CREATE FUNCTION public.get_product_performance_report(p_start_date date, p_end_date date)
RETURNS TABLE (
  product_id uuid, product_name text, product_code text, qty_sold numeric,
  total_sales numeric, total_cost numeric, total_profit numeric, profit_pct numeric,
  costed_lines bigint, total_lines bigint, cost_coverage numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lines AS (
    SELECT sii.product_id, p.product_name, COALESCE(p.product_code, '') AS product_code,
      sii.quantity, sii.unit_price, b.landed_cost_per_unit,
      (b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    JOIN public.products p ON p.id = sii.product_id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ), grouped AS (
    SELECT product_id, product_name, product_code, SUM(quantity) AS qty_sold,
      SUM(quantity * unit_price) AS total_sales,
      COALESCE(SUM(quantity * landed_cost_per_unit) FILTER (WHERE is_costed), 0) AS total_cost,
      SUM(quantity * unit_price) FILTER (WHERE is_costed) AS costed_revenue,
      COUNT(*) FILTER (WHERE is_costed) AS costed_lines, COUNT(*) AS total_lines
    FROM lines GROUP BY product_id, product_name, product_code
  )
  SELECT product_id, product_name, product_code, qty_sold, ROUND(total_sales, 2), ROUND(total_cost, 2),
    ROUND(COALESCE(costed_revenue, 0) - total_cost, 2),
    CASE WHEN COALESCE(costed_revenue, 0) = 0 THEN NULL
      ELSE ROUND((costed_revenue - total_cost) / costed_revenue * 100, 2) END,
    costed_lines, total_lines, ROUND(costed_lines::numeric / NULLIF(total_lines, 0) * 100, 2)
  FROM grouped ORDER BY total_sales DESC;
$$;

CREATE FUNCTION public.get_customer_sales_report(p_start_date date, p_end_date date)
RETURNS TABLE (
  customer_id uuid, customer_name text, total_orders bigint, total_sales numeric,
  avg_order_value numeric, last_order_date date, total_qty numeric, total_cogs numeric,
  total_profit numeric, profit_pct numeric, costed_lines bigint, total_lines bigint,
  cost_coverage numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lines AS (
    SELECT si.id, si.customer_id, c.company_name, si.invoice_date, sii.quantity, sii.unit_price,
      b.landed_cost_per_unit, (b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoices si
    JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
    JOIN public.customers c ON c.id = si.customer_id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ), grouped AS (
    SELECT customer_id, company_name, COUNT(DISTINCT id) AS total_orders,
      SUM(quantity * unit_price) AS total_sales, SUM(quantity) AS total_qty,
      SUM(quantity * unit_price) FILTER (WHERE is_costed) AS costed_revenue,
      COALESCE(SUM(quantity * landed_cost_per_unit) FILTER (WHERE is_costed), 0) AS total_cogs,
      MAX(invoice_date) AS last_order_date, COUNT(*) FILTER (WHERE is_costed) AS costed_lines,
      COUNT(*) AS total_lines
    FROM lines GROUP BY customer_id, company_name
  )
  SELECT customer_id, company_name, total_orders, ROUND(total_sales, 2),
    ROUND(total_sales / NULLIF(total_orders, 0), 2), last_order_date, total_qty,
    ROUND(total_cogs, 2), ROUND(COALESCE(costed_revenue, 0) - total_cogs, 2),
    CASE WHEN COALESCE(costed_revenue, 0) = 0 THEN NULL
      ELSE ROUND((costed_revenue - total_cogs) / costed_revenue * 100, 2) END,
    costed_lines, total_lines, ROUND(costed_lines::numeric / NULLIF(total_lines, 0) * 100, 2)
  FROM grouped ORDER BY total_sales DESC;
$$;

CREATE FUNCTION public.get_expense_vs_profit_report(p_start_date date, p_end_date date)
RETURNS TABLE (
  total_sales numeric, total_cogs numeric, gross_profit numeric, outbound_delivery numeric,
  contribution_profit numeric, operating_expenses numeric, operational_profit numeric,
  profit_pct numeric, costed_lines bigint, total_lines bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lines AS (
    SELECT sii.quantity, sii.unit_price, b.landed_cost_per_unit,
      (b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoices si
    JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ), sales AS (
    SELECT COALESCE(SUM(quantity * unit_price), 0) AS total_sales,
      COALESCE(SUM(quantity * unit_price) FILTER (WHERE is_costed), 0) AS costed_revenue,
      COALESCE(SUM(quantity * landed_cost_per_unit) FILTER (WHERE is_costed), 0) AS total_cogs,
      COUNT(*) FILTER (WHERE is_costed) AS costed_lines, COUNT(*) AS total_lines FROM lines
  ), expenses AS (
    SELECT COALESCE(SUM(amount) FILTER (WHERE expense_category IN ('delivery_sales', 'loading_sales')), 0) AS outbound_delivery,
      COALESCE(SUM(amount) FILTER (WHERE expense_category NOT IN ('delivery_sales', 'loading_sales')), 0) AS operating_expenses
    FROM public.finance_expenses WHERE expense_date >= p_start_date AND expense_date <= p_end_date
  )
  SELECT ROUND(s.total_sales, 2), ROUND(s.total_cogs, 2), ROUND(s.costed_revenue - s.total_cogs, 2),
    ROUND(e.outbound_delivery, 2), ROUND(s.costed_revenue - s.total_cogs - e.outbound_delivery, 2),
    ROUND(e.operating_expenses, 2), ROUND(s.costed_revenue - s.total_cogs - e.outbound_delivery - e.operating_expenses, 2),
    CASE WHEN s.costed_revenue = 0 THEN NULL ELSE ROUND((s.costed_revenue - s.total_cogs - e.outbound_delivery - e.operating_expenses) / s.costed_revenue * 100, 2) END,
    s.costed_lines, s.total_lines
  FROM sales s CROSS JOIN expenses e;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profit_summary(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_profit_drilldown(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_monthly_sales_report(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_product_performance_report(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_sales_report(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_expense_vs_profit_report(date, date) TO authenticated;
