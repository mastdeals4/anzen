-- Use posted sales COGS journals and forward line snapshots for profitability.
-- This changes reporting only; no accounting or historical data is written.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_monthly_sales_report(p_start_date date, p_end_date date)
RETURNS TABLE(month_label text, month_start date, total_sales numeric, total_orders bigint,
  total_qty_sold numeric, avg_order_value numeric, total_cogs numeric, gross_profit numeric,
  profit_pct numeric, outbound_delivery numeric, operational_profit numeric, costed_lines bigint, total_lines bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH inv AS (
 SELECT si.id,si.invoice_date,si.invoice_number,
   sum(sii.quantity*sii.unit_price) sales,sum(sii.quantity) qty,count(*) lines,
   coalesce(sum(sii.cogs_total_cost),0) snap_cost,
   coalesce((SELECT sum(jel.debit-jel.credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id=jel.account_id
      JOIN journal_entries je ON je.id=jel.journal_entry_id WHERE je.source_module='sales_invoice_cogs' AND je.reference_id=si.id
      AND je.is_posted AND NOT coalesce(je.is_reversed,false) AND coa.code='5100'),0) je_cost,
   count(*) FILTER (WHERE sii.cogs_total_cost IS NOT NULL) costed
 FROM sales_invoices si JOIN sales_invoice_items sii ON sii.invoice_id=si.id
 WHERE si.invoice_date BETWEEN p_start_date AND p_end_date AND NOT coalesce(si.is_draft,false)
 GROUP BY si.id,si.invoice_date,si.invoice_number
), lines AS (
 SELECT *,CASE WHEN costed=lines AND costed>0 THEN snap_cost WHEN lines=1 AND je_cost>0 THEN je_cost ELSE NULL END authoritative_cost
 FROM inv
), monthly AS (
 SELECT date_trunc('month',invoice_date)::date month_start,to_char(date_trunc('month',invoice_date),'Mon YYYY') month_label,
   sum(sales) total_sales,count(*) total_orders,sum(qty) total_qty_sold,sum(je_cost) total_cogs,
   sum(authoritative_cost) FILTER (WHERE authoritative_cost IS NOT NULL) costed_cogs
 FROM lines GROUP BY 1,2
), expenses AS (
 SELECT date_trunc('month',expense_date)::date month_start,coalesce(sum(amount),0) outbound_delivery
 FROM finance_expenses WHERE expense_category IN ('delivery_sales','loading_sales') AND approval_status='approved'
   AND expense_date BETWEEN p_start_date AND p_end_date GROUP BY 1
)
SELECT m.month_label,m.month_start,round(m.total_sales,2),m.total_orders,m.total_qty_sold,
 round(m.total_sales/nullif(m.total_orders,0),2),round(coalesce(m.total_cogs,0),2),
 round(coalesce(m.total_sales,0)-coalesce(m.total_cogs,0),2),
 CASE WHEN m.total_sales=0 THEN NULL ELSE round((m.total_sales-coalesce(m.total_cogs,0))/m.total_sales*100,2) END,
 round(coalesce(e.outbound_delivery,0),2),round(m.total_sales-coalesce(m.total_cogs,0)-coalesce(e.outbound_delivery,0),2),
 (SELECT coalesce(sum(costed),0) FROM lines x WHERE date_trunc('month',x.invoice_date)::date=m.month_start),
 (SELECT coalesce(sum(lines),0) FROM lines x WHERE date_trunc('month',x.invoice_date)::date=m.month_start)
FROM monthly m LEFT JOIN expenses e USING(month_start) ORDER BY m.month_start;
$$;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(p_start_date date,p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH inv AS (
 SELECT si.id,si.invoice_date,sii.product_id,sii.batch_id,sii.quantity,sii.unit_price,
   round(sii.quantity*sii.unit_price,2) sales,sii.cogs_total_cost,sii.cogs_unit_cost,
   (SELECT sum(jel.debit-jel.credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id=jel.account_id JOIN journal_entries je ON je.id=jel.journal_entry_id
    WHERE je.source_module='sales_invoice_cogs' AND je.reference_id=si.id AND je.is_posted AND NOT coalesce(je.is_reversed,false) AND coa.code='5100') je_cost
 FROM sales_invoices si JOIN sales_invoice_items sii ON sii.invoice_id=si.id
 WHERE si.invoice_date BETWEEN p_start_date AND p_end_date AND NOT coalesce(si.is_draft,false)
), invoice_cost AS (
 SELECT id,coalesce(max(je_cost),0) je_cost,count(*) lines,count(*) FILTER(WHERE cogs_total_cost IS NOT NULL) costed,
   coalesce(sum(cogs_total_cost),0) snap_cost,max(invoice_date) invoice_date,sum(sales) sales,sum(quantity) quantity
 FROM inv GROUP BY id
), resolved AS (
 SELECT i.*,CASE WHEN c.costed=c.lines AND c.costed>0 THEN i.cogs_total_cost WHEN c.lines=1 AND c.je_cost>0 THEN c.je_cost ELSE NULL END line_cost,
   c.je_cost invoice_cogs FROM inv i JOIN invoice_cost c ON c.id=i.id
), products AS (
 SELECT p.id product_id,p.product_name,coalesce(p.product_code,'') product_code,coalesce(p.unit,'kg') product_unit,
   coalesce((SELECT sum(current_stock) FROM batches b0 WHERE b0.product_id=p.id AND b0.is_active),0) current_stock,
   sum(r.quantity) sold_qty,sum(r.sales) gross_sales,sum(r.line_cost) product_cost,
   count(*) FILTER(WHERE r.line_cost IS NOT NULL) costed_lines,count(*) total_lines
 FROM products p JOIN resolved r ON r.product_id=p.id GROUP BY p.id,p.product_name,p.product_code,p.unit
), company AS (
 SELECT coalesce(sum(c.sales),0) gross_sales,coalesce(sum(c.je_cost),0) product_cost,
   coalesce(sum(c.quantity),0) total_qty_sold,count(*) order_count,(SELECT count(distinct product_id) FROM resolved) product_count
 FROM invoice_cost c
), monthly AS (
 SELECT to_char(date_trunc('month',invoice_date),'Mon YYYY') month_label,date_trunc('month',invoice_date)::date month_start,
   sum(sales) gross_sales,sum(je_cost) product_cost,sum(quantity) total_qty_sold,count(*) order_count
 FROM invoice_cost GROUP BY 1,2
)
SELECT jsonb_build_object(
 'company',jsonb_build_object('gross_sales',c.gross_sales,'product_cost',c.product_cost,'sales_expenses',0,'unallocated_sales_expenses',0,
   'gross_profit',c.gross_sales-c.product_cost,'profit_after_sales_expenses',c.gross_sales-c.product_cost,
   'profit_margin_pct',case when c.gross_sales=0 then null else round((c.gross_sales-c.product_cost)/c.gross_sales*100,2) end,
   'total_qty_sold',c.total_qty_sold,'order_count',c.order_count,'product_count',c.product_count),
 'products',coalesce((select jsonb_agg(to_jsonb(p)) from products p),'[]'::jsonb),
 'monthly',coalesce((select jsonb_agg(jsonb_build_object('month_label',m.month_label,'month_start',m.month_start,'gross_sales',m.gross_sales,'product_cost',m.product_cost,'sales_expenses',0,'gross_profit',m.gross_sales-m.product_cost,'profit_after_sales_expenses',m.gross_sales-m.product_cost,'profit_margin_pct',case when m.gross_sales=0 then null else round((m.gross_sales-m.product_cost)/m.gross_sales*100,2) end,'total_qty_sold',m.total_qty_sold,'order_count',m.order_count) order by m.month_start) from monthly m),'[]'::jsonb))
FROM company c;
$$;

-- Drill-down functions retain their established response shape but source line
-- costs exclusively from snapshots, with the documented single-line fallback.
CREATE OR REPLACE FUNCTION public.get_sales_profitability_batch_orders(p_batch_id uuid,p_start_date date,p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH x AS (
 SELECT sii.id line_id,si.id invoice_id,si.invoice_number,si.invoice_date,si.customer_id,coalesce(c.company_name,'Unknown Customer') customer_name,
   si.sales_order_id,so.so_number,sii.quantity,sii.unit_price,round(sii.quantity*sii.unit_price,2) line_gross_sales,sii.cogs_unit_cost,
   CASE WHEN sii.cogs_total_cost IS NOT NULL THEN sii.cogs_total_cost WHEN (SELECT count(*) FROM sales_invoice_items z WHERE z.invoice_id=si.id)=1 THEN
      (SELECT sum(jel.debit-jel.credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id=jel.account_id JOIN journal_entries je ON je.id=jel.journal_entry_id WHERE je.source_module='sales_invoice_cogs' AND je.reference_id=si.id AND je.is_posted AND NOT coalesce(je.is_reversed,false) AND coa.code='5100') ELSE NULL END line_cost
 FROM sales_invoice_items sii JOIN sales_invoices si ON si.id=sii.invoice_id LEFT JOIN customers c ON c.id=si.customer_id LEFT JOIN sales_orders so ON so.id=si.sales_order_id
 WHERE sii.batch_id=p_batch_id AND si.invoice_date BETWEEN p_start_date AND p_end_date AND NOT coalesce(si.is_draft,false)
)
SELECT jsonb_build_object('batch',(SELECT to_jsonb(b) FROM (SELECT b.id batch_id,b.batch_number,p.product_name,b.current_stock FROM batches b JOIN products p ON p.id=b.product_id WHERE b.id=p_batch_id) b),
 'orders',coalesce((SELECT jsonb_agg(jsonb_build_object('line_id',line_id,'invoice_id',invoice_id,'invoice_number',invoice_number,'invoice_date',invoice_date,'customer_id',customer_id,'customer_name',customer_name,'sales_order_id',sales_order_id,'so_number',so_number,'quantity',quantity,'unit_price',unit_price,'selling_price',unit_price,'gross_sales',line_gross_sales,'unit_cost',cogs_unit_cost,'line_cost',line_cost,'gross_profit',case when line_cost is null then null else line_gross_sales-line_cost end) order by invoice_date desc) FROM x),'[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(p_product_id uuid,p_start_date date,p_end_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH x0 AS (SELECT sii.batch_id,sii.quantity,round(sii.quantity*sii.unit_price,2) sales,sii.cogs_total_cost,sii.cogs_unit_cost,si.id invoice_id,
 (SELECT count(*) FROM sales_invoice_items z WHERE z.invoice_id=si.id) invoice_lines,
 (SELECT sum(jel.debit-jel.credit) FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id=jel.account_id JOIN journal_entries je ON je.id=jel.journal_entry_id
  WHERE je.source_module='sales_invoice_cogs' AND je.reference_id=si.id AND je.is_posted AND NOT coalesce(je.is_reversed,false) AND coa.code='5100') je_cost
 FROM sales_invoice_items sii JOIN sales_invoices si ON si.id=sii.invoice_id WHERE sii.product_id=p_product_id AND si.invoice_date BETWEEN p_start_date AND p_end_date AND NOT coalesce(si.is_draft,false)),
 x AS (SELECT *,CASE WHEN cogs_total_cost IS NOT NULL THEN cogs_total_cost WHEN invoice_lines=1 AND je_cost IS NOT NULL THEN je_cost ELSE NULL END line_cost FROM x0),
 s AS (SELECT batch_id,sum(quantity) sold_qty,sum(sales) gross_sales,sum(line_cost) product_cost,count(*) total_lines,count(*) FILTER(WHERE line_cost IS NOT NULL) costed_lines,
   CASE WHEN count(*) FILTER(WHERE line_cost IS NOT NULL)=count(*) THEN sum(sales)-sum(line_cost) ELSE NULL END gross_profit,
   CASE WHEN count(*) FILTER(WHERE line_cost IS NOT NULL)=count(*) AND sum(sales)<>0 THEN round((sum(sales)-sum(line_cost))/sum(sales)*100,2) ELSE NULL END profit_margin_pct,
   CASE WHEN count(*) FILTER(WHERE line_cost IS NOT NULL)=0 THEN 'unavailable' WHEN count(*) FILTER(WHERE line_cost IS NOT NULL)<count(*) THEN 'partial' ELSE 'complete' END cost_coverage
 FROM x GROUP BY batch_id)
SELECT jsonb_build_object('product',(SELECT jsonb_build_object('product_id',p.id,'product_name',p.product_name,'product_code',coalesce(p.product_code,''),'product_unit',coalesce(p.unit,'kg'),'sold_qty',coalesce(sum(s.sold_qty),0),'gross_sales',coalesce(sum(s.gross_sales),0),'product_cost',coalesce(sum(s.product_cost),0),'costed_lines',coalesce(sum(s.costed_lines),0),'total_lines',coalesce(sum(s.total_lines),0)) FROM products p LEFT JOIN s ON true WHERE p.id=p_product_id GROUP BY p.id,p.product_name,p.product_code,p.unit),'batches',coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM s),'[]'::jsonb));
$$;

COMMIT;
