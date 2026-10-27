-- ============================================================================
-- Migration: 20260903161000_reconcile_product_batches_dc_expense_scope.sql
-- ============================================================================
-- Delta update to public.get_sales_profitability_product_batches:
-- Expands the Delivery Challan revenue scope (all_dc_lines) to include all
-- invoice lines associated with the affected DCs, ensuring that value-based
-- sales expense allocations on multi-item DCs match get_sales_profitability_summary
-- and get_sales_profitability_batch_orders with 100.0% exact reconciliation.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(p_product_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH line_sources AS (
    SELECT
      sii.id AS line_id,
      sii.invoice_id,
      sii.quantity,
      sii.unit_price,
      ROUND(sii.quantity * sii.unit_price, 2) AS line_gross_sales,
      sii.batch_id,
      dci.challan_id AS dc_id
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    WHERE sii.product_id = p_product_id
      AND si.invoice_date >= p_start_date
      AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ),
  all_dc_lines AS (
    SELECT
      dci.challan_id AS dc_id,
      SUM(sii.quantity * sii.unit_price) AS total_dc_sales,
      SUM(sii.quantity) AS total_dc_qty
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    WHERE dci.challan_id IN (SELECT DISTINCT dc_id FROM line_sources WHERE dc_id IS NOT NULL)
      AND COALESCE(si.is_draft, false) = false
    GROUP BY dci.challan_id
  ),
  approved_dc_expenses AS (
    SELECT
      delivery_challan_id AS dc_id,
      SUM(amount) AS total_expense
    FROM public.finance_expenses
    WHERE expense_category IN ('delivery_sales', 'loading_sales')
      AND approval_status = 'approved'
      AND delivery_challan_id IN (SELECT DISTINCT dc_id FROM line_sources WHERE dc_id IS NOT NULL)
    GROUP BY delivery_challan_id
  ),
  lines_with_expense AS (
    SELECT
      ls.*,
      b.batch_number,
      b.current_stock,
      public.effective_sales_cogs_unit_cost(ls.batch_id) AS unit_cost,
      (b.import_container_id IS NOT NULL OR COALESCE(b.landed_cost_per_unit, 0) > 0) AS is_imported,
      b.import_price,
      b.import_price_usd,
      b.exchange_rate_usd_to_idr,
      b.duty_charges,
      b.freight_charges,
      b.other_charges,
      b.landed_cost_per_unit,
      b.cost_per_unit,
      ROUND(ls.quantity * COALESCE(public.effective_sales_cogs_unit_cost(ls.batch_id), 0), 2) AS line_cost,
      COALESCE(
        CASE
          WHEN adl.total_dc_sales > 0
            THEN ROUND(de.total_expense * (ls.line_gross_sales / adl.total_dc_sales), 2)
          WHEN adl.total_dc_qty > 0
            THEN ROUND(de.total_expense * (ls.quantity / adl.total_dc_qty), 2)
          ELSE 0
        END,
        0
      ) AS line_sales_expense
    FROM line_sources ls
    LEFT JOIN public.batches b ON b.id = ls.batch_id
    LEFT JOIN all_dc_lines adl ON adl.dc_id = ls.dc_id
    LEFT JOIN approved_dc_expenses de ON de.dc_id = ls.dc_id
  ),
  batch_summaries AS (
    SELECT
      lwe.batch_id,
      COALESCE(lwe.batch_number, 'Unassigned Batch') AS batch_number,
      COALESCE(lwe.current_stock, 0) AS current_stock,
      SUM(lwe.quantity) AS sold_qty,
      SUM(lwe.line_gross_sales) AS gross_sales,
      SUM(lwe.line_cost) AS product_cost,
      SUM(lwe.line_sales_expense) AS sales_expense,
      SUM(lwe.line_gross_sales - lwe.line_cost) AS gross_profit,
      SUM(lwe.line_gross_sales - lwe.line_cost - lwe.line_sales_expense) AS profit_after_sales_expense,
      lwe.unit_cost AS cost_per_unit,
      ROUND(SUM(lwe.line_gross_sales) / NULLIF(SUM(lwe.quantity), 0), 2) AS avg_selling_price,
      ROUND(SUM(lwe.line_sales_expense) / NULLIF(SUM(lwe.quantity), 0), 2) AS sales_expense_per_unit,
      ROUND((SUM(lwe.line_gross_sales) - SUM(lwe.line_sales_expense)) / NULLIF(SUM(lwe.quantity), 0), 2) AS net_selling_price_per_unit,
      ROUND((SUM(lwe.line_gross_sales) - SUM(lwe.line_cost) - SUM(lwe.line_sales_expense)) / NULLIF(SUM(lwe.quantity), 0), 2) AS profit_per_unit,
      CASE
        WHEN SUM(lwe.line_gross_sales) = 0 THEN 0
        ELSE ROUND(SUM(lwe.line_gross_sales - lwe.line_cost - lwe.line_sales_expense) / SUM(lwe.line_gross_sales) * 100, 2)
      END AS profit_margin_pct,
      lwe.is_imported,
      jsonb_build_object(
        'is_imported', lwe.is_imported,
        'import_price', lwe.import_price,
        'import_price_usd', lwe.import_price_usd,
        'exchange_rate', lwe.exchange_rate_usd_to_idr,
        'duty_charges', lwe.duty_charges,
        'freight_charges', lwe.freight_charges,
        'other_charges', lwe.other_charges,
        'landed_cost_per_unit', lwe.landed_cost_per_unit,
        'local_cost_per_unit', lwe.cost_per_unit
      ) AS cost_breakdown
    FROM lines_with_expense lwe
    GROUP BY
      lwe.batch_id, lwe.batch_number, lwe.current_stock, lwe.unit_cost,
      lwe.is_imported, lwe.import_price, lwe.import_price_usd, lwe.exchange_rate_usd_to_idr,
      lwe.duty_charges, lwe.freight_charges, lwe.other_charges, lwe.landed_cost_per_unit, lwe.cost_per_unit
  ),
  product_summary AS (
    SELECT
      p.id AS product_id,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit,
      COALESCE((SELECT SUM(current_stock) FROM public.batches WHERE product_id = p.id AND is_active = true), 0) AS current_stock,
      COALESCE(SUM(bs.sold_qty), 0) AS sold_qty,
      COALESCE(SUM(bs.gross_sales), 0) AS gross_sales,
      COALESCE(SUM(bs.product_cost), 0) AS product_cost,
      COALESCE(SUM(bs.sales_expense), 0) AS sales_expense,
      COALESCE(SUM(bs.gross_profit), 0) AS gross_profit,
      COALESCE(SUM(bs.profit_after_sales_expense), 0) AS profit_after_sales_expense,
      ROUND(COALESCE(SUM(bs.product_cost), 0) / NULLIF(SUM(bs.sold_qty), 0), 2) AS avg_landed_cost,
      ROUND(COALESCE(SUM(bs.gross_sales), 0) / NULLIF(SUM(bs.sold_qty), 0), 2) AS avg_selling_price,
      ROUND(COALESCE(SUM(bs.sales_expense), 0) / NULLIF(SUM(bs.sold_qty), 0), 2) AS sales_expense_per_unit,
      ROUND((COALESCE(SUM(bs.gross_sales), 0) - COALESCE(SUM(bs.sales_expense), 0)) / NULLIF(SUM(bs.sold_qty), 0), 2) AS net_selling_price_per_unit,
      ROUND(COALESCE(SUM(bs.profit_after_sales_expense), 0) / NULLIF(SUM(bs.sold_qty), 0), 2) AS profit_per_unit,
      CASE
        WHEN COALESCE(SUM(bs.gross_sales), 0) = 0 THEN 0
        ELSE ROUND(COALESCE(SUM(bs.profit_after_sales_expense), 0) / SUM(bs.gross_sales) * 100, 2)
      END AS profit_margin_pct
    FROM public.products p
    LEFT JOIN batch_summaries bs ON true
    WHERE p.id = p_product_id
    GROUP BY p.id, p.product_name, p.product_code, p.unit
  )
  SELECT jsonb_build_object(
    'product', (SELECT to_jsonb(ps) FROM product_summary ps),
    'batches', COALESCE((SELECT jsonb_agg(to_jsonb(bs) ORDER BY bs.profit_after_sales_expense DESC) FROM batch_summaries bs), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_product_batches(uuid, date, date) TO authenticated;

COMMIT;
