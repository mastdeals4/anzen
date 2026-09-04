-- The statutory PPh register is source-document authoritative. Reporting-period
-- reassignment must not make a temporary journal reversal remove its liability.
BEGIN;

CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.tax_periods%ROWTYPE;
  v_pph_total numeric(18,2);
BEGIN
  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);
  SELECT * INTO v_period FROM public.tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found', p_period_id; END IF;
  IF v_period.tax_type = 'PPN' THEN RETURN; END IF;

  SELECT
    COALESCE((
      SELECT SUM(fe.pph_amount)
      FROM public.finance_expenses fe
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
      WHERE (fe.pph_tax_period_id = v_period.id OR (
               fe.pph_tax_period_id IS NULL
           AND EXTRACT(YEAR FROM public.get_expense_pph_period_date(fe.id))::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM public.get_expense_pph_period_date(fe.id))::int = v_period.period_month
            ))
        AND fe.approval_status = 'approved' AND fe.pph_amount > 0
        AND COALESCE(fe.expense_category, '') NOT IN ('pib_import', 'pph_import')
        AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
    ), 0)
    + COALESCE((
      SELECT SUM(pv.pph_amount)
      FROM public.payment_vouchers pv
      LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
      WHERE (pv.tax_period_id = v_period.id OR (
               pv.tax_period_id IS NULL
           AND EXTRACT(YEAR FROM pv.voucher_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM pv.voucher_date)::int = v_period.period_month
            ))
        AND COALESCE(pv.is_posted, false) AND pv.pph_amount > 0
        AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
    ), 0)
    + CASE WHEN v_period.tax_type IN ('PPh22', 'PPh_Unifikasi') THEN COALESCE((
      SELECT SUM(CASE WHEN fe.expense_category = 'pib_import' THEN fe.pib_pph_amount ELSE fe.amount END)
      FROM public.finance_expenses fe
      WHERE fe.expense_category IN ('pib_import', 'pph_import')
        AND (fe.pph_tax_period_id = v_period.id OR (
               fe.pph_tax_period_id IS NULL
           AND EXTRACT(YEAR FROM public.get_expense_pph_period_date(fe.id))::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM public.get_expense_pph_period_date(fe.id))::int = v_period.period_month
            ))
        AND fe.approval_status = 'approved'
    ), 0) ELSE 0 END
  INTO v_pph_total;

  UPDATE public.tax_periods SET pph_total = v_pph_total, updated_at = now() WHERE id = p_period_id;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_period_ppn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_period_ppn(uuid) TO authenticated, service_role;

DO $$ DECLARE p uuid; BEGIN
  FOR p IN SELECT id FROM public.tax_periods WHERE tax_type <> 'PPN' LOOP PERFORM public.compute_period_ppn(p); END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
