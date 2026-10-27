/*
  # Create get_cogs_for_period function

  Returns total COGS (cost of goods sold) for a given date range,
  calculated as sum of (quantity × landed_cost_per_unit) for all
  non-draft sales invoice items, joining to batches for the cost.
  Falls back to import_price when landed_cost_per_unit is zero.

  Parameters: p_start date, p_end date
  Returns: numeric (total COGS in IDR)
*/

CREATE OR REPLACE FUNCTION get_cogs_for_period(
  p_start date,
  p_end   date
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    SUM(
      sii.quantity *
      CASE
        WHEN COALESCE(b.landed_cost_per_unit, 0) > 0
          THEN b.landed_cost_per_unit
        WHEN COALESCE(b.import_price_usd, 0) > 0
          THEN b.import_price_usd * COALESCE(b.exchange_rate_usd_to_idr, 16000)
        ELSE COALESCE(b.import_price, 0)
      END
    ), 0)
  FROM sales_invoice_items sii
  JOIN sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN batches b ON b.id = sii.batch_id
  WHERE si.invoice_date BETWEEN p_start AND p_end
    AND si.is_draft = false;
$$;

GRANT EXECUTE ON FUNCTION get_cogs_for_period(date, date) TO authenticated;
