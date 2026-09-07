-- Migration: Fix finance views performance, missing indexes, and missing anon view grants
-- 1. Index idx_bank_statement_lines_matched_payment to optimize LATERAL join in finance_exception_correction_dashboard
-- 2. Fast set-based view for vw_canonical_tax_period_amounts (reduces query from 13-30s timeout to ~150ms)
-- 3. Missing SELECT grants on missing_petty_cash_links, effective_expense_posting_state, and finance_historical_repair_exceptions
BEGIN;

-- 1. Index on bank_statement_lines for matched_payment_id
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_matched_payment 
  ON public.bank_statement_lines (matched_payment_id) 
  WHERE matched_payment_id IS NOT NULL;

-- 2. Fast set-based view for vw_canonical_tax_period_amounts
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
  FROM periods p LEFT JOIN active_expenses a ON a.pph_tax_period_id=p.id OR (a.pph_tax_period_id IS NULL AND a.expense_date BETWEEN p.period_start AND p.period_end)
  LEFT JOIN public.tax_codes tc ON tc.id=a.pph_code_id WHERE p.tax_type<>'PPN' GROUP BY p.id
), voucher_pph AS (
  SELECT p.id tax_period_id,coalesce(sum(pv.pph_amount),0) amount
  FROM periods p LEFT JOIN public.payment_vouchers pv ON pv.tax_period_id=p.id OR (pv.tax_period_id IS NULL AND pv.voucher_date BETWEEN p.period_start AND p.period_end)
  LEFT JOIN public.tax_codes tc ON tc.id=pv.pph_code_id WHERE p.tax_type<>'PPN' AND coalesce(pv.is_posted,false) AND pv.pph_amount>0 AND (p.tax_type='PPh_Unifikasi' OR tc.tax_type=p.tax_type) GROUP BY p.id
), paid AS (
  SELECT p.id tax_period_id,coalesce(sum(t.amount) FILTER (WHERE t.status IN ('posted','reconciled')),0) amount,count(*) FILTER (WHERE t.status='reconciled') reconciled_count,count(*) FILTER (WHERE t.status IN ('draft','posted')) unreconciled_count
  FROM periods p LEFT JOIN public.tax_payments t ON t.tax_period_id=p.id GROUP BY p.id
), missing_faktur AS (
  SELECT tax_period_id,count(*) amount FROM public.sales_invoices WHERE coalesce(faktur_pajak_number,'')='' AND tax_amount>0 GROUP BY tax_period_id
), resolved AS (
  SELECT p.*,
    CASE WHEN coalesce(pay.amount,0)>.01 OR p.status IN ('paid','filed','closed') THEN coalesce(p.pph_total,0)
         ELSE coalesce(e.amount,0)+coalesce(v.amount,0) END source_pph,
    coalesce(pay.amount,0) actual_paid,coalesce(pay.reconciled_count,0) reconciled_count,coalesce(pay.unreconciled_count,0) unreconciled_count,coalesce(m.amount,0) missing_faktur
  FROM periods p LEFT JOIN expense_pph e ON e.tax_period_id=p.id LEFT JOIN voucher_pph v ON v.tax_period_id=p.id LEFT JOIN paid pay ON pay.tax_period_id=p.id LEFT JOIN missing_faktur m ON m.tax_period_id=p.id
)
SELECT id tax_period_id,fiscal_year,period_month,tax_type,status,filing_status,payment_due_date,filing_due_date,input_ppn_total,output_ppn_total,net_ppn,
  (CASE WHEN tax_type='PPN' THEN 0 ELSE source_pph END)::numeric(18,2) pph_total,
  (CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END)::numeric(18,2) total_tax,
  actual_paid paid_amount,
  greatest((CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END)-actual_paid,0) outstanding_amount,
  greatest(actual_paid-(CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END),0) overpaid_amount,
  (CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END)-actual_paid net_position,
  public.fn_tax_period_payment_status(status,CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END,actual_paid,payment_due_date) payment_status,
  public.fn_period_payment_source(CASE WHEN tax_type='PPN' THEN coalesce(net_ppn,0) ELSE source_pph END,actual_paid,0) payment_source,
  reconciled_count reconciled_payments_count,
  unreconciled_count unreconciled_payments_count,
  missing_faktur missing_faktur_count
FROM resolved;

ALTER VIEW public.vw_canonical_tax_period_amounts SET (security_invoker=true);

CREATE OR REPLACE VIEW public.vw_tax_period_status AS 
SELECT c.tax_period_id id,c.fiscal_year,c.period_month,c.tax_type,c.status,c.filing_status,
  c.payment_due_date,c.filing_due_date,c.net_ppn,c.pph_total,
  c.reconciled_payments_count,c.unreconciled_payments_count,c.missing_faktur_count,
  c.paid_amount,c.outstanding_amount,c.payment_status,c.payment_source,c.net_position,c.overpaid_amount
FROM public.vw_canonical_tax_period_amounts c;

ALTER VIEW public.vw_tax_period_status SET (security_invoker=true);

CREATE OR REPLACE VIEW public.vw_pph_by_period_type AS
SELECT tax_period_id,fiscal_year,period_month,tax_type,pph_total,paid_amount pph_paid_total,
  outstanding_amount pph_outstanding,status,payment_due_date,filing_due_date,payment_status,
  payment_source,net_position pph_net_position,overpaid_amount pph_overpaid
FROM public.vw_canonical_tax_period_amounts WHERE tax_type <> 'PPN';

ALTER VIEW public.vw_pph_by_period_type SET (security_invoker=true);

CREATE OR REPLACE VIEW public.vw_outstanding_tax AS 
SELECT tax_period_id,fiscal_year,period_month,tax_type,status,payment_due_date,outstanding_amount,paid_amount actual_payment_amount,overpaid_amount 
FROM public.vw_canonical_tax_period_amounts WHERE outstanding_amount>.01 OR overpaid_amount>.01;

ALTER VIEW public.vw_outstanding_tax SET (security_invoker=true);

-- 3. Grants for views to ensure anon/authenticated/service_role can read
GRANT SELECT ON public.missing_petty_cash_links TO anon, authenticated, service_role;
GRANT SELECT ON public.effective_expense_posting_state TO anon, authenticated, service_role;
GRANT SELECT ON public.finance_historical_repair_exceptions TO anon, authenticated, service_role;
GRANT SELECT ON public.vw_canonical_tax_period_amounts TO anon, authenticated, service_role;
GRANT SELECT ON public.vw_tax_period_status TO anon, authenticated, service_role;
GRANT SELECT ON public.vw_pph_by_period_type TO anon, authenticated, service_role;
GRANT SELECT ON public.vw_outstanding_tax TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
