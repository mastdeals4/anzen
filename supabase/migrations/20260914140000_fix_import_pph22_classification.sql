-- ============================================================================
-- Migration: Fix Import PPh 22 Classification in Tax Compliance Engine
-- ============================================================================
-- Root Cause:
--   Import PPh 22 (paid under PIB customs clearance) was previously aggregated
--   into monthly tax_periods.pph_total as if it were a monthly withholding tax
--   liability. Because Import PPh 22 is paid directly at customs via bank transfer
--   to the State Treasury (Kas Negara/DJBC) and debited to 1155 PPh 22 Dibayar
--   Dimuka (Advance Income Tax Asset), it is NOT a monthly withholding liability
--   and is never remitted via monthly DJP billing (tax_payments).
--
-- Fix:
--   1. Exclude pib_import and pph_import from fn_pph_authoritative_source_total()
--      and compute_period_ppn_pre_posted_register().
--   2. Maintain vw_pph22_advance_tax_report as the authoritative register for
--      Annual Corporate Tax Return (SPT Tahunan PPh Badan / Form 1771 Lampiran III).
--   3. Recalculate tax_periods for PPh22 and PPh_Unifikasi so that phantom
--      liabilities are cleared from vw_outstanding_tax.
--   4. Genuine withholdings (PPh 21, PPh 23, PPh 4(2)) and COA 1155/2137 balances
--      remain 100% unaffected.
-- ============================================================================

BEGIN;

-- 1. Central authoritative source resolver: exclude import advance taxes
CREATE OR REPLACE FUNCTION public.fn_pph_authoritative_source_total(p_period_id uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path = public AS $$
  WITH period AS (
    SELECT id, fiscal_year, period_month, tax_type, period_start, period_end
      FROM public.tax_periods WHERE id = p_period_id AND tax_type <> 'PPN'
  )
  -- (a) Genuine withholding on expenses (where pph_amount > 0).
  -- Note: pib_import and pph_import are excluded because import PPh 22 is an
  -- advance tax (prepaid tax asset / COA 1155) paid at customs clearance under PIB,
  -- NOT a monthly withholding liability payable to DJP.
  SELECT COALESCE((
    SELECT SUM(fe.pph_amount)
      FROM period p
      JOIN public.finance_expenses fe
        ON (fe.pph_tax_period_id = p.id
            OR (p.tax_type = 'PPh_Unifikasi' AND EXISTS (
                SELECT 1 FROM public.tax_periods p_sub
                 WHERE p_sub.id = fe.pph_tax_period_id
                   AND p_sub.fiscal_year = p.fiscal_year
                   AND p_sub.period_month = p.period_month
            ))
            OR (fe.pph_tax_period_id IS NULL AND fe.expense_date BETWEEN p.period_start AND p.period_end))
      JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
       AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
      LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
     WHERE fe.approval_status = 'approved' AND fe.pph_amount > 0
       AND COALESCE(fe.expense_category,'') NOT IN ('pib_import','pph_import')
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ),0)
  -- (b) Genuine withholding on payment vouchers
  + COALESCE((
    SELECT SUM(pv.pph_amount) FROM period p
      JOIN public.payment_vouchers pv ON (pv.tax_period_id = p.id
        OR (p.tax_type = 'PPh_Unifikasi' AND EXISTS (
            SELECT 1 FROM public.tax_periods p_sub
             WHERE p_sub.id = pv.tax_period_id
               AND p_sub.fiscal_year = p.fiscal_year
               AND p_sub.period_month = p.period_month
        ))
        OR (pv.tax_period_id IS NULL AND pv.voucher_date BETWEEN p.period_start AND p.period_end))
      LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
     WHERE COALESCE(pv.is_posted,false) AND pv.pph_amount > 0
       AND (p.tax_type = 'PPh_Unifikasi' OR tc.tax_type = p.tax_type)
  ),0)
  -- (c) Historical verified tax payments with missing source
  + COALESCE((
    SELECT SUM(tp.amount) FROM period p
      JOIN public.tax_payments tp ON tp.tax_period_id = p.id
     WHERE (p.tax_type = 'PPh_Unifikasi' OR tp.tax_type = p.tax_type)
       AND tp.historical_source_status = 'missing_source_verified'
  ),0);
$$;

-- 2. Legacy pre-posted register calculation: align with authoritative resolver
CREATE OR REPLACE FUNCTION public.compute_period_ppn_pre_posted_register(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_period       tax_periods%ROWTYPE;
  v_input        numeric(18,2);
  v_output_gross numeric(18,2);
  v_output_cn    numeric(18,2);
  v_output       numeric(18,2);
  v_prior_cf     numeric(18,2);
  v_pph_total    numeric(18,2);
BEGIN
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  IF v_period.tax_type = 'PPN' THEN
    SELECT
      COALESCE((
        SELECT SUM(tax_amount) FROM purchase_invoices
         WHERE tax_period_id = p_period_id AND tax_amount > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(fe.ppn_amount)
          FROM finance_expenses fe
         WHERE fe.tax_period_id = p_period_id
           AND fe.ppn_amount > 0
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
              WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
           )
      ), 0)
      +
      COALESCE((
        SELECT SUM(COALESCE((item->>'ppn_amount')::numeric, 0))
          FROM finance_expenses fe
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
         WHERE fe.tax_period_id = p_period_id
           AND COALESCE((item->>'ppn_amount')::numeric, 0) > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(pib_ppn_amount) FROM finance_expenses
         WHERE tax_period_id = p_period_id AND pib_ppn_amount > 0
      ), 0)
    INTO v_input;

    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output_gross
      FROM sales_invoices
     WHERE tax_period_id = p_period_id AND tax_amount > 0;

    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output_cn
      FROM credit_notes
     WHERE tax_period_id = p_period_id
       AND status = 'approved'
       AND tax_amount > 0;

    v_output := GREATEST(v_output_gross - v_output_cn, 0);

    SELECT COALESCE(carry_forward_out, 0) INTO v_prior_cf
      FROM tax_periods
     WHERE tax_type = 'PPN'
       AND (fiscal_year, period_month) < (v_period.fiscal_year, v_period.period_month)
     ORDER BY fiscal_year DESC, period_month DESC
     LIMIT 1;
    v_prior_cf := COALESCE(v_prior_cf, 0);

    UPDATE tax_periods SET
      input_ppn_total   = v_input,
      output_ppn_total  = v_output,
      carry_forward_in  = v_prior_cf,
      net_ppn           = GREATEST(v_output - v_input - v_prior_cf, 0),
      carry_forward_out = GREATEST(v_input + v_prior_cf - v_output, 0),
      updated_at        = now()
    WHERE id = p_period_id;

  ELSE
    -- PPh period: only sum genuine withholdings (never import advance taxes)
    SELECT
      COALESCE((
        SELECT SUM(fe.pph_amount)
          FROM finance_expenses fe
          LEFT JOIN tax_codes tc ON tc.id = fe.pph_code_id
         WHERE EXTRACT(YEAR  FROM fe.expense_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
           AND fe.pph_amount > 0
           AND COALESCE(fe.expense_category, '') NOT IN ('pib_import', 'pph_import')
           AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
      ), 0)
      +
      COALESCE((
        SELECT SUM(pv.pph_amount)
          FROM payment_vouchers pv
          LEFT JOIN tax_codes tc ON tc.id = pv.pph_code_id
         WHERE EXTRACT(YEAR  FROM pv.voucher_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM pv.voucher_date)::int = v_period.period_month
           AND pv.pph_amount > 0
           AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
      ), 0)
    INTO v_pph_total;

    UPDATE tax_periods SET
      pph_total  = v_pph_total,
      updated_at = now()
    WHERE id = p_period_id;
  END IF;
END;
$$;

-- 3. Recalculate/refresh all open/unfiled PPh22 and PPh_Unifikasi tax periods
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id FROM public.tax_periods
     WHERE tax_type IN ('PPh22', 'PPh_Unifikasi')
       AND status NOT IN ('closed', 'filed')
       AND COALESCE(filing_status, '') <> 'filed'
     ORDER BY fiscal_year, period_month
  LOOP
    PERFORM public.compute_period_ppn(r.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
