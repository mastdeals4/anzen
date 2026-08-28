/*
  # Fix Sales Profit Report — Drop and Recreate with Landed Cost

  Drops the old functions (which had different return signatures) and recreates
  them using batches.landed_cost_per_unit (import price + allocated delivery costs).

  Profit % = (Profit per unit / Avg Landed Cost) × 100
  Total Profit = Profit per unit × Total Qty
*/

DROP FUNCTION IF EXISTS get_sales_profit_summary(date, date);
DROP FUNCTION IF EXISTS get_sales_profit_drilldown(uuid, date, date);

CREATE FUNCTION get_sales_profit_summary(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  product_id          uuid,
  product_name        text,
  product_code        text,
  total_qty_sold      numeric,
  avg_selling_price   numeric,
  avg_landed_cost     numeric,
  profit_per_unit     numeric,
  profit_pct          numeric,
  total_profit        numeric,
  no_cost             boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id                                                                    AS product_id,
    p.product_name,
    COALESCE(p.product_code, '')                                            AS product_code,
    SUM(sii.quantity)                                                       AS total_qty_sold,

    CASE WHEN SUM(sii.quantity) = 0 THEN 0
         ELSE ROUND(SUM(sii.quantity * sii.unit_price) / SUM(sii.quantity), 4)
    END                                                                     AS avg_selling_price,

    CASE WHEN SUM(sii.quantity) = 0 THEN 0
         ELSE ROUND(
           SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0))
           / SUM(sii.quantity), 4)
    END                                                                     AS avg_landed_cost,

    CASE WHEN SUM(sii.quantity) = 0 THEN 0
         ELSE ROUND(
           SUM(sii.quantity * sii.unit_price) / SUM(sii.quantity)
           - SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0)) / SUM(sii.quantity),
           4)
    END                                                                     AS profit_per_unit,

    CASE
      WHEN SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0)) = 0 THEN 0
      ELSE ROUND(
        (SUM(sii.quantity * sii.unit_price)
         - SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0)))
        / SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0)) * 100,
        2)
    END                                                                     AS profit_pct,

    ROUND(
      SUM(sii.quantity * sii.unit_price)
      - SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0)),
      2)                                                                    AS total_profit,

    (SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0)) = 0)          AS no_cost

  FROM sales_invoice_items sii
  JOIN sales_invoices si ON si.id  = sii.invoice_id
  JOIN products       p  ON p.id  = sii.product_id
  LEFT JOIN batches   b  ON b.id  = sii.batch_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  GROUP BY p.id, p.product_name, p.product_code
  ORDER BY total_profit DESC;
$$;

GRANT EXECUTE ON FUNCTION get_sales_profit_summary(date, date) TO authenticated;


CREATE FUNCTION get_sales_profit_drilldown(
  p_product_id uuid,
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  invoice_id        uuid,
  invoice_number    text,
  invoice_date      date,
  customer_name     text,
  batch_number      text,
  qty               numeric,
  selling_price     numeric,
  landed_cost       numeric,
  profit_per_unit   numeric,
  line_sales        numeric,
  line_cost         numeric,
  line_profit       numeric,
  profit_pct        numeric,
  no_cost           boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    si.id                                                                   AS invoice_id,
    si.invoice_number,
    si.invoice_date,
    COALESCE(c.company_name, '')                                            AS customer_name,
    COALESCE(b.batch_number, '')                                            AS batch_number,
    sii.quantity                                                            AS qty,
    sii.unit_price                                                          AS selling_price,
    COALESCE(b.landed_cost_per_unit, 0)                                     AS landed_cost,
    ROUND(sii.unit_price - COALESCE(b.landed_cost_per_unit, 0), 4)         AS profit_per_unit,
    ROUND(sii.quantity * sii.unit_price, 2)                                 AS line_sales,
    ROUND(sii.quantity * COALESCE(b.landed_cost_per_unit, 0), 2)            AS line_cost,
    ROUND(
      sii.quantity * sii.unit_price
      - sii.quantity * COALESCE(b.landed_cost_per_unit, 0),
      2)                                                                    AS line_profit,
    CASE
      WHEN COALESCE(b.landed_cost_per_unit, 0) = 0 THEN 0
      ELSE ROUND(
        (sii.unit_price - COALESCE(b.landed_cost_per_unit, 0))
        / b.landed_cost_per_unit * 100,
        2)
    END                                                                     AS profit_pct,
    (COALESCE(b.landed_cost_per_unit, 0) = 0)                              AS no_cost
  FROM sales_invoice_items sii
  JOIN sales_invoices si ON si.id = sii.invoice_id
  JOIN customers      c  ON c.id = si.customer_id
  LEFT JOIN batches   b  ON b.id = sii.batch_id
  WHERE sii.product_id = p_product_id
    AND si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  ORDER BY si.invoice_date DESC;
$$;

GRANT EXECUTE ON FUNCTION get_sales_profit_drilldown(uuid, date, date) TO authenticated;
