-- Set-based canonical tax period resolver. The prior views invoked payment
-- and source-total scans once per period, causing statement timeouts.
BEGIN;
CREATE INDEX IF NOT EXISTS idx_tax_payments_period_status_amount ON public.tax_payments (tax_period_id,status) INCLUDE (amount);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_pph_period_date ON public.finance_expenses (pph_tax_period_id,expense_date) INCLUDE (pph_amount,pph_code_id,approval_status,expense_category,due_date,pib_pph_amount);
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_tax_period_posted ON public.payment_vouchers (tax_period_id,is_posted) INCLUDE (pph_amount,pph_code_id,voucher_date);

CREATE OR REPLACE FUNCTION public.fn_tax_period_payment_status(p_status text,p_total numeric,p_paid numeric,p_due date) RETURNS text LANGUAGE sql STABLE AS $$
SELECT CASE WHEN coalesce(p_paid,0)>coalesce(p_total,0)+.01 THEN 'overpaid' WHEN coalesce(p_total,0)>.01 AND coalesce(p_paid,0)>=coalesce(p_total,0)-.01 THEN 'paid' WHEN coalesce(p_paid,0)>.01 THEN 'partial' ELSE 'open' END;
$$;

CREATE OR REPLACE VIEW public.vw_canonical_tax_period_amounts AS
WITH periods AS MATERIALIZED (SELECT * FROM public.tax_periods),
active_expenses AS MATERIALIZED (
 SELECT fe.id,fe.pph_tax_period_id,fe.expense_date,fe.due_date,fe.pph_amount,fe.pph_code_id,fe.expense_category,fe.pib_pph_amount
 FROM public.finance_expenses fe JOIN public.effective_expense_posting_state eps ON eps.expense_id=fe.id AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
 WHERE fe.approval_status='approved'
), expense_pph AS (
 SELECT p.id tax_period_id,
   coalesce(sum(a.pph_amount) FILTER (WHERE a.expense_category NOT IN ('pib_import','pph_import') AND (p.tax_type='PPh_Unifikasi' OR tc.tax_type=p.tax_type)),0)
   + coalesce(sum(CASE WHEN p.tax_type IN ('PPh22','PPh_Unifikasi') AND a.expense_category IN ('pib_import','pph_import') THEN CASE WHEN a.expense_category='pib_import' THEN coalesce(a.pib_pph_amount,0) ELSE coalesce(a.pph_amount,0) END ELSE 0 END),0) amount
 FROM periods p LEFT JOIN active_expenses a ON a.pph_tax_period_id=p.id OR (a.pph_tax_period_id IS NULL AND coalesce(a.due_date,a.expense_date) BETWEEN p.period_start AND p.period_end)
 LEFT JOIN public.tax_codes tc ON tc.id=a.pph_code_id WHERE p.tax_type<>'PPN' GROUP BY p.id
), voucher_pph AS (
 SELECT p.id tax_period_id,coalesce(sum(pv.pph_amount),0) amount
 FROM periods p LEFT JOIN public.payment_vouchers pv ON pv.tax_period_id=p.id OR (pv.tax_period_id IS NULL AND pv.voucher_date BETWEEN p.period_start AND p.period_end)
 LEFT JOIN public.tax_codes tc ON tc.id=pv.pph_code_id WHERE p.tax_type<>'PPN' AND coalesce(pv.is_posted,false) AND pv.pph_amount>0 AND (p.tax_type='PPh_Unifikasi' OR tc.tax_type=p.tax_type) GROUP BY p.id
), paid AS (
 SELECT p.id tax_period_id,coalesce(sum(t.amount) FILTER (WHERE t.status IN ('posted','reconciled')),0) amount,count(*) FILTER (WHERE t.status='reconciled') reconciled_count,count(*) FILTER (WHERE t.status IN ('draft','posted')) unreconciled_count
 FROM periods p LEFT JOIN public.tax_payments t ON t.tax_period_id=p.id GROUP BY p.id
), missing_faktur AS (SELECT tax_period_id,count(*) amount FROM public.sales_invoices WHERE coalesce(faktur_pajak_number,'')='' AND tax_amount>0 GROUP BY tax_period_id), resolved AS (
 SELECT p.*,
   CASE WHEN coalesce(pay.amount,0)>.01 OR p.status IN ('paid','filed','closed') THEN coalesce(p.pph_total,0)
        ELSE coalesce(e.amount,0)+coalesce(v.amount,0) END source_pph,
   coalesce(pay.amount,0) actual_paid,coalesce(pay.reconciled_count,0) reconciled_count,coalesce(pay.unreconciled_count,0) unreconciled_count,coalesce(m.amount,0) missing_faktur
 FROM periods p LEFT JOIN expense_pph e ON e.tax_period_id=p.id LEFT JOIN voucher_pph v ON v.tax_period_id=p.id LEFT JOIN paid pay ON pay.tax_period_id=p.id LEFT JOIN missing_faktur m ON m.tax_period_id=p.id
)
SELECT id tax_period_id,fiscal_year,period_month,tax_type,status,filing_status,payment_due_date,filing_due_date,input_ppn_total,output_ppn_total,net_ppn,
 (CASE WHEN tax_type='PPN' THEN 0 ELSE source_pph END)::numeric(18,2) pph_total,(CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END)::numeric(18,2) total_tax,actual_paid paid_amount,
 greatest((CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END)-actual_paid,0) outstanding_amount,greatest(actual_paid-(CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END),0) overpaid_amount,
 (CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END)-actual_paid net_position,public.fn_tax_period_payment_status(status,CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END,actual_paid,payment_due_date) payment_status,
 public.fn_period_payment_source(CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END,actual_paid,0) payment_source,reconciled_count reconciled_payments_count,unreconciled_count unreconciled_payments_count,missing_faktur missing_faktur_count
FROM resolved;
ALTER VIEW public.vw_canonical_tax_period_amounts SET (security_invoker=true); GRANT SELECT ON public.vw_canonical_tax_period_amounts TO authenticated;
CREATE OR REPLACE VIEW public.vw_tax_period_status AS SELECT tax_period_id id,fiscal_year,period_month,tax_type,status,filing_status,payment_due_date,filing_due_date,net_ppn,pph_total,reconciled_payments_count,unreconciled_payments_count,missing_faktur_count,paid_amount,outstanding_amount,payment_status,payment_source,net_position,overpaid_amount FROM public.vw_canonical_tax_period_amounts;
ALTER VIEW public.vw_tax_period_status SET (security_invoker=true); GRANT SELECT ON public.vw_tax_period_status TO authenticated;
CREATE OR REPLACE VIEW public.vw_outstanding_tax AS SELECT tax_period_id,fiscal_year,period_month,tax_type,status,payment_due_date,outstanding_amount,paid_amount actual_payment_amount,overpaid_amount FROM public.vw_canonical_tax_period_amounts WHERE outstanding_amount>.01 OR overpaid_amount>.01;
ALTER VIEW public.vw_outstanding_tax SET (security_invoker=true); GRANT SELECT ON public.vw_outstanding_tax TO authenticated;
NOTIFY pgrst,'reload schema'; COMMIT;
