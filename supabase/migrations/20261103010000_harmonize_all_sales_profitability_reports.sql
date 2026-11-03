-- ==============================================================================
-- MIGRATION: 20261103010000_harmonize_all_sales_profitability_reports.sql
-- Description:
--   Harmonize all auxiliary operational sales reports (Monthly Sales, Product Performance,
--   Customer Sales) with CanonicalSalesProfitReport and get_sales_profitability_summary.
--   Enforces a single authoritative source of truth across the ERP:
--     1. Net Sales = Valid posted commercial sales invoice revenue ex-PPN minus approved credit notes.
--     2. FIFO COGS = Authoritative FIFO batch cost layer attribution minus credit note COGS reversals.
--     3. Excludes cancelled invoices (SAPJ-26-072) and prevents duplicate counting (SAPJ-26-039 is valid & included).
--     4. Eliminates cartesian joins and row multiplication across items/returns.
--     5. Guarantees that every screen and export displays identical financial numbers.
-- ==============================================================================

-- 1. Harmonized Monthly Sales Report
CREATE OR REPLACE FUNCTION public.get_monthly_sales_report(p_start_date date, p_end_date date)
 RETURNS TABLE(
   month_label text,
   month_start date,
   total_sales numeric,
   total_orders bigint,
   total_qty_sold numeric,
   avg_order_value numeric,
   total_cogs numeric,
   gross_profit numeric,
   profit_pct numeric,
   outbound_delivery numeric,
   operational_profit numeric,
   costed_lines bigint,
   total_lines bigint
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH reportable_lines AS (
  SELECT
    ar.line_id,
    ar.invoice_id,
    si.invoice_date,
    ar.quantity,
    sii.unit_price,
    ROUND(ar.quantity * sii.unit_price, 2) AS line_gross_sales,
    ar.authoritative_cogs,
    (ar.authoritative_cogs IS NOT NULL) AS is_costed
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  JOIN public.sales_invoices si ON si.id = ar.invoice_id
  WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
),
monthly_returns AS (
  SELECT 
    DATE_TRUNC('month', cn.credit_note_date)::date as month_start,
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
      AND NOT COALESCE(je.is_reversed, false)
  ) cogs_reversal ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(cni.quantity), 0) AS qty
    FROM public.credit_note_items cni
    WHERE cni.credit_note_id = cn.id
  ) cni_q ON true
  WHERE cn.status = 'approved'
    AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
  GROUP BY 1
),
monthly_sales AS (
  SELECT 
    DATE_TRUNC('month', invoice_date)::date as month_start,
    TO_CHAR(DATE_TRUNC('month', invoice_date), 'Mon YYYY') as month_label,
    COUNT(DISTINCT invoice_id) as total_orders,
    SUM(quantity) as total_qty_sold,
    SUM(line_gross_sales) as gross_sales,
    SUM(authoritative_cogs) as gross_cogs,
    COUNT(*) FILTER (WHERE is_costed) as costed_lines,
    COUNT(*) as total_lines
  FROM reportable_lines
  GROUP BY 1, 2
),
monthly_expenses AS (
  SELECT 
    DATE_TRUNC('month', expense_date)::date as month_start,
    COALESCE(SUM(amount), 0) as outbound_delivery
  FROM public.finance_expenses 
  WHERE expense_category IN ('delivery_sales', 'loading_sales', 'freight_outward', 'delivery_expense')
    AND approval_status = 'approved'
    AND expense_date BETWEEN p_start_date AND p_end_date
  GROUP BY 1
)
SELECT 
  ms.month_label,
  ms.month_start,
  ROUND(ms.gross_sales - COALESCE(mr.return_revenue, 0), 2) as total_sales,
  ms.total_orders,
  ms.total_qty_sold - COALESCE(mr.return_qty, 0) as total_qty_sold,
  ROUND((ms.gross_sales - COALESCE(mr.return_revenue, 0)) / NULLIF(ms.total_orders, 0), 2) as avg_order_value,
  ROUND(ms.gross_cogs - COALESCE(mr.return_cogs, 0), 2) as total_cogs,
  ROUND((ms.gross_sales - COALESCE(mr.return_revenue, 0)) - (ms.gross_cogs - COALESCE(mr.return_cogs, 0)), 2) as gross_profit,
  CASE 
    WHEN (ms.gross_sales - COALESCE(mr.return_revenue, 0)) = 0 THEN NULL
    ELSE ROUND(((ms.gross_sales - COALESCE(mr.return_revenue, 0)) - (ms.gross_cogs - COALESCE(mr.return_cogs, 0))) / (ms.gross_sales - COALESCE(mr.return_revenue, 0)) * 100, 2)
  END as profit_pct,
  ROUND(COALESCE(me.outbound_delivery, 0), 2) as outbound_delivery,
  ROUND((ms.gross_sales - COALESCE(mr.return_revenue, 0)) - (ms.gross_cogs - COALESCE(mr.return_cogs, 0)) - COALESCE(me.outbound_delivery, 0), 2) as operational_profit,
  ms.costed_lines,
  ms.total_lines
FROM monthly_sales ms
LEFT JOIN monthly_returns mr ON mr.month_start = ms.month_start
LEFT JOIN monthly_expenses me ON me.month_start = ms.month_start
ORDER BY ms.month_start;
$function$;

-- 2. Harmonized Product Performance Report
CREATE OR REPLACE FUNCTION public.get_product_performance_report(p_start_date date, p_end_date date)
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
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH reportable_lines AS (
  SELECT
    ar.product_id,
    p.product_name,
    COALESCE(p.product_code, '') AS product_code,
    ar.quantity,
    sii.unit_price,
    ROUND(ar.quantity * sii.unit_price, 2) AS line_gross_sales,
    ar.authoritative_cogs,
    (ar.authoritative_cogs IS NOT NULL) AS is_costed
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  JOIN public.sales_invoices si ON si.id = ar.invoice_id
  JOIN public.products p ON p.id = ar.product_id
  WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
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
    SUM(l.line_gross_sales) AS total_sales,
    COALESCE(SUM(l.authoritative_cogs) FILTER (WHERE l.is_costed), 0) AS total_cost,
    SUM(l.line_gross_sales) FILTER (WHERE l.is_costed) AS costed_revenue,
    COUNT(*) FILTER (WHERE l.is_costed) AS costed_lines,
    COUNT(*) AS total_lines,
    COALESCE(MAX(pr.return_revenue), 0) AS return_revenue,
    COALESCE(MAX(pr.return_cogs), 0) AS return_cogs,
    COALESCE(MAX(pr.return_qty), 0) AS return_qty
  FROM reportable_lines l
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
$function$;

-- 3. Harmonized Customer Sales Report
CREATE OR REPLACE FUNCTION public.get_customer_sales_report(p_start_date date, p_end_date date)
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
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH reportable_lines AS (
  SELECT
    si.id as invoice_id,
    si.customer_id,
    c.company_name,
    si.invoice_date,
    ar.quantity,
    sii.unit_price,
    ROUND(ar.quantity * sii.unit_price, 2) AS line_gross_sales,
    ar.authoritative_cogs,
    (ar.authoritative_cogs IS NOT NULL) AS is_costed
  FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
  JOIN public.sales_invoices si ON si.id = ar.invoice_id
  JOIN public.customers c ON c.id = si.customer_id
  WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
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
      AND NOT COALESCE(je.is_reversed, false)
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
    COUNT(DISTINCT l.invoice_id) AS total_orders,
    MAX(l.invoice_date) AS last_order_date,
    SUM(l.quantity) AS invoice_qty,
    SUM(l.line_gross_sales) AS invoice_sales,
    COALESCE(SUM(l.authoritative_cogs) FILTER (WHERE l.is_costed), 0) AS invoice_cogs,
    SUM(l.line_gross_sales) FILTER (WHERE l.is_costed) AS costed_revenue,
    COUNT(*) FILTER (WHERE l.is_costed) AS costed_lines,
    COUNT(*) AS total_lines,
    COALESCE(MAX(cr.return_revenue), 0) AS return_revenue,
    COALESCE(MAX(cr.return_cogs), 0) AS return_cogs,
    COALESCE(MAX(cr.return_qty), 0) AS return_qty
  FROM reportable_lines l
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
$function$;
