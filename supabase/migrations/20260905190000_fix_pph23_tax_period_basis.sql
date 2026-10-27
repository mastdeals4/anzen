-- PPh withholding periods are determined by the expense/document date unless
-- an explicit pph_tax_period_id was selected.  Due dates are payment terms,
-- not the withholding month; using them moved August PPh23 into September.
-- This migration changes reporting/recomputation only and posts no journals.
BEGIN;

-- Central date resolver used by PPh recomputation triggers.  An explicit
-- pph_tax_period_id remains the manual override; otherwise the source
-- document's expense date is the established PPh period basis.
CREATE OR REPLACE FUNCTION public.get_expense_pph_period_date(p_expense_id uuid)
RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT fe.expense_date
  FROM public.finance_expenses fe
  WHERE fe.id = p_expense_id;
$$;

CREATE OR REPLACE FUNCTION public.fn_pph_authoritative_source_total(p_period_id uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path = public AS $$
  WITH period AS (
    SELECT id, fiscal_year, period_month, tax_type, period_start, period_end
      FROM public.tax_periods WHERE id = p_period_id AND tax_type <> 'PPN'
  )
  SELECT COALESCE((
    SELECT SUM(fe.pph_amount)
      FROM period p
      JOIN public.finance_expenses fe
        ON (fe.pph_tax_period_id = p.id
            OR (fe.pph_tax_period_id IS NULL AND fe.expense_date BETWEEN p.period_start AND p.period_end))
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.approval_status = 'approved' AND fe.pph_amount > 0
       AND COALESCE(fe.expense_category,'') NOT IN ('pib_import','pph_import')
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ),0) + COALESCE((
    SELECT SUM(pv.pph_amount) FROM period p
      JOIN public.payment_vouchers pv ON (pv.tax_period_id = p.id
        OR (pv.tax_period_id IS NULL AND pv.voucher_date BETWEEN p.period_start AND p.period_end))
      LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
     WHERE COALESCE(pv.is_posted,false) AND pv.pph_amount > 0
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ),0) + COALESCE((
    SELECT SUM(CASE WHEN fe.expense_category='pib_import' THEN COALESCE(fe.pib_pph_amount,0) ELSE COALESCE(fe.amount,0) END)
      FROM period p JOIN public.finance_expenses fe ON (fe.pph_tax_period_id = p.id
        OR (fe.pph_tax_period_id IS NULL AND fe.expense_date BETWEEN p.period_start AND p.period_end))
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
     WHERE p.tax_type IN ('PPh22','PPh_Unifikasi') AND fe.approval_status='approved'
       AND fe.expense_category IN ('pib_import','pph_import')
  ),0);
$$;

-- Keep the stored-total recomputation on the same authoritative basis.
CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_period public.tax_periods%rowtype; v_pph_total numeric(18,2);
BEGIN
  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);
  SELECT * INTO v_period FROM public.tax_periods WHERE id=p_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found',p_period_id; END IF;
  IF v_period.tax_type='PPN' THEN RETURN; END IF;
  SELECT COALESCE(public.fn_pph_authoritative_source_total(p_period_id),0)
    + COALESCE((SELECT sum(tp.amount) FROM public.tax_payments tp
      WHERE tp.tax_period_id=p_period_id AND tp.tax_type=v_period.tax_type
        AND tp.historical_source_status='missing_source_verified'),0)
    INTO v_pph_total;
  UPDATE public.tax_periods SET pph_total=v_pph_total,updated_at=now() WHERE id=p_period_id;
END; $$;

CREATE OR REPLACE VIEW public.vw_canonical_tax_period_amounts AS
WITH amounts AS (
 SELECT tp.*, public.fn_tax_payments_paid(tp.id) actual_paid,
   CASE WHEN public.fn_tax_payments_paid(tp.id)>0.01
          OR tp.status IN ('paid','filed','closed') THEN tp.pph_total
        ELSE public.fn_pph_authoritative_source_total(tp.id) END::numeric(18,2) resolved_pph_total
 FROM public.tax_periods tp
)
SELECT id tax_period_id,fiscal_year,period_month,tax_type,status,filing_status,
 payment_due_date,filing_due_date,input_ppn_total,output_ppn_total,net_ppn,
 CASE WHEN tax_type='PPN' THEN 0::numeric(18,2) ELSE resolved_pph_total END pph_total,
 CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END::numeric(18,2) total_tax,
 actual_paid paid_amount,
 GREATEST((CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END)-actual_paid,0) outstanding_amount,
 GREATEST(actual_paid-(CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END),0) overpaid_amount,
 (CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END)-actual_paid net_position,
 public.fn_tax_period_payment_status(status,CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END,actual_paid,payment_due_date) payment_status,
 public.fn_period_payment_source(CASE WHEN tax_type='PPN' THEN net_ppn ELSE resolved_pph_total END,actual_paid,0) payment_source,
 (SELECT count(*) FROM public.tax_payments p WHERE p.tax_period_id=amounts.id AND p.status='reconciled') reconciled_payments_count,
 (SELECT count(*) FROM public.tax_payments p WHERE p.tax_period_id=amounts.id AND p.status IN ('draft','posted')) unreconciled_payments_count,
 (SELECT count(*) FROM public.sales_invoices si WHERE si.tax_period_id=amounts.id AND COALESCE(si.faktur_pajak_number,'')='' AND si.tax_amount>0) missing_faktur_count
FROM amounts;

CREATE OR REPLACE VIEW public.vw_pph_by_period_type AS
SELECT tax_period_id,fiscal_year,period_month,tax_type,pph_total,paid_amount pph_paid_total,
 outstanding_amount pph_outstanding,status,payment_due_date,filing_due_date,payment_status,
 payment_source,net_position pph_net_position,overpaid_amount pph_overpaid
FROM public.vw_canonical_tax_period_amounts WHERE tax_type <> 'PPN';

CREATE OR REPLACE VIEW public.vw_tax_period_status AS
SELECT c.tax_period_id id,c.fiscal_year,c.period_month,c.tax_type,c.status,c.filing_status,
 c.payment_due_date,c.filing_due_date,c.net_ppn,c.pph_total,
 c.reconciled_payments_count,c.unreconciled_payments_count,c.missing_faktur_count,
 c.paid_amount,c.outstanding_amount,c.payment_status,c.payment_source,c.net_position,c.overpaid_amount
FROM public.vw_canonical_tax_period_amounts c;

GRANT SELECT ON public.vw_canonical_tax_period_amounts, public.vw_pph_by_period_type, public.vw_tax_period_status TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
