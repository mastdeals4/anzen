/*
  # Sales Profit Report RPC Functions

  ## Summary
  Two RPC functions for the Sales Profit Report page:

  1. get_sales_profit_summary(start_date, end_date)
     - Aggregates by product across all posted sales invoices in the date range
     - Returns: product_id, product_name, total_qty_sold, total_sales_value,
       avg_selling_price, avg_cost_per_unit, gross_profit, profit_pct

  2. get_sales_profit_drilldown(product_id, start_date, end_date)
     - Per-invoice detail rows for a specific product
     - Returns: invoice_number, invoice_date, customer_name, qty, selling_price,
       cost_per_unit, line_sales, line_cost, line_profit, profit_pct

  ## Logic
  - Revenue = quantity × unit_price (from sales_invoice_items)
  - COGS = quantity × batches.cost_per_unit (landed cost already baked into batch)
  - Profit = Revenue - COGS
  - Profit % = (Profit / Revenue) × 100
  - Invoices with is_draft = true are excluded
*/

CREATE OR REPLACE FUNCTION get_sales_profit_summary(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  product_id        uuid,
  product_name      text,
  product_code      text,
  total_qty_sold    numeric,
  total_sales_value numeric,
  total_cost_value  numeric,
  total_profit      numeric,
  profit_pct        numeric,
  avg_selling_price numeric,
  avg_cost_per_unit numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id                                              AS product_id,
    p.product_name,
    COALESCE(p.product_code, '')                      AS product_code,
    SUM(sii.quantity)                                 AS total_qty_sold,
    SUM(sii.quantity * sii.unit_price)                AS total_sales_value,
    SUM(sii.quantity * COALESCE(b.cost_per_unit, 0))  AS total_cost_value,
    SUM(sii.quantity * sii.unit_price)
      - SUM(sii.quantity * COALESCE(b.cost_per_unit, 0))
                                                      AS total_profit,
    CASE
      WHEN SUM(sii.quantity * sii.unit_price) = 0 THEN 0
      ELSE ROUND(
        (SUM(sii.quantity * sii.unit_price)
          - SUM(sii.quantity * COALESCE(b.cost_per_unit, 0)))
        / SUM(sii.quantity * sii.unit_price) * 100,
        2
      )
    END                                               AS profit_pct,
    CASE
      WHEN SUM(sii.quantity) = 0 THEN 0
      ELSE ROUND(SUM(sii.quantity * sii.unit_price) / SUM(sii.quantity), 2)
    END                                               AS avg_selling_price,
    CASE
      WHEN SUM(sii.quantity) = 0 THEN 0
      ELSE ROUND(SUM(sii.quantity * COALESCE(b.cost_per_unit, 0)) / SUM(sii.quantity), 2)
    END                                               AS avg_cost_per_unit
  FROM sales_invoice_items sii
  JOIN sales_invoices      si  ON si.id  = sii.invoice_id
  JOIN products            p   ON p.id   = sii.product_id
  LEFT JOIN batches        b   ON b.id   = sii.batch_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  GROUP BY p.id, p.product_name, p.product_code
  ORDER BY total_profit DESC;
$$;

CREATE OR REPLACE FUNCTION get_sales_profit_drilldown(
  p_product_id uuid,
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  invoice_id      uuid,
  invoice_number  text,
  invoice_date    date,
  customer_name   text,
  batch_number    text,
  qty             numeric,
  selling_price   numeric,
  cost_per_unit   numeric,
  line_sales      numeric,
  line_cost       numeric,
  line_profit     numeric,
  profit_pct      numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    si.id                                                     AS invoice_id,
    si.invoice_number,
    si.invoice_date,
    COALESCE(c.company_name, '')                              AS customer_name,
    COALESCE(b.batch_number, '')                              AS batch_number,
    sii.quantity                                              AS qty,
    sii.unit_price                                            AS selling_price,
    COALESCE(b.cost_per_unit, 0)                              AS cost_per_unit,
    ROUND(sii.quantity * sii.unit_price, 2)                   AS line_sales,
    ROUND(sii.quantity * COALESCE(b.cost_per_unit, 0), 2)     AS line_cost,
    ROUND(
      sii.quantity * sii.unit_price
      - sii.quantity * COALESCE(b.cost_per_unit, 0),
      2
    )                                                         AS line_profit,
    CASE
      WHEN sii.unit_price = 0 THEN 0
      ELSE ROUND(
        (sii.unit_price - COALESCE(b.cost_per_unit, 0))
        / sii.unit_price * 100,
        2
      )
    END                                                       AS profit_pct
  FROM sales_invoice_items sii
  JOIN sales_invoices      si  ON si.id  = sii.invoice_id
  JOIN customers           c   ON c.id   = si.customer_id
  LEFT JOIN batches        b   ON b.id   = sii.batch_id
  WHERE sii.product_id  = p_product_id
    AND si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  ORDER BY si.invoice_date DESC;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_sales_profit_summary(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_sales_profit_drilldown(uuid, date, date) TO authenticated;
