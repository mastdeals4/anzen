/*
  # Fix Sales Profit Report — USD prices, product unit, and purchase price fallback

  Changes:
  - Summary function now returns:
    - `product_unit` (text) — unit of measure from products table (kg, g, etc.)
    - `avg_selling_price_usd` (numeric) — avg selling price converted to USD via batch exchange rate
    - `avg_landed_cost_usd` (numeric) — avg landed cost in USD (landed_cost_per_unit / exchange_rate)
    - `using_purchase_price` (boolean) — true when landed_cost_per_unit = 0 and we fell back to import_price_usd
    - All IDR price columns removed from summary (profit still in IDR for total_profit)
  - Drilldown function similarly returns USD prices for sell and landed cost
  - When landed_cost_per_unit = 0, falls back to import_price_usd as the cost basis
  - no_cost = true only when both landed_cost_per_unit AND import_price_usd are 0/null
*/

DROP FUNCTION IF EXISTS get_sales_profit_summary(date, date);
DROP FUNCTION IF EXISTS get_sales_profit_drilldown(uuid, date, date);

-- ─── Summary ──────────────────────────────────────────────────────────────────

CREATE FUNCTION get_sales_profit_summary(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  product_id              uuid,
  product_name            text,
  product_code            text,
  product_unit            text,
  total_qty_sold          numeric,
  avg_selling_price_usd   numeric,
  avg_landed_cost_usd     numeric,
  profit_per_unit_usd     numeric,
  profit_pct              numeric,
  total_profit            numeric,    -- still IDR for grand-total display
  no_cost                 boolean,
  using_purchase_price    boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id                                                                        AS product_id,
    p.product_name,
    COALESCE(p.product_code, '')                                                AS product_code,
    COALESCE(p.unit, '')                                                        AS product_unit,
    SUM(sii.quantity)                                                           AS total_qty_sold,

    -- Avg selling price in USD  (unit_price IDR / exchange_rate)
    CASE WHEN SUM(sii.quantity) = 0 THEN 0
         ELSE ROUND(
           SUM(sii.quantity * sii.unit_price
               / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0))
           / SUM(sii.quantity), 4)
    END                                                                         AS avg_selling_price_usd,

    -- Avg landed cost in USD:
    --   If landed_cost_per_unit > 0 → use landed_cost_per_unit / exchange_rate
    --   Else if import_price_usd > 0 → use import_price_usd directly
    --   Else 0 (no data)
    CASE WHEN SUM(sii.quantity) = 0 THEN 0
         ELSE ROUND(
           SUM(
             sii.quantity *
             CASE
               WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
                 THEN b.landed_cost_per_unit
                      / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0)
               WHEN COALESCE(b.import_price_usd, 0) > 0
                 THEN b.import_price_usd
               ELSE 0
             END
           )
           / SUM(sii.quantity), 4)
    END                                                                         AS avg_landed_cost_usd,

    -- Profit per unit (USD)
    CASE WHEN SUM(sii.quantity) = 0 THEN 0
         ELSE ROUND(
           SUM(sii.quantity * sii.unit_price
               / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0))
           / SUM(sii.quantity)
           -
           SUM(
             sii.quantity *
             CASE
               WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
                 THEN b.landed_cost_per_unit
                      / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0)
               WHEN COALESCE(b.import_price_usd, 0) > 0
                 THEN b.import_price_usd
               ELSE 0
             END
           )
           / SUM(sii.quantity), 4)
    END                                                                         AS profit_per_unit_usd,

    -- Profit %  based on cost
    CASE
      WHEN SUM(
             sii.quantity *
             CASE
               WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
                 THEN b.landed_cost_per_unit
               WHEN COALESCE(b.import_price_usd, 0) > 0
                 THEN b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
               ELSE 0
             END
           ) = 0 THEN 0
      ELSE ROUND(
        (SUM(sii.quantity * sii.unit_price)
         - SUM(
             sii.quantity *
             CASE
               WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
                 THEN b.landed_cost_per_unit
               WHEN COALESCE(b.import_price_usd, 0) > 0
                 THEN b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
               ELSE 0
             END
           )
        )
        /
        SUM(
          sii.quantity *
          CASE
            WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
              THEN b.landed_cost_per_unit
            WHEN COALESCE(b.import_price_usd, 0) > 0
              THEN b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
            ELSE 0
          END
        ) * 100,
        2)
    END                                                                         AS profit_pct,

    -- Total profit in IDR (for grand total display)
    ROUND(
      SUM(sii.quantity * sii.unit_price)
      - SUM(
          sii.quantity *
          CASE
            WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
              THEN b.landed_cost_per_unit
            WHEN COALESCE(b.import_price_usd, 0) > 0
              THEN b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
            ELSE 0
          END
        ),
      2)                                                                        AS total_profit,

    -- no_cost: true only when absolutely no cost data
    (SUM(sii.quantity *
         CASE
           WHEN COALESCE(b.landed_cost_per_unit, 0) > 0 THEN 1
           WHEN COALESCE(b.import_price_usd, 0) > 0 THEN 1
           ELSE 0
         END
       ) = 0)                                                                   AS no_cost,

    -- using_purchase_price: true when at least one line used import_price_usd fallback
    (
      SUM(CASE WHEN COALESCE(b.landed_cost_per_unit, 0) = 0
               AND COALESCE(b.import_price_usd, 0) > 0 THEN sii.quantity ELSE 0 END)
      > 0
    )                                                                           AS using_purchase_price

  FROM sales_invoice_items sii
  JOIN sales_invoices si ON si.id  = sii.invoice_id
  JOIN products       p  ON p.id  = sii.product_id
  LEFT JOIN batches   b  ON b.id  = sii.batch_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  GROUP BY p.id, p.product_name, p.product_code, p.unit
  ORDER BY total_profit DESC;
$$;

GRANT EXECUTE ON FUNCTION get_sales_profit_summary(date, date) TO authenticated;


-- ─── Drilldown ────────────────────────────────────────────────────────────────

CREATE FUNCTION get_sales_profit_drilldown(
  p_product_id uuid,
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  invoice_id            uuid,
  invoice_number        text,
  invoice_date          date,
  customer_name         text,
  batch_number          text,
  qty                   numeric,
  product_unit          text,
  selling_price_usd     numeric,
  landed_cost_usd       numeric,
  profit_per_unit_usd   numeric,
  line_sales            numeric,    -- IDR
  line_cost             numeric,    -- IDR
  line_profit           numeric,    -- IDR
  profit_pct            numeric,
  no_cost               boolean,
  using_purchase_price  boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    si.id                                                                         AS invoice_id,
    si.invoice_number,
    si.invoice_date,
    COALESCE(c.company_name, '')                                                  AS customer_name,
    COALESCE(b.batch_number, '')                                                  AS batch_number,
    sii.quantity                                                                  AS qty,
    COALESCE(p.unit, '')                                                          AS product_unit,

    -- Selling price in USD
    ROUND(sii.unit_price
          / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0), 4)           AS selling_price_usd,

    -- Landed cost in USD (with fallback)
    CASE
      WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
        THEN ROUND(b.landed_cost_per_unit
                   / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0), 4)
      WHEN COALESCE(b.import_price_usd, 0) > 0
        THEN ROUND(b.import_price_usd, 4)
      ELSE 0
    END                                                                           AS landed_cost_usd,

    -- Profit per unit (USD)
    CASE
      WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
        THEN ROUND(sii.unit_price / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0)
                   - b.landed_cost_per_unit / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0), 4)
      WHEN COALESCE(b.import_price_usd, 0) > 0
        THEN ROUND(sii.unit_price / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0)
                   - b.import_price_usd, 4)
      ELSE ROUND(sii.unit_price / NULLIF(COALESCE(b.exchange_rate_usd_to_idr, 16000), 0), 4)
    END                                                                           AS profit_per_unit_usd,

    -- Line amounts in IDR
    ROUND(sii.quantity * sii.unit_price, 2)                                       AS line_sales,

    ROUND(sii.quantity *
      CASE
        WHEN COALESCE(b.landed_cost_per_unit, 0) > 0 THEN b.landed_cost_per_unit
        WHEN COALESCE(b.import_price_usd, 0) > 0
          THEN b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
        ELSE 0
      END, 2)                                                                     AS line_cost,

    ROUND(
      sii.quantity * sii.unit_price
      - sii.quantity *
        CASE
          WHEN COALESCE(b.landed_cost_per_unit, 0) > 0 THEN b.landed_cost_per_unit
          WHEN COALESCE(b.import_price_usd, 0) > 0
            THEN b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
          ELSE 0
        END,
      2)                                                                          AS line_profit,

    -- Profit %
    CASE
      WHEN COALESCE(b.landed_cost_per_unit, 0) = 0 AND COALESCE(b.import_price_usd, 0) = 0 THEN 0
      ELSE ROUND(
        (sii.unit_price
         - CASE
             WHEN COALESCE(b.landed_cost_per_unit, 0) > 0 THEN b.landed_cost_per_unit
             ELSE b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
           END
        )
        /
        NULLIF(
          CASE
            WHEN COALESCE(b.landed_cost_per_unit, 0) > 0 THEN b.landed_cost_per_unit
            ELSE b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
          END, 0)
        * 100, 2)
    END                                                                           AS profit_pct,

    (COALESCE(b.landed_cost_per_unit, 0) = 0 AND COALESCE(b.import_price_usd, 0) = 0) AS no_cost,

    (COALESCE(b.landed_cost_per_unit, 0) = 0 AND COALESCE(b.import_price_usd, 0) > 0) AS using_purchase_price

  FROM sales_invoice_items sii
  JOIN sales_invoices si ON si.id = sii.invoice_id
  JOIN customers      c  ON c.id = si.customer_id
  JOIN products       p  ON p.id = sii.product_id
  LEFT JOIN batches   b  ON b.id = sii.batch_id
  WHERE sii.product_id = p_product_id
    AND si.invoice_date BETWEEN p_start_date AND p_end_date
    AND si.is_draft = false
  ORDER BY si.invoice_date DESC;
$$;

GRANT EXECUTE ON FUNCTION get_sales_profit_drilldown(uuid, date, date) TO authenticated;
