-- ==============================================================================
-- Migration: Return-Aware Customer & Product Profitability
-- ==============================================================================
-- Ensures Customer and Product profitability sections strictly consume the
-- canonical return-aware logic:
--   Net Sales = Gross Sales - Approved Return Revenue
--   Net COGS  = Cost of Goods Sold - Original FIFO Return COGS Reversal
--   Gross Profit = Net Sales - Net COGS
-- ==============================================================================

-- 1. Helper function: calculate FIFO COGS for an individual credit note item
CREATE OR REPLACE FUNCTION public.get_credit_note_item_fifo_cogs(p_cni_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cni record;
  v_cn record;
  v_orig_inv_id uuid;
  v_unit_cogs numeric(18,4);
BEGIN
  SELECT * INTO v_cni FROM public.credit_note_items WHERE id = p_cni_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = v_cni.credit_note_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  -- Resolve original invoice ID: directly on CN, or indirectly via Material Return
  v_orig_inv_id := v_cn.original_invoice_id;
  IF v_orig_inv_id IS NULL AND v_cn.material_return_id IS NOT NULL THEN
    SELECT mr.original_invoice_id INTO v_orig_inv_id
      FROM public.material_returns mr
     WHERE mr.id = v_cn.material_return_id;

    IF v_orig_inv_id IS NULL THEN
      SELECT si.id INTO v_orig_inv_id
        FROM public.material_returns mr
        JOIN public.sales_invoices si ON mr.original_dc_id::text = ANY(si.linked_challan_ids)
       WHERE mr.id = v_cn.material_return_id
       LIMIT 1;
    END IF;
  END IF;

  -- 1. Exact historical FIFO cost from original sales invoice line
  IF v_orig_inv_id IS NOT NULL THEN
    SELECT COALESCE(sii.cogs_unit_cost, CASE WHEN sii.quantity > 0 THEN ROUND(sii.cogs_total_cost / sii.quantity, 4) ELSE NULL END)
      INTO v_unit_cogs
      FROM public.sales_invoice_items sii
     WHERE sii.invoice_id = v_orig_inv_id
       AND (
         (v_cni.batch_id IS NOT NULL AND sii.batch_id = v_cni.batch_id)
         OR (v_cni.batch_id IS NULL AND sii.product_id = v_cni.product_id)
       )
       AND ((sii.cogs_unit_cost IS NOT NULL AND sii.cogs_unit_cost > 0) OR (sii.cogs_total_cost IS NOT NULL AND sii.cogs_total_cost > 0))
     ORDER BY sii.created_at
     LIMIT 1;
  END IF;

  -- 1b. Fallback: Delivery challan / inventory transaction for original FIFO cost
  IF (v_unit_cogs IS NULL OR v_unit_cogs <= 0) AND v_cn.material_return_id IS NOT NULL THEN
    SELECT it.unit_cost INTO v_unit_cogs
      FROM public.material_returns mr
      JOIN public.inventory_transactions it ON it.source_id = mr.original_dc_id
     WHERE mr.id = v_cn.material_return_id
       AND (
         (v_cni.batch_id IS NOT NULL AND it.batch_id = v_cni.batch_id)
         OR (v_cni.batch_id IS NULL AND it.product_id = v_cni.product_id)
       )
       AND it.unit_cost IS NOT NULL AND it.unit_cost > 0
     ORDER BY it.created_at
     LIMIT 1;
  END IF;

  -- 2. Fallback to batch landed cost if original transaction cost not found
  IF v_unit_cogs IS NULL OR v_unit_cogs <= 0 THEN
    SELECT COALESCE(b.landed_cost_per_unit, b.cost_per_unit, 0) INTO v_unit_cogs
      FROM public.batches b
     WHERE b.id = v_cni.batch_id;
  END IF;

  RETURN ROUND(v_cni.quantity * COALESCE(v_unit_cogs, 0), 2);
END;
$$;

-- 2. Return-Aware Customer Sales Report (CUSTOMER PROFITABILITY)
CREATE OR REPLACE FUNCTION public.get_customer_sales_report(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(
  customer_id uuid,
  customer_name text,
  total_orders bigint,
  total_sales numeric,
  avg_order_value numeric,
  last_order_date date,
  total_qty numeric,
  total_cogs numeric,
  total_profit numeric,
  profit_pct numeric,
  costed_lines bigint,
  total_lines bigint,
  cost_coverage numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH lines AS (
    SELECT
      si.id,
      si.customer_id,
      c.company_name,
      si.invoice_date,
      sii.quantity,
      sii.unit_price,
      b.landed_cost_per_unit,
      (b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoices si
    JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
    JOIN public.customers c ON c.id = si.customer_id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ),
  customer_returns AS (
    SELECT 
      cn.customer_id,
      COALESCE(SUM(cn.subtotal), 0) AS return_revenue,
      COALESCE(SUM(cogs_reversal.total_cogs), 0) AS return_cogs,
      COALESCE(SUM(cni_q.qty), 0) AS return_qty
    FROM public.credit_notes cn
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(jel.credit), 0) AS total_cogs
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id AND coa.code = '5100'
      WHERE je.source_module = 'credit_note_cogs'
        AND je.reference_id = cn.id
        AND je.is_posted = true
    ) cogs_reversal ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(cni.quantity), 0) AS qty
      FROM public.credit_note_items cni
      WHERE cni.credit_note_id = cn.id
    ) cni_q ON true
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
    GROUP BY cn.customer_id
  ),
  grouped AS (
    SELECT
      l.customer_id,
      l.company_name,
      COUNT(DISTINCT l.id) AS total_orders,
      SUM(l.quantity * l.unit_price) AS invoice_sales,
      SUM(l.quantity) AS invoice_qty,
      SUM(l.quantity * l.unit_price) FILTER (WHERE l.is_costed) AS costed_revenue,
      COALESCE(SUM(l.quantity * l.landed_cost_per_unit) FILTER (WHERE l.is_costed), 0) AS invoice_cogs,
      MAX(l.invoice_date) AS last_order_date,
      COUNT(*) FILTER (WHERE l.is_costed) AS costed_lines,
      COUNT(*) AS total_lines,
      COALESCE(MAX(cr.return_revenue), 0) AS return_revenue,
      COALESCE(MAX(cr.return_cogs), 0) AS return_cogs,
      COALESCE(MAX(cr.return_qty), 0) AS return_qty
    FROM lines l
    LEFT JOIN customer_returns cr ON cr.customer_id = l.customer_id
    GROUP BY l.customer_id, l.company_name
  )
  SELECT
    g.customer_id,
    g.company_name AS customer_name,
    g.total_orders,
    ROUND(g.invoice_sales - g.return_revenue, 2) AS total_sales,
    ROUND((g.invoice_sales - g.return_revenue) / NULLIF(g.total_orders, 0), 2) AS avg_order_value,
    g.last_order_date,
    g.invoice_qty - g.return_qty AS total_qty,
    ROUND(g.invoice_cogs - g.return_cogs, 2) AS total_cogs,
    ROUND((COALESCE(g.costed_revenue, 0) - g.return_revenue) - (g.invoice_cogs - g.return_cogs), 2) AS total_profit,
    CASE
      WHEN (COALESCE(g.costed_revenue, 0) - g.return_revenue) = 0 THEN NULL
      ELSE ROUND(((COALESCE(g.costed_revenue, 0) - g.return_revenue) - (g.invoice_cogs - g.return_cogs)) / (COALESCE(g.costed_revenue, 0) - g.return_revenue) * 100, 2)
    END AS profit_pct,
    g.costed_lines,
    g.total_lines,
    ROUND(g.costed_lines::numeric / NULLIF(g.total_lines, 0) * 100, 2) AS cost_coverage
  FROM grouped g
  ORDER BY total_sales DESC;
$$;

-- 3. Return-Aware Sales Profitability Summary (PRODUCT & COMPANY PROFITABILITY)
CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
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
  returns AS (
    SELECT 
      COALESCE(SUM(cn.subtotal), 0) AS total_return_revenue,
      COALESCE(SUM(cogs_reversal.total_cogs), 0) AS total_return_cogs
    FROM public.credit_notes cn
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(jel.credit), 0) AS total_cogs
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id AND coa.code = '5100'
      WHERE je.source_module = 'credit_note_cogs'
        AND je.reference_id = cn.id
        AND je.is_posted = true
    ) cogs_reversal ON true
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
  ),
  prod_returns AS (
    SELECT
      cni.product_id,
      COALESCE(SUM(cni.total_price), 0) AS return_revenue,
      COALESCE(SUM(cni.quantity), 0) AS return_qty,
      COALESCE(SUM(public.get_credit_note_item_fifo_cogs(cni.id)), 0) AS return_cogs
    FROM public.credit_notes cn
    JOIN public.credit_note_items cni ON cni.credit_note_id = cn.id
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
    GROUP BY cni.product_id
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
      l.product_id,
      MAX(l.product_name) AS product_name,
      MAX(l.product_code) AS product_code,
      MAX(l.product_unit) AS product_unit,
      COALESCE((SELECT SUM(b.current_stock) FROM public.batches b WHERE b.product_id = l.product_id AND b.is_active), 0) AS current_stock,
      SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0) AS sold_qty,
      SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0) AS gross_sales,
      SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0) AS product_cost,
      SUM(l.line_sales_expense) AS sales_expense,
      ROUND((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) / NULLIF(SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0), 0), 2) AS avg_selling_price,
      ROUND(SUM(l.line_sales_expense) / NULLIF(SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0), 0), 2) AS sales_expense_per_unit,
      ROUND(((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - SUM(l.line_sales_expense)) / NULLIF(SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0), 0), 2) AS net_selling_price_per_unit,
      COALESCE(
        ROUND((SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(pr.return_qty), 0), 0), 2),
        ROUND(SUM(l.quantity * l.batch_unit_cost) / NULLIF(SUM(l.quantity), 0), 2)
      ) AS avg_landed_cost,
      ROUND((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)), 2) AS gross_profit,
      ROUND((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense), 2) AS profit_after_sales_expense,
      ROUND(
        ((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense))
        / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(pr.return_qty), 0), 0),
        2
      ) AS profit_per_unit,
      CASE
        WHEN (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) = 0 THEN NULL
        ELSE ROUND(
          ((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense))
          / (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) * 100,
          2
        )
      END AS profit_margin_pct,
      COUNT(l.authoritative_cogs) AS costed_lines,
      COUNT(*) AS total_lines,
      COUNT(l.authoritative_cogs) < COUNT(*) AS has_unreported_cost
    FROM lines l
    LEFT JOIN prod_returns pr ON pr.product_id = l.product_id
    GROUP BY l.product_id
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
      (SELECT COUNT(DISTINCT product_id) FROM lines) AS product_count,
      (SELECT total_return_revenue FROM returns) AS sales_returns,
      (SELECT total_return_cogs FROM returns) AS return_cogs
    FROM inv
  )
  SELECT jsonb_build_object(
    'company', jsonb_build_object(
      'gross_sales', c.gross_sales,
      'sales_returns', c.sales_returns,
      'net_sales', c.gross_sales - c.sales_returns,
      'product_cost', c.product_cost,
      'return_cogs', c.return_cogs,
      'net_product_cost', c.product_cost - c.return_cogs,
      'sales_expenses', c.sales_expenses,
      'unallocated_sales_expenses', c.unallocated_sales_expenses,
      'gross_profit', (c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs),
      'profit_after_sales_expenses', (c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses,
      'profit_margin_pct', CASE WHEN (c.gross_sales - c.sales_returns) = 0 THEN NULL 
        ELSE ROUND(((c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses) / (c.gross_sales - c.sales_returns) * 100, 2) END,
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
  ) INTO v_result
  FROM company c;

  RETURN v_result;
END;
$$;

-- 4. Return-Aware Product Performance Report (Legacy Tab)
CREATE OR REPLACE FUNCTION public.get_product_performance_report(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(
  product_id uuid,
  product_name text,
  product_code text,
  qty_sold numeric,
  total_sales numeric,
  total_cost numeric,
  total_profit numeric,
  profit_pct numeric,
  costed_lines bigint,
  total_lines bigint,
  cost_coverage numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH lines AS (
    SELECT
      sii.product_id,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      sii.quantity,
      sii.unit_price,
      b.landed_cost_per_unit,
      (b.landed_cost_per_unit > 0) AS is_costed
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    JOIN public.products p ON p.id = sii.product_id
    LEFT JOIN public.batches b ON b.id = sii.batch_id
    WHERE si.invoice_date >= p_start_date AND si.invoice_date <= p_end_date
      AND COALESCE(si.is_draft, false) = false
  ),
  prod_returns AS (
    SELECT
      cni.product_id,
      COALESCE(SUM(cni.total_price), 0) AS return_revenue,
      COALESCE(SUM(cni.quantity), 0) AS return_qty,
      COALESCE(SUM(public.get_credit_note_item_fifo_cogs(cni.id)), 0) AS return_cogs
    FROM public.credit_notes cn
    JOIN public.credit_note_items cni ON cni.credit_note_id = cn.id
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
    GROUP BY cni.product_id
  ),
  grouped AS (
    SELECT
      l.product_id,
      l.product_name,
      l.product_code,
      SUM(l.quantity) AS qty_sold,
      SUM(l.quantity * l.unit_price) AS total_sales,
      COALESCE(SUM(l.quantity * l.landed_cost_per_unit) FILTER (WHERE l.is_costed), 0) AS total_cost,
      SUM(l.quantity * l.unit_price) FILTER (WHERE l.is_costed) AS costed_revenue,
      COUNT(*) FILTER (WHERE l.is_costed) AS costed_lines,
      COUNT(*) AS total_lines,
      COALESCE(MAX(pr.return_revenue), 0) AS return_revenue,
      COALESCE(MAX(pr.return_cogs), 0) AS return_cogs,
      COALESCE(MAX(pr.return_qty), 0) AS return_qty
    FROM lines l
    LEFT JOIN prod_returns pr ON pr.product_id = l.product_id
    GROUP BY l.product_id, l.product_name, l.product_code
  )
  SELECT
    g.product_id,
    g.product_name,
    g.product_code,
    g.qty_sold - g.return_qty AS qty_sold,
    ROUND(g.total_sales - g.return_revenue, 2) AS total_sales,
    ROUND(g.total_cost - g.return_cogs, 2) AS total_cost,
    ROUND((COALESCE(g.costed_revenue, 0) - g.return_revenue) - (g.total_cost - g.return_cogs), 2) AS total_profit,
    CASE
      WHEN (COALESCE(g.costed_revenue, 0) - g.return_revenue) = 0 THEN NULL
      ELSE ROUND(((COALESCE(g.costed_revenue, 0) - g.return_revenue) - (g.total_cost - g.return_cogs)) / (COALESCE(g.costed_revenue, 0) - g.return_revenue) * 100, 2)
    END AS profit_pct,
    g.costed_lines,
    g.total_lines,
    ROUND(g.costed_lines::numeric / NULLIF(g.total_lines, 0) * 100, 2) AS cost_coverage
  FROM grouped g
  ORDER BY total_sales DESC;
$$;

-- 5. Return-Aware Product Batches Breakdown (Drilldown in Canonical Sales Profit Report)
CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(
  p_product_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
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
  batch_returns AS (
    SELECT
      cni.batch_id,
      COALESCE(SUM(cni.total_price), 0) AS return_revenue,
      COALESCE(SUM(cni.quantity), 0) AS return_qty,
      COALESCE(SUM(public.get_credit_note_item_fifo_cogs(cni.id)), 0) AS return_cogs
    FROM public.credit_notes cn
    JOIN public.credit_note_items cni ON cni.credit_note_id = cn.id
    WHERE cn.status = 'approved'
      AND cni.product_id = p_product_id
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
    GROUP BY cni.batch_id
  ),
  b AS (
    SELECT
      l.batch_id,
      COALESCE(l.batch_number, 'Unassigned Batch') AS batch_number,
      COALESCE(l.current_stock, 0) AS current_stock,
      SUM(l.quantity) - COALESCE(MAX(br.return_qty), 0) AS sold_qty,
      SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0) AS gross_sales,
      SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0) AS product_cost,
      SUM(l.sales_expense) AS sales_expense,
      ROUND((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) / NULLIF(SUM(l.quantity) - COALESCE(MAX(br.return_qty), 0), 0), 2) AS avg_selling_price,
      ROUND(SUM(l.sales_expense) / NULLIF(SUM(l.quantity) - COALESCE(MAX(br.return_qty), 0), 0), 2) AS sales_expense_per_unit,
      ROUND(((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - SUM(l.sales_expense)) / NULLIF(SUM(l.quantity) - COALESCE(MAX(br.return_qty), 0), 0), 2) AS net_selling_price_per_unit,
      COALESCE(
        ROUND((SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)) / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(br.return_qty), 0), 0), 2),
        MAX(COALESCE(l.landed_cost_per_unit, l.cost_per_unit))
      ) AS cost_per_unit,
      ROUND((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)), 2) AS gross_profit,
      ROUND((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)) - SUM(l.sales_expense), 2) AS profit_after_sales_expense,
      ROUND(
        ((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)) - SUM(l.sales_expense))
        / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(br.return_qty), 0), 0),
        2
      ) AS profit_per_unit,
      CASE
        WHEN (SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) = 0 THEN NULL
        ELSE ROUND(
          ((SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(br.return_cogs), 0)) - SUM(l.sales_expense))
          / (SUM(l.gross_sales) - COALESCE(MAX(br.return_revenue), 0)) * 100,
          2
        )
      END AS profit_margin_pct,
      COUNT(l.authoritative_cogs) AS costed_lines,
      COUNT(*) AS total_lines,
      CASE
        WHEN COUNT(l.authoritative_cogs) = 0 THEN 'unavailable'
        WHEN COUNT(l.authoritative_cogs) < COUNT(*) THEN 'partial'
        ELSE 'complete'
      END AS cost_coverage,
      BOOL_OR(l.import_price IS NOT NULL OR l.landed_cost_per_unit IS NOT NULL) AS is_imported,
      jsonb_build_object(
        'import_price', MAX(l.import_price),
        'import_price_usd', MAX(l.import_price_usd),
        'exchange_rate', MAX(l.exchange_rate_usd_to_idr),
        'duty_charges', MAX(l.duty_charges),
        'freight_charges', MAX(l.freight_charges),
        'other_charges', MAX(l.other_charges),
        'landed_cost_per_unit', MAX(l.landed_cost_per_unit),
        'local_cost_per_unit', MAX(l.cost_per_unit)
      ) AS cost_breakdown
    FROM l
    LEFT JOIN batch_returns br ON br.batch_id = l.batch_id
    GROUP BY l.batch_id, l.batch_number, l.current_stock
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
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Permissions
GRANT EXECUTE ON FUNCTION public.get_credit_note_item_fifo_cogs(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_sales_report(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_performance_report(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_sales_profitability_product_batches(uuid, date, date) TO authenticated, service_role;
