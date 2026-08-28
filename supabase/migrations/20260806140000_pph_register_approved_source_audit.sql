-- The PPh Register is the statutory withholding register. Approved source
-- documents create the liability; journals are an independent accounting audit
-- trail and must not add, remove, or invalidate that liability.

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
  -- Keep the established PPN computation unchanged.
  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);

  SELECT * INTO v_period
  FROM public.tax_periods
  WHERE id = p_period_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;
  IF v_period.tax_type = 'PPN' THEN
    RETURN;
  END IF;

  SELECT
    COALESCE((
      SELECT SUM(fe.pph_amount)
      FROM public.finance_expenses fe
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
      WHERE EXTRACT(YEAR FROM fe.expense_date)::int = v_period.fiscal_year
        AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
        AND fe.approval_status = 'approved'
        AND fe.pph_amount > 0
        AND COALESCE(fe.expense_category, '') NOT IN ('pib_import', 'pph_import')
        AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
    ), 0)
    + COALESCE((
      SELECT SUM(pv.pph_amount)
      FROM public.payment_vouchers pv
      LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
      WHERE EXTRACT(YEAR FROM pv.voucher_date)::int = v_period.fiscal_year
        AND EXTRACT(MONTH FROM pv.voucher_date)::int = v_period.period_month
        AND COALESCE(pv.is_posted, false) = true
        AND pv.pph_amount > 0
        AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
    ), 0)
    + CASE WHEN v_period.tax_type IN ('PPh22', 'PPh_Unifikasi') THEN
      COALESCE((
        SELECT SUM(fe.pib_pph_amount)
        FROM public.finance_expenses fe
        WHERE fe.expense_category = 'pib_import'
          AND EXTRACT(YEAR FROM fe.expense_date)::int = v_period.fiscal_year
          AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
          AND fe.approval_status = 'approved'
          AND COALESCE(fe.pib_pph_amount, 0) > 0
      ), 0)
      + COALESCE((
        SELECT SUM(fe.amount)
        FROM public.finance_expenses fe
        WHERE fe.expense_category = 'pph_import'
          AND EXTRACT(YEAR FROM fe.expense_date)::int = v_period.fiscal_year
          AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
          AND fe.approval_status = 'approved'
          AND COALESCE(fe.amount, 0) > 0
      ), 0)
    ELSE 0 END
  INTO v_pph_total;

  UPDATE public.tax_periods
  SET pph_total = v_pph_total,
      updated_at = now()
  WHERE id = p_period_id;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_period_ppn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_period_ppn(uuid)
TO authenticated, service_role;

-- Recalculate only derived Register totals. Source documents, journals, tax
-- payments, filings, and historical accounting data are not changed.
DO $$
DECLARE
  v_period_id uuid;
BEGIN
  FOR v_period_id IN
    SELECT id
    FROM public.tax_periods
    WHERE tax_type <> 'PPN'
    ORDER BY fiscal_year, period_month, tax_type
  LOOP
    PERFORM public.compute_period_ppn(v_period_id);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
