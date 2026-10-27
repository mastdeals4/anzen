/*
  # Reports Module RPC Functions

  ## Summary
  Four new RPC functions to power the Reports module:

  1. get_monthly_sales_report(start_date, end_date)
     - Groups sales invoices by month
     - Returns: month, total_sales, total_orders, total_qty_sold, avg_order_value

  2. get_product_performance_report(start_date, end_date)
     - Aggregates by product, sorted by total sales descending
     - Returns: product_id, product_name, product_code, qty_sold, total_sales, total_cost, total_profit, profit_pct

  3. get_customer_sales_report(start_date, end_date)
     - Aggregates by customer
     - Returns: customer_id, customer_name, total_orders, total_sales, avg_order_value, last_order_date

  4. get_expense_vs_profit_report(start_date, end_date)
     - Summarises total sales, total expenses (finance_expenses), net profit
     - Returns: total_sales, total_cogs, gross_profit, total_expenses, net_profit, profit_pct

  ## Notes
  - All functions exclude is_draft = true invoices
  - SECURITY DEFINER with explicit search_path for safety
*/

-- ─── 1. Monthly Sales Report ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_monthly_sales_report(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  month_label     text,
  month_start     date,
  total_sales     numeric,
  total_orders    bigint,
  total_qty_sold  numeric,
  avg_order_value numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    TO_CHAR(DATE_TRUNC('month', si.invoice_date), 'Mon YYYY')  AS month_label,
    DATE_TRUNC('month', si.invoice_date)::date                 AS month_start,
    ROUND(SUM(si.total_amount), 2)                             AS total_sales,
    COUNT(DISTINCT si.id)                                      AS total_orders,
    COALESCE(SUM(sii.quantity), 0)                             AS total_qty_sold,
    CASE WHEN COUNT(DISTINCT si.id) = 0 THEN 0
         ELSE ROUND(SUM(si.total_amount) / COUNT(DISTINCT si.id), 2)
    END                                                        AS avg_order_value
  FROM sales_invoices si
  LEFT JOIN sales_invoice_items sii ON sii.invoice_id = si.id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  GROUP BY DATE_TRUNC('month', si.invoice_date)
  ORDER BY DATE_TRUNC('month', si.invoice_date);
$$;

GRANT EXECUTE ON FUNCTION get_monthly_sales_report(date, date) TO authenticated;

-- ─── 2. Product Performance Report ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_product_performance_report(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  product_id   uuid,
  product_name text,
  product_code text,
  qty_sold     numeric,
  total_sales  numeric,
  total_cost   numeric,
  total_profit numeric,
  profit_pct   numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id                                                       AS product_id,
    p.product_name,
    COALESCE(p.product_code, '')                               AS product_code,
    SUM(sii.quantity)                                          AS qty_sold,
    ROUND(SUM(sii.quantity * sii.unit_price), 2)               AS total_sales,
    ROUND(SUM(sii.quantity * COALESCE(b.cost_per_unit, 0)), 2) AS total_cost,
    ROUND(
      SUM(sii.quantity * sii.unit_price)
      - SUM(sii.quantity * COALESCE(b.cost_per_unit, 0)),
      2
    )                                                          AS total_profit,
    CASE
      WHEN SUM(sii.quantity * sii.unit_price) = 0 THEN 0
      ELSE ROUND(
        (SUM(sii.quantity * sii.unit_price)
          - SUM(sii.quantity * COALESCE(b.cost_per_unit, 0)))
        / SUM(sii.quantity * sii.unit_price) * 100,
        2
      )
    END                                                        AS profit_pct
  FROM sales_invoice_items sii
  JOIN sales_invoices si ON si.id = sii.invoice_id
  JOIN products       p  ON p.id = sii.product_id
  LEFT JOIN batches   b  ON b.id = sii.batch_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  GROUP BY p.id, p.product_name, p.product_code
  ORDER BY total_sales DESC;
$$;

GRANT EXECUTE ON FUNCTION get_product_performance_report(date, date) TO authenticated;

-- ─── 3. Customer Sales Report ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_customer_sales_report(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  customer_id      uuid,
  customer_name    text,
  total_orders     bigint,
  total_sales      numeric,
  avg_order_value  numeric,
  last_order_date  date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id                                                  AS customer_id,
    c.company_name                                        AS customer_name,
    COUNT(DISTINCT si.id)                                 AS total_orders,
    ROUND(SUM(si.total_amount), 2)                        AS total_sales,
    CASE WHEN COUNT(DISTINCT si.id) = 0 THEN 0
         ELSE ROUND(SUM(si.total_amount) / COUNT(DISTINCT si.id), 2)
    END                                                   AS avg_order_value,
    MAX(si.invoice_date)                                  AS last_order_date
  FROM sales_invoices si
  JOIN customers c ON c.id = si.customer_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  GROUP BY c.id, c.company_name
  ORDER BY total_sales DESC;
$$;

GRANT EXECUTE ON FUNCTION get_customer_sales_report(date, date) TO authenticated;

-- ─── 4. Expense vs Profit Report ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_expense_vs_profit_report(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  total_sales    numeric,
  total_cogs     numeric,
  gross_profit   numeric,
  total_expenses numeric,
  net_profit     numeric,
  profit_pct     numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sales_data AS (
    SELECT
      COALESCE(SUM(si.total_amount), 0)                             AS total_sales,
      COALESCE(SUM(sii.quantity * COALESCE(b.cost_per_unit, 0)), 0) AS total_cogs
    FROM sales_invoices si
    LEFT JOIN sales_invoice_items sii ON sii.invoice_id = si.id
    LEFT JOIN batches b ON b.id = sii.batch_id
    WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
      AND si.is_draft = false
  ),
  expense_data AS (
    SELECT COALESCE(SUM(fe.amount), 0) AS total_expenses
    FROM finance_expenses fe
    WHERE fe.expense_date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    ROUND(sd.total_sales, 2)                                          AS total_sales,
    ROUND(sd.total_cogs, 2)                                           AS total_cogs,
    ROUND(sd.total_sales - sd.total_cogs, 2)                          AS gross_profit,
    ROUND(ed.total_expenses, 2)                                       AS total_expenses,
    ROUND(sd.total_sales - sd.total_cogs - ed.total_expenses, 2)      AS net_profit,
    CASE WHEN sd.total_sales = 0 THEN 0
         ELSE ROUND(
           (sd.total_sales - sd.total_cogs - ed.total_expenses)
           / sd.total_sales * 100,
           2
         )
    END                                                               AS profit_pct
  FROM sales_data sd, expense_data ed;
$$;

GRANT EXECUTE ON FUNCTION get_expense_vs_profit_report(date, date) TO authenticated;
