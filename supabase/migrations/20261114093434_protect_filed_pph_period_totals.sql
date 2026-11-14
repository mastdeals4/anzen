-- ============================================================================
-- Migration: 20261114140000_protect_filed_pph_period_totals.sql
-- Description:
--   Guarantees permanent immutability of filed PPh tax periods:
--   1. Filed tax periods (filing_status = 'filed', status IN ('filed', 'closed'),
--      or filed_at IS NOT NULL) serve immutable pph_total snapshots as submitted
--      to the tax authorities.
--   2. Background triggers, manual recomputations, and batch jobs are blocked
--      from mutating pph_total on filed periods (skip with NOTICE).
--   3. canonical views (vw_canonical_tax_period_amounts, vw_pph_by_period_type,
--      vw_tax_period_status) strictly preserve the filed return totals.
--   4. PPN computations remain 100% untouched and functional.
-- ============================================================================

BEGIN;

-- 1. Guard compute_period_ppn: never mutate pph_total on filed/closed periods
CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.tax_periods%rowtype;
  v_pph_total numeric(18,2);
BEGIN
  -- Run pre-posted register calculation for PPN (always safe)
  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);

  SELECT * INTO v_period FROM public.tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  -- PPN periods do not track pph_total; exit early
  IF v_period.tax_type = 'PPN' THEN
    RETURN;
  END IF;

  -- STATUTORY SAFEGUARD: Filed or closed periods represent official submissions
  -- to the government and MUST NEVER be recalculated or overwritten.
  IF v_period.filing_status = 'filed'
     OR v_period.status IN ('filed', 'closed')
     OR v_period.filed_at IS NOT NULL THEN
    RAISE NOTICE 'Skipping pph_total recalculation on filed/closed tax period % (type: %, status: %, filing_status: %)',
      p_period_id, v_period.tax_type, v_period.status, v_period.filing_status;
    RETURN;
  END IF;

  -- Recompute pph_total for open/draft periods only
  SELECT COALESCE(public.fn_pph_authoritative_source_total(p_period_id), 0)
    + COALESCE((
      SELECT sum(tp.amount)
        FROM public.tax_payments tp
       WHERE tp.tax_period_id = p_period_id
         AND tp.tax_type = v_period.tax_type
         AND tp.historical_source_status = 'missing_source_verified'
    ), 0)
    INTO v_pph_total;

  UPDATE public.tax_periods
     SET pph_total = v_pph_total,
         updated_at = now()
   WHERE id = p_period_id;
END;
$$;

-- 2. Guard recompute_pph_periods_for_date: skip filed periods
CREATE OR REPLACE FUNCTION public.recompute_pph_periods_for_date(p_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_tax_type text;
  v_period_id uuid;
  v_is_filed boolean;
BEGIN
  IF p_date IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_tax_type IN ARRAY ARRAY['PPh21', 'PPh22', 'PPh23', 'PPh4(2)']::text[]
  LOOP
    SELECT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL), id
      INTO v_is_filed, v_period_id
      FROM public.tax_periods
     WHERE fiscal_year = EXTRACT(YEAR FROM p_date)::int
       AND period_month = EXTRACT(MONTH FROM p_date)::int
       AND tax_type = v_tax_type;

    IF v_is_filed IS TRUE THEN
      RAISE NOTICE 'Skipping recompute_pph_periods_for_date on protected % period for %', v_tax_type, p_date;
      CONTINUE;
    END IF;

    v_period_id := public.upsert_tax_period(
      EXTRACT(YEAR FROM p_date)::int,
      EXTRACT(MONTH FROM p_date)::int,
      v_tax_type
    );
    PERFORM public.compute_period_ppn(v_period_id);
  END LOOP;

  -- Legacy consolidated period
  FOR v_period_id IN
    SELECT id
      FROM public.tax_periods
     WHERE fiscal_year = EXTRACT(YEAR FROM p_date)::int
       AND period_month = EXTRACT(MONTH FROM p_date)::int
       AND tax_type = 'PPh_Unifikasi'
       AND NOT (filing_status = 'filed' OR status IN ('filed', 'closed') OR filed_at IS NOT NULL)
  LOOP
    PERFORM public.compute_period_ppn(v_period_id);
  END LOOP;
END;
$$;

-- 3. Upgrade vw_canonical_tax_period_amounts: guarantee filed periods use immutable pph_total
CREATE OR REPLACE VIEW public.vw_canonical_tax_period_amounts AS
WITH amounts AS (
 SELECT tp.*, public.fn_tax_payments_paid(tp.id) actual_paid,
   CASE
     WHEN tp.filing_status = 'filed'
       OR tp.status IN ('paid', 'filed', 'closed')
       OR tp.filed_at IS NOT NULL
       OR public.fn_tax_payments_paid(tp.id) > 0.01 THEN tp.pph_total
     ELSE public.fn_pph_authoritative_source_total(tp.id)
   END::numeric(18,2) resolved_pph_total
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

GRANT EXECUTE ON FUNCTION public.compute_period_ppn(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recompute_pph_periods_for_date(date) TO authenticated, service_role;
GRANT SELECT ON public.vw_canonical_tax_period_amounts, public.vw_pph_by_period_type, public.vw_tax_period_status TO authenticated;

COMMIT;

