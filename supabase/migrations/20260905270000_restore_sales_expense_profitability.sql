-- Restore report-only sales-expense attribution. No accounting/business data is written.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_line_expenses(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(line_id uuid, sales_expense numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH scoped AS (
  SELECT sii.id AS line_id, dci.challan_id AS dc_id,
         ROUND(sii.quantity * sii.unit_price, 2) AS line_sales,
         sii.quantity
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
), dc_totals AS (
  SELECT dci.challan_id AS dc_id,
         SUM(ROUND(sii.quantity * sii.unit_price, 2)) AS total_sales,
         SUM(sii.quantity) AS total_qty
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  WHERE NOT COALESCE(si.is_draft, false)
    AND dci.challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
  GROUP BY dci.challan_id
), dc_expenses AS (
  SELECT delivery_challan_id AS dc_id, SUM(amount) AS total_expense
  FROM public.finance_expenses
  WHERE expense_category IN ('delivery_sales', 'loading_sales')
    AND approval_status = 'approved'
    AND delivery_challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
  GROUP BY delivery_challan_id
)
SELECT s.line_id,
       COALESCE(CASE
         WHEN d.total_sales > 0 THEN ROUND(e.total_expense * s.line_sales / d.total_sales, 2)
         WHEN d.total_qty > 0 THEN ROUND(e.total_expense * s.quantity / d.total_qty, 2)
         ELSE 0
       END, 0)::numeric AS sales_expense
FROM scoped s
LEFT JOIN dc_totals d ON d.dc_id = s.dc_id
LEFT JOIN dc_expenses e ON e.dc_id = s.dc_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_line_expenses(date,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(p_start_date date, p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH resolved AS (
  SELECT ar.*, si.invoice_date, ROUND(sii.quantity*sii.unit_price,2) AS sales,
         p.product_name, COALESCE(p.product_code,'') AS product_code, COALESCE(p.unit,'kg') AS product_unit,
         COALESCE(le.sales_expense,0) AS sales_expense
  FROM public.get_authoritative_sales_line_cogs(p_start_date,p_end_date) ar
  JOIN public.sales_invoice_items sii ON sii.id=ar.line_id
  JOIN public.sales_invoices si ON si.id=ar.invoice_id
  JOIN public.products p ON p.id=ar.product_id
  LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date,p_end_date) le ON le.line_id=ar.line_id
), unallocated AS (
  SELECT COALESCE(SUM(fe.amount),0) AS amount
  FROM public.finance_expenses fe
  WHERE fe.expense_category IN ('delivery_sales','loading_sales')
    AND fe.approval_status='approved'
    AND fe.expense_date BETWEEN p_start_date AND p_end_date
    AND (fe.delivery_challan_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM resolved r WHERE r.line_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.sales_invoice_items sii2
                   JOIN public.delivery_challan_items dci2 ON dci2.id=sii2.delivery_challan_item_id
                   WHERE sii2.id=r.line_id AND dci2.challan_id=fe.delivery_challan_id)
    ))
), products_report AS (
  SELECT r.product_id,MAX(r.product_name) product_name,MAX(r.product_code) product_code,MAX(r.product_unit) product_unit,
    COALESCE((SELECT SUM(b.current_stock) FROM public.batches b WHERE b.product_id=r.product_id AND b.is_active),0) current_stock,
    SUM(r.quantity) sold_qty,SUM(r.sales) gross_sales,SUM(r.authoritative_cogs) product_cost,SUM(r.sales_expense) sales_expense,
    CASE WHEN COUNT(r.authoritative_cogs)=COUNT(*) THEN SUM(r.sales)-SUM(r.authoritative_cogs) ELSE NULL END gross_profit,
    CASE WHEN COUNT(r.authoritative_cogs)=COUNT(*) THEN SUM(r.sales)-SUM(r.authoritative_cogs)-SUM(r.sales_expense) ELSE NULL END profit_after_sales_expenses,
    COUNT(r.authoritative_cogs) costed_lines,COUNT(*) total_lines,COUNT(r.authoritative_cogs)<COUNT(*) has_unreported_cost
  FROM resolved r GROUP BY r.product_id
), invoice_scope AS (
  SELECT invoice_id,MAX(invoice_date) invoice_date,MAX(posted_invoice_cogs) posted_invoice_cogs,SUM(sales) invoice_sales,SUM(quantity) invoice_qty,SUM(sales_expense) sales_expense
  FROM resolved GROUP BY invoice_id
), company AS (
  SELECT COALESCE(SUM(invoice_sales),0) gross_sales,COALESCE(SUM(posted_invoice_cogs),0) product_cost,
    COALESCE(SUM(sales_expense),0)+(SELECT amount FROM unallocated) sales_expenses,(SELECT amount FROM unallocated) unallocated_sales_expenses,
    COALESCE(SUM(invoice_qty),0) total_qty_sold,COUNT(*) order_count,(SELECT COUNT(DISTINCT product_id) FROM resolved) product_count
  FROM invoice_scope
), unallocated_by_month AS (
  SELECT DATE_TRUNC('month',fe.expense_date)::date month_start,SUM(fe.amount) amount
  FROM public.finance_expenses fe
  WHERE fe.expense_category IN ('delivery_sales','loading_sales') AND fe.approval_status='approved'
    AND fe.expense_date BETWEEN p_start_date AND p_end_date
    AND (fe.delivery_challan_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM resolved r JOIN public.sales_invoice_items sii2 ON sii2.id=r.line_id
      JOIN public.delivery_challan_items dci2 ON dci2.id=sii2.delivery_challan_item_id
      WHERE dci2.challan_id=fe.delivery_challan_id
    )) GROUP BY 1
), monthly_base AS (
  SELECT TO_CHAR(DATE_TRUNC('month',invoice_date),'Mon YYYY') month_label,DATE_TRUNC('month',invoice_date)::date month_start,
    SUM(invoice_sales) gross_sales,COALESCE(SUM(posted_invoice_cogs),0) product_cost,
    SUM(sales_expense) sales_expenses,
    SUM(invoice_qty) total_qty_sold,COUNT(*) order_count
  FROM invoice_scope GROUP BY 1,2
), monthly AS (
  SELECT mb.*, mb.sales_expenses + COALESCE(u.amount,0) AS sales_expenses_total
  FROM monthly_base mb LEFT JOIN unallocated_by_month u USING (month_start)
)
SELECT jsonb_build_object(
 'company',jsonb_build_object('gross_sales',c.gross_sales,'product_cost',c.product_cost,'sales_expenses',c.sales_expenses,'unallocated_sales_expenses',c.unallocated_sales_expenses,
   'gross_profit',c.gross_sales-c.product_cost,'profit_after_sales_expenses',c.gross_sales-c.product_cost-c.sales_expenses,
   'profit_margin_pct',CASE WHEN c.gross_sales=0 THEN NULL ELSE ROUND((c.gross_sales-c.product_cost-c.sales_expenses)/c.gross_sales*100,2) END,
   'total_qty_sold',c.total_qty_sold,'order_count',c.order_count,'product_count',c.product_count),
 'products',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM products_report p),'[]'::jsonb),
 'monthly',COALESCE((SELECT jsonb_agg(jsonb_build_object('month_label',m.month_label,'month_start',m.month_start,'gross_sales',m.gross_sales,'product_cost',m.product_cost,'sales_expenses',m.sales_expenses_total,
   'gross_profit',m.gross_sales-m.product_cost,'profit_after_sales_expenses',m.gross_sales-m.product_cost-m.sales_expenses_total,
   'profit_margin_pct',CASE WHEN m.gross_sales=0 THEN NULL ELSE ROUND((m.gross_sales-m.product_cost-m.sales_expenses_total)/m.gross_sales*100,2) END,'total_qty_sold',m.total_qty_sold,'order_count',m.order_count) ORDER BY m.month_start) FROM monthly m),'[]'::jsonb)
) FROM company c;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_summary(date,date) TO authenticated;

-- Keep drilldowns on the same line-level expense source as the company report.
CREATE OR REPLACE FUNCTION public.get_sales_profitability_batch_orders(p_batch_id uuid,p_start_date date,p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
WITH x AS (
 SELECT ar.*,sii.unit_price,si.invoice_number,si.invoice_date,si.customer_id,COALESCE(c.company_name,'Unknown Customer') customer_name,si.sales_order_id,so.so_number,
   ROUND(ar.quantity*sii.unit_price,2) gross_sales,COALESCE(le.sales_expense,0) line_sales_expense
 FROM public.get_authoritative_sales_line_cogs(p_start_date,p_end_date) ar JOIN public.sales_invoice_items sii ON sii.id=ar.line_id JOIN public.sales_invoices si ON si.id=ar.invoice_id
 LEFT JOIN public.customers c ON c.id=si.customer_id LEFT JOIN public.sales_orders so ON so.id=si.sales_order_id
 LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date,p_end_date) le ON le.line_id=ar.line_id WHERE ar.batch_id=p_batch_id
)
SELECT jsonb_build_object('batch',(SELECT jsonb_build_object('batch_id',b.id,'batch_number',b.batch_number,'product_name',p.product_name,'product_code',COALESCE(p.product_code,''),'product_unit',COALESCE(p.unit,'kg'),'current_stock',b.current_stock) FROM public.batches b JOIN public.products p ON p.id=b.product_id WHERE b.id=p_batch_id),
 'orders',COALESCE((SELECT jsonb_agg(jsonb_build_object('line_id',line_id,'invoice_id',invoice_id,'invoice_number',invoice_number,'invoice_date',invoice_date,'customer_id',customer_id,'customer_name',customer_name,'sales_order_id',sales_order_id,'so_number',so_number,'quantity',quantity,'unit_price',unit_price,'selling_price',unit_price,'gross_sales',gross_sales,'unit_cost',authoritative_unit_cogs,'line_cost',authoritative_cogs,'line_sales_expense',line_sales_expense,'gross_profit',CASE WHEN authoritative_cogs IS NULL THEN NULL ELSE gross_sales-authoritative_cogs END,'profit',CASE WHEN authoritative_cogs IS NULL THEN NULL ELSE gross_sales-authoritative_cogs-line_sales_expense END) ORDER BY invoice_date DESC,invoice_number) FROM x),'[]'::jsonb));
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_batch_orders(uuid,date,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(p_product_id uuid,p_start_date date,p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
WITH x AS (
 SELECT ar.*,sii.unit_price,ROUND(ar.quantity*sii.unit_price,2) gross_sales,b.batch_number,b.current_stock,
   COALESCE(le.sales_expense,0) sales_expense
 FROM public.get_authoritative_sales_line_cogs(p_start_date,p_end_date) ar
 JOIN public.sales_invoice_items sii ON sii.id=ar.line_id
 LEFT JOIN public.batches b ON b.id=ar.batch_id
 LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date,p_end_date) le ON le.line_id=ar.line_id
 WHERE ar.product_id=p_product_id
), batches_report AS (
 SELECT batch_id,COALESCE(batch_number,'Unassigned Batch') batch_number,COALESCE(current_stock,0) current_stock,
   SUM(quantity) sold_qty,SUM(gross_sales) gross_sales,SUM(authoritative_cogs) product_cost,SUM(sales_expense) sales_expense,
   COUNT(authoritative_cogs) costed_lines,COUNT(*) total_lines,
   CASE WHEN COUNT(authoritative_cogs)=0 THEN 'unavailable' WHEN COUNT(authoritative_cogs)<COUNT(*) THEN 'partial' ELSE 'complete' END cost_coverage,
   CASE WHEN COUNT(authoritative_cogs)=COUNT(*) THEN SUM(gross_sales)-SUM(authoritative_cogs) ELSE NULL END gross_profit,
   CASE WHEN COUNT(authoritative_cogs)=COUNT(*) THEN SUM(gross_sales)-SUM(authoritative_cogs)-SUM(sales_expense) ELSE NULL END profit_after_sales_expense
 FROM x GROUP BY batch_id,batch_number,current_stock
), product_report AS (
 SELECT p.id product_id,p.product_name,COALESCE(p.product_code,'') product_code,COALESCE(p.unit,'kg') product_unit,
   COALESCE(SUM(b.sold_qty),0) sold_qty,COALESCE(SUM(b.gross_sales),0) gross_sales,COALESCE(SUM(b.product_cost),0) product_cost,COALESCE(SUM(b.sales_expense),0) sales_expense,
   COALESCE(SUM(b.costed_lines),0) costed_lines,COALESCE(SUM(b.total_lines),0) total_lines,
   CASE WHEN COALESCE(SUM(b.costed_lines),0)=COALESCE(SUM(b.total_lines),0) THEN SUM(b.gross_profit) ELSE NULL END gross_profit,
   CASE WHEN COALESCE(SUM(b.costed_lines),0)=COALESCE(SUM(b.total_lines),0) THEN SUM(b.gross_profit)-SUM(b.sales_expense) ELSE NULL END profit_after_sales_expense
 FROM public.products p LEFT JOIN batches_report b ON true WHERE p.id=p_product_id GROUP BY p.id,p.product_name,p.product_code,p.unit
)
SELECT jsonb_build_object('product',(SELECT to_jsonb(pr) FROM product_report pr),'batches',COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.batch_number) FROM batches_report br),'[]'::jsonb));
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_product_batches(uuid,date,date) TO authenticated;
COMMIT;
