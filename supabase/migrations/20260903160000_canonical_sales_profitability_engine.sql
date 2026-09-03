-- ============================================================================
-- Canonical Sales Profitability Engine
-- ============================================================================
-- Redesigned from the ground up to establish a single, canonical,
-- management-grade profitability calculation model.
-- 
-- Hierarchy:
--   Company Totals -> Products -> Batches -> Invoices/Orders -> Customers
--
-- Product Cost Rule:
--   - Imported batches (has import_container or landed_cost_per_unit > 0):
--       product_cost_per_unit = landed_cost_per_unit
--   - Local batches:
--       product_cost_per_unit = cost_per_unit (fallback import_price_per_unit)
--   - Uncosted: flagged as unknown, excluded from margin distortion
--
-- Sales Expenses:
--   - delivery_sales and loading_sales from finance_expenses (approved)
--   - Deduplicated and allocated proportionally by line gross sales
--   - Deducted from realization (never mixed into product landed cost)
-- ============================================================================

BEGIN;

-- 1. Effective COGS unit cost resolver
CREATE OR REPLACE FUNCTION public.effective_sales_cogs_unit_cost(p_batch_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN b.import_container_id IS NOT NULL OR COALESCE(b.landed_cost_per_unit, 0) > 0
      THEN NULLIF(b.landed_cost_per_unit, 0)
    ELSE COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price_per_unit, 0))
  END
  FROM public.batches b
  WHERE b.id = p_batch_id;
$$;

GRANT EXECUTE ON FUNCTION public.effective_sales_cogs_unit_cost(uuid) TO authenticated;

-- 2. get_sales_profitability_summary
CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH line_sources AS (
    SELECT
      sii.id AS line_id,
      sii.invoice_id,
      si.invoice_number,
      si.invoice_date,
      si.customer_id,
      COALESCE(c.company_name, 'Unknown Customer') AS customer_name,
      sii.product_id,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit,
      sii.batch_id,
      b.batch_number,
      sii.quantity,
      sii.unit_price,
      ROUND(sii.quantity * sii.unit_price, 2) AS line_gross_sales,
      public.effective_sales_cogs_unit_cost(sii.batch_id) AS unit_cost,
      dci.challan_id AS dc_id
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    JOIN public.products p ON p.id = sii.product_id
    LEFT JOIN public.customers c ON c.id = si.customer_id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    WHERE si.invoice_date >= p_start_date
      AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ),
  dc_revenue_totals AS (
    SELECT
      dc_id,
      SUM(line_gross_sales) AS total_dc_sales,
      SUM(quantity) AS total_dc_qty
    FROM line_sources
    WHERE dc_id IS NOT NULL
    GROUP BY dc_id
  ),
  approved_dc_expenses AS (
    SELECT
      delivery_challan_id AS dc_id,
      SUM(amount) AS total_expense
    FROM public.finance_expenses
    WHERE expense_category IN ('delivery_sales', 'loading_sales')
      AND approval_status = 'approved'
      AND delivery_challan_id IS NOT NULL
    GROUP BY delivery_challan_id
  ),
  lines_with_expense AS (
    SELECT
      ls.*,
      ROUND(ls.quantity * COALESCE(ls.unit_cost, 0), 2) AS line_cost,
      COALESCE(
        CASE
          WHEN dt.total_dc_sales > 0
            THEN ROUND(de.total_expense * (ls.line_gross_sales / dt.total_dc_sales), 2)
          WHEN dt.total_dc_qty > 0
            THEN ROUND(de.total_expense * (ls.quantity / dt.total_dc_qty), 2)
          ELSE 0
        END,
        0
      ) AS line_sales_expense
    FROM line_sources ls
    LEFT JOIN dc_revenue_totals dt ON dt.dc_id = ls.dc_id
    LEFT JOIN approved_dc_expenses de ON de.dc_id = ls.dc_id
  ),
  product_stocks AS (
    SELECT
      product_id,
      SUM(current_stock) AS current_stock
    FROM public.batches
    WHERE is_active = true
    GROUP BY product_id
  ),
  unallocated_exp AS (
    SELECT COALESCE(SUM(amount), 0) AS amount
    FROM public.finance_expenses
    WHERE expense_category IN ('delivery_sales', 'loading_sales')
      AND approval_status = 'approved'
      AND (delivery_challan_id IS NULL OR delivery_challan_id NOT IN (SELECT DISTINCT dc_id FROM line_sources WHERE dc_id IS NOT NULL))
      AND expense_date >= p_start_date AND expense_date <= p_end_date
  ),
  product_summaries AS (
    SELECT
      lwe.product_id,
      lwe.product_name,
      lwe.product_code,
      lwe.product_unit,
      COALESCE(ps.current_stock, 0) AS current_stock,
      SUM(lwe.quantity) AS sold_qty,
      SUM(lwe.line_gross_sales) AS gross_sales,
      SUM(lwe.line_cost) AS product_cost,
      SUM(lwe.line_sales_expense) AS sales_expense,
      SUM(lwe.line_gross_sales - lwe.line_cost) AS gross_profit,
      SUM(lwe.line_gross_sales - lwe.line_cost - lwe.line_sales_expense) AS profit_after_sales_expense,
      ROUND(SUM(lwe.line_cost) / NULLIF(SUM(lwe.quantity), 0), 2) AS avg_landed_cost,
      ROUND(SUM(lwe.line_gross_sales) / NULLIF(SUM(lwe.quantity), 0), 2) AS avg_selling_price,
      ROUND(SUM(lwe.line_sales_expense) / NULLIF(SUM(lwe.quantity), 0), 2) AS sales_expense_per_unit,
      ROUND((SUM(lwe.line_gross_sales) - SUM(lwe.line_sales_expense)) / NULLIF(SUM(lwe.quantity), 0), 2) AS net_selling_price_per_unit,
      ROUND((SUM(lwe.line_gross_sales) - SUM(lwe.line_cost) - SUM(lwe.line_sales_expense)) / NULLIF(SUM(lwe.quantity), 0), 2) AS profit_per_unit,
      CASE
        WHEN SUM(lwe.line_gross_sales) = 0 THEN 0
        ELSE ROUND(SUM(lwe.line_gross_sales - lwe.line_cost - lwe.line_sales_expense) / SUM(lwe.line_gross_sales) * 100, 2)
      END AS profit_margin_pct,
      COUNT(*) FILTER (WHERE lwe.unit_cost IS NOT NULL) AS costed_lines,
      COUNT(*) AS total_lines,
      BOOL_OR(lwe.unit_cost IS NULL) AS has_unreported_cost
    FROM lines_with_expense lwe
    LEFT JOIN product_stocks ps ON ps.product_id = lwe.product_id
    GROUP BY lwe.product_id, lwe.product_name, lwe.product_code, lwe.product_unit, ps.current_stock
  ),
  monthly_summaries AS (
    SELECT
      to_char(date_trunc('month', lwe.invoice_date), 'Mon YYYY') AS month_label,
      date_trunc('month', lwe.invoice_date)::date AS month_start,
      SUM(lwe.line_gross_sales) AS gross_sales,
      SUM(lwe.line_cost) AS product_cost,
      SUM(lwe.line_sales_expense) AS sales_expenses,
      SUM(lwe.line_gross_sales - lwe.line_cost) AS gross_profit,
      SUM(lwe.line_gross_sales - lwe.line_cost - lwe.line_sales_expense) AS profit_after_sales_expenses,
      CASE
        WHEN SUM(lwe.line_gross_sales) = 0 THEN 0
        ELSE ROUND(SUM(lwe.line_gross_sales - lwe.line_cost - lwe.line_sales_expense) / SUM(lwe.line_gross_sales) * 100, 2)
      END AS profit_margin_pct,
      SUM(lwe.quantity) AS total_qty_sold,
      COUNT(DISTINCT lwe.invoice_id) AS order_count
    FROM lines_with_expense lwe
    GROUP BY 1, 2
    ORDER BY month_start
  ),
  company_totals AS (
    SELECT
      COALESCE(SUM(lwe.line_gross_sales), 0) AS gross_sales,
      COALESCE(SUM(lwe.line_cost), 0) AS product_cost,
      COALESCE(SUM(lwe.line_sales_expense), 0) + (SELECT amount FROM unallocated_exp) AS sales_expenses,
      (SELECT amount FROM unallocated_exp) AS unallocated_sales_expenses,
      COALESCE(SUM(lwe.line_gross_sales - lwe.line_cost), 0) AS gross_profit,
      COALESCE(SUM(lwe.line_gross_sales - lwe.line_cost - lwe.line_sales_expense), 0) - (SELECT amount FROM unallocated_exp) AS profit_after_sales_expenses,
      CASE
        WHEN COALESCE(SUM(lwe.line_gross_sales), 0) = 0 THEN 0
        ELSE ROUND((COALESCE(SUM(lwe.line_gross_sales - lwe.line_cost - lwe.line_sales_expense), 0) - (SELECT amount FROM unallocated_exp)) / SUM(lwe.line_gross_sales) * 100, 2)
      END AS profit_margin_pct,
      COALESCE(SUM(lwe.quantity), 0) AS total_qty_sold,
      COUNT(DISTINCT lwe.invoice_id) AS order_count,
      COUNT(DISTINCT lwe.product_id) AS product_count
    FROM lines_with_expense lwe
  )
  SELECT jsonb_build_object(
    'company', (SELECT to_jsonb(ct) FROM company_totals ct),
    'products', COALESCE((SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.profit_after_sales_expense DESC) FROM product_summaries ps), '[]'::jsonb),
    'monthly', COALESCE((SELECT jsonb_agg(to_jsonb(ms) ORDER BY ms.month_start) FROM monthly_summaries ms), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date, date) TO authenticated;

-- 3. get_sales_profitability_product_batches
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

-- 4. get_sales_profitability_batch_orders
CREATE OR REPLACE FUNCTION public.get_sales_profitability_batch_orders(p_batch_id uuid, p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH line_sources AS (
    SELECT
      sii.id AS line_id,
      sii.invoice_id,
      si.invoice_number,
      si.invoice_date,
      si.customer_id,
      COALESCE(c.company_name, 'Unknown Customer') AS customer_name,
      si.sales_order_id,
      so.so_number,
      dci.challan_id AS dc_id,
      dc.challan_number AS dc_number,
      sii.quantity,
      sii.unit_price,
      ROUND(sii.quantity * sii.unit_price, 2) AS line_gross_sales,
      public.effective_sales_cogs_unit_cost(sii.batch_id) AS unit_cost
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    LEFT JOIN public.customers c ON c.id = si.customer_id
    LEFT JOIN public.sales_orders so ON so.id = si.sales_order_id
    LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    WHERE sii.batch_id = p_batch_id
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
      fe.id AS expense_id,
      fe.voucher_number,
      fe.expense_category,
      fe.amount,
      fe.description,
      fe.expense_date,
      fe.delivery_challan_id AS dc_id
    FROM public.finance_expenses fe
    WHERE fe.expense_category IN ('delivery_sales', 'loading_sales')
      AND fe.approval_status = 'approved'
      AND fe.delivery_challan_id IN (SELECT DISTINCT dc_id FROM line_sources WHERE dc_id IS NOT NULL)
  ),
  dc_expenses_grouped AS (
    SELECT
      dc_id,
      SUM(amount) AS total_expense,
      jsonb_agg(jsonb_build_object(
        'id', expense_id,
        'voucher_number', voucher_number,
        'category', expense_category,
        'total_amount', amount,
        'description', description,
        'expense_date', expense_date
      )) AS expenses_json
    FROM approved_dc_expenses
    GROUP BY dc_id
  ),
  order_lines AS (
    SELECT
      ls.line_id,
      ls.invoice_id,
      ls.invoice_number,
      ls.invoice_date,
      ls.customer_id,
      ls.customer_name,
      ls.sales_order_id,
      ls.so_number,
      ls.dc_id,
      ls.dc_number,
      ls.quantity,
      ls.unit_price,
      ls.line_gross_sales,
      ls.unit_cost,
      ROUND(ls.quantity * COALESCE(ls.unit_cost, 0), 2) AS line_cost,
      COALESCE(
        CASE
          WHEN adl.total_dc_sales > 0
            THEN ROUND(deg.total_expense * (ls.line_gross_sales / adl.total_dc_sales), 2)
          WHEN adl.total_dc_qty > 0
            THEN ROUND(deg.total_expense * (ls.quantity / adl.total_dc_qty), 2)
          ELSE 0
        END,
        0
      ) AS line_sales_expense,
      ROUND(ls.line_gross_sales - COALESCE(
        CASE
          WHEN adl.total_dc_sales > 0
            THEN ROUND(deg.total_expense * (ls.line_gross_sales / adl.total_dc_sales), 2)
          WHEN adl.total_dc_qty > 0
            THEN ROUND(deg.total_expense * (ls.quantity / adl.total_dc_qty), 2)
          ELSE 0
        END,
        0
      ), 2) AS net_selling_realization,
      ROUND(ls.line_gross_sales - ROUND(ls.quantity * COALESCE(ls.unit_cost, 0), 2), 2) AS gross_profit,
      ROUND(ls.line_gross_sales - ROUND(ls.quantity * COALESCE(ls.unit_cost, 0), 2) - COALESCE(
        CASE
          WHEN adl.total_dc_sales > 0
            THEN ROUND(deg.total_expense * (ls.line_gross_sales / adl.total_dc_sales), 2)
          WHEN adl.total_dc_qty > 0
            THEN ROUND(deg.total_expense * (ls.quantity / adl.total_dc_qty), 2)
          ELSE 0
        END,
        0
      ), 2) AS profit,
      CASE
        WHEN ls.line_gross_sales = 0 THEN 0
        ELSE ROUND((ls.line_gross_sales - ROUND(ls.quantity * COALESCE(ls.unit_cost, 0), 2) - COALESCE(
          CASE
            WHEN adl.total_dc_sales > 0
              THEN ROUND(deg.total_expense * (ls.line_gross_sales / adl.total_dc_sales), 2)
            WHEN adl.total_dc_qty > 0
              THEN ROUND(deg.total_expense * (ls.quantity / adl.total_dc_qty), 2)
            ELSE 0
          END,
          0
        )) / ls.line_gross_sales * 100, 2)
      END AS profit_margin_pct,
      COALESCE(deg.expenses_json, '[]'::jsonb) AS expenses
    FROM line_sources ls
    LEFT JOIN all_dc_lines adl ON adl.dc_id = ls.dc_id
    LEFT JOIN dc_expenses_grouped deg ON deg.dc_id = ls.dc_id
  ),
  batch_header AS (
    SELECT
      b.id AS batch_id,
      b.batch_number,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit,
      b.current_stock,
      (b.import_container_id IS NOT NULL OR COALESCE(b.landed_cost_per_unit, 0) > 0) AS is_imported,
      public.effective_sales_cogs_unit_cost(b.id) AS cost_per_unit,
      jsonb_build_object(
        'is_imported', (b.import_container_id IS NOT NULL OR COALESCE(b.landed_cost_per_unit, 0) > 0),
        'import_price', b.import_price,
        'import_price_usd', b.import_price_usd,
        'exchange_rate', b.exchange_rate_usd_to_idr,
        'duty_charges', b.duty_charges,
        'freight_charges', b.freight_charges,
        'other_charges', b.other_charges,
        'landed_cost_per_unit', b.landed_cost_per_unit,
        'local_cost_per_unit', b.cost_per_unit
      ) AS cost_breakdown
    FROM public.batches b
    JOIN public.products p ON p.id = b.product_id
    WHERE b.id = p_batch_id
  )
  SELECT jsonb_build_object(
    'batch', (SELECT to_jsonb(bh) FROM batch_header bh),
    'orders', COALESCE((SELECT jsonb_agg(to_jsonb(ol) ORDER BY ol.invoice_date DESC, ol.invoice_number) FROM order_lines ol), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_batch_orders(uuid, date, date) TO authenticated;

-- 5. Fix legacy RPCs for backward compatibility with tests & legacy components
CREATE OR REPLACE FUNCTION public.get_sales_profit_summary(p_start_date date, p_end_date date)
RETURNS TABLE (
  product_id uuid, product_name text, product_code text, product_unit text,
  total_qty_sold numeric, total_revenue numeric, costed_revenue numeric,
  total_cogs numeric, total_profit numeric, profit_pct numeric,
  costed_lines bigint, total_lines bigint, no_cost boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lines AS (
    SELECT sii.product_id, p.product_name, COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit, sii.quantity, sii.unit_price,
      public.effective_sales_cogs_unit_cost(sii.batch_id) AS effective_unit_cost
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    JOIN public.products p ON p.id = sii.product_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ), grouped AS (
    SELECT product_id, product_name, product_code, product_unit,
      SUM(quantity) AS total_qty_sold,
      SUM(quantity * unit_price) AS total_revenue,
      SUM(quantity * unit_price) FILTER (WHERE effective_unit_cost IS NOT NULL) AS costed_revenue,
      COALESCE(SUM(quantity * effective_unit_cost) FILTER (WHERE effective_unit_cost IS NOT NULL), 0) AS total_cogs,
      COUNT(*) FILTER (WHERE effective_unit_cost IS NOT NULL) AS costed_lines,
      COUNT(*) AS total_lines
    FROM lines GROUP BY product_id, product_name, product_code, product_unit
  )
  SELECT
    product_id,
    product_name,
    product_code,
    product_unit,
    ROUND(total_qty_sold, 3) AS total_qty_sold,
    ROUND(total_revenue, 2) AS total_revenue,
    ROUND(COALESCE(costed_revenue, 0), 2) AS costed_revenue,
    ROUND(total_cogs, 2) AS total_cogs,
    ROUND(COALESCE(costed_revenue, 0) - total_cogs, 2) AS total_profit,
    CASE WHEN COALESCE(costed_revenue, 0) = 0 THEN NULL
      ELSE ROUND((costed_revenue - total_cogs) / costed_revenue * 100, 2) END AS profit_pct,
    costed_lines,
    total_lines,
    costed_lines = 0 AS no_cost
  FROM grouped
  ORDER BY (COALESCE(costed_revenue, 0) - total_cogs) DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profit_summary(date, date) TO authenticated;

COMMIT;
