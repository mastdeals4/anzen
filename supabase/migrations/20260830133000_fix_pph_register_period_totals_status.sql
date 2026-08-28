-- Resolve open PPh register periods from their authoritative source documents.
-- Historical/settled snapshots remain frozen, while "Paid" is derived only
-- from actual posted/reconciled tax_payments.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_pph_authoritative_source_total(p_period_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH period AS (
    SELECT id, fiscal_year, period_month, tax_type, period_start, period_end
      FROM public.tax_periods
     WHERE id = p_period_id
       AND tax_type <> 'PPN'
  )
  SELECT COALESCE((
    SELECT SUM(fe.pph_amount)
      FROM period p
      JOIN public.finance_expenses fe
        ON (fe.pph_tax_period_id = p.id
            OR (fe.pph_tax_period_id IS NULL
                AND COALESCE(fe.due_date, fe.expense_date) BETWEEN p.period_start AND p.period_end))
      JOIN public.effective_expense_posting_state eps
        ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE', 'REPLACED')
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.approval_status = 'approved'
       AND fe.pph_amount > 0
       AND COALESCE(fe.expense_category, '') NOT IN ('pib_import', 'pph_import')
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ), 0)
  + COALESCE((
    SELECT SUM(pv.pph_amount)
      FROM period p
      JOIN public.payment_vouchers pv
        ON (pv.tax_period_id = p.id
            OR (pv.tax_period_id IS NULL AND pv.voucher_date BETWEEN p.period_start AND p.period_end))
      LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
     WHERE COALESCE(pv.is_posted, false)
       AND pv.pph_amount > 0
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ), 0)
  + COALESCE((
    SELECT SUM(CASE WHEN fe.expense_category = 'pib_import'
                    THEN COALESCE(fe.pib_pph_amount, 0)
                    ELSE COALESCE(fe.amount, 0) END)
      FROM period p
      JOIN public.finance_expenses fe
        ON (fe.pph_tax_period_id = p.id
            OR (fe.pph_tax_period_id IS NULL
                AND COALESCE(fe.due_date, fe.expense_date) BETWEEN p.period_start AND p.period_end))
      JOIN public.effective_expense_posting_state eps
        ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE', 'REPLACED')
     WHERE p.tax_type IN ('PPh22', 'PPh_Unifikasi')
       AND fe.approval_status = 'approved'
       AND fe.expense_category IN ('pib_import', 'pph_import')
  ), 0);
$$;

CREATE OR REPLACE FUNCTION public.fn_tax_period_payment_status(
  p_status text,
  p_total numeric,
  p_paid numeric,
  p_due date
) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_status IN ('closed', 'filed') THEN p_status
    WHEN COALESCE(p_total, 0) > 0.01
     AND COALESCE(p_total, 0) - COALESCE(p_paid, 0) <= 0.01 THEN 'paid'
    WHEN COALESCE(p_paid, 0) > 0.01 THEN 'partial'
    WHEN COALESCE(p_total, 0) > 0.01
     AND p_due IS NOT NULL AND p_due < CURRENT_DATE THEN 'overdue'
    ELSE 'open'
  END;
$$;

CREATE OR REPLACE VIEW public.vw_canonical_tax_period_amounts AS
WITH amounts AS (
  SELECT tp.*,
         public.fn_tax_payments_paid(tp.id) AS actual_paid,
         CASE
           -- A remitted or formally completed period is an historical tax
           -- snapshot. Do not rewrite it when later source attribution rules
           -- improve; this preserves July and all filed/closed periods.
           WHEN public.fn_tax_payments_paid(tp.id) > 0.01
             OR tp.status IN ('paid', 'filed', 'closed') THEN tp.pph_total
           ELSE public.fn_pph_authoritative_source_total(tp.id)
         END::numeric(18,2) AS resolved_pph_total
    FROM public.tax_periods tp
)
SELECT id AS tax_period_id,
       fiscal_year,
       period_month,
       tax_type,
       status,
       filing_status,
       payment_due_date,
       filing_due_date,
       input_ppn_total,
       output_ppn_total,
       net_ppn,
       CASE WHEN tax_type = 'PPN' THEN 0::numeric(18,2) ELSE resolved_pph_total END AS pph_total,
       CASE WHEN tax_type = 'PPN' THEN net_ppn ELSE resolved_pph_total END::numeric(18,2) AS total_tax,
       actual_paid AS paid_amount,
       GREATEST((CASE WHEN tax_type = 'PPN' THEN net_ppn ELSE resolved_pph_total END) - actual_paid, 0) AS outstanding_amount,
       GREATEST(actual_paid - (CASE WHEN tax_type = 'PPN' THEN net_ppn ELSE resolved_pph_total END), 0) AS overpaid_amount,
       (CASE WHEN tax_type = 'PPN' THEN net_ppn ELSE resolved_pph_total END) - actual_paid AS net_position,
       public.fn_tax_period_payment_status(
         status,
         CASE WHEN tax_type = 'PPN' THEN net_ppn ELSE resolved_pph_total END,
         actual_paid,
         payment_due_date
       ) AS payment_status,
       public.fn_period_payment_source(
         CASE WHEN tax_type = 'PPN' THEN net_ppn ELSE resolved_pph_total END,
         actual_paid,
         0
       ) AS payment_source
  FROM amounts;

ALTER VIEW public.vw_canonical_tax_period_amounts SET (security_invoker = true);
GRANT SELECT ON public.vw_canonical_tax_period_amounts TO authenticated;

CREATE OR REPLACE VIEW public.vw_pph_by_period_type AS
SELECT tax_period_id,
       fiscal_year,
       period_month,
       tax_type,
       pph_total,
       paid_amount AS pph_paid_total,
       outstanding_amount AS pph_outstanding,
       status,
       payment_due_date,
       filing_due_date,
       payment_status,
       payment_source,
       net_position AS pph_net_position,
       overpaid_amount AS pph_overpaid
  FROM public.vw_canonical_tax_period_amounts
 WHERE tax_type <> 'PPN';

ALTER VIEW public.vw_pph_by_period_type SET (security_invoker = true);
GRANT SELECT ON public.vw_pph_by_period_type TO authenticated;

CREATE OR REPLACE VIEW public.vw_tax_period_status AS
SELECT c.tax_period_id AS id,
       c.fiscal_year,
       c.period_month,
       c.tax_type,
       c.status,
       c.filing_status,
       c.payment_due_date,
       c.filing_due_date,
       c.net_ppn,
       c.pph_total,
       (SELECT count(*) FROM public.tax_payments p
         WHERE p.tax_period_id = c.tax_period_id AND p.status = 'reconciled') AS reconciled_payments_count,
       (SELECT count(*) FROM public.tax_payments p
         WHERE p.tax_period_id = c.tax_period_id AND p.status IN ('draft', 'posted')) AS unreconciled_payments_count,
       (SELECT count(*) FROM public.sales_invoices si
         WHERE si.tax_period_id = c.tax_period_id
           AND COALESCE(si.faktur_pajak_number, '') = '' AND si.tax_amount > 0) AS missing_faktur_count,
       c.paid_amount,
       c.outstanding_amount,
       c.payment_status,
       c.payment_source,
       c.net_position,
       c.overpaid_amount
  FROM public.vw_canonical_tax_period_amounts c;

ALTER VIEW public.vw_tax_period_status SET (security_invoker = true);
GRANT SELECT ON public.vw_tax_period_status TO authenticated;

CREATE OR REPLACE VIEW public.vw_outstanding_tax AS
SELECT tax_period_id,
       fiscal_year,
       period_month,
       tax_type,
       status,
       payment_due_date,
       outstanding_amount,
       paid_amount AS actual_payment_amount,
       overpaid_amount
  FROM public.vw_canonical_tax_period_amounts
 WHERE status NOT IN ('paid', 'closed');

ALTER VIEW public.vw_outstanding_tax SET (security_invoker = true);
GRANT SELECT ON public.vw_outstanding_tax TO authenticated;

CREATE OR REPLACE VIEW public.vw_monthly_tax_summary AS
SELECT to_char(make_date(p.fiscal_year, p.period_month, 1), 'YYYY-MM') AS month,
       p.fiscal_year,
       p.period_month,
       sum(p.input_ppn_total) AS input_ppn,
       sum(p.output_ppn_total) AS output_ppn,
       sum(p.net_ppn) AS net_ppn_payable,
       sum(tp.carry_forward_in) AS carry_forward_in,
       sum(tp.carry_forward_out) AS carry_forward_out,
       COALESCE((
         SELECT sum(pph.pph_total)
           FROM public.vw_canonical_tax_period_amounts pph
          WHERE pph.fiscal_year = p.fiscal_year
            AND pph.period_month = p.period_month
            AND pph.tax_type IN ('PPh21', 'PPh22', 'PPh23', 'PPh4(2)')
       ), 0) AS pph_total
  FROM public.vw_canonical_tax_period_amounts p
  JOIN public.tax_periods tp ON tp.id = p.tax_period_id
 GROUP BY p.fiscal_year, p.period_month
 ORDER BY p.fiscal_year DESC, p.period_month DESC;

ALTER VIEW public.vw_monthly_tax_summary SET (security_invoker = true);
GRANT SELECT ON public.vw_monthly_tax_summary TO authenticated;

GRANT EXECUTE ON FUNCTION public.fn_pph_authoritative_source_total(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tax_period_payment_status(text, numeric, numeric, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
